package audio

import (
	"errors"
	"math"
	"testing"
)

func TestProcessFamily(t *testing.T) {
	const browser = `C:\Apps\Browser\browser.exe`
	processes := map[uint32]process{
		1:  {1, 0, 2, browser, 100},
		2:  {2, 1, 2, browser, 110},
		3:  {3, 1, 2, `c:\apps\browser\BROWSER.exe`, 120},
		4:  {4, 0, 2, browser, 105}, // Unrelated instance.
		5:  {5, 1, 2, `C:\Apps\player.exe`, 120},
		6:  {6, 1, 3, browser, 120}, // Other Windows session.
		7:  {7, 1, 2, browser, 90},  // Parent PID reused after this child began.
		8:  {8, 0, 2, `C:\Other\browser.exe`, 120},
		9:  {9, 5, 2, browser, 130}, // Different executable in the ancestry.
		10: {10, 11, 2, browser, 200},
		11: {11, 10, 2, browser, 200}, // Corrupt cyclic snapshot.
	}
	for _, tc := range []struct {
		name                  string
		candidate, foreground uint32
		want                  bool
	}{
		{"self", 2, 2, true}, {"parent", 1, 2, true}, {"sibling audio child", 3, 2, true},
		{"unrelated instance", 4, 2, false}, {"launched player", 5, 2, false},
		{"other session", 6, 2, false}, {"reused parent", 7, 2, false},
		{"other binary", 8, 2, false}, {"broken ancestry", 9, 2, false},
		{"missing candidate", 99, 2, false}, {"missing foreground", 2, 99, false},
		{"cycle", 11, 10, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := belongsTo(tc.candidate, tc.foreground, processes); got != tc.want {
				t.Fatalf("belongsTo = %v, want %v", got, tc.want)
			}
		})
	}
}

type fakeSession struct {
	percent                     float64
	muted                       bool
	writes                      int
	readErr, writeErr, validErr error
	afterWrite                  func()
	ignoreWrite                 bool
}

func (s *fakeSession) validate() error              { return s.validErr }
func (s *fakeSession) read() (float64, bool, error) { return s.percent, s.muted, s.readErr }
func (s *fakeSession) set(percent float64) error {
	s.writes++
	if !s.ignoreWrite {
		s.percent = percent
	}
	if s.afterWrite != nil {
		s.afterWrite()
	}
	return s.writeErr
}
func allow() error { return nil }

func TestMixerUnifiedPercentageAndMute(t *testing.T) {
	a := &fakeSession{percent: 22, muted: true}
	b := &fakeSession{percent: 83}
	sessions := []mixerSession{a, b}
	state, err := mix(sessions, nil, allow)
	if err != nil || state.Percent != 83 || state.Muted || state.Sessions != 2 || a.writes+b.writes != 0 {
		t.Fatalf("read: %+v, %v", state, err)
	}
	value := 51.5
	state, err = mix(sessions, &value, allow)
	if err != nil || state.Percent != value || state.Muted || a.percent != value || b.percent != value || !a.muted || b.muted || a.writes != 1 || b.writes != 1 {
		t.Fatalf("unified write: %+v, %v; %+v %+v", state, err, a, b)
	}
	b.muted = true
	state, err = mix(sessions, nil, allow)
	if err != nil || !state.Muted {
		t.Fatalf("all muted: %+v, %v", state, err)
	}
}

func TestMixerRejectsInvalidInputAndMissingSessions(t *testing.T) {
	for _, value := range []float64{-1, 101, math.NaN(), math.Inf(1), math.Inf(-1)} {
		s := &fakeSession{percent: 30}
		if _, err := mix([]mixerSession{s}, &value, allow); err == nil || s.writes != 0 {
			t.Fatalf("accepted invalid percentage %v", value)
		}
	}
	if _, err := mix(nil, nil, allow); !errors.Is(err, ErrNoSessions) {
		t.Fatalf("missing-session error: %v", err)
	}
	for _, value := range []float64{0, 100} {
		if err := validatePercent(value); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMixerPreflightsBeforeWriting(t *testing.T) {
	value := 50.0
	for _, failing := range []*fakeSession{{readErr: errors.New("read failed")}, {validErr: ErrStaleTarget}, {percent: math.NaN()}} {
		a := &fakeSession{percent: 30}
		if _, err := mix([]mixerSession{a, failing}, &value, allow); err == nil || a.writes+failing.writes != 0 {
			t.Fatal("preflight failure must prevent every write")
		}
	}
}

func TestMixerStopsStaleForegroundWrites(t *testing.T) {
	stale := false
	a := &fakeSession{percent: 20, afterWrite: func() { stale = true }}
	b := &fakeSession{percent: 80}
	value := 45.0
	_, err := mix([]mixerSession{a, b}, &value, func() error {
		if stale {
			return ErrStaleTarget
		}
		return nil
	})
	if !errors.Is(err, ErrStaleTarget) || !errors.Is(err, ErrPartialWrite) || a.writes != 1 || b.writes != 0 || b.percent != 80 {
		t.Fatalf("stale commands continued: %v, %+v, %+v", err, a, b)
	}
	a.writes = 0
	_, err = mix([]mixerSession{a}, &value, func() error { return ErrStaleTarget })
	if !errors.Is(err, ErrStaleTarget) || errors.Is(err, ErrPartialWrite) || a.writes != 0 {
		t.Fatalf("already stale target wrote: %v", err)
	}
}

func TestMixerReportsWriteAndReadbackFailures(t *testing.T) {
	value := 60.0
	for _, s := range []*fakeSession{
		{percent: 20, writeErr: errors.New("device invalidated")},
		{percent: 20, ignoreWrite: true},
		{percent: 20, afterWrite: func() {}},
	} {
		if s.writeErr == nil && !s.ignoreWrite {
			s.afterWrite = func() { s.readErr = errors.New("readback failed") }
		}
		if _, err := mix([]mixerSession{s}, &value, allow); !errors.Is(err, ErrPartialWrite) {
			t.Fatalf("missing partial-write error: %v", err)
		}
	}
}
