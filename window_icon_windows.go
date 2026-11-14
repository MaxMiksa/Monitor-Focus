//go:build windows

package main

import (
	"fmt"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Windows Shell surfaces use ICO resources; SVG remains the single design source.
func nativeIconResource() uintptr {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err == nil {
		defer key.Close()
		if light, _, err := key.GetIntegerValue("SystemUsesLightTheme"); err == nil && light == 0 {
			return 32513
		}
	}
	return 32512
}

func nativeTrayIcon() []byte {
	if nativeIconResource() == 32513 {
		return whiteIcon
	}
	return icon
}

func setPanelIcon(hwnd uintptr) error {
	instance, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	user := windows.NewLazySystemDLL("user32.dll")
	handle, _, err := user.NewProc("LoadIconW").Call(instance, nativeIconResource())
	if handle == 0 {
		return fmt.Errorf("load window icon: %w", err)
	}
	// LoadIcon returns a shared handle owned by the module, never DestroyIcon it.
	send := user.NewProc("SendMessageW")
	send.Call(hwnd, 0x0080, 0, handle) // ICON_SMALL
	send.Call(hwnd, 0x0080, 1, handle) // ICON_BIG / taskbar
	return nil
}
