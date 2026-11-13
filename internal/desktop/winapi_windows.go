//go:build windows

package desktop

import (
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	u32               = windows.NewLazySystemDLL("user32.dll")
	g32               = windows.NewLazySystemDLL("gdi32.dll")
	k32               = windows.NewLazySystemDLL("kernel32.dll")
	dwm               = windows.NewLazySystemDLL("dwmapi.dll")
	peekMessage       = u32.NewProc("PeekMessageW")
	translateMessage  = u32.NewProc("TranslateMessage")
	dispatchMessage   = u32.NewProc("DispatchMessageW")
	defWindowProc     = u32.NewProc("DefWindowProcW")
	createWindow      = u32.NewProc("CreateWindowExW")
	destroyWindow     = u32.NewProc("DestroyWindow")
	setWindowPos      = u32.NewProc("SetWindowPos")
	showWindow        = u32.NewProc("ShowWindow")
	setLayered        = u32.NewProc("SetLayeredWindowAttributes")
	setTimer          = u32.NewProc("SetTimer")
	killTimer         = u32.NewProc("KillTimer")
	setHook           = u32.NewProc("SetWindowsHookExW")
	unhook            = u32.NewProc("UnhookWindowsHookEx")
	nextHook          = u32.NewProc("CallNextHookEx")
	asyncKey          = u32.NewProc("GetAsyncKeyState")
	getForeground     = u32.NewProc("GetForegroundWindow")
	getCursor         = u32.NewProc("GetCursorPos")
	getSystemMetrics  = u32.NewProc("GetSystemMetrics")
	waitMessages      = u32.NewProc("MsgWaitForMultipleObjectsEx")
	getMonitorInfo    = u32.NewProc("GetMonitorInfoW")
	enumMonitors      = u32.NewProc("EnumDisplayMonitors")
	enumWindows       = u32.NewProc("EnumWindows")
	monitorFromWindow = u32.NewProc("MonitorFromWindow")
	dwmAttribute      = dwm.NewProc("DwmGetWindowAttribute")
	getModule         = k32.NewProc("GetModuleHandleW")
	consoleSession    = k32.NewProc("WTSGetActiveConsoleSessionId")
	tickCount         = k32.NewProc("GetTickCount64")
	setDPIContext     = u32.NewProc("SetThreadDpiAwarenessContext")
	getDPI            = windows.NewLazySystemDLL("shcore.dll").NewProc("GetDpiForMonitor")
	windowOwners      sync.Map // HWND -> *Controller; only window procedure dispatch.
	threadOwners      sync.Map // thread ID -> *Controller; one shared hook trampoline.
	classOnce         sync.Once
	classErr          error
	className         = windows.StringToUTF16Ptr("MonitorsFocus.Desktop.Native.Go")
	windowCallback    = windows.NewCallback(windowProc)
	mouseCallback     = windows.NewCallback(mouseProc)
)

const (
	wmPaint         = 0x000f
	wmTimer         = 0x0113
	wmDisplayChange = 0x007e
	wmMouseMove     = 0x0200
	wmMouseWheel    = 0x020a
	exOverlay       = 0x08000000 | 0x00080000 | 0x00000080 | 0x00000020 // noactivate/layered/tool/transparent
	swpShow         = 0x0010 | 0x0040                                   // NOACTIVATE | SHOWWINDOW
	feedbackTimer   = 1
	scopeTimer      = 2
)

type point struct{ X, Y int32 }
type message struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          point
	Private        uint32
}
type mouseInput struct {
	Point                  point
	MouseData, Flags, Time uint32
	Extra                  uintptr
}
type monitorInfo struct {
	Size         uint32
	Bounds, Work Rect
	Flags        uint32
	Device       [32]uint16
}
type windowClass struct {
	Size, Style                                               uint32
	Proc                                                      uintptr
	ClassExtra, WindowExtra                                   int32
	Instance, Icon, Cursor, Background, Menu, Name, SmallIcon uintptr
}

func winError(name string, err error) error {
	if err == nil || err == windows.ERROR_SUCCESS {
		return fmt.Errorf("%s failed", name)
	}
	return fmt.Errorf("%s: %w", name, err)
}
func boolCall(p *windows.LazyProc, args ...uintptr) error {
	r, _, err := p.Call(args...)
	if r == 0 {
		return winError(p.Name, err)
	}
	return nil
}
func ticks() uint64         { r, _, _ := tickCount.Call(); return uint64(r) }
func foreground() uintptr   { r, _, _ := getForeground.Call(); return r }
func down(key uintptr) bool { r, _, _ := asyncKey.Call(key); return r&0x8000 != 0 }
func readKeys() keys {
	return keys{down(0x11), down(0x10), down(0x12), down(0x5b) || down(0x5c), down(1) || down(2) || down(4) || down(5) || down(6)}
}
func isConsole() bool {
	id, _, _ := consoleSession.Call()
	var session uint32
	if uint32(id) == ^uint32(0) || windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session) != nil || session != uint32(id) {
		return false
	}
	remote, _, _ := getSystemMetrics.Call(0x1000)
	return remote == 0
}

func registerClass() error {
	classOnce.Do(func() {
		module, _, _ := getModule.Call(0)
		brush, _, _ := g32.NewProc("GetStockObject").Call(4) // BLACK_BRUSH, system-owned.
		wc := windowClass{Proc: windowCallback, Instance: module, Background: brush, Name: uintptr(unsafe.Pointer(className))}
		wc.Size = uint32(unsafe.Sizeof(wc))
		if r, _, err := u32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
			classErr = winError("RegisterClassExW", err)
		}
	})
	return classErr
}

func makeWindow(c *Controller, control bool) (uintptr, error) {
	module, _, _ := getModule.Call(0)
	parent, ex := uintptr(0), uintptr(exOverlay)
	if control {
		ex = 0x08000080 // Hidden top-level notification window; receives broadcasts.
	}
	hwnd, _, err := createWindow.Call(ex, uintptr(unsafe.Pointer(className)), 0, 0x80000000, 0, 0, 0, 0, parent, 0, module, 0)
	if hwnd == 0 {
		return 0, winError("CreateWindowExW", err)
	}
	windowOwners.Store(hwnd, c)
	return hwnd, nil
}

func windowProc(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
	if owner, ok := windowOwners.Load(hwnd); ok {
		c := owner.(*Controller)
		switch msg {
		case wmTimer:
			if hwnd == c.window {
				if wp == feedbackTimer {
					c.hideFeedback()
				}
				if wp == scopeTimer {
					c.checkScope()
				}
				return 0
			}
		case wmDisplayChange:
			c.refreshDisplays()
		case 0x0015, 0x001a, 0x031a: // System color/settings/theme changes.
			if c.feedbackVisible {
				u32.NewProc("InvalidateRect").Call(c.feedbackWindow, 0, 0)
			}
		case 0x0084:
			return ^uintptr(0) // HTTRANSPARENT (-1).
		case 0x0021:
			return 3 // MA_NOACTIVATE.
		case 0x0010:
			return 0 // Host Close owns destruction.
		case 0x0014:
			return 1 // Paint handles the complete surface.
		case wmPaint:
			c.paint(hwnd)
			return 0
		}
	}
	r, _, _ := defWindowProc.Call(hwnd, uintptr(msg), wp, lp)
	return r
}

func mouseProc(code int32, msg uintptr, data *mouseInput) uintptr {
	if code >= 0 {
		if owner, ok := threadOwners.Load(windows.GetCurrentThreadId()); ok {
			if owner.(*Controller).enqueueMouse(msg, *data) {
				return 1
			}
		}
	}
	r, _, _ := nextHook.Call(0, uintptr(code), msg, uintptr(unsafe.Pointer(data)))
	return r
}
