//go:build windows

package main

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Keep the WebView client area at 16:9. WM_SIZING modifies the physical window
// rect supplied by Windows, so this also works during a live border drag.
const (
	wmSizing        = 0x0214
	panelClientWide = 1168
	panelClientHigh = 657
	minClientWide   = 1024
	maxClientWide   = 2560
	wmszTop         = 3
	wmszTopLeft     = 4
	wmszTopRight    = 5
	wmszBottom      = 6
	wmszBottomLeft  = 7
	wmszBottomRight = 8
	swpNoMove       = 0x0002
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
)

var (
	kernel32Ratio   = windows.NewLazySystemDLL("kernel32.dll")
	rtlMoveMemory   = kernel32Ratio.NewProc("RtlMoveMemory")
	user32Ratio     = windows.NewLazySystemDLL("user32.dll")
	getWindowRect   = user32Ratio.NewProc("GetWindowRect")
	getClientRect   = user32Ratio.NewProc("GetClientRect")
	getDpiForWindow = user32Ratio.NewProc("GetDpiForWindow")
	setWindowPos    = user32Ratio.NewProc("SetWindowPos")
	isZoomed        = user32Ratio.NewProc("IsZoomed")
	showWindow      = user32Ratio.NewProc("ShowWindow")
	ratioWindowMu   sync.Mutex
	ratioWindowHWND uintptr
)

type ratioRect struct{ Left, Top, Right, Bottom int32 }

// Copy lParam's RECT into Go-owned memory instead of casting a uintptr. The
// source belongs to Windows and is valid only for the duration of WM_SIZING.
func sizingRect(lParam uintptr) ratioRect {
	var rect ratioRect
	rtlMoveMemory.Call(uintptr(unsafe.Pointer(&rect)), lParam, unsafe.Sizeof(rect))
	return rect
}

func writeSizingRect(lParam uintptr, rect *ratioRect) {
	rtlMoveMemory.Call(lParam, uintptr(unsafe.Pointer(rect)), unsafe.Sizeof(*rect))
}

func setFixedRatioWindow(hwnd uintptr) {
	ratioWindowMu.Lock()
	ratioWindowHWND = hwnd
	ratioWindowMu.Unlock()
}

func clearFixedRatioWindow(hwnd uintptr) {
	ratioWindowMu.Lock()
	if ratioWindowHWND == hwnd {
		ratioWindowHWND = 0
	}
	ratioWindowMu.Unlock()
}

func isFixedRatioWindow(hwnd uintptr) bool {
	ratioWindowMu.Lock()
	match := hwnd != 0 && hwnd == ratioWindowHWND
	ratioWindowMu.Unlock()
	return match
}

func restoreNormalWindow(hwnd uintptr) {
	zoomed, _, _ := isZoomed.Call(hwnd)
	if zoomed != 0 {
		showWindow.Call(hwnd, 9) // SW_RESTORE
	}
}

func windowFrame(hwnd uintptr) (int, int) {
	var outer, client ratioRect
	if ok, _, _ := getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&outer))); ok == 0 {
		return 0, 0
	}
	if ok, _, _ := getClientRect.Call(hwnd, uintptr(unsafe.Pointer(&client))); ok == 0 {
		return 0, 0
	}
	frameX := int(outer.Right - outer.Left - client.Right)
	frameY := int(outer.Bottom - outer.Top - client.Bottom)
	if frameX < 0 || frameY < 0 {
		return 0, 0
	}
	return frameX, frameY
}

func windowDPI(hwnd uintptr) uintptr {
	dpi, _, _ := getDpiForWindow.Call(hwnd)
	if dpi == 0 {
		return 96
	}
	return dpi
}

func windowMetrics(hwnd uintptr, frameX, frameY int) (dpi uintptr, minWidth, maxWidth int64, frameXPixels, clientWidth, clientHeight int64) {
	dpi = windowDPI(hwnd)
	frameXPixels = int64(frameX)
	minWidth = int64(minClientWide)*int64(dpi)/96 + frameXPixels
	maxWidth = int64(maxClientWide)*int64(dpi)/96 + frameXPixels
	var outer ratioRect
	if ok, _, _ := getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&outer))); ok == 0 {
		return
	}
	clientWidth = int64(outer.Right-outer.Left) - frameXPixels
	clientHeight = int64(outer.Bottom-outer.Top) - int64(frameY)
	return
}

// Wails sizes are DIP; WM_SIZING receives physical pixels. Measure the current
// non-client frame once and keep the client dimensions proportional to 16:9.
func fixedRatioSizing(hwnd uintptr, wParam, lParam uintptr) (uintptr, bool) {
	if !isFixedRatioWindow(hwnd) {
		return 0, false
	}
	restoreNormalWindow(hwnd)
	frameX, frameY := windowFrame(hwnd)
	_, minWidth, maxWidth, _, _, _ := windowMetrics(hwnd, frameX, frameY)
	rect := constrainSizingRect(sizingRect(lParam), wParam, frameX, frameY, minWidth, maxWidth)
	writeSizingRect(lParam, &rect)
	return 1, true
}

func absRatioError(width, height int64) int64 {
	difference := width*9 - height*16
	if difference < 0 {
		return -difference
	}
	return difference
}

func constrainSizingRect(rect ratioRect, edge uintptr, frameX, frameY int, minWidth, maxWidth int64) ratioRect {
	frameXPixels := int64(frameX)
	width := int64(rect.Right - rect.Left)
	height := int64(rect.Bottom - rect.Top)
	if edge == wmszTop || edge == wmszBottom {
		width = (height-int64(frameY))*16/9 + frameXPixels
	}
	if width < minWidth {
		width = minWidth
	}
	if width > maxWidth {
		width = maxWidth
	}
	finalClientWidth := width - frameXPixels
	if finalClientWidth < 1 {
		finalClientWidth = 1
	}
	clientHeight := (finalClientWidth*9 + 8) / 16
	height = clientHeight + int64(frameY)
	switch edge {
	case 1, 4, 7: // left / top-left / bottom-left
		rect.Left = rect.Right - int32(width)
	case 2, 5, 8: // right / top-right / bottom-right
		rect.Right = rect.Left + int32(width)
	default:
		rect.Right = rect.Left + int32(width)
	}
	switch edge {
	case wmszTop, wmszTopLeft, wmszTopRight:
		rect.Top = rect.Bottom - int32(height)
	case wmszBottom, wmszBottomLeft, wmszBottomRight:
		rect.Bottom = rect.Top + int32(height)
	default:
		rect.Bottom = rect.Top + int32(height)
	}
	return rect
}

func fixedRatioInterceptor(hwnd uintptr, msg uint32, wParam, lParam uintptr) (uintptr, bool) {
	if msg == wmSizing {
		return fixedRatioSizing(hwnd, wParam, lParam)
	}
	return 0, false
}

// Frame dimensions may change after the window is created or its DPI changes.
// SetWindowPos with SWP_NOMOVE keeps the client area precisely 16:9.
func applyFixedRatioSize(hwnd uintptr, clientWidthDIP, clientHeightDIP int) {
	frameX, frameY := windowFrame(hwnd)
	dpi, _, _, frameXPixels, _, _ := windowMetrics(hwnd, frameX, frameY)
	outerWidth := int64(clientWidthDIP)*int64(dpi)/96 + frameXPixels
	outerHeight := int64(clientHeightDIP)*int64(dpi)/96 + int64(frameY)
	setWindowPos.Call(hwnd, 0, 0, 0, uintptr(outerWidth), uintptr(outerHeight), swpNoMove|swpNoZOrder|swpNoActivate)
}
