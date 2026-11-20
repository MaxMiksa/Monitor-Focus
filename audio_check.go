package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"myscreen/internal/audio"
	"os"
	"time"
)

func runAudioCheck() {
	emit := func(event string, fields map[string]any) {
		fields["event"] = event
		fields["at"] = time.Now().Format(time.RFC3339Nano)
		json.NewEncoder(os.Stdout).Encode(fields)
	}
	c, err := audio.New()
	if err != nil {
		emit("failed", map[string]any{"error": err.Error()})
		os.Exit(1)
	}
	success := false
	err = func() error {
		before, err := c.SystemVolume()
		if err != nil {
			return err
		}
		emit("system-before", map[string]any{"state": before})
		fixture, err := c.NewSilentSession()
		if err != nil {
			return err
		}
		defer fixture.Close()
		initial, err := fixture.State()
		if err != nil {
			return err
		}
		emit("owned-session-before", map[string]any{"state": initial, "pid": os.Getpid()})
		for cycle := 1; cycle <= 5; cycle++ {
			start := time.Now()
			actual, err := fixture.SetVolume(float64(35 + cycle))
			emit("owned-session-write-readback", map[string]any{"cycle": cycle, "target": 35 + cycle, "state": actual, "elapsedMs": float64(time.Since(start).Microseconds()) / 1000, "error": errorText(err)})
			if err != nil {
				return err
			}
			if math.Abs(actual.Percent-float64(35+cycle)) > .01 || actual.Muted != initial.Muted {
				return errors.New("session readback or mute mismatch")
			}
		}
		restored, err := fixture.SetVolume(initial.Percent)
		if err != nil || math.Abs(restored.Percent-initial.Percent) > .01 || restored.Muted != initial.Muted {
			return fmt.Errorf("owned session restore failed: %v", err)
		}
		after, err := c.SystemVolume()
		if err != nil {
			return err
		}
		unchanged := math.Abs(before.Percent-after.Percent) < .01 && before.Muted == after.Muted
		emit("system-after", map[string]any{"state": after, "unchanged": unchanged})
		if !unchanged {
			return errors.New("system volume changed during session acceptance")
		}
		return nil
	}()
	if err == nil {
		success = true
	}
	cleanup := c.Close()
	emit("cleanup", map[string]any{"success": success && cleanup == nil, "error": errorText(errors.Join(err, cleanup))})
	if err != nil || cleanup != nil {
		os.Exit(1)
	}
}
