package desktop

type keys struct{ ctrl, shift, alt, win, buttons bool }

func mode(k keys, modifier string) (enhanced, valid bool) {
	if k.win || k.buttons {
		return false, false
	}
	n := 0
	for _, down := range []bool{k.ctrl, k.shift, k.alt} {
		if down {
			n++
		}
	}
	selected := false
	switch modifier {
	case "alt":
		selected = k.alt
	case "ctrl":
		selected = k.ctrl
	case "shift":
		selected = k.shift
	default:
		return false, false
	}
	return selected, n == 0 || n == 1 && selected
}

type edgeTarget struct {
	display    string
	brightness bool
}

func hitTest(displays []Display, x, y int32, o Options, enhanced bool) (edgeTarget, bool) {
	for _, d := range displays {
		if !d.Bounds.contains(x, y) {
			continue
		}
		capable := d.Brightness
		if enhanced {
			capable = d.Temperature
		}
		if o.TopEnabled && capable && y == d.Bounds.Top {
			return edgeTarget{d.Display, true}, true
		}
		if o.BottomEnabled && y == d.Bounds.Bottom-1 {
			return edgeTarget{d.Display, false}, true
		}
		break
	}
	return edgeTarget{}, false
}

type accumulator struct {
	target     edgeTarget
	enhanced   bool
	foreground uintptr
	last       uint64
	remainder  int
	valid      bool
}

func (a *accumulator) reset() { *a = accumulator{} }

func (a *accumulator) add(t edgeTarget, valid bool, delta int, now uint64, enhanced bool, foreground uintptr) int {
	if !valid {
		a.reset()
		return 0
	}
	if !a.valid || t != a.target || enhanced != a.enhanced || foreground != a.foreground || now-a.last > 500 {
		a.remainder = 0
	}
	a.valid, a.target, a.enhanced, a.foreground, a.last = true, t, enhanced, foreground, now
	a.remainder += delta
	steps := a.remainder / 120
	a.remainder %= 120
	return steps
}

// observe resets partial detents when moving away or changing context without
// extending the 500ms interval between actual wheel inputs.
func (a *accumulator) observe(t edgeTarget, valid, enhanced bool, foreground uintptr) {
	if !valid || t != a.target || enhanced != a.enhanced || foreground != a.foreground {
		a.reset()
	}
}
