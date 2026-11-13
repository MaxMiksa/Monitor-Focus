//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"io"
	"runtime"
	"time"
	"unsafe"
)

var desktopValidationPlan = []validationCheck{
	{"preflight", true}, {"controller.new", true},
	{"configure.hook_enable", true}, {"configure.hook_disable", true},
	{"feedback.visible", true}, {"feedback.styles", true}, {"feedback.hwnd_reuse", true},
	{"feedback.auto_hide", true}, {"feedback.foreground", true},
	{"mask.primary_excluded", true}, {"mask.secondary_visible", true}, {"mask.styles", true},
	{"mask.foreground", true}, {"mask.cleanup", true},
	{"native_osd.volume.call", true}, {"native_osd.brightness.call", true},
	{"native_osd.volume.foreground", true}, {"native_osd.brightness.foreground", true},
	{"native_osd.visual", false}, {"input.physical_gesture", false}, {"input.click_through", false},
	{"controller.close", true}, {"controller.cleanup", true}, {"async.errors", true},
}

// ValidationCheck performs real desktop operations ONLY when explicitly called.
// The host must call during exclusive takeover, off its UI/native loop thread.
// No input is injected; the controller's gesture callback is nil and no hardware
// or audio value is written. This function is deliberately never called by tests.
// A nil error means all required automated checks ran and passed. JSONL still
// reports untested physical input, click-through and shell visuals as not_run,
// and therefore its overall summary remains incomplete until manual acceptance.
func ValidationCheck(w io.Writer) (result error) {
	if w == nil {
		return errors.New("desktop validation requires a JSONL writer")
	}
	l := newValidationLog(w, desktopValidationPlan)
	l.emit(validationRecord{Event: "start", Evidence: map[string]any{"real_desktop_operations": true, "explicit_call": true, "mask_opacity": 0.05}})
	if l.writeErr != nil {
		return l.writeErr
	} // Do not touch the desktop if logging is unavailable.
	var c *Controller
	defer func() {
		if c != nil {
			validationClose(c, l)
		}
		l.notRun("native_osd.visual", "only the real shell COM return is observable; no shell pixel/visibility assertion", false)
		l.notRun("input.physical_gesture", "no keyboard/mouse injection; real user wheel delivery still needs manual acceptance", false)
		l.notRun("input.click_through", "extended styles are read back, but actual mouse routing is not exercised", false)
		result = errors.Join(result, l.finish())
	}()
	state, err := CaptureDesktopState()
	if err == nil {
		err = validationAssert(state.Foreground != 0 && len(state.Displays) > 0, "desktop requires attached displays and a foreground window")
	}
	l.result("preflight", map[string]any{"foreground": fmt.Sprintf("0x%X", state.Foreground), "displays": state.Displays}, err)
	if err != nil || l.writeErr != nil {
		return nil
	}
	c, err = New(nil)
	l.result("controller.new", nil, err)
	if err != nil || l.writeErr != nil {
		return nil
	}
	if !validationHook(c, l) || l.writeErr != nil {
		return nil
	}
	if !validationFeedback(c, l, state) || l.writeErr != nil {
		return nil
	}
	if !validationMasks(c, l, state) || l.writeErr != nil {
		return nil
	}
	for _, brightness := range []bool{false, true} {
		name := "native_osd.volume.call"
		if brightness {
			name = "native_osd.brightness.call"
		}
		before := foreground()
		err := c.NativeOSD(brightness) // Real ImmersiveShell/IFlyoutDisplay call; never a mock.
		after := foreground()
		l.result(name, map[string]any{"brightness": brightness, "foreground_before": fmt.Sprintf("0x%X", before), "foreground_after": fmt.Sprintf("0x%X", after), "shell_visibility_verified": false}, err)
		focusName := "native_osd.volume.foreground"
		if brightness {
			focusName = "native_osd.brightness.foreground"
		}
		l.result(focusName, map[string]any{"before": fmt.Sprintf("0x%X", before), "after": fmt.Sprintf("0x%X", after)}, errors.Join(err, validationAssert(before != 0 && before == after, "foreground changed across the shell OSD call; no focus restoration attempted")))
		if l.writeErr != nil {
			return nil
		}
	}
	return nil
}

// No log IO or waits while the hook is enabled; disable immediately after reading
// the actual hook handle. Deferred Close is an additional cleanup path.
func validationHook(c *Controller, l *validationLog) bool {
	enableErr := c.Configure(Options{BottomEnabled: true, Modifier: "alt"})
	var enabled, disabled uintptr
	readEnable := c.call(func() error { enabled = c.hook; return nil })
	disableErr := c.Configure(Options{})
	readDisable := c.call(func() error { disabled = c.hook; return nil })
	l.result("configure.hook_enable", map[string]any{"hook": fmt.Sprintf("0x%X", enabled), "kind": "WH_MOUSE_LL", "physical_input_exercised": false}, errors.Join(enableErr, readEnable, validationAssert(enabled != 0, "Configure did not install a hook")))
	err := errors.Join(disableErr, readDisable, validationAssert(disabled == 0, "Configure did not remove the hook"))
	l.result("configure.hook_disable", map[string]any{"hook": fmt.Sprintf("0x%X", disabled)}, err)
	return err == nil
}

type validationWindow struct {
	HWND         string `json:"hwnd"`
	Exists       bool   `json:"exists"`
	Visible      bool   `json:"visible"`
	Cloaked      uint32 `json:"cloaked"`
	Bounds       Rect   `json:"bounds"`
	ExStyle      string `json:"ex_style"`
	NoActivate   bool   `json:"no_activate"`
	Transparent  bool   `json:"transparent"`
	ToolWindow   bool   `json:"tool_window"`
	Layered      bool   `json:"layered"`
	Alpha        uint8  `json:"alpha"`
	LayeredFlags uint32 `json:"layered_flags"`
}

func validationIsWindow(hwnd uintptr) bool {
	r, _, _ := u32.NewProc("IsWindow").Call(hwnd)
	return r != 0
}

// Must run on the controller thread to preserve physical-coordinate readback.
func validationReadWindow(hwnd uintptr) (s validationWindow, err error) {
	s.HWND = fmt.Sprintf("0x%X", hwnd)
	s.Exists = hwnd != 0 && validationIsWindow(hwnd)
	if !s.Exists {
		return s, errors.New("native HWND does not exist")
	}
	v, _, _ := u32.NewProc("IsWindowVisible").Call(hwnd)
	s.Visible = v != 0
	if err = boolCall(u32.NewProc("GetWindowRect"), hwnd, uintptr(unsafe.Pointer(&s.Bounds))); err != nil {
		return
	}
	proc := "GetWindowLongPtrW"
	if runtime.GOARCH == "386" {
		proc = "GetWindowLongW"
	}
	style, _, e := u32.NewProc(proc).Call(hwnd, ^uintptr(19)) // GWL_EXSTYLE (-20).
	if style == 0 {
		return s, winError(proc, e)
	}
	s.ExStyle = fmt.Sprintf("0x%X", style)
	s.NoActivate, s.Transparent, s.ToolWindow, s.Layered = style&0x08000000 != 0, style&0x20 != 0, style&0x80 != 0, style&0x80000 != 0
	var color uint32
	if err = boolCall(u32.NewProc("GetLayeredWindowAttributes"), hwnd, uintptr(unsafe.Pointer(&color)), uintptr(unsafe.Pointer(&s.Alpha)), uintptr(unsafe.Pointer(&s.LayeredFlags))); err != nil {
		return
	}
	hr, _, _ := dwmAttribute.Call(hwnd, 14, uintptr(unsafe.Pointer(&s.Cloaked)), unsafe.Sizeof(s.Cloaked))
	err = hresult("DwmGetWindowAttribute(CLOAKED)", hr)
	return
}
func (s validationWindow) visibleError() error {
	return validationAssert(s.Exists && s.Visible && s.Cloaked == 0, "HWND is missing, hidden or DWM-cloaked")
}
func (s validationWindow) styleError() error {
	return validationAssert(s.NoActivate && s.Transparent && s.ToolWindow && s.Layered, "native extended styles do not include NOACTIVATE/TRANSPARENT/TOOLWINDOW/LAYERED")
}

func validationFeedback(c *Controller, l *validationLog, state DesktopState) bool {
	target := state.Displays[0]
	for _, d := range state.Displays {
		if !d.Primary {
			target = d
			break
		}
	}
	before := foreground()
	f := Feedback{Label: "Monitors Focus", Value: "Native validation", Percent: 5, Display: target.Display}
	showErr := c.ShowFeedback(f)
	var first, second validationWindow
	var firstHWND, secondHWND uintptr
	readFirst := c.call(func() error {
		var err error
		firstHWND = c.feedbackWindow
		first, err = validationReadWindow(firstHWND)
		return err
	})
	if showErr != nil || readFirst != nil {
		hideErr := c.HideFeedback()
		l.result("feedback.visible", first, errors.Join(showErr, readFirst, hideErr))
		return hideErr == nil
	}
	f.Value = "Native validation · reuse"
	reuseErr := c.ShowFeedback(f)
	shownAt := time.Now() // Timer is armed before ShowFeedback returns.
	readSecond := c.call(func() error {
		var err error
		secondHWND = c.feedbackWindow
		second, err = validationReadWindow(secondHWND)
		return err
	})
	var lastVisible, firstHidden time.Duration
	var observeErr error
	if reuseErr == nil && readSecond == nil && second.Visible {
		for {
			var visible bool
			observeErr = c.call(func() error {
				if c.feedbackWindow != secondHWND || !validationIsWindow(secondHWND) {
					return errors.New("feedback HWND changed/disappeared during timer observation")
				}
				r, _, _ := u32.NewProc("IsWindowVisible").Call(secondHWND)
				visible = r != 0
				return nil
			})
			elapsed := time.Since(shownAt)
			if observeErr != nil {
				break
			}
			if !visible {
				firstHidden = elapsed
				break
			}
			lastVisible = elapsed
			if elapsed >= 2500*time.Millisecond {
				observeErr = errors.New("feedback remained visible after 2500ms")
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
	} else {
		observeErr = errors.Join(reuseErr, readSecond, errors.New("feedback reuse was not visibly established"))
	}
	// Explicit cleanup follows timer observation, never substitutes for it.
	hideErr := c.HideFeedback()
	after := foreground()
	l.result("feedback.visible", first, first.visibleError())
	l.result("feedback.styles", []validationWindow{first, second}, errors.Join(first.styleError(), readSecond, second.styleError()))
	l.result("feedback.hwnd_reuse", map[string]any{"first": first, "second": second}, errors.Join(reuseErr, readSecond, second.visibleError(), validationAssert(firstHWND != 0 && firstHWND == secondHWND, "feedback HWND was not reused")))
	l.result("feedback.auto_hide", map[string]any{"timer_ms": 1500, "last_visible_ms": float64(lastVisible) / float64(time.Millisecond), "first_hidden_ms": float64(firstHidden) / float64(time.Millisecond), "poll_ms": 25, "accepted_transition_ms": []int{1400, 2500}, "max_observation_gap_ms": 150}, errors.Join(observeErr, validationHideTiming(lastVisible, firstHidden), hideErr))
	l.result("feedback.foreground", map[string]any{"before": fmt.Sprintf("0x%X", before), "after": fmt.Sprintf("0x%X", after)}, errors.Join(reuseErr, readSecond, hideErr, validationAssert(before != 0 && before == after, "foreground changed while showing/reusing/hiding feedback; no focus restoration attempted")))
	return hideErr == nil
}

func validationMasks(c *Controller, l *validationLog, state DesktopState) bool {
	var primary, secondary *Display
	for i := range state.Displays {
		d := &state.Displays[i]
		if d.Primary {
			primary = d
		} else if secondary == nil {
			secondary = d
		}
	}
	if primary == nil {
		l.notRun("mask.primary_excluded", "no primary display was identified", true)
	} else {
		rejectErr := c.SetMasks([]Mask{{Display: primary.Display, Bounds: primary.Bounds, Opacity: 0.05}})
		var count int
		readErr := c.call(func() error { count = len(c.masks); return nil })
		clearErr := c.SetMasks(nil) // Also clear an unexpected mask before logging.
		// Distinguish deliberate primary rejection from unrelated API/session errors.
		expected := rejectErr != nil && rejectErr.Error() == "mask must match an attached secondary display"
		l.result("mask.primary_excluded", map[string]any{"display": primary.Display, "mask_count": count, "rejection": fmt.Sprint(rejectErr)}, errors.Join(readErr, clearErr, validationAssert(expected && count == 0, "primary exclusion was not verified")))
		if clearErr != nil {
			return false
		}
	}
	if l.writeErr != nil {
		return true
	}
	if secondary == nil {
		for _, name := range []string{"mask.secondary_visible", "mask.styles", "mask.foreground", "mask.cleanup"} {
			l.notRun(name, "no attached secondary display; primary is never used as a substitute", true)
		}
		return true
	}
	before := foreground()
	showErr := c.SetMasks([]Mask{{Display: secondary.Display, Bounds: secondary.Bounds, Opacity: 0.05}})
	var hwnd uintptr
	var sample validationWindow
	readErr := c.call(func() error {
		var err error
		hwnd = c.masks[secondary.Display]
		sample, err = validationReadWindow(hwnd)
		return err
	})
	// Brief low-opacity dwell only; never simulate a click or wheel event.
	if showErr == nil && readErr == nil {
		time.Sleep(120 * time.Millisecond)
	}
	clearErr := c.SetMasks(nil) // Always clear before any possibly slow JSONL write.
	after := foreground()
	var count int
	readClear := c.call(func() error { count = len(c.masks); return nil })
	destroyed := hwnd != 0 && !validationIsWindow(hwnd)
	l.result("mask.secondary_visible", sample, errors.Join(showErr, readErr, sample.visibleError(), validationAssert(sample.Bounds == secondary.Bounds && sample.Alpha == 13 && sample.LayeredFlags&2 != 0, "secondary mask bounds/0.05 alpha readback differs")))
	l.result("mask.styles", sample, errors.Join(showErr, readErr, sample.styleError()))
	l.result("mask.foreground", map[string]any{"before": fmt.Sprintf("0x%X", before), "after": fmt.Sprintf("0x%X", after)}, validationAssert(showErr == nil && readErr == nil && before != 0 && before == after, "foreground preservation during secondary mask was not verified"))
	l.result("mask.cleanup", map[string]any{"hwnd": fmt.Sprintf("0x%X", hwnd), "destroyed": destroyed, "remaining_masks": count}, errors.Join(clearErr, readClear, validationAssert(destroyed && count == 0, "secondary mask HWND was not created then destroyed")))
	return clearErr == nil && readClear == nil && count == 0
}

func validationClose(c *Controller, l *validationLog) {
	known := map[string]uintptr{}
	snapshotErr := c.call(func() error {
		known["notification"] = c.window
		if c.feedbackWindow != 0 {
			known["feedback"] = c.feedbackWindow
		}
		for name, h := range c.masks {
			known["mask:"+name] = h
		}
		return nil
	})
	closeErr := c.Close() // Disables/unhooks/destroys/drains even after failed logging.
	l.result("controller.close", nil, closeErr)
	evidence := map[string]any{}
	cleanupErr := snapshotErr
	for name, h := range known {
		exists := validationIsWindow(h)
		_, owned := windowOwners.Load(h)
		evidence[name] = map[string]any{"hwnd": fmt.Sprintf("0x%X", h), "still_exists": exists, "owner_retained": owned}
		cleanupErr = errors.Join(cleanupErr, validationAssert(!exists && !owned, "native HWND or owner retained after Close: "+name))
	}
	cleanupErr = errors.Join(cleanupErr, validationAssert(len(known) > 0 && c.pending.Load() == 0, "Close cleanup snapshot missing or pending delivery remains"))
	l.result("controller.cleanup", evidence, cleanupErr)
	var async []error
	for err := range c.Errors() {
		async = append(async, err)
	}
	l.result("async.errors", map[string]any{"count": len(async)}, errors.Join(async...))
}
