package domain

import (
	"fmt"
	"slices"
	"strings"
)

type BrightnessMatchPoint struct {
	Source int
	Target int
}
type BrightnessLinkCalibration struct {
	SourceId string
	TargetId string
	Points   []BrightnessMatchPoint
}

func (c BrightnessLinkCalibration) Validate() error {
	if strings.TrimSpace(c.SourceId) == "" || strings.TrimSpace(c.TargetId) == "" || c.SourceId == c.TargetId || len(c.Points) < 2 || len(c.Points) > 101 || c.Points[0].Source != 0 || c.Points[len(c.Points)-1].Source != 100 {
		return fmt.Errorf("invalid device-pair calibration")
	}
	for i, p := range c.Points {
		if p.Source < 0 || p.Source > 100 || p.Target < 0 || p.Target > 100 || (i > 0 && (p.Source <= c.Points[i-1].Source || p.Target < c.Points[i-1].Target)) {
			return fmt.Errorf("calibration must be ordered and monotone")
		}
	}
	return nil
}

// MapToTarget and MapToSource require a validated calibration.
func (c BrightnessLinkCalibration) MapToTarget(source int) int {
	source = clamp(source, 0, 100)
	for i := 1; i < len(c.Points); i++ {
		left, right := c.Points[i-1], c.Points[i]
		if source <= right.Source {
			return rounded(float64(left.Target) + float64(right.Target-left.Target)*float64(source-left.Source)/float64(right.Source-left.Source))
		}
	}
	return c.Points[len(c.Points)-1].Target
}

func (c BrightnessLinkCalibration) MapToSource(target, currentSource int) int {
	target = clamp(target, c.Points[0].Target, c.Points[len(c.Points)-1].Target)
	for i := 1; i < len(c.Points); i++ {
		if c.Points[i-1].Target == target && c.Points[i].Target == target {
			first := i - 1
			for i+1 < len(c.Points) && c.Points[i+1].Target == target {
				i++
			}
			return clamp(currentSource, c.Points[first].Source, c.Points[i].Source)
		}
	}
	for i := 1; i < len(c.Points); i++ {
		left, right := c.Points[i-1], c.Points[i]
		if target <= right.Target {
			return rounded(float64(left.Source) + float64(right.Source-left.Source)*float64(target-left.Target)/float64(right.Target-left.Target))
		}
	}
	return c.Points[len(c.Points)-1].Source
}

func (c BrightnessLinkCalibration) MatchesPair(available []string) bool {
	return slices.Contains(available, c.SourceId) && slices.Contains(available, c.TargetId)
}
func (c BrightnessLinkCalibration) Calculate(anchor string, value, currentSource int) (map[string]int, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if anchor == c.SourceId {
		return map[string]int{c.SourceId: clamp(value, 0, 100), c.TargetId: c.MapToTarget(value)}, nil
	}
	if anchor == c.TargetId {
		return map[string]int{c.SourceId: c.MapToSource(value, currentSource), c.TargetId: clamp(value, 0, 100)}, nil
	}
	return nil, fmt.Errorf("anchor does not belong to calibrated pair")
}

func CalculateRatio(weights map[string]float64, anchor string, value int) (map[string]int, error) {
	if err := validateBinding(false, weights); err != nil {
		return nil, err
	}
	w, ok := weights[anchor]
	if !ok {
		return nil, fmt.Errorf("anchor has no baseline weight")
	}
	maximum := w
	for _, v := range weights {
		maximum = max(maximum, v)
	}
	factor := min(float64(clamp(value, 0, 100))/w, 100/maximum)
	values := map[string]int{}
	for id, v := range weights {
		values[id] = rounded(v * factor)
	}
	return values, nil
}

func CalculateAvailableRatio(weights map[string]float64, available []string, anchor string, value int) (map[string]int, error) {
	active := map[string]float64{}
	for _, id := range available {
		if w, ok := weights[id]; ok {
			active[id] = w
		}
	}
	if _, ok := active[anchor]; !ok {
		return map[string]int{anchor: clamp(value, 0, 100)}, nil
	}
	return CalculateRatio(active, anchor, value)
}

// LinkedBrightness returns normal user targets, never compensated backlight.
// A missing member of a calibrated pair disables that pair, never substitutes a
// third device, and never falls back to a ratio for a calibrated pair member.
func LinkedBrightness(s Settings, available []string, current map[string]DisplayTarget, anchor string, value int) (map[string]int, error) {
	if !slices.Contains(available, anchor) {
		return nil, fmt.Errorf("anchor is unavailable")
	}
	if !s.Linked {
		return map[string]int{anchor: clamp(value, 0, 100)}, nil
	}
	c := s.BrightnessLinkCalibration
	if c != nil && (anchor == c.SourceId || anchor == c.TargetId) {
		if !c.MatchesPair(available) {
			return map[string]int{anchor: clamp(value, 0, 100)}, nil
		}
		source, ok := current[c.SourceId]
		if !ok {
			return nil, fmt.Errorf("missing current source target")
		}
		return c.Calculate(anchor, value, source.Brightness)
	}
	filtered := []string{}
	for _, id := range available {
		if c == nil || (id != c.SourceId && id != c.TargetId) {
			filtered = append(filtered, id)
		}
	}
	return CalculateAvailableRatio(s.LinkWeights, filtered, anchor, value)
}

// SetLinked captures current normal targets. Calibrated pairs allow zero;
// uncalibrated ratio linking requires nonzero baselines. Enabling aligns from
// the calibration source (the external display in the current product).
func SetLinked(s Settings, enabled bool, available []string, current map[string]DisplayTarget) (Settings, map[string]DisplayTarget, error) {
	next := s.Clone()
	next.Linked = enabled
	if enabled {
		if len(available) < 2 {
			return Settings{}, nil, fmt.Errorf("linking requires two available displays")
		}
		calibrated := s.BrightnessLinkCalibration != nil && s.BrightnessLinkCalibration.MatchesPair(available)
		next.LinkWeights = map[string]float64{}
		for _, id := range available {
			t, ok := current[id]
			if !ok || (!calibrated && t.Brightness <= 0) {
				return Settings{}, nil, fmt.Errorf("linking requires nonzero baseline targets")
			}
			next.LinkWeights[id] = float64(t.Brightness)
			if calibrated {
				next.LinkWeights[id] = max(1, next.LinkWeights[id])
			}
		}
	}
	targets, err := ApplyCalibratedLink(next, available, current, nil)
	return next, targets, err
}

// addressed nil means align on enable; non-nil limits alignment to scene/plan
// devices. Scene/plan source wins if both pair members are addressed.
func ApplyCalibratedLink(s Settings, available []string, current map[string]DisplayTarget, addressed map[string]DisplayTarget) (map[string]DisplayTarget, error) {
	r := CloneTargets(current)
	c := s.BrightnessLinkCalibration
	if !s.Linked || c == nil || !c.MatchesPair(available) {
		return r, nil
	}
	anchor := c.SourceId
	if addressed != nil {
		if _, ok := addressed[anchor]; !ok {
			anchor = c.TargetId
			if _, ok = addressed[anchor]; !ok {
				return r, nil
			}
		}
	}
	t, ok := current[anchor]
	if !ok {
		return nil, fmt.Errorf("missing calibrated anchor target")
	}
	values, err := LinkedBrightness(s, available, current, anchor, t.Brightness)
	if err != nil {
		return nil, err
	}
	for id, v := range values {
		t := r[id]
		t.Brightness = v
		r[id] = t
	}
	return r, nil
}
