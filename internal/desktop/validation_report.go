package desktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

type validationCheck struct {
	name     string
	required bool
}

// JSONL schema v1. A pass describes only the named observed property, never a
// whole scenario inferred from an API returning success. not_run is not a pass.
type validationRecord struct {
	Schema   string `json:"schema"`
	Event    string `json:"event"`
	Time     string `json:"time"`
	Check    string `json:"check,omitempty"`
	Status   string `json:"status,omitempty"`
	Evidence any    `json:"evidence,omitempty"`
	Error    string `json:"error,omitempty"`
}

type validationLog struct {
	encoder  *json.Encoder
	plan     []validationCheck
	seen     map[string]string
	writeErr error
	failures []error
}

func newValidationLog(w io.Writer, plan []validationCheck) *validationLog {
	return &validationLog{encoder: json.NewEncoder(w), plan: plan, seen: make(map[string]string)}
}
func (l *validationLog) emit(r validationRecord) {
	if l.writeErr != nil {
		return
	}
	r.Schema = "monitorsfocus.desktop.validation.v1"
	r.Time = time.Now().UTC().Format(time.RFC3339Nano)
	if err := l.encoder.Encode(r); err != nil {
		l.writeErr = fmt.Errorf("write desktop validation JSONL: %w", err)
	}
}
func (l *validationLog) result(name string, evidence any, err error) {
	if _, exists := l.seen[name]; exists {
		l.failures = append(l.failures, fmt.Errorf("duplicate validation result: %s", name))
		return
	}
	r := validationRecord{Event: "check", Check: name, Status: "pass", Evidence: evidence}
	if err != nil {
		r.Status, r.Error = "fail", err.Error()
		l.failures = append(l.failures, fmt.Errorf("%s: %w", name, err))
	}
	l.seen[name] = r.Status
	l.emit(r)
}
func (l *validationLog) notRun(name, reason string, required bool) {
	if _, exists := l.seen[name]; exists {
		return
	}
	l.seen[name] = "not_run"
	if required {
		l.failures = append(l.failures, fmt.Errorf("%s not run: %s", name, reason))
	}
	l.emit(validationRecord{Event: "check", Check: name, Status: "not_run", Evidence: map[string]any{"reason": reason, "required": required}})
}
func (l *validationLog) finish() error {
	for _, check := range l.plan {
		l.notRun(check.name, "prerequisite failed or the check was not reached", check.required)
	}
	counts := map[string]int{"pass": 0, "fail": 0, "not_run": 0}
	for _, status := range l.seen {
		counts[status]++
	}
	status := "pass"
	if counts["not_run"] > 0 {
		status = "incomplete"
	}
	if len(l.failures) > 0 || l.writeErr != nil {
		status = "fail"
	}
	l.emit(validationRecord{Event: "summary", Status: status, Evidence: map[string]any{"counts": counts, "automated_checks_passed": len(l.failures) == 0 && l.writeErr == nil, "input_injected": false, "hardware_audio_written": false}})
	return errors.Join(append(l.failures, l.writeErr)...)
}

func validationAssert(ok bool, message string) error {
	if !ok {
		return errors.New(message)
	}
	return nil
}

// Require an observed transition bracket, not a sleep followed by one sample.
// Sampling stalls or an early/late disappearance cannot be reported as a pass.
func validationHideTiming(lastVisible, firstHidden time.Duration) error {
	if lastVisible < 1400*time.Millisecond || firstHidden > 2500*time.Millisecond || firstHidden <= lastVisible || firstHidden-lastVisible > 150*time.Millisecond {
		return fmt.Errorf("feedback hide transition outside observation tolerance: visible through %s, hidden by %s", lastVisible, firstHidden)
	}
	return nil
}
