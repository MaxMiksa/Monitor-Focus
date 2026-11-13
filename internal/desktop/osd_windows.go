//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	ole32           = windows.NewLazySystemDLL("ole32.dll")
	immersiveShell  = mustGUID("{C2F03A33-21F5-47FA-B4BB-156362A2F239}")
	serviceProvider = mustGUID("{6D5140C1-7436-11CE-8034-00AA006009FA}")
	flyoutDisplay   = mustGUID("{41F9D2FB-7834-4AB6-8B1B-73E74064B465}")
)

func mustGUID(value string) windows.GUID {
	g, err := windows.GUIDFromString(value)
	if err != nil {
		panic(err)
	}
	return g
}

type comInterface struct{ VTable *[4]uintptr }

func (p *comInterface) release() {
	syscall.SyscallN(p.VTable[2], uintptr(unsafe.Pointer(p)))
	runtime.KeepAlive(p)
}
func hresult(name string, hr uintptr) error {
	if int32(hr) < 0 {
		return fmt.Errorf("%s: HRESULT 0x%08X", name, uint32(hr))
	}
	return nil
}

// NativeOSD asks the Windows shell to show its ordinary volume (false) or
// brightness (true) flyout. This private interface is best effort and errors
// are returned; no simulated media keys or hardware/audio writes are used.
func (c *Controller) NativeOSD(brightness bool) error {
	c.submit.Lock()
	if c.closing.Load() {
		c.submit.Unlock()
		return ErrClosed
	}
	if !c.osdStarted {
		c.osdStarted = true
		go c.runOSD()
	}
	generation := c.generation.Load()
	j := command{done: make(chan error, 1), fn: func() error {
		if c.closing.Load() {
			return ErrClosed
		}
		if generation != c.generation.Load() {
			return errors.New("OSD request superseded by configuration")
		}
		return showShellOSD(c, brightness)
	}}
	c.osdJobs <- j
	c.submit.Unlock()
	return <-j.done
}

// Shell COM runs separately from the low-level input/window thread. Close waits
// for real completion; a COM timeout would not imply that the call was canceled.
func (c *Controller) runOSD() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(c.osdDone)
	for j := range c.osdJobs {
		j.done <- j.fn()
	}
}

func showShellOSD(c *Controller, brightness bool) error {
	if !isConsole() {
		return ErrNotConsole
	}
	hr, _, _ := ole32.NewProc("CoInitializeEx").Call(0, 0) // MTA, matching the C# background worker.
	if err := hresult("CoInitializeEx", hr); err != nil {
		return err
	}
	defer ole32.NewProc("CoUninitialize").Call()
	var provider *comInterface
	hr, _, _ = ole32.NewProc("CoCreateInstance").Call(uintptr(unsafe.Pointer(&immersiveShell)), 0, 4, uintptr(unsafe.Pointer(&serviceProvider)), uintptr(unsafe.Pointer(&provider)))
	if provider != nil {
		defer provider.release()
	}
	if err := hresult("ImmersiveShell", hr); err != nil {
		return err
	}
	if provider == nil {
		return fmt.Errorf("ImmersiveShell returned no service provider")
	}
	var flyout *comInterface
	hr, _, _ = syscall.SyscallN(provider.VTable[3], uintptr(unsafe.Pointer(provider)), uintptr(unsafe.Pointer(&flyoutDisplay)), uintptr(unsafe.Pointer(&flyoutDisplay)), uintptr(unsafe.Pointer(&flyout)))
	runtime.KeepAlive(provider)
	if flyout != nil {
		defer flyout.release()
	}
	if err := hresult("IFlyoutDisplay QueryService", hr); err != nil {
		return err
	}
	if flyout == nil {
		return fmt.Errorf("shell returned no flyout display")
	}
	if !isConsole() || c.closing.Load() {
		if c.closing.Load() {
			return ErrClosed
		}
		return ErrNotConsole
	}
	kind := uintptr(0)
	if brightness {
		kind = 3
	}
	hr, _, _ = syscall.SyscallN(flyout.VTable[3], uintptr(unsafe.Pointer(flyout)), kind, 0)
	runtime.KeepAlive(flyout)
	return hresult("IFlyoutDisplay.ShowFlyout", hr)
}
