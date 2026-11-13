//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type paintStruct struct {
	DC              uintptr
	Erase           int32
	Bounds          Rect
	Restore, Update int32
	Reserved        [32]byte
}

func rgb(r, g, b uint32) uintptr { return uintptr(r | g<<8 | b<<16) }

// ShowFeedback lazily creates one reusable, click-through, nonactivating native
// window and rearms its 1500ms hide timer. It never changes a target value.
func (c *Controller) ShowFeedback(f Feedback) error {
	if math.IsNaN(f.Percent) || math.IsInf(f.Percent, 0) || f.Percent < 0 || f.Percent > 100 {
		return errors.New("feedback percent must be 0..100")
	}
	if f.Kelvin != 0 && (f.Kelvin < 2700 || f.Kelvin > 6500) {
		return errors.New("feedback kelvin must be 2700..6500 or zero")
	}
	if strings.ContainsRune(f.Label, '\x00') || strings.ContainsRune(f.Value, '\x00') {
		return errors.New("feedback text contains NUL")
	}
	return c.call(func() error {
		if !isConsole() {
			c.hideFeedback()
			return ErrNotConsole
		}
		displays, err := captureDisplays()
		if err != nil {
			c.hideFeedback()
			return err
		}
		var target *Display
		for i := range displays {
			d := &displays[i]
			if f.Display != "" && strings.EqualFold(d.Display, f.Display) || f.Display == "" && d.Bounds.contains(f.X, f.Y) {
				target = d
				break
			}
		}
		if target == nil {
			c.hideFeedback()
			return errors.New("feedback display is not attached")
		}
		c.acceptDisplays(withCapabilities(displays, c.options))
		if c.feedbackWindow == 0 {
			c.feedbackWindow, err = makeWindow(c, false)
			if err != nil {
				return err
			}
		}
		c.feedback, c.feedbackScale = f, float64(target.DPI)/96
		scale := func(v float64) int32 { return int32(math.Round(v * c.feedbackScale)) }
		w, h := scale(336), scale(76)
		work := target.WorkArea
		if !work.valid() {
			work = target.Bounds
		}
		if w > work.Right-work.Left {
			w = work.Right - work.Left
		}
		if h > work.Bottom-work.Top {
			h = work.Bottom - work.Top
		}
		x, y := work.Left+(work.Right-work.Left-w)/2, work.Bottom-h-scale(24)
		if y < work.Top {
			y = work.Top
		}
		if err = boolCall(setLayered, c.feedbackWindow, 0, 254, 2); err != nil {
			c.hideFeedback()
			return err
		}
		region, _, e := g32.NewProc("CreateRoundRectRgn").Call(0, 0, uintptr(w+1), uintptr(h+1), uintptr(scale(24)), uintptr(scale(24)))
		if region == 0 {
			c.hideFeedback()
			return winError("CreateRoundRectRgn", e)
		}
		if err = boolCall(u32.NewProc("SetWindowRgn"), c.feedbackWindow, region, 1); err != nil {
			g32.NewProc("DeleteObject").Call(region)
			c.hideFeedback()
			return err
		} // On success Windows owns the region.
		if err = boolCall(setWindowPos, c.feedbackWindow, ^uintptr(0), uintptr(x), uintptr(y), uintptr(w), uintptr(h), swpShow); err != nil {
			c.hideFeedback()
			return err
		}
		u32.NewProc("InvalidateRect").Call(c.feedbackWindow, 0, 0)
		c.feedbackVisible = true
		if r, _, e := setTimer.Call(c.window, feedbackTimer, 1500, 0); r == 0 {
			c.hideFeedback()
			return winError("SetTimer(feedback)", e)
		}
		if err := c.updateScopeTimer(); err != nil {
			c.hideFeedback()
			return err
		}
		return nil
	})
}

// HideFeedback also lets the host dismiss a failed asynchronous adjustment.
func (c *Controller) HideFeedback() error {
	return c.call(func() error { c.hideFeedback(); return nil })
}
func (c *Controller) hideFeedback() {
	if c.window != 0 {
		killTimer.Call(c.window, feedbackTimer)
	}
	if c.feedbackWindow != 0 {
		showWindow.Call(c.feedbackWindow, 0)
	}
	c.feedback = Feedback{}
	c.feedbackVisible = false
	c.stopScopeIfIdle()
}

func (c *Controller) paint(hwnd uintptr) {
	var ps paintStruct
	dc, _, err := u32.NewProc("BeginPaint").Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	if dc == 0 {
		c.report(winError("BeginPaint", err))
		return
	}
	defer u32.NewProc("EndPaint").Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var rect Rect
	u32.NewProc("GetClientRect").Call(hwnd, uintptr(unsafe.Pointer(&rect)))
	if hwnd != c.feedbackWindow {
		black, _, _ := g32.NewProc("GetStockObject").Call(4)
		u32.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&rect)), black)
		return
	}
	// Buffer only during WM_PAINT; there is no render loop or bitmap cache.
	buffer, _, _ := g32.NewProc("CreateCompatibleDC").Call(dc)
	bitmap, _, _ := g32.NewProc("CreateCompatibleBitmap").Call(dc, uintptr(rect.Right), uintptr(rect.Bottom))
	if buffer == 0 || bitmap == 0 {
		if buffer != 0 {
			g32.NewProc("DeleteDC").Call(buffer)
		}
		if bitmap != 0 {
			g32.NewProc("DeleteObject").Call(bitmap)
		}
		c.hideFeedback()
		c.report(errors.New("feedback drawing buffer unavailable"))
		return
	}
	old, _, _ := g32.NewProc("SelectObject").Call(buffer, bitmap)
	c.paintFeedback(buffer, rect)
	g32.NewProc("BitBlt").Call(dc, 0, 0, uintptr(rect.Right), uintptr(rect.Bottom), buffer, 0, 0, 0x00cc0020)
	g32.NewProc("SelectObject").Call(buffer, old)
	g32.NewProc("DeleteObject").Call(bitmap)
	g32.NewProc("DeleteDC").Call(buffer)
}

func palette() (background, text, rail, accent uintptr, highContrast bool) {
	background, text, rail, accent = rgb(41, 41, 41), rgb(255, 255, 255), rgb(145, 145, 145), rgb(70, 190, 240)
	if key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE); err == nil {
		light, _, err := key.GetIntegerValue("AppsUseLightTheme")
		key.Close()
		if err == nil && light != 0 {
			background, text, rail = rgb(246, 246, 246), rgb(24, 24, 24), rgb(180, 180, 180)
		}
	}
	var hc struct {
		Size, Flags uint32
		Scheme      uintptr
	}
	hc.Size = uint32(unsafe.Sizeof(hc))
	r, _, _ := u32.NewProc("SystemParametersInfoW").Call(0x0042, uintptr(hc.Size), uintptr(unsafe.Pointer(&hc)), 0)
	if r != 0 && hc.Flags&1 != 0 {
		highContrast = true
		background, _, _ = u32.NewProc("GetSysColor").Call(5)
		text, _, _ = u32.NewProc("GetSysColor").Call(8)
		rail, _, _ = u32.NewProc("GetSysColor").Call(16)
		accent, _, _ = u32.NewProc("GetSysColor").Call(13)
	}
	return
}
func fill(dc uintptr, rect Rect, color uintptr) {
	brush, _, _ := g32.NewProc("GetStockObject").Call(18) // DC_BRUSH.
	g32.NewProc("SetDCBrushColor").Call(dc, color)
	u32.NewProc("FillRect").Call(dc, uintptr(unsafe.Pointer(&rect)), brush)
}

func (c *Controller) paintFeedback(dc uintptr, rect Rect) {
	background, text, rail, accent, hc := palette()
	fill(dc, rect, background)
	s := func(v float64) int32 { return int32(math.Round(v * c.feedbackScale)) }
	fontName := windows.StringToUTF16Ptr("Segoe UI")
	font, _, _ := g32.NewProc("CreateFontW").Call(uintptr(-s(14)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(fontName)))
	if font == 0 {
		c.report(errors.New("feedback font unavailable"))
		return
	}
	oldFont, _, _ := g32.NewProc("SelectObject").Call(dc, font)
	defer func() { g32.NewProc("SelectObject").Call(dc, oldFont); g32.NewProc("DeleteObject").Call(font) }()
	g32.NewProc("SetBkMode").Call(dc, 1)
	g32.NewProc("SetTextColor").Call(dc, text)
	drawText := func(value string, r Rect, flags uintptr) {
		p, _ := windows.UTF16PtrFromString(value)
		u32.NewProc("DrawTextW").Call(dc, uintptr(unsafe.Pointer(p)), ^uintptr(0), uintptr(unsafe.Pointer(&r)), flags|0x0020|0x0004|0x8000|0x0800) // SINGLELINE, VCENTER, END_ELLIPSIS, NOPREFIX.
	}
	f := c.feedback
	icon := "♪"
	if f.Kelvin > 0 {
		icon = "☀"
	} else if f.Muted {
		icon = "×"
	}
	drawText(icon, Rect{s(17), s(15), s(38), s(39)}, 0)
	drawText(f.Label, Rect{s(44), s(15), s(186), s(39)}, 0)
	value := f.Value
	if f.Pending {
		value = "…"
	} else if value == "" {
		if f.Kelvin > 0 {
			value = fmt.Sprintf("%d K", f.Kelvin)
		} else {
			value = fmt.Sprintf("%.0f%%", f.Percent)
			if f.Muted {
				value += " · Muted"
			}
		}
	}
	drawText(value, Rect{s(184), s(15), s(318), s(39)}, 0x0002)
	if f.HideProgress {
		return
	}
	track := Rect{s(44), s(51), s(318), s(56)}
	fill(dc, track, rail)
	progress := f.Percent / 100
	if f.Kelvin > 0 {
		progress = float64(f.Kelvin-2700) / 3800
	}
	if f.Pending {
		return
	}
	end := track.Left + int32(math.Round(float64(track.Right-track.Left)*progress))
	if f.Kelvin == 0 || hc {
		fill(dc, Rect{track.Left, track.Top, end, track.Bottom}, accent)
		return
	}
	for x := track.Left; x < end; x++ {
		t := float64(x-track.Left) / float64(track.Right-track.Left)
		color := rgb(uint32(245+(70-245)*t), uint32(159+(190-159)*t), uint32(83+(240-83)*t))
		fill(dc, Rect{x, track.Top, x + 1, track.Bottom}, color)
	}
}
