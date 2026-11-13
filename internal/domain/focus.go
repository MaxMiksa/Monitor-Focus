package domain

import "slices"

// FocusState is per display. Time is a host-supplied monotonic millisecond tick.
type FocusState struct{ LeftAt *int64 }
type FocusInput struct {
	DisplayId           string
	Paused              bool
	IsPrimary           bool
	CursorOnDisplay     bool
	HasFullscreenWindow bool
	NowMillis           int64
}

// EvaluateFocus changes only overlay intent. No brightness target is involved.
// Fullscreen disappearance starts a fresh full delay on the next evaluation.
func EvaluateFocus(s Settings, state FocusState, input FocusInput) (FocusState, bool) {
	if !s.FocusEnabled || input.Paused || input.IsPrimary || input.CursorOnDisplay ||
		(s.ControlledDisplayIds != nil && !slices.Contains(s.ControlledDisplayIds, input.DisplayId)) ||
		(s.KeepSecondaryAwakeOnFullscreen && input.HasFullscreenWindow) {
		return FocusState{}, false
	}
	if state.LeftAt == nil || input.NowMillis < *state.LeftAt {
		state.LeftAt = clonePointer(&input.NowMillis)
	}
	return state, input.NowMillis-*state.LeftAt >= int64(s.FocusDelaySeconds)*1000
}
