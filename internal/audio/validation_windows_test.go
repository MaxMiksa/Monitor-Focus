//go:build windows

package audio

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestValidationOnlyAcceptsExactOwnedSessionSet(t *testing.T) {
	check := &applicationValidation{hwnd: 123, ids: map[string]bool{"first": true, "second": true}}
	for _, tc := range []struct {
		hwnd uintptr
		ids  []string
		good bool
	}{
		{123, []string{"second", "first"}, true},
		{456, []string{"first", "second"}, false},
		{123, []string{"first", "external"}, false},
		{123, []string{"first", "first"}, false},
		{123, []string{"first", "second", "external"}, false},
		{123, nil, false},
	} {
		if err := check.checkIDs(tc.hwnd, tc.ids); (err == nil) != tc.good {
			t.Fatalf("hwnd=%d ids=%v: %v", tc.hwnd, tc.ids, err)
		}
	}
}

func TestValidationSystemRestoresOnlyOwnedValueAndMute(t *testing.T) {
	baseline := State{Percent: 42, Muted: true}
	for _, tc := range []struct {
		name      string
		current   State
		external  bool
		readErr   error
		wantWrite bool
	}{
		{"own changed value", State{Percent: 43, Muted: true}, false, nil, true},
		{"newer external volume", State{Percent: 44, Muted: true}, false, nil, false},
		{"newer external mute", State{Percent: 43}, false, nil, false},
		{"external event same value", State{Percent: 43, Muted: true}, true, nil, false},
		{"default device changed", State{}, false, ErrDeviceChanged, false},
		{"failed read", State{}, false, io.ErrUnexpectedEOF, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			observer := &endpointObserver{}
			observer.external.Store(tc.external)
			check := &systemValidation{expected: State{Percent: 43, Muted: true}, observer: observer}
			current, writes := tc.current, 0
			state, err := restoreCheckedVolume(func() (State, error) { return current, tc.readErr }, func(value float64) (State, error) {
				writes++
				current.Percent = value
				check.expected = current
				return current, nil
			}, check.before, baseline)
			if tc.wantWrite {
				if err != nil || writes != 1 || !sameVolume(state, baseline) {
					t.Fatalf("restore: %+v writes=%d err=%v", state, writes, err)
				}
			} else if err == nil || writes != 0 || !sameVolume(current, tc.current) {
				t.Fatalf("overwrote unowned state: %+v writes=%d err=%v", current, writes, err)
			}
		})
	}
}

func TestValidationRestoreDoesNotRetryFailureOrOverwriteAfterReadback(t *testing.T) {
	baseline := State{Percent: 20}
	current := State{Percent: 21}
	writes := 0
	_, err := restoreCheckedVolume(func() (State, error) { return current, nil }, func(float64) (State, error) { writes++; return current, ErrPartialWrite }, func(State) error { return nil }, baseline)
	if !errors.Is(err, ErrPartialWrite) || writes != 1 {
		t.Fatalf("write failure retried: %d %v", writes, err)
	}
	writes = 0
	_, err = restoreCheckedVolume(func() (State, error) { return current, nil }, func(value float64) (State, error) { writes++; current.Percent = 55; return State{Percent: value}, nil }, func(State) error { return nil }, baseline)
	if err == nil || writes != 1 || current.Percent != 55 {
		t.Fatalf("external readback overwritten: %d %+v %v", writes, current, err)
	}
}

func TestValidationOnePercentBoundariesAndFixtureRestore(t *testing.T) {
	for _, level := range []float64{0, 0.2, 50, 99, 99.2, 100} {
		next := onePercent(level)
		if validatePercent(next) != nil || math.Abs(math.Abs(next-level)-1) > 1e-10 {
			t.Fatalf("invalid 1%% change: %v -> %v", level, next)
		}
	}
	fixture := &validationFixture{initial: State{Percent: 100, Muted: true}, owned: []float64{23, 47}}
	if !fixture.canRestore(State{Percent: 47, Muted: true}) || !fixture.canRestore(fixture.initial) || fixture.canRestore(State{Percent: 48, Muted: true}) || fixture.canRestore(State{Percent: 47}) {
		t.Fatal("fixture restore did not respect owned levels/mute")
	}
}

func TestValidationObserverABIAndOwnership(t *testing.T) {
	context := guid("{A6795AAE-E058-4C38-AACA-A50562F888E4}")
	observer := newEndpointObserver(context)
	defer observerRelease(observer)
	if unsafe.Offsetof(endpointObserver{}.vtable) != 0 {
		t.Fatal("callback interface is not first field")
	}
	var returned *endpointObserver
	hr, _, _ := syscall.SyscallN(observer.vtable[0], uintptr(unsafe.Pointer(observer)), uintptr(unsafe.Pointer(&iidEndpointCallback)), uintptr(unsafe.Pointer(&returned)))
	if hr != 0 || returned != observer || observer.refs.Load() != 2 {
		t.Fatalf("QueryInterface ABI failed: hr=%x ref=%d", hr, observer.refs.Load())
	}
	syscall.SyscallN(observer.vtable[2], uintptr(unsafe.Pointer(returned)))
	// Only synthetic callbacks: no registration with real CoreAudio, no writes.
	syscall.SyscallN(observer.vtable[3], uintptr(unsafe.Pointer(observer)), uintptr(unsafe.Pointer(&context)))
	if observer.external.Load() {
		t.Fatal("own notification marked external")
	}
	foreign := windows.GUID{}
	syscall.SyscallN(observer.vtable[3], uintptr(unsafe.Pointer(observer)), uintptr(unsafe.Pointer(&foreign)))
	if !observer.external.Load() {
		t.Fatal("external notification ignored")
	}
	observerNotify(observer, &context)
	if !observer.external.Load() {
		t.Fatal("own event cleared external takeover")
	}
}

func TestValidationJSONLAndUnmeasuredFailure(t *testing.T) {
	var buffer bytes.Buffer
	l := &validationLog{encoder: json.NewEncoder(&buffer)}
	failure := unmeasured("foreground denied", ErrStaleTarget)
	if err := l.emit("window.foreground", validationStatus(failure), nil, failure); err != nil {
		t.Fatal(err)
	}
	if err := l.emit("system.readback", "pass", &State{Percent: 21, Muted: true}, nil); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buffer.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("not JSONL: %q", buffer.String())
	}
	for i, line := range lines {
		var record validationRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil || record.Sequence != i+1 || record.Component != "audio" || record.Time == "" {
			t.Fatalf("bad record %q: %v", line, err)
		}
		if i == 0 && (record.Status != "unmeasured" || record.Error == "") {
			t.Fatal("foreground denial reported as success")
		}
	}
	if validationStatus(errors.Join(failure, errors.New("cleanup failed"))) != "fail" {
		t.Fatal("unmeasured status concealed cleanup failure")
	}
	if validationStatus(errors.Join(failure)) != "unmeasured" {
		t.Fatal("unmeasured status lost")
	}
}

type validationBrokenWriter struct{ calls int }

func (w *validationBrokenWriter) Write([]byte) (int, error) { w.calls++; return 0, io.ErrClosedPipe }

func TestValidationWriterFailureStopsBeforeNativeSetup(t *testing.T) {
	writer := &validationBrokenWriter{}
	if err := ValidationCheck(writer); !errors.Is(err, io.ErrClosedPipe) || writer.calls != 1 {
		t.Fatalf("bad output must abort before native setup: %d %v", writer.calls, err)
	}
	if err := ValidationCheck(nil); err == nil {
		t.Fatal("nil writer accepted")
	}
}

func TestValidationRejectsOverlappingRunsBeforeNativeSetup(t *testing.T) {
	if !validationActive.CompareAndSwap(false, true) {
		t.Fatal("unexpected active validation")
	}
	defer validationActive.Store(false)
	var buffer bytes.Buffer
	if err := ValidationCheck(&buffer); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("overlapping validation was accepted: %v", err)
	}
	var record validationRecord
	lines := strings.Split(strings.TrimSpace(buffer.String()), "\n")
	if len(lines) != 2 || json.Unmarshal([]byte(lines[1]), &record) != nil || record.Status != "fail" {
		t.Fatalf("missing overlap failure record: %q", buffer.String())
	}
}

func TestValidationRechecksTakeoverInRestoreSetter(t *testing.T) {
	observer := &endpointObserver{}
	check := &systemValidation{observer: observer, expected: State{Percent: 21}}
	writes := 0
	_, err := restoreCheckedVolume(func() (State, error) { return State{Percent: 21}, nil }, func(value float64) (State, error) {
		// External takeover after the helper's read but before the actual job.
		observer.external.Store(true)
		if err := check.before(State{Percent: 21}); err != nil {
			return State{}, err
		}
		writes++
		return State{Percent: value}, nil
	}, check.before, State{Percent: 20})
	if !errors.Is(err, errValidationExternal) || writes != 0 {
		t.Fatalf("late takeover was overwritten: writes=%d err=%v", writes, err)
	}
}
