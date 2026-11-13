package desktop

import "testing"

func TestModifiers(t *testing.T) {
	// Every combination, including AltGr (Ctrl+Alt), Windows and all buttons.
	for _, modifier := range []string{"alt", "ctrl", "shift"} {
		for bits := 0; bits < 32; bits++ {
			k := keys{bits&1 != 0, bits&2 != 0, bits&4 != 0, bits&8 != 0, bits&16 != 0}
			enhanced, valid := mode(k, modifier)
			selected := map[string]int{"ctrl": 1, "shift": 2, "alt": 4}[modifier]
			want := bits == 0 || bits == selected
			if valid != want || valid && enhanced != (bits == selected) {
				t.Fatalf("%s bits=%d: enhanced=%v valid=%v", modifier, bits, enhanced, valid)
			}
		}
	}
	if _, valid := mode(keys{}, "invalid"); valid {
		t.Fatal("unknown modifier accepted")
	}
}

func TestPhysicalEdges(t *testing.T) {
	displays := []Display{
		{Display: "left", Bounds: Rect{-1920, -120, 0, 960}, Brightness: true},
		{Display: "right", Bounds: Rect{0, 0, 2560, 1440}, Temperature: true},
	}
	o := Options{TopEnabled: true, BottomEnabled: true}
	cases := []struct {
		x, y              int32
		enhanced          bool
		name              string
		brightness, valid bool
	}{
		{-1920, -120, false, "left", true, true}, {-1, -119, false, "", false, false},
		{-1, 959, false, "left", false, true}, {-1, 960, false, "", false, false},
		{0, 0, false, "", false, false}, {0, 0, true, "right", true, true},
		{-1, -120, true, "", false, false}, {2559, 1439, true, "right", false, true},
		{2560, 1439, false, "", false, false}, {0, 1, true, "", false, false},
	}
	for _, tt := range cases {
		got, ok := hitTest(displays, tt.x, tt.y, o, tt.enhanced)
		if ok != tt.valid || ok && (got.display != tt.name || got.brightness != tt.brightness) {
			t.Errorf("%+v: %+v %v", tt, got, ok)
		}
	}
	if _, ok := hitTest(displays, -1, 959, Options{TopEnabled: true}, false); ok {
		t.Fatal("disabled bottom intercepted")
	}
	if _, ok := hitTest(displays, -1, -120, Options{BottomEnabled: true}, false); ok {
		t.Fatal("disabled top intercepted")
	}
}

func TestAccumulationAndReset(t *testing.T) {
	top := edgeTarget{"one", true}
	bottom := edgeTarget{"one", false}
	other := edgeTarget{"two", true}
	resetCases := []struct {
		name     string
		target   edgeTarget
		enhanced bool
		fg       uintptr
		at       uint64
		valid    bool
	}{
		{"monitor", other, false, 10, 100, true}, {"edge", bottom, false, 10, 100, true},
		{"enhanced", top, true, 10, 100, true}, {"foreground", top, false, 11, 100, true},
		{"idle", top, false, 10, 501, true}, {"invalid", top, false, 10, 100, false},
	}
	for _, tt := range resetCases {
		t.Run(tt.name, func(t *testing.T) {
			var a accumulator
			if n := a.add(top, true, 60, 0, false, 10); n != 0 {
				t.Fatal(n)
			}
			if n := a.add(tt.target, tt.valid, 60, tt.at, tt.enhanced, tt.fg); n != 0 {
				t.Fatalf("stale remainder produced %d", n)
			}
		})
	}
	var a accumulator
	for i, tt := range []struct {
		delta int
		at    uint64
		want  int
	}{{60, 0, 0}, {60, 500, 1}, {-30, 501, 0}, {-330, 502, -3}, {240, 503, 2}} {
		if got := a.add(top, true, tt.delta, tt.at, false, 10); got != tt.want {
			t.Fatalf("sample %d got %d want %d", i, got, tt.want)
		}
	}
}

func TestMovementResetsWithoutProlongingWheelTimeout(t *testing.T) {
	top := edgeTarget{"one", true}
	var a accumulator
	a.add(top, true, 60, 0, false, 1)
	a.observe(top, true, false, 1)
	if n := a.add(top, true, 60, 501, false, 1); n != 0 {
		t.Fatal("movement extended the wheel interval")
	}
	a.observe(top, false, false, 1)
	if n := a.add(top, true, 60, 502, false, 1); n != 0 {
		t.Fatal("leaving edge retained remainder")
	}
	a.observe(top, true, true, 1)
	if n := a.add(top, true, 60, 503, true, 1); n != 0 {
		t.Fatal("mode change on movement retained remainder")
	}
}

func TestFullscreenTolerance(t *testing.T) {
	r := Rect{-1920, -120, 0, 960}
	if !matchesFullscreen(Rect{-1922, -118, 2, 958}, r) {
		t.Fatal("two-pixel border rejected")
	}
	if matchesFullscreen(Rect{-1923, -120, 0, 960}, r) || matchesFullscreen(Rect{}, Rect{}) {
		t.Fatal("non-fullscreen accepted")
	}
}
