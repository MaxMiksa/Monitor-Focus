package main

import (
	"errors"
	"github.com/wailsapp/wails/v3/pkg/w32"
	"golang.org/x/sys/windows"
	"unsafe"
)

const trayWindowClass = "MyScreen.Host"

// Wails 3.1.0 creates our single tray (UID 1) on a message-only window.
// Modify only an existing icon owned by this process; never create another icon.
func showTrayWarning(message string) error {
	u := windows.NewLazySystemDLL("user32.dll")
	class, _ := windows.UTF16PtrFromString(trayWindowClass)
	var previous uintptr
	for i := 0; i < 16; i++ {
		hwnd, _, _ := u.NewProc("FindWindowExW").Call(^uintptr(2), previous, uintptr(unsafe.Pointer(class)), 0)
		if hwnd == 0 {
			break
		}
		previous = hwnd
		var pid uint32
		u.NewProc("GetWindowThreadProcessId").Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid != windows.GetCurrentProcessId() {
			continue
		}
		data := w32.NOTIFYICONDATA{HWnd: w32.HWND(hwnd), UID: 1, UFlags: w32.NIF_INFO, UVersion: 3000, DwInfoFlags: w32.NIIF_WARNING | 0x10}
		data.CbSize = uint32(unsafe.Sizeof(data))
		title, _ := windows.UTF16FromString(productName)
		body, _ := windows.UTF16FromString(message)
		copy(data.SzInfoTitle[:], title)
		copy(data.SzInfo[:], body)
		if w32.ShellNotifyIcon(w32.NIM_MODIFY, &data) {
			return nil
		}
	}
	return errors.New("existing " + productName + " tray icon was not available for notification")
}
