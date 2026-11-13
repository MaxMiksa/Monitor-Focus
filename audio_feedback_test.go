package main

import (
	"fmt"
	"monitorsfocus/internal/audio"
	"testing"
)

func TestApplicationFeedbackMissingSessionIsNotZeroVolume(t *testing.T) {
	for _, cause := range []error{audio.ErrNoTarget, audio.ErrNoSessions} {
		missing := applicationVolumeFeedback(audio.State{}, fmt.Errorf("discovery: %w", cause))
		if missing.Value != "请先播放音频" || missing.Pending || !missing.HideProgress {
			t.Fatalf("missing session must show a stable notice, not a numeric/loading bar: %+v", missing)
		}
	}
	zero := applicationVolumeFeedback(audio.State{Name: "Player", Percent: 0, Sessions: 1}, nil)
	if zero.Label != "Player" || zero.Value != "" || zero.Pending || zero.HideProgress || zero.Percent != 0 {
		t.Fatalf("a real zero-volume session must remain adjustable: %+v", zero)
	}
}
