// Package desktop adapts native Windows input and feedback without changing
// hardware, audio or product settings. All rectangles use physical desktop pixels.
package desktop

import "errors"

const (
	PercentPerStep = 2
	KelvinPerStep  = 100
)

var (
	ErrClosed     = errors.New("desktop controller closed")
	ErrNotConsole = errors.New("desktop operation requires the physical console session")
)

type Rect struct{ Left, Top, Right, Bottom int32 }

func (r Rect) contains(x, y int32) bool {
	return x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom
}
func (r Rect) valid() bool { return r.Right > r.Left && r.Bottom > r.Top }

// Display uses the GDI device name (e.g. \\.\DISPLAY1). Bounds and WorkArea are
// captured from Windows; Configure uses only Display/Brightness/Temperature.
type Display struct {
	Display                 string
	Bounds, WorkArea        Rect
	Primary                 bool
	Brightness, Temperature bool
	DPI                     uint32
}

type Options struct {
	TopEnabled, BottomEnabled bool
	Modifier                  string    // "alt" (also the empty default), "ctrl", or "shift".
	Displays                  []Display // Explicit top-edge capabilities. Bottom works on every display.
}

// Steps are signed wheel detents, not percentages: ordinary brightness/volume
// and enhanced application volume use Steps*2 percent; enhanced top uses Steps*100 K.
// The host owns clamping, target identity validation and all writes.
type Gesture struct {
	Display              string
	Brightness, Enhanced bool
	Steps                int
	Foreground           uintptr
	X, Y                 int32
}

type Feedback struct {
	Label, Value   string  // Value overrides the automatically formatted numeric value.
	Percent        float64 // 0..100 (not 0..1).
	Kelvin         int     // >0 selects the temperature visual, 2700..6500 K progress.
	Muted, Pending bool
	HideProgress   bool   // A status notice has no numeric volume or progress track.
	Display        string // Optional GDI name; otherwise the display containing X,Y.
	X, Y           int32
}

type Mask struct {
	Display string
	Bounds  Rect    // Must exactly match a current secondary display.
	Opacity float64 // 0..1; zero removes the mask.
}

type DesktopState struct {
	X, Y       int32
	Foreground uintptr
	Displays   []Display
	Occupied   map[string]bool // Secondary GDI names with fullscreen/maximized windows.
}
