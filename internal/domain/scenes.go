package domain

import (
	"fmt"
	"maps"
	"slices"
)

func CaptureBehavior(s Settings) SceneBehavior {
	return SceneBehavior{Linked: s.Linked, LinkWeights: maps.Clone(s.LinkWeights), FocusEnabled: s.FocusEnabled, ControlledDisplayIds: slices.Clone(s.ControlledDisplayIds)}
}
func (b SceneBehavior) Clone() SceneBehavior {
	b.LinkWeights = maps.Clone(b.LinkWeights)
	b.ControlledDisplayIds = slices.Clone(b.ControlledDisplayIds)
	return b
}
func sameSelection(a, b []string) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	left, right := map[string]bool{}, map[string]bool{}
	for _, id := range a {
		left[id] = true
	}
	for _, id := range b {
		right[id] = true
	}
	return maps.Equal(left, right)
}
func (b SceneBehavior) Equal(other SceneBehavior) bool {
	return b.Linked == other.Linked && b.FocusEnabled == other.FocusEnabled && maps.Equal(b.LinkWeights, other.LinkWeights) && sameSelection(b.ControlledDisplayIds, other.ControlledDisplayIds)
}

// ApplyBehavior returns an independent settings draft and whether persisted
// behavior changed. Focus timers should still reset on an explicit scene switch.
func ApplyBehavior(s Settings, b SceneBehavior) (Settings, bool) {
	changed := !CaptureBehavior(s).Equal(b)
	next := s.Clone()
	next.Linked, next.LinkWeights, next.FocusEnabled, next.ControlledDisplayIds = b.Linked, maps.Clone(b.LinkWeights), b.FocusEnabled, slices.Clone(b.ControlledDisplayIds)
	return next, changed
}

func WithSceneDefaults(s Settings) Settings {
	s = s.Clone()
	for i := range s.Scenes {
		if s.Scenes[i].Behavior == nil {
			b := CaptureBehavior(s)
			s.Scenes[i].Behavior = &b
		}
	}
	return s
}

// CaptureScene uses caller-provided stable IDs and normal targets, never OSD,
// temporary focus state or compensated backlight. Offline targets are retained.
func CaptureScene(s Settings, id, name string, targets map[string]DisplayTarget) Scene {
	b := CaptureBehavior(s)
	return Scene{Id: id, Name: name, Targets: CloneTargets(targets), Behavior: &b}
}

// DefaultScenes requires measured current display state; it never invents user
// brightnesses or ships a personal device-pair/temperature curve. IDs are supplied
// so the function stays pure; call only when the host finds no saved scenes.
func DefaultScenes(s Settings, displays []DisplayState, ids [3]string) []Scene {
	names := [3]string{"日常", "夜间", "专注"}
	factors := [3]float64{1, 0.5, 0.7}
	values := [3]int{6500, 3200, 4500}
	scenes := make([]Scene, 3)
	for i, name := range names {
		targets := map[string]DisplayTarget{}
		for _, d := range displays {
			var k *int
			if d.CanAdjustColor {
				k = clonePointer(&values[i])
			}
			targets[d.Id] = DisplayTarget{Brightness: rounded(float64(d.Brightness) * factors[i]), Kelvin: k}
		}
		scenes[i] = CaptureScene(s, ids[i], name, targets)
		scenes[i].DefaultName = clonePointer(&name)
	}
	return scenes
}

// ApplyScene returns rules and targets; the caller owns persistence, focus reset,
// hardware capability checks and manual hold. Scene color uses 100 K steps.
func ApplyScene(s Settings, scene Scene, available []string, current map[string]DisplayTarget) (Settings, map[string]DisplayTarget, bool, error) {
	b := CaptureBehavior(s)
	if scene.Behavior != nil {
		b = scene.Behavior.Clone()
	}
	if err := validateBinding(b.Linked, b.LinkWeights); err != nil {
		return Settings{}, nil, false, err
	}
	next, changed := ApplyBehavior(s, b)
	targets := CloneTargets(current)
	for id, t := range scene.Targets {
		t.Kelvin = QuantizeKelvin(t.Kelvin)
		targets[id] = t
	}
	targets, err := ApplyCalibratedLink(next, available, targets, scene.Targets)
	return next, targets, changed, err
}

func CanDeleteScene(s Settings, id string) bool {
	for _, p := range s.Schedule {
		if p.SceneId == id {
			return false
		}
	}
	return true
}
func DeleteScene(s Settings, id string) (Settings, error) {
	if !CanDeleteScene(s, id) {
		return Settings{}, fmt.Errorf("scene is referenced by the schedule")
	}
	r := s.Clone()
	r.Scenes = slices.DeleteFunc(r.Scenes, func(scene Scene) bool { return scene.Id == id })
	return r, nil
}
