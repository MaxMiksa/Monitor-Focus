// Package audio controls Windows CoreAudio without changing endpoint/session mute.
package audio

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// State describes the endpoint, or the eligible sessions of one foreground app.
// For apps Percent is the highest session scalar and Muted means all are muted.
type State struct {
	Percent   float64
	Muted     bool
	Name      string
	ProcessID uint32
	Sessions  int
}

var (
	ErrClosed        = errors.New("audio controller is closed")
	ErrNoTarget      = errors.New("no valid foreground audio target")
	ErrStaleTarget   = errors.New("foreground audio target changed or expired")
	ErrNoSessions    = errors.New("foreground application has no unambiguous audio sessions")
	ErrNotConsole    = errors.New("audio control requires the physical console session")
	ErrDeviceChanged = errors.New("default audio endpoint changed during the operation")
	ErrPartialWrite  = errors.New("audio write failed; some volume changes may already have applied")
)

func validatePercent(percent float64) error {
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 || percent > 100 {
		return fmt.Errorf("audio percentage must be finite and between 0 and 100: %v", percent)
	}
	return nil
}

type process struct {
	id, parent, session uint32
	image               string
	started             uint64
}

// belongsTo groups only the verified executable's family, never unrelated
// instances with the same executable name or a separately launched application.
func belongsTo(candidate, foreground uint32, processes map[uint32]process) bool {
	root, ok := processes[foreground]
	if !ok {
		return false
	}
	member, ok := processes[candidate]
	if !ok {
		return false
	}
	visited := map[uint32]bool{}
	for !visited[root.id] {
		visited[root.id] = true
		parent, exists := processes[root.parent]
		if !exists || !sameExecutable(root, parent) || parent.started > root.started {
			break
		}
		if visited[parent.id] {
			return false
		}
		root = parent
	}
	if !sameExecutable(member, root) {
		return false
	}
	clear(visited)
	for !visited[member.id] {
		visited[member.id] = true
		if member.id == root.id {
			return true
		}
		parent, exists := processes[member.parent]
		if !exists || !sameExecutable(member, parent) || parent.started > member.started {
			return false
		}
		member = parent
	}
	return false
}

func sameExecutable(a, b process) bool {
	return a.session == b.session && a.image != "" && strings.EqualFold(a.image, b.image)
}

type mixerSession interface {
	validate() error
	read() (percent float64, muted bool, err error)
	set(percent float64) error
}

// mix preflights the whole set, then checks identity immediately before every
// write. It never rescales sessions relative to their individual previous values.
func mix(sessions []mixerSession, percent *float64, guard func() error) (State, error) {
	if percent != nil {
		if err := validatePercent(*percent); err != nil {
			return State{}, err
		}
	}
	if len(sessions) == 0 {
		return State{}, ErrNoSessions
	}
	state := State{Muted: true, Sessions: len(sessions)}
	for _, s := range sessions {
		if err := guard(); err != nil {
			return State{}, err
		}
		if err := s.validate(); err != nil {
			return State{}, err
		}
		value, muted, err := s.read()
		if err != nil {
			return State{}, err
		}
		if err := validatePercent(value); err != nil {
			return State{}, err
		}
		state.Percent = math.Max(state.Percent, value)
		state.Muted = state.Muted && muted
	}
	if percent == nil {
		return state, guard()
	}
	state.Percent, state.Muted = 0, true
	for i, s := range sessions {
		if err := guard(); err != nil {
			if i > 0 {
				err = errors.Join(ErrPartialWrite, err)
			}
			return state, err
		}
		if err := s.validate(); err != nil {
			if i > 0 {
				err = errors.Join(ErrPartialWrite, err)
			}
			return state, err
		}
		if err := s.set(*percent); err != nil {
			return state, errors.Join(ErrPartialWrite, err)
		}
		value, muted, err := s.read()
		if err != nil {
			return state, errors.Join(ErrPartialWrite, err)
		}
		if math.IsNaN(value) || math.Abs(value-*percent) > 0.5 {
			return state, errors.Join(ErrPartialWrite, errors.New("session volume readback did not match requested percentage"))
		}
		state.Percent = math.Max(state.Percent, value)
		state.Muted = state.Muted && muted
	}
	if err := guard(); err != nil {
		return state, errors.Join(ErrPartialWrite, err)
	}
	return state, nil
}
