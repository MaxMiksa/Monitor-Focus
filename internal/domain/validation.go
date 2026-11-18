package domain

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

func Validate(s Settings) error {
	if s.SchemaVersion != 1 {
		return fmt.Errorf("unsupported schema version %d", s.SchemaVersion)
	}
	if s.Revision < 0 {
		return fmt.Errorf("revision cannot be negative")
	}
	if s.Language != "system" && s.Language != "zh-CN" && s.Language != "en" {
		return fmt.Errorf("unsupported language %q", s.Language)
	}
	if s.EdgeWheelModifier != "alt" && s.EdgeWheelModifier != "ctrl" && s.EdgeWheelModifier != "shift" {
		return fmt.Errorf("unsupported edge wheel modifier")
	}
	if err := s.WindowShortcut.validate(); err != nil {
		return err
	}
	if s.FocusDelaySeconds < 0 || s.FocusDelaySeconds > 600 {
		return fmt.Errorf("focus delay must be 0–600 seconds")
	}
	if v := s.ScheduleTransitionMinutes; v != nil && (*v < 0 || *v > 1440) {
		return fmt.Errorf("schedule transition must be 0–1440 minutes")
	}
	if err := validateBinding(s.Linked, s.LinkWeights); err != nil {
		return err
	}
	if s.BrightnessLinkCalibration != nil {
		if err := s.BrightnessLinkCalibration.Validate(); err != nil {
			return err
		}
	}
	if s.TemperatureBrightnessCalibrations == nil || len(s.TemperatureBrightnessCalibrations) > 16 {
		return fmt.Errorf("invalid temperature calibration collection")
	}
	for id, c := range s.TemperatureBrightnessCalibrations {
		if strings.TrimSpace(id) == "" {
			return fmt.Errorf("empty calibration device id")
		}
		if err := c.Validate(); err != nil {
			return fmt.Errorf("calibration %s: %w", id, err)
		}
	}
	if s.Scenes == nil || s.Schedule == nil {
		return fmt.Errorf("scenes and schedule must be arrays")
	}
	ids := map[string]bool{}
	for _, scene := range s.Scenes {
		if strings.TrimSpace(scene.Id) == "" || ids[scene.Id] {
			return fmt.Errorf("empty or duplicate scene id %q", scene.Id)
		}
		ids[scene.Id] = true
		if strings.TrimSpace(scene.Name) == "" {
			return fmt.Errorf("scene must have a name")
		}
		if scene.Targets == nil {
			return fmt.Errorf("scene targets must be an object")
		}
		if scene.Behavior != nil {
			if err := validateBinding(scene.Behavior.Linked, scene.Behavior.LinkWeights); err != nil {
				return err
			}
		}
		for id, target := range scene.Targets {
			if strings.TrimSpace(id) == "" || target.Brightness < 0 || target.Brightness > 100 ||
				(target.Kelvin != nil && (*target.Kelvin < 2700 || *target.Kelvin > 6500)) {
				return fmt.Errorf("invalid display target for %q", id)
			}
		}
	}
	if s.SolarLocation != nil {
		if err := s.SolarLocation.Validate(); err != nil {
			return err
		}
	}
	solar := HasSolarPoints(s)
	if solar && s.SolarLocation == nil {
		return fmt.Errorf("solar schedule needs a city")
	}
	points := slices.Clone(s.Schedule)
	slices.SortFunc(points, func(a, b PlanPoint) int { return a.MinuteOfDay - b.MinuteOfDay })
	fixedTimes := map[int]bool{}
	for i, p := range points {
		if p.TimeKind != "" && p.TimeKind != "fixed" && p.TimeKind != "sunrise" && p.TimeKind != "sunset" {
			return fmt.Errorf("invalid schedule time kind")
		}
		if p.OffsetMinutes < -720 || p.OffsetMinutes > 720 || (!p.IsSolar() && p.OffsetMinutes != 0) {
			return fmt.Errorf("invalid solar offset")
		}
		if p.TransitionMinutes > 1440 {
			return fmt.Errorf("invalid schedule transition")
		}
		if p.MinuteOfDay < 0 || p.MinuteOfDay >= 1440 || !ids[p.SceneId] || p.TransitionMinutes < 0 {
			return fmt.Errorf("invalid schedule node")
		}
		if !p.IsSolar() && fixedTimes[p.MinuteOfDay] || !solar && i > 0 && points[i-1].MinuteOfDay == p.MinuteOfDay {
			return fmt.Errorf("duplicate schedule time")
		}
		if !p.IsSolar() {
			fixedTimes[p.MinuteOfDay] = true
		}
		gap := (points[(i+1)%len(points)].MinuteOfDay - p.MinuteOfDay + 1440) % 1440
		if gap == 0 {
			gap = 1440
		}
		if !solar && p.TransitionMinutes > gap {
			return fmt.Errorf("transition overlaps the next node")
		}
	}
	return nil
}

func validateBinding(linked bool, weights map[string]float64) error {
	if weights == nil || (linked && len(weights) < 2) {
		return fmt.Errorf("linking needs at least two positive baseline weights")
	}
	for id, w := range weights {
		if strings.TrimSpace(id) == "" || w <= 0 || math.IsNaN(w) || math.IsInf(w, 0) {
			return fmt.Errorf("invalid baseline weight for %q", id)
		}
	}
	return nil
}

func clamp(v, low, high int) int { return min(max(v, low), high) }

// C# Math.Round defaults to ties-to-even, unlike Go math.Round.
func rounded(v float64) int { return int(math.RoundToEven(v)) }
func QuantizeKelvin(v *int) *int {
	if v == nil {
		return nil
	}
	k := rounded(float64(clamp(*v, 2700, 6500))/100) * 100
	return &k
}
