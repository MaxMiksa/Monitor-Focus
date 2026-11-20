//go:build windows

package audio

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

type validationMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	X, Y           int32
	Private        uint32
}

type validationWindow struct {
	hwnd         uintptr
	threadID     uint32
	stop         windows.Handle
	done         chan struct{}
	once         sync.Once
	err, stopErr error
}

// Uses the system STATIC class, so it needs no Go window-procedure callback or
// registered class. Creation, message pumping and destruction share one thread.
// There is one ordinary foreground request; no input injection/attachment or
// repeated attempts to reclaim focus from the user.
func newValidationWindow() (*validationWindow, error) {
	stop, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return nil, err
	}
	w := &validationWindow{stop: stop, done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(w.done)
		defer windows.CloseHandle(stop)
		w.threadID = windows.GetCurrentThreadId()
		class := windows.StringToUTF16Ptr("STATIC")
		title := windows.StringToUTF16Ptr("MyScreen audio validation — silent")
		hwnd, _, callErr := user32.NewProc("CreateWindowExW").Call(0,
			uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)), 0x00C00000,
			100, 100, 380, 90, 0, 0, 0, 0)
		if hwnd == 0 {
			ready <- fmt.Errorf("CreateWindowExW(validation): %w", callErr)
			return
		}
		w.hwnd = hwnd
		defer func() {
			if w.ownsWindow() {
				ok, _, err := user32.NewProc("DestroyWindow").Call(hwnd)
				if ok == 0 {
					w.err = errors.Join(w.err, fmt.Errorf("DestroyWindow(validation): %w", err))
				}
			}
		}()
		user32.NewProc("ShowWindow").Call(hwnd, 4) // SW_SHOWNOACTIVATE
		user32.NewProc("SetForegroundWindow").Call(hwnd)
		ready <- nil
		for {
			status, _, err := user32.NewProc("MsgWaitForMultipleObjectsEx").Call(1,
				uintptr(unsafe.Pointer(&stop)), 0xFFFFFFFF, 0x04FF, 4)
			if status == 0 {
				return
			}
			if status != 1 {
				w.err = fmt.Errorf("validation window message wait (%d): %w", status, err)
				return
			}
			var msg validationMessage
			for batch := 0; batch < 64; batch++ {
				found, _, _ := user32.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1)
				if found == 0 {
					break
				}
				if msg.Message == 0x0012 {
					return
				} // WM_QUIT
				user32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&msg)))
				user32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&msg)))
			}
		}
	}()
	if err := <-ready; err != nil {
		<-w.done
		return nil, err
	}
	return w, nil
}

func (w *validationWindow) ownsWindow() bool {
	var pid uint32
	thread, _, _ := getWindowThreadProcessID.Call(w.hwnd, uintptr(unsafe.Pointer(&pid)))
	return w.hwnd != 0 && pid == windows.GetCurrentProcessId() && uint32(thread) == w.threadID
}

func (w *validationWindow) foreground() error {
	if !w.ownsWindow() || ForegroundWindow() != w.hwnd {
		return unmeasured("owned validation window is not foreground", ErrStaleTarget)
	}
	return nil
}

func (w *validationWindow) close() error {
	w.once.Do(func() {
		select {
		case <-w.done:
			return
		default:
		}
		w.stopErr = windows.SetEvent(w.stop)
		<-w.done
	})
	return errors.Join(w.err, w.stopErr)
}
