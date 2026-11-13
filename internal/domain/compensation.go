package domain

import (
	"fmt"
	"slices"
)

type TemperatureBrightnessPoint struct {
	Kelvin                int
	ReferenceBrightness   int
	CompensatedBrightness int
}
type TemperatureBrightnessCalibration struct{ Points []TemperatureBrightnessPoint }
type CompensatedBrightness struct {
	Value   int
	Limited bool
}

func (c TemperatureBrightnessCalibration) Validate() error {
	if len(c.Points) < 4 || len(c.Points) > 32 {
		return fmt.Errorf("temperature calibration needs 4–32 points")
	}
	curves := map[int]map[int]int{}
	for _, p := range c.Points {
		if p.Kelvin < 2700 || p.Kelvin >= 6500 || p.ReferenceBrightness < 1 || p.ReferenceBrightness > 99 || p.CompensatedBrightness < p.ReferenceBrightness || p.CompensatedBrightness > 100 {
			return fmt.Errorf("invalid temperature calibration point")
		}
		if curves[p.Kelvin] == nil {
			curves[p.Kelvin] = map[int]int{}
		}
		if _, exists := curves[p.Kelvin][p.ReferenceBrightness]; exists {
			return fmt.Errorf("duplicate temperature calibration point")
		}
		curves[p.Kelvin][p.ReferenceBrightness] = p.CompensatedBrightness
	}
	if len(curves) < 2 {
		return fmt.Errorf("at least two temperatures required")
	}
	temperatures := []int{}
	for k := range curves {
		temperatures = append(temperatures, k)
	}
	slices.Sort(temperatures)
	references := []int{}
	for r := range curves[temperatures[0]] {
		references = append(references, r)
	}
	slices.Sort(references)
	if len(references) < 2 {
		return fmt.Errorf("at least two reference brightnesses required")
	}
	for ki, k := range temperatures {
		if len(curves[k]) != len(references) {
			return fmt.Errorf("incomplete reference grid")
		}
		for ri, r := range references {
			v, ok := curves[k][r]
			if !ok || (ri > 0 && v < curves[k][references[ri-1]]) || (ki > 0 && v > curves[temperatures[ki-1]][r]) {
				return fmt.Errorf("incomplete or non-monotone temperature calibration")
			}
		}
	}
	return nil
}

// Evaluate requires a validated calibration. Below measured brightness use a
// proportional boost; above it retain the nearest measured additive offset.
func (c TemperatureBrightnessCalibration) Evaluate(brightness int, kelvin *int) CompensatedBrightness {
	brightness = clamp(brightness, 0, 100)
	if brightness == 0 || kelvin == nil || *kelvin >= 6500 || len(c.Points) == 0 {
		return CompensatedBrightness{Value: brightness}
	}
	minimum := 6500
	for _, p := range c.Points {
		minimum = min(minimum, p.Kelvin)
	}
	temperature := clamp(*kelvin, minimum, 6500)
	lower, upper := minimum, 6500
	for _, p := range c.Points {
		if p.Kelvin <= temperature {
			lower = max(lower, p.Kelvin)
		}
		if p.Kelvin >= temperature {
			upper = min(upper, p.Kelvin)
		}
	}
	lowOffset, highOffset := c.offset(brightness, lower), 0.0
	if upper != 6500 {
		highOffset = c.offset(brightness, upper)
	}
	offset := lowOffset
	if lower != upper {
		offset += (highOffset - lowOffset) * float64(temperature-lower) / float64(upper-lower)
	}
	requested := float64(brightness) + offset
	return CompensatedBrightness{Value: clamp(rounded(requested), brightness, 100), Limited: requested > 100}
}

func (c TemperatureBrightnessCalibration) offset(brightness, kelvin int) float64 {
	var before, after *TemperatureBrightnessPoint
	for _, p := range c.Points {
		if p.Kelvin != kelvin {
			continue
		}
		if p.ReferenceBrightness <= brightness && (before == nil || p.ReferenceBrightness > before.ReferenceBrightness) {
			copy := p
			before = &copy
		}
		if p.ReferenceBrightness >= brightness && (after == nil || p.ReferenceBrightness < after.ReferenceBrightness) {
			copy := p
			after = &copy
		}
	}
	if before == nil {
		if after == nil {
			return 0
		}
		return float64(after.CompensatedBrightness-after.ReferenceBrightness) * float64(brightness) / float64(after.ReferenceBrightness)
	}
	offset := float64(before.CompensatedBrightness - before.ReferenceBrightness)
	if after == nil || before.ReferenceBrightness == after.ReferenceBrightness {
		return offset
	}
	return offset + (float64(after.CompensatedBrightness-after.ReferenceBrightness)-offset)*float64(brightness-before.ReferenceBrightness)/float64(after.ReferenceBrightness-before.ReferenceBrightness)
}

// CompensationScope must be supplied by the host after identity/color checks.
// ColorActive must become false on restore, failure, exit or external ownership.
type CompensationScope struct {
	Id                string
	IsInternal        bool
	IsPrimary         bool
	IdentityConfirmed bool
	SupportsColor     bool
	ColorActive       bool
}
type BrightnessTargets struct {
	UserTarget      int
	BacklightTarget int
	Limited         bool
}

func ResolveBrightnessTargets(s Settings, scope CompensationScope, userTarget int, kelvin *int) BrightnessTargets {
	userTarget = clamp(userTarget, 0, 100)
	r := BrightnessTargets{UserTarget: userTarget, BacklightTarget: userTarget}
	if !scope.IsInternal || scope.IsPrimary || !scope.IdentityConfirmed || !scope.SupportsColor || !scope.ColorActive {
		return r
	}
	if c, ok := s.TemperatureBrightnessCalibrations[scope.Id]; ok && c.Validate() == nil {
		result := c.Evaluate(userTarget, kelvin)
		r.BacklightTarget, r.Limited = result.Value, result.Limited
	}
	return r
}
