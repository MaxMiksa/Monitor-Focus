//go:build windows

package audio

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                   = windows.NewLazySystemDLL("user32.dll")
	getForegroundWindow      = user32.NewProc("GetForegroundWindow")
	getWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	getSystemMetrics         = user32.NewProc("GetSystemMetrics")
)

// ForegroundWindow is a cheap identity-only read suitable for an input callback.
func ForegroundWindow() uintptr { hwnd, _, _ := getForegroundWindow.Call(); return hwnd }

// ForegroundWindow is also available on the controller for host integration.
func (c *Controller) ForegroundWindow() uintptr { return ForegroundWindow() }

func windowProcess(hwnd uintptr) uint32 {
	var pid uint32
	thread, _, _ := getWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if thread == 0 {
		return 0
	}
	return pid
}

func physicalConsole() error {
	remote, _, _ := getSystemMetrics.Call(0x1000) // SM_REMOTESESSION
	var session uint32
	err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session)
	if err != nil {
		return fmt.Errorf("resolve audio process session: %w", err)
	}
	if remote != 0 || session != windows.WTSGetActiveConsoleSessionId() {
		return ErrNotConsole
	}
	return nil
}

type pinnedProcess struct {
	info   process
	handle windows.Handle
}

func pinProcess(pid, parent uint32) (*pinnedProcess, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return nil, err
	}
	p := &pinnedProcess{handle: h}
	var created, exited, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		p.close()
		return nil, err
	}
	var session uint32
	if err = windows.ProcessIdToSessionId(pid, &session); err != nil {
		p.close()
		return nil, err
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err = windows.QueryFullProcessImageName(h, 0, &buffer[0], &size); err != nil {
		p.close()
		return nil, err
	}
	p.info = process{id: pid, parent: parent, session: session, image: windows.UTF16ToString(buffer[:size]), started: uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)}
	if !p.alive() {
		p.close()
		return nil, ErrStaleTarget
	}
	return p, nil
}

func (p *pinnedProcess) close() {
	if p != nil && p.handle != 0 {
		windows.CloseHandle(p.handle)
		p.handle = 0
	}
}
func (p *pinnedProcess) alive() bool {
	if p == nil || p.handle == 0 {
		return false
	}
	status, err := windows.WaitForSingleObject(p.handle, 0)
	return err == nil && status == uint32(windows.WAIT_TIMEOUT)
}

type foregroundTarget struct {
	hwnd     uintptr
	pid      uint32
	pin      *pinnedProcess
	captured time.Time
	cutoff   uint64
}

func captureTarget(hwnd uintptr) (*foregroundTarget, error) {
	if err := physicalConsole(); err != nil {
		return nil, err
	}
	if hwnd == 0 || ForegroundWindow() != hwnd {
		return nil, ErrNoTarget
	}
	pid := windowProcess(hwnd)
	if pid == 0 {
		return nil, ErrNoTarget
	}
	captured := time.Now()
	pin, err := pinProcess(pid, 0)
	if err != nil {
		return nil, fmt.Errorf("pin foreground process: %w", err)
	}
	// Convert UTC Unix time to Windows 100ns ticks without overflowing UnixNano.
	cutoff := uint64(captured.Unix())*10000000 + uint64(captured.Nanosecond()/100) + 116444736000000000
	t := &foregroundTarget{hwnd: hwnd, pid: pid, pin: pin, captured: captured, cutoff: cutoff}
	if pin.info.started > cutoff || pin.info.session != windows.WTSGetActiveConsoleSessionId() {
		t.close()
		return nil, ErrStaleTarget
	}
	if err := t.current(); err != nil {
		t.close()
		return nil, err
	}
	return t, nil
}

func (t *foregroundTarget) close() { t.pin.close() }
func (t *foregroundTarget) current() error {
	// A queued foreground request is intentionally short lived. COM calls are not
	// cancellable; expiry is checked again before each individual session write.
	if time.Since(t.captured) > time.Second || ForegroundWindow() != t.hwnd || windowProcess(t.hwnd) != t.pid || !t.pin.alive() {
		return ErrStaleTarget
	}
	return nil
}

func (t *foregroundTarget) resolve() (map[uint32]process, map[uint32]*pinnedProcess, error) {
	processes := map[uint32]process{}
	pins := map[uint32]*pinnedProcess{}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return processes, pins, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	err = windows.Process32First(snapshot, &entry)
	for err == nil {
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(t.pin.info.image)) {
			p, pinErr := pinProcess(entry.ProcessID, entry.ParentProcessID)
			if pinErr == nil {
				if sameExecutable(p.info, t.pin.info) && p.info.started <= t.cutoff {
					processes[p.info.id], pins[p.info.id] = p.info, p
				} else {
					p.close()
				}
			}
		}
		err = windows.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return processes, pins, fmt.Errorf("enumerate audio process family: %w", err)
	}
	root, ok := processes[t.pid]
	if !ok || root.started != t.pin.info.started {
		return processes, pins, ErrStaleTarget
	}
	if err := t.current(); err != nil {
		return processes, pins, err
	}
	return processes, pins, nil
}

func imageName(image string) string {
	return strings.TrimSuffix(filepath.Base(image), filepath.Ext(image))
}
