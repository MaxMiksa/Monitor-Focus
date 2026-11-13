//go:build windows

package audio

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type validationUnmeasured struct {
	reason string
	cause  error
}

var validationActive atomic.Bool

func (e *validationUnmeasured) Error() string {
	return "audio validation unmeasured: " + e.reason + ": " + e.cause.Error()
}
func (e *validationUnmeasured) Unwrap() error     { return e.cause }
func unmeasured(reason string, cause error) error { return &validationUnmeasured{reason, cause} }

type validationLog struct {
	encoder  *json.Encoder
	sequence int
	err      error
}
type validationRecord struct {
	Time      string `json:"time"`
	Component string `json:"component"`
	Sequence  int    `json:"sequence"`
	Step      string `json:"step"`
	Status    string `json:"status"`
	State     *State `json:"state,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (l *validationLog) emit(step, status string, state *State, failure error) error {
	if l.err != nil {
		return l.err
	}
	l.sequence++
	r := validationRecord{Time: time.Now().UTC().Format(time.RFC3339Nano), Component: "audio", Sequence: l.sequence, Step: step, Status: status, State: state}
	if failure != nil {
		r.Error = failure.Error()
	}
	if err := l.encoder.Encode(r); err != nil {
		l.err = fmt.Errorf("audio validation JSONL: %w", err)
	}
	return l.err
}
func validationStatus(err error) string {
	if err == nil {
		return "pass"
	}
	if _, ok := err.(*validationUnmeasured); ok {
		return "unmeasured"
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			if validationStatus(child) == "fail" {
				return "fail"
			}
		}
		return "unmeasured"
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return validationStatus(wrapped.Unwrap())
	}
	return "fail"
}
func (l *validationLog) finish(step string, err *error) {
	*err = errors.Join(*err, l.emit(step, validationStatus(*err), nil, *err))
}

// ValidationCheck performs real audio writes and requests foreground ONLY when
// explicitly called by the exclusive acceptance host. It is never auto-run.
// It emits JSONL, preserves mute, restores owned changes where still safe, and
// returns a non-nil error for failed or unmeasured checks (including cleanup).
func ValidationCheck(out io.Writer) (err error) {
	if out == nil {
		return errors.New("audio validation requires a JSONL writer")
	}
	l := &validationLog{encoder: json.NewEncoder(out)}
	if err := l.emit("validation", "begin", nil, nil); err != nil {
		return err
	}
	defer l.finish("validation", &err)
	if !validationActive.CompareAndSwap(false, true) {
		return errors.New("audio validation is already running in this process")
	}
	defer validationActive.Store(false)
	c, err := New()
	if err != nil {
		return err
	}
	defer func() {
		closeErr := c.Close()
		err = errors.Join(err, closeErr, l.emit("controller.close", validationStatus(closeErr), nil, closeErr))
	}()
	applicationErr := validateApplication(c, l)
	if l.err != nil {
		return errors.Join(applicationErr, l.err)
	}
	systemErr := validateSystem(c, l)
	return errors.Join(applicationErr, systemErr)
}

func sameVolume(a, b State) bool {
	return a.Muted == b.Muted && math.Abs(a.Percent-b.Percent) <= 0.0001
}
func onePercent(value float64) float64 {
	if value > 99 {
		return value - 1
	}
	return value + 1
}

type applicationValidation struct {
	hwnd uintptr
	ids  map[string]bool
}

func (s *applicationValidation) check(hwnd uintptr, sessions []*nativeSession) error {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		if session.process.info.id != windows.GetCurrentProcessId() {
			return errors.New("validation refuses a session outside this process")
		}
		id, err := sessionInstanceID(session.control)
		if err != nil {
			return err
		}
		ids = append(ids, id)
	}
	return s.checkIDs(hwnd, ids)
}
func (s *applicationValidation) checkIDs(hwnd uintptr, ids []string) error {
	if hwnd != s.hwnd || len(ids) != 2 || len(s.ids) != 2 {
		return errors.New("validation requires exactly its two owned sessions and window")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !s.ids[id] || seen[id] {
			return errors.New("validation refuses an unexpected or duplicate audio session")
		}
		seen[id] = true
	}
	return nil
}
func sessionInstanceID(control *comObject) (string, error) {
	var id *uint16
	err := hresult("GetSessionInstanceIdentifier(validation)", control.invoke(13, uintptr(unsafe.Pointer(&id))))
	if id != nil {
		defer coTaskMemFree.Call(uintptr(unsafe.Pointer(id)))
	}
	if err != nil {
		return "", err
	}
	if id == nil {
		return "", errors.New("validation session has no instance identifier")
	}
	return windows.UTF16PtrToString(id), nil
}

type validationFixture struct {
	session *SilentSession
	initial State
	owned   []float64
}

func (f *validationFixture) canRestore(actual State) bool {
	if sameVolume(actual, f.initial) {
		return true
	}
	if actual.Muted != f.initial.Muted {
		return false
	}
	for _, level := range f.owned {
		if math.Abs(actual.Percent-level) <= 0.0001 {
			return true
		}
	}
	return false
}

func validateApplication(c *Controller, l *validationLog) (err error) {
	defer l.finish("application", &err)
	fixtures := make([]*validationFixture, 0, 2)
	for i := 0; i < 2; i++ {
		session, createErr := c.NewSilentSession()
		if createErr != nil {
			return fmt.Errorf("create silent session %d: %w", i, createErr)
		}
		// Register cleanup immediately, including failures creating the next session.
		defer func(index int, session *SilentSession) {
			closeErr := session.Close()
			err = errors.Join(err, closeErr, l.emit(fmt.Sprintf("fixture.%d.close", index), validationStatus(closeErr), nil, closeErr))
		}(i, session)
		initial, readErr := session.State()
		if readErr != nil {
			return readErr
		}
		fixtures = append(fixtures, &validationFixture{session: session, initial: initial})
		if err := l.emit(fmt.Sprintf("fixture.%d.created", i), "pass", &initial, nil); err != nil {
			return err
		}
	}
	if math.Abs(fixtures[0].initial.Percent-fixtures[1].initial.Percent) > 0.0001 {
		return errors.New("new silent sessions have different original percentages; unified restore cannot represent both")
	}
	window, err := newValidationWindow()
	if err != nil {
		return err
	}
	defer func() {
		closeErr := window.close()
		err = errors.Join(err, closeErr, l.emit("window.close", validationStatus(closeErr), nil, closeErr))
	}()
	if err := window.foreground(); err != nil {
		return err
	}
	if err := l.emit("window.foreground", "pass", nil, nil); err != nil {
		return err
	}
	_, err = c.call(func(w *worker) (State, error) {
		check := &applicationValidation{hwnd: window.hwnd, ids: map[string]bool{}}
		for _, fixture := range fixtures {
			id, err := sessionInstanceID(w.fixtures[fixture.session].session.control)
			if err != nil {
				return State{}, err
			}
			check.ids[id] = true
		}
		w.applicationCheck = check
		return State{}, nil
	})
	if err != nil {
		return err
	}
	defer func() {
		_, clearErr := c.call(func(w *worker) (State, error) { w.applicationCheck = nil; return State{}, nil })
		err = errors.Join(err, clearErr)
	}()
	defer func() { err = errors.Join(err, restoreApplication(c, window, fixtures, l)) }()
	for i, fixture := range fixtures {
		if err := window.foreground(); err != nil {
			return err
		}
		level := []float64{23, 71}[i]
		fixture.owned = append(fixture.owned, level)
		state, setErr := fixture.session.SetVolume(level)
		if setErr != nil {
			return setErr
		}
		if state.Muted != fixture.initial.Muted || math.Abs(state.Percent-level) > 0.01 {
			return errors.New("silent session seed/mute readback mismatch")
		}
		fixture.owned = append(fixture.owned, state.Percent)
		if err := l.emit(fmt.Sprintf("fixture.%d.seed", i), "pass", &state, nil); err != nil {
			return err
		}
	}
	before, err := c.ApplicationVolume(window.hwnd)
	if err != nil {
		return applicationValidationError(err)
	}
	if err := verifyApplication(before, 71, fixtures); err != nil {
		return err
	}
	if err := l.emit("application.before", "pass", &before, nil); err != nil {
		return err
	}
	for _, fixture := range fixtures {
		fixture.owned = append(fixture.owned, 47)
	}
	state, err := c.SetApplicationVolume(window.hwnd, 47)
	if err != nil {
		return applicationValidationError(err)
	}
	if err := verifyApplication(state, 47, fixtures); err != nil {
		return err
	}
	if err := l.emit("application.write", "pass", &state, nil); err != nil {
		return err
	}
	state, err = c.ApplicationVolume(window.hwnd)
	if err != nil {
		return applicationValidationError(err)
	}
	if err := verifyApplication(state, 47, fixtures); err != nil {
		return err
	}
	for _, fixture := range fixtures {
		actual, err := fixture.session.State()
		if err != nil {
			return err
		}
		if math.Abs(actual.Percent-47) > 0.01 || actual.Muted != fixture.initial.Muted {
			return errors.New("unified application write did not preserve each session's mute/percentage")
		}
	}
	return l.emit("application.readback", "pass", &state, nil)
}

func applicationValidationError(err error) error {
	if errors.Is(err, ErrNoTarget) || errors.Is(err, ErrStaleTarget) {
		return unmeasured("foreground changed during application check", err)
	}
	return err
}
func verifyApplication(state State, level float64, fixtures []*validationFixture) error {
	if state.ProcessID != windows.GetCurrentProcessId() || state.Sessions != 2 || math.Abs(state.Percent-level) > 0.01 || state.Muted != (fixtures[0].initial.Muted && fixtures[1].initial.Muted) {
		return fmt.Errorf("application mixer readback mismatch: %+v, want %.4f%% and 2 owned sessions", state, level)
	}
	return nil
}

func restoreApplication(c *Controller, window *validationWindow, fixtures []*validationFixture, l *validationLog) (err error) {
	changed := false
	for _, fixture := range fixtures {
		actual, readErr := fixture.session.State()
		if readErr != nil {
			return readErr
		}
		if !fixture.canRestore(actual) {
			l.emit("application.restore", "preserved", &actual, errValidationExternal)
			return errValidationExternal
		}
		changed = changed || !sameVolume(actual, fixture.initial)
	}
	if !changed {
		return nil
	}
	if err = window.foreground(); err == nil {
		_, err = c.SetApplicationVolume(window.hwnd, fixtures[0].initial.Percent)
		if err == nil {
			var state State
			state, err = c.ApplicationVolume(window.hwnd)
			if err == nil {
				err = verifyApplication(state, fixtures[0].initial.Percent, fixtures)
			}
			for _, fixture := range fixtures {
				actual, readErr := fixture.session.State()
				if readErr != nil {
					err = errors.Join(err, readErr)
				} else if !sameVolume(actual, fixture.initial) {
					err = errors.Join(err, errors.New("restored silent-session readback mismatch"))
				}
			}
			if err == nil {
				return l.emit("application.restore", "pass", &state, nil)
			}
		}
	}
	err = applicationValidationError(err)
	l.emit("application.restore", validationStatus(err), nil, err)
	// Losing foreground never justifies reclaiming it or touching the new app.
	// Restore only the two owned fixtures directly, then deferred Close releases them.
	for i, fixture := range fixtures {
		actual, restoreErr := fixture.session.State()
		if restoreErr == nil && !fixture.canRestore(actual) {
			restoreErr = errValidationExternal
		}
		if restoreErr == nil {
			actual, restoreErr = fixture.session.SetVolume(fixture.initial.Percent)
			if restoreErr == nil && !sameVolume(actual, fixture.initial) {
				restoreErr = errors.New("fixture cleanup readback mismatch")
			}
		}
		err = errors.Join(err, restoreErr, l.emit(fmt.Sprintf("fixture.%d.restore", i), validationStatus(restoreErr), &actual, restoreErr))
	}
	return err
}

func validateSystem(c *Controller, l *validationLog) (err error) {
	defer l.finish("system", &err)
	check, err := c.beginSystemValidation()
	if err != nil {
		return err
	}
	defer func() {
		closeErr := c.endSystemValidation(check)
		err = errors.Join(err, closeErr, l.emit("system.observer.close", validationStatus(closeErr), nil, closeErr))
	}()
	before, err := c.SystemVolume()
	if err != nil {
		return err
	}
	check.expected = before
	if err := l.emit("system.before", "pass", &before, nil); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, restoreSystem(c, check, before, l)) }()
	level := onePercent(before.Percent)
	state, err := c.SetSystemVolume(level)
	if err != nil {
		return err
	}
	if state.Muted != before.Muted || math.Abs(state.Percent-level) > 0.01 {
		return errors.New("system 1% write/mute readback mismatch")
	}
	if err := l.emit("system.write", "pass", &state, nil); err != nil {
		return err
	}
	state, err = c.SystemVolume()
	if err != nil {
		return err
	}
	if err := check.before(state); err != nil {
		return err
	}
	if math.Abs(state.Percent-level) > 0.01 {
		return errors.New("system separate readback did not match 1% request")
	}
	return l.emit("system.readback", "pass", &state, nil)
}

func restoreSystem(c *Controller, check *systemValidation, before State, l *validationLog) error {
	if !check.attempted {
		return nil
	}
	state, err := restoreCheckedVolume(c.SystemVolume, c.SetSystemVolume, check.before, before)
	status := validationStatus(err)
	if errors.Is(err, errValidationExternal) || errors.Is(err, ErrDeviceChanged) {
		status = "preserved"
	}
	return errors.Join(err, l.emit("system.restore", status, &state, err))
}

// Shared with injected tests: no restore is attempted unless both read and
// ownership check succeed. The real setter repeats that check on its COM job.
func restoreCheckedVolume(read func() (State, error), set func(float64) (State, error), check func(State) error, before State) (State, error) {
	state, err := read()
	if err == nil {
		err = check(state)
	}
	if err != nil {
		return state, fmt.Errorf("system restore skipped: %w", err)
	}
	if !sameVolume(state, before) {
		state, err = set(before.Percent)
		if err != nil {
			return state, err
		}
	}
	state, err = read()
	if err == nil {
		err = check(state)
	}
	if err == nil && !sameVolume(state, before) {
		err = errors.New("system restore readback/mute mismatch")
	}
	return state, err
}
