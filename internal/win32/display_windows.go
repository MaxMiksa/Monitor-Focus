//go:build windows

package win32

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
	"golang.org/x/sys/windows"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var dxva = windows.NewLazySystemDLL("dxva2.dll")
var kernel = windows.NewLazySystemDLL("kernel32.dll")
var gdi = windows.NewLazySystemDLL("gdi32.dll")

// Go's Windows callback trampolines cannot be freed. Reuse one across scans.
var monitorEnumerations sync.Map
var monitorEnumToken atomic.Uintptr
var monitorCallback = syscall.NewCallback(func(handle, dc, rect, token uintptr) uintptr {
	if value, ok := monitorEnumerations.Load(token); ok {
		return value.(func(uintptr) uintptr)(handle)
	}
	return 0
})

func enumerateMonitors(visit func(uintptr) uintptr) error {
	token := monitorEnumToken.Add(1)
	monitorEnumerations.Store(token, visit)
	defer monitorEnumerations.Delete(token)
	ok, _, err := user32.NewProc("EnumDisplayMonitors").Call(0, 0, monitorCallback, token)
	if ok == 0 {
		return err
	}
	return nil
}

type Rect struct{ Left, Top, Right, Bottom int32 }
type monitorInfo struct {
	Size          uint32
	Monitor, Work Rect
	Flags         uint32
	Device        [32]uint16
}
type displayDevice struct {
	Size        uint32
	Name        [32]uint16
	Description [128]uint16
	Flags       uint32
	ID          [128]uint16
	Key         [128]uint16
}
type physical struct {
	Handle      uintptr
	Description [128]uint16
}
type Display struct {
	Id               string
	Name             string
	GDI              string
	Primary          bool
	Bounds           Rect
	DPI              uint32
	Brightness       int
	Method           string
	Error            string
	Gamma            []uint16
	ColorMode        ColorMode
	ColorError       string
	color            *GammaOwner
	physical         physical
	minimum, maximum uint32
	wmiName          string
	levels           []uint8
}
type Result struct {
	Displays []*Display
	Error    error
}
type job struct {
	fn   func() error
	done chan error
}

// Worker owns every DDC handle and COM reference on one locked OS thread.
// Calls do not have a fake cancellation timeout: Close queues behind all work.
type Worker struct {
	mu          sync.RWMutex
	closed      bool
	queue       chan job
	done        chan struct{}
	Displays    []*Display
	service     *ole.IDispatch
	locator     *ole.IDispatch
	err         error
	Trace       func(string, map[string]any)
	TraceID     string
	JournalPath string
	ownership   windows.Handle
}

func Console() bool {
	r, _, _ := kernel.NewProc("WTSGetActiveConsoleSessionId").Call()
	var session uint32
	err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session)
	return err == nil && uint32(r) != ^uint32(0) && session == uint32(r)
}
func EnableDPI() { user32.NewProc("SetProcessDpiAwarenessContext").Call(^uintptr(3)) }

func CursorPosition() (int32, int32) {
	var point struct{ X, Y int32 }
	user32.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
	return point.X, point.Y
}

// Wails sizes include the native frame; the reused React design uses client DIP.
func ClientOuterSize(hwnd uintptr, width, height int) (int, int) {
	var outer, client Rect
	user32.NewProc("GetWindowRect").Call(hwnd, uintptr(unsafe.Pointer(&outer)))
	user32.NewProc("GetClientRect").Call(hwnd, uintptr(unsafe.Pointer(&client)))
	dpi, _, _ := user32.NewProc("GetDpiForWindow").Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	horizontal := float64(outer.Right-outer.Left-client.Right+client.Left) * 96 / float64(dpi)
	vertical := float64(outer.Bottom-outer.Top-client.Bottom+client.Top) * 96 / float64(dpi)
	return width + int(horizontal+0.5), height + int(vertical+0.5)
}
func Identity(device string) (string, error) {
	name, _ := windows.UTF16PtrFromString(device)
	result := ""
	for i := uint32(0); ; i++ {
		var d displayDevice
		d.Size = uint32(unsafe.Sizeof(d))
		ok, _, _ := user32.NewProc("EnumDisplayDevicesW").Call(uintptr(unsafe.Pointer(name)), uintptr(i), uintptr(unsafe.Pointer(&d)), 1)
		if ok == 0 {
			break
		}
		if d.Flags&1 == 0 {
			continue
		}
		parts := strings.Split(windows.UTF16ToString(d.ID[:]), "#")
		if len(parts) != 4 || !strings.EqualFold(parts[0], `\\?\DISPLAY`) || result != "" {
			return "", errors.New("ambiguous display identity")
		}
		result = `DISPLAY\` + parts[1] + `\` + parts[2]
	}
	if result == "" {
		return "", errors.New("missing display identity")
	}
	return result, nil
}
func (d *Display) ensure() error {
	if !Console() {
		return errors.New("not physical console session")
	}
	id, err := Identity(d.GDI)
	if err != nil || !strings.EqualFold(id, d.Id) {
		return errors.New("physical display mapping changed; rescan required")
	}
	return nil
}
func NewWorker() (*Worker, error) {
	if !Console() {
		return nil, errors.New("only physical console session may enumerate hardware")
	}
	w := &Worker{queue: make(chan job, 32), done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(w.done)
		defer func() {
			if w.ownership != 0 {
				windows.ReleaseMutex(w.ownership)
				windows.CloseHandle(w.ownership)
			}
		}()
		err := ole.CoInitializeEx(0, ole.COINIT_MULTITHREADED)
		if err != nil {
			ready <- err
			return
		}
		defer ole.CoUninitialize()
		unknown, err := oleutil.CreateObject("WbemScripting.SWbemLocator")
		if err == nil {
			w.locator, err = unknown.QueryInterface(ole.IID_IDispatch)
			unknown.Release()
		}
		if err == nil {
			var v *ole.VARIANT
			v, err = oleutil.CallMethod(w.locator, "ConnectServer", ".", `root\wmi`)
			if err == nil {
				w.service = v.ToIDispatch()
			}
		}
		if w.service != nil {
			defer w.service.Release()
		}
		if w.locator != nil {
			defer w.locator.Release()
		}
		w.err = err
		err = w.scan()
		ready <- err
		if err != nil {
			w.release()
			return
		}
		for j := range w.queue {
			j.done <- j.fn()
		}
		w.release()
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return w, nil
}
func (w *Worker) Call(fn func() error) error {
	w.mu.RLock()
	if w.closed {
		w.mu.RUnlock()
		return errors.New("hardware worker stopped")
	}
	j := job{fn: fn, done: make(chan error, 1)}
	select {
	case w.queue <- j:
	case <-w.done:
		w.mu.RUnlock()
		return errors.New("hardware worker stopped")
	}
	w.mu.RUnlock()
	select {
	case err := <-j.done:
		return err
	case <-w.done:
		return errors.New("hardware worker stopped")
	}
}
func (w *Worker) Close() {
	w.mu.Lock()
	if !w.closed {
		w.closed = true
		close(w.queue)
	}
	w.mu.Unlock()
	<-w.done
}

// Shares the existing C# entry's exclusion name. While Go owns the handle,
// launching that original entry cannot create a second hardware core.
func (w *Worker) AcquireHardware() error {
	return w.Call(func() error {
		name, err := windows.UTF16PtrFromString(`Local\MonitorsFocus.` + os.Getenv("USERNAME"))
		if err != nil {
			return err
		}
		handle, err := windows.CreateMutex(nil, true, name)
		if err != nil {
			if handle != 0 {
				windows.CloseHandle(handle)
			}
			return fmt.Errorf("hardware ownership unavailable: %w", err)
		}
		w.ownership = handle
		return nil
	})
}
func (w *Worker) callNamed(name string, fields map[string]any, fn func() error) error {
	queued := time.Now()
	traceID := w.TraceID
	sink := w.Trace
	return w.Call(func() error {
		start := time.Now()
		fields["traceId"] = traceID
		fields["operation"] = name
		fields["queueMs"] = start.Sub(queued).Milliseconds()
		if sink != nil {
			sink("hardware-start", fields)
		}
		err := fn()
		result := map[string]any{}
		for k, v := range fields {
			result[k] = v
		}
		result["elapsedMs"] = time.Since(start).Milliseconds()
		if err != nil {
			result["error"] = err.Error()
		}
		if sink != nil {
			sink("hardware-end", result)
		}
		return err
	})
}

// Re-scan in the owning worker after every outstanding command has drained.
// Restore only owned, still-identified tables; errors are retained for the caller.
func (w *Worker) Rescan() error {
	return w.callNamed("rescan", map[string]any{}, func() error {
		if !Console() {
			return errors.New("not physical console session")
		}
		// GDI numbers may have changed. Resolve current identities before restoring
		// colors; otherwise the old mapping blocks the very scan needed to fix it.
		bindings, err := currentDisplayBindings()
		if err != nil {
			return err
		}
		var failures []error
		for _, d := range w.Displays {
			device := d.GDI
			if d.color != nil {
				var err error
				device, err = displayBinding(bindings, d.Id)
				if err != nil {
					failures = append(failures, err)
					continue
				}
			}
			if err := w.restoreGammaAt(d, device); err != nil {
				failures = append(failures, err)
			}
		}
		// Keep the old identities and color owners on any restoration failure.
		// A new scan must never adopt an unrestored warm table as its baseline.
		if len(failures) != 0 {
			return errors.Join(failures...)
		}
		w.release()
		w.Displays = nil
		if err := w.scan(); err != nil {
			failures = append(failures, err)
		}
		return errors.Join(failures...)
	})
}

func (w *Worker) restoreGammaAt(d *Display, device string) error {
	// Temporarily rebind only for gamma. On failure, the old DDC handle must
	// remain paired with its old GDI name so subsequent writes still fail closed.
	previous := d.GDI
	d.GDI = device
	defer func() { d.GDI = previous }()
	return w.restoreGamma(d)
}

type displayBindings map[string][]string

func displayBinding(bindings displayBindings, id string) (string, error) {
	devices := bindings[strings.ToUpper(id)]
	if len(devices) != 1 {
		return "", fmt.Errorf("display offline or ambiguous during rescan: %s", id)
	}
	return devices[0], nil
}

// Read topology without touching brightness, gamma or physical DDC handles.
func currentDisplayBindings() (displayBindings, error) {
	bindings := displayBindings{}
	var failures []error
	err := enumerateMonitors(func(handle uintptr) uintptr {
		var info monitorInfo
		info.Size = uint32(unsafe.Sizeof(info))
		ok, _, _ := user32.NewProc("GetMonitorInfoW").Call(handle, uintptr(unsafe.Pointer(&info)))
		if ok == 0 {
			failures = append(failures, errors.New("GetMonitorInfo failed during rescan"))
			return 1
		}
		device := windows.UTF16ToString(info.Device[:])
		id, err := Identity(device)
		if err != nil {
			failures = append(failures, err)
			return 1
		}
		key := strings.ToUpper(id)
		bindings[key] = append(bindings[key], device)
		return 1
	})
	return bindings, errors.Join(append(failures, err)...)
}

// Only identity/topology reads: no DDC transaction, COM call or hardware write.
func DisplaySignature() (string, error) {
	var rows []string
	var failure error
	callback := func(handle uintptr) uintptr {
		var info monitorInfo
		info.Size = uint32(unsafe.Sizeof(info))
		ok, _, _ := user32.NewProc("GetMonitorInfoW").Call(handle, uintptr(unsafe.Pointer(&info)))
		if ok == 0 {
			return 1
		}
		gdiName := windows.UTF16ToString(info.Device[:])
		id, err := Identity(gdiName)
		if err != nil {
			failure = err
			return 1
		}
		rows = append(rows, fmt.Sprintf("%s|%s|%v|%d", gdiName, id, info.Monitor, info.Flags))
		return 1
	}
	if err := enumerateMonitors(callback); err != nil {
		return "", err
	}
	sort.Strings(rows)
	return strings.Join(rows, ";"), failure
}
func (w *Worker) release() {
	for _, d := range w.Displays {
		if d.physical.Handle != 0 {
			dxva.NewProc("DestroyPhysicalMonitor").Call(d.physical.Handle)
			d.physical.Handle = 0
		}
	}
}
func (w *Worker) scan() error {
	var scanErr error
	cb := func(handle uintptr) uintptr {
		var info monitorInfo
		info.Size = uint32(unsafe.Sizeof(info))
		ok, _, _ := user32.NewProc("GetMonitorInfoW").Call(handle, uintptr(unsafe.Pointer(&info)))
		if ok == 0 {
			return 1
		}
		device := windows.UTF16ToString(info.Device[:])
		id, err := Identity(device)
		if err != nil {
			scanErr = err
			return 1
		}
		d := &Display{Id: id, GDI: device, Name: device, Primary: info.Flags&1 != 0, Bounds: info.Monitor, DPI: 96, Brightness: -1, Method: "none"}
		var desc displayDevice
		desc.Size = uint32(unsafe.Sizeof(desc))
		p, _ := windows.UTF16PtrFromString(device)
		user32.NewProc("EnumDisplayDevicesW").Call(uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&desc)), 0)
		d.Name = windows.UTF16ToString(desc.Description[:])
		shcore := windows.NewLazySystemDLL("shcore.dll")
		var x, y uint32
		hr, _, _ := shcore.NewProc("GetDpiForMonitor").Call(handle, 0, uintptr(unsafe.Pointer(&x)), uintptr(unsafe.Pointer(&y)))
		if hr == 0 {
			d.DPI = x
		}
		ambiguousWMI := false
		if err = w.matchWMI(d); err != nil {
			d.Error = err.Error()
			ambiguousWMI = d.wmiName != ""
		}
		if ambiguousWMI {
			d.wmiName = ""
		} else if d.wmiName != "" {
			d.Method = "WMI"
		} else {
			var count uint32
			ok, _, _ := dxva.NewProc("GetNumberOfPhysicalMonitorsFromHMONITOR").Call(handle, uintptr(unsafe.Pointer(&count)))
			if ok != 0 && count == 1 {
				ok, _, _ := dxva.NewProc("GetPhysicalMonitorsFromHMONITOR").Call(handle, 1, uintptr(unsafe.Pointer(&d.physical)))
				if ok != 0 {
					d.Method = "DDC/CI"
					if strings.TrimSpace(windows.UTF16ToString(d.physical.Description[:])) != "" {
						d.Name = windows.UTF16ToString(d.physical.Description[:])
					}
				}
			}
		}
		if d.Method != "none" {
			if err = w.read(d); err != nil {
				d.Error = err.Error()
			} else {
				d.Error = ""
			}
		}
		d.Gamma, _ = ReadGamma(device)
		d.ColorMode, err = ReadColorMode(device)
		if err != nil {
			d.ColorError = err.Error()
		} else if !strings.EqualFold(d.ColorMode.TargetIdentity, d.Id) {
			d.ColorError = "CCD target mismatch"
		} else {
			if d.ColorMode.Friendly != "" {
				d.Name = d.ColorMode.Friendly
			}
			if d.ColorMode.Internal {
				d.Name = "笔记本屏幕"
			}
		}
		w.Displays = append(w.Displays, d)
		return 1
	}
	err := enumerateMonitors(cb)
	if err != nil {
		return err
	}
	if len(w.Displays) == 0 {
		return fmt.Errorf("no identified displays: %v", scanErr)
	}
	return nil
}
func (w *Worker) eachWMI(query string, fn func(*ole.IDispatch) error) error {
	if w.service == nil {
		return fmt.Errorf("WMI unavailable: %v", w.err)
	}
	v, err := oleutil.CallMethod(w.service, "ExecQuery", query)
	if err != nil {
		return err
	}
	defer v.Clear()
	collection := v.ToIDispatch()
	return oleutil.ForEach(collection, func(value *ole.VARIANT) error { return fn(value.ToIDispatch()) })
}
func property(d *ole.IDispatch, name string) (*ole.VARIANT, error) {
	if d == nil {
		return nil, errors.New("WMI returned no dispatch object")
	}
	return oleutil.GetProperty(d, name)
}
func textProperty(d *ole.IDispatch, name string) string {
	v, err := property(d, name)
	if err != nil {
		return ""
	}
	defer v.Clear()
	return v.ToString()
}
func numberProperty(d *ole.IDispatch, name string) int {
	v, err := property(d, name)
	if err != nil {
		return -1
	}
	defer v.Clear()
	switch n := v.Value().(type) {
	case uint8:
		return int(n)
	case int32:
		return int(n)
	case uint32:
		return int(n)
	case int16:
		return int(n)
	}
	return -1
}
func matchesWMI(id, name string) bool {
	if strings.EqualFold(id, name) {
		return true
	}
	if len(name) <= len(id)+1 || !strings.EqualFold(name[:len(id)+1], id+"_") {
		return false
	}
	for _, c := range name[len(id)+1:] {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func (w *Worker) matchWMI(d *Display) error {
	return w.eachWMI("SELECT * FROM WmiMonitorBrightness", func(item *ole.IDispatch) error {
		name := textProperty(item, "InstanceName")
		active, err := property(item, "Active")
		if err != nil {
			return err
		}
		defer active.Clear()
		if active.Value() != true || !matchesWMI(d.Id, name) {
			return nil
		}
		if d.wmiName != "" {
			return errors.New("multiple WMI matches")
		}
		d.wmiName = name
		levels, err := property(item, "Level")
		if err != nil {
			return err
		}
		defer levels.Clear()
		array := levels.ToArray()
		if array == nil {
			return errors.New("missing brightness levels")
		}
		for _, value := range array.ToValueArray() {
			switch n := value.(type) {
			case uint8:
				d.levels = append(d.levels, n)
			case int32:
				d.levels = append(d.levels, uint8(n))
			}
		}
		if len(d.levels) == 0 {
			return errors.New("empty brightness levels")
		}
		return nil
	})
}
func (w *Worker) read(d *Display) error {
	if err := d.ensure(); err != nil {
		return err
	}
	if d.wmiName != "" {
		found := false
		err := w.eachWMI("SELECT * FROM WmiMonitorBrightness", func(item *ole.IDispatch) error {
			if strings.EqualFold(textProperty(item, "InstanceName"), d.wmiName) {
				d.Brightness = numberProperty(item, "CurrentBrightness")
				found = true
			}
			return nil
		})
		if err != nil {
			return err
		}
		if !found || d.Brightness < 0 {
			return errors.New("matched WMI brightness disappeared")
		}
		return nil
	}
	var current uint32
	for attempt := 0; attempt < 3; attempt++ {
		ok, _, _ := dxva.NewProc("GetMonitorBrightness").Call(d.physical.Handle, uintptr(unsafe.Pointer(&d.minimum)), uintptr(unsafe.Pointer(&current)), uintptr(unsafe.Pointer(&d.maximum)))
		if ok != 0 && d.maximum > d.minimum {
			d.Brightness = int((float64(current-d.minimum) * 100 / float64(d.maximum-d.minimum)) + 0.5)
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("DDC brightness read failed")
}
func (w *Worker) Refresh() error {
	return w.Call(func() error {
		for _, d := range w.Displays {
			if d.Method == "none" {
				continue
			}
			if err := w.read(d); err != nil {
				d.Error = err.Error()
			} else {
				d.Error = ""
			}
		}
		return nil
	})
}
func (w *Worker) Set(id string, value int) error {
	return w.callNamed("brightness", map[string]any{"deviceId": id, "target": value}, func() error {
		expected := value
		if value < 0 || value > 100 {
			return errors.New("invalid brightness")
		}
		var d *Display
		for _, candidate := range w.Displays {
			if candidate.Id == id {
				d = candidate
			}
		}
		if d == nil {
			return errors.New("display not identified")
		}
		if err := d.ensure(); err != nil {
			return err
		}
		if d.wmiName != "" {
			target := d.levels[0]
			for _, level := range d.levels {
				if abs(int(level)-value) < abs(int(target)-value) {
					target = level
				}
			}
			expected = int(target)
			found := false
			err := w.eachWMI("SELECT * FROM WmiMonitorBrightnessMethods", func(item *ole.IDispatch) error {
				if !strings.EqualFold(textProperty(item, "InstanceName"), d.wmiName) {
					return nil
				}
				found = true
				if err := d.ensure(); err != nil {
					return err
				}
				return invokeBrightness(item, target)
			})
			if err != nil {
				return err
			}
			if !found {
				return errors.New("matched WMI method missing")
			}
		} else if d.Method == "DDC/CI" {
			value := d.minimum + uint32(float64(d.maximum-d.minimum)*float64(value)/100+0.5)
			success := false
			for attempt := 0; attempt < 3; attempt++ {
				if err := d.ensure(); err != nil {
					return err
				}
				ok, _, _ := dxva.NewProc("SetMonitorBrightness").Call(d.physical.Handle, uintptr(value))
				if ok != 0 {
					success = true
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
			if !success {
				return errors.New("DDC brightness write failed")
			}
		} else {
			return errors.New("brightness unsupported")
		}
		for attempt := 0; attempt < 10; attempt++ {
			if err := w.read(d); err != nil {
				return err
			}
			if d.Brightness == expected {
				return nil
			}
			time.Sleep(25 * time.Millisecond)
		}
		return fmt.Errorf("brightness readback mismatch: target %d, actual %d", expected, d.Brightness)
	})
}

// SWbem numeric arguments use VT_I4. This provider can return VT_EMPTY on
// success, so Worker.Set separately requires the actual WMI brightness readback.
func invokeBrightness(item *ole.IDispatch, target uint8) error {
	result, err := oleutil.CallMethod(item, "WmiSetBrightness", int32(1), int32(target))
	if err != nil {
		return err
	}
	defer result.Clear()
	if result.VT == ole.VT_EMPTY || result.VT == ole.VT_NULL {
		return nil
	}
	if result.Value() != int32(0) && result.Value() != uint32(0) {
		return fmt.Errorf("WMI returned %v (VT=%d)", result.Value(), result.VT)
	}
	return nil
}
func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
func ReadGamma(device string) ([]uint16, error) {
	p, _ := windows.UTF16PtrFromString(device)
	driver, _ := windows.UTF16PtrFromString("DISPLAY")
	dc, _, _ := gdi.NewProc("CreateDCW").Call(uintptr(unsafe.Pointer(driver)), uintptr(unsafe.Pointer(p)), 0, 0)
	if dc == 0 {
		return nil, errors.New("CreateDC failed")
	}
	defer gdi.NewProc("DeleteDC").Call(dc)
	ramp := make([]uint16, 768)
	ok, _, _ := gdi.NewProc("GetDeviceGammaRamp").Call(dc, uintptr(unsafe.Pointer(&ramp[0])))
	if ok == 0 {
		return nil, errors.New("Gamma read failed")
	}
	return ramp, nil
}
func ExistingCore() bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return true
	}
	defer windows.CloseHandle(snap)
	var p windows.ProcessEntry32
	p.Size = uint32(unsafe.Sizeof(p))
	err = windows.Process32First(snap, &p)
	for err == nil {
		if strings.EqualFold(windows.UTF16ToString(p.ExeFile[:]), "MonitorsFocus.exe") {
			return true
		}
		err = windows.Process32Next(snap, &p)
	}
	return false
}
