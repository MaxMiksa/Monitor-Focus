package desktop

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// Only report/timing rules are tested here, with an in-memory writer. These are
// not native acceptance results and do not call ValidationCheck or any Win32 API.
func validationRecords(t *testing.T, b *bytes.Buffer) []validationRecord {
	t.Helper()
	var records []validationRecord
	decoder := json.NewDecoder(b)
	for {
		var r validationRecord
		err := decoder.Decode(&r)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, r)
	}
	return records
}

func TestValidationNeverPassesAnUnperformedRequiredCheck(t *testing.T) {
	var output bytes.Buffer
	l := newValidationLog(&output, []validationCheck{{"unit.unperformed", true}})
	if err := l.finish(); err == nil {
		t.Fatal("missing required check returned success")
	}
	records := validationRecords(t, &output)
	if len(records) != 2 || records[0].Status != "not_run" || records[1].Status != "fail" {
		t.Fatalf("unexpected results: %+v", records)
	}
	for _, r := range records {
		if r.Schema != "monitorsfocus.desktop.validation.v1" || r.Time == "" {
			t.Fatal("missing JSONL schema/time")
		}
	}
}

func TestValidationUnverifiedVisualsKeepSummaryIncomplete(t *testing.T) {
	var output bytes.Buffer
	l := newValidationLog(&output, []validationCheck{{"unit.call", true}, {"unit.visual", false}})
	l.result("unit.call", map[string]any{"api_return": "nil"}, nil)
	l.notRun("unit.visual", "not visually observed", false)
	if err := l.finish(); err != nil {
		t.Fatal(err)
	}
	records := validationRecords(t, &output)
	if len(records) != 3 || records[0].Status != "pass" || records[1].Status != "not_run" || records[2].Status != "incomplete" {
		t.Fatalf("unobserved visual implied success: %+v", records)
	}
}

func TestValidationNativeFailureAndWriterFailurePropagate(t *testing.T) {
	var output bytes.Buffer
	failure := errors.New("synthetic unit failure, not a native result")
	l := newValidationLog(&output, []validationCheck{{"unit.call", true}})
	l.result("unit.call", nil, failure)
	if err := l.finish(); !errors.Is(err, failure) {
		t.Fatalf("lost failure: %v", err)
	}
	r := validationRecords(t, &output)
	if len(r) != 2 || r[0].Status != "fail" || !strings.Contains(r[0].Error, "synthetic") || r[1].Status != "fail" {
		t.Fatalf("%+v", r)
	}
	l = newValidationLog(validationBrokenWriter{}, nil)
	l.emit(validationRecord{Event: "start"})
	if err := l.finish(); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("lost output failure: %v", err)
	}
}

type validationBrokenWriter struct{}

func (validationBrokenWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestValidationHideTimingRequiresObservedTransition(t *testing.T) {
	for _, tt := range []struct {
		name         string
		last, hidden int
		valid        bool
	}{
		{"normal", 1480, 1510, true}, {"lower_bound", 1400, 1500, true},
		{"never_observed", 0, 1510, false}, {"early", 1300, 1330, false},
		{"late", 2490, 2520, false}, {"sampling_stalled", 1400, 1600, false},
		{"no_transition", 1500, 0, false}, {"invalid_order", 1510, 1500, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := validationHideTiming(time.Duration(tt.last)*time.Millisecond, time.Duration(tt.hidden)*time.Millisecond)
			if (err == nil) != tt.valid {
				t.Fatalf("timing accepted=%v want=%v: %v", err == nil, tt.valid, err)
			}
		})
	}
}
