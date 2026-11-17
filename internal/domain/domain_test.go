package domain

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"
)

func ptr[T any](v T) *T { return &v }
func requireEqual[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Fatalf("got %v, want %v", got, want)
	}
}
func testCurve() *BrightnessLinkCalibration {
	return &BrightnessLinkCalibration{SourceId: "external", TargetId: "internal", Points: []BrightnessMatchPoint{{0, 25}, {20, 35}, {60, 70}, {95, 100}, {97, 100}, {100, 100}}}
}
func testCompensation() TemperatureBrightnessCalibration {
	return TemperatureBrightnessCalibration{Points: []TemperatureBrightnessPoint{{3200, 20, 30}, {3200, 60, 85}, {4500, 20, 25}, {4500, 60, 70}}}
}

func TestDefaultsAndJSONCompatibility(t *testing.T) {
	s, err := DecodeSettings([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, s.Language, "system")
	requireEqual(t, s.EdgeWheelModifier, "alt")
	requireEqual(t, s.FocusDelaySeconds, 180)
	if !s.KeepSecondaryAwakeOnFullscreen || s.ControlledDisplayIds != nil || s.BrightnessLinkCalibration != nil || len(s.TemperatureBrightnessCalibrations) != 0 || len(s.Scenes) != 0 {
		t.Fatal("defaults must not invent a user/device configuration")
	}
	for _, selected := range [][]string{nil, {}} {
		s.ControlledDisplayIds = selected
		data, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		want := "[]"
		if selected == nil {
			want = "null"
		}
		requireEqual(t, string(fields["ControlledDisplayIds"]), want)
		if _, ok := fields["SchemaVersion"]; !ok {
			t.Fatal("JSON must use PascalCase")
		}
		roundtrip, err := DecodeSettings(data)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(s, roundtrip) {
			t.Fatal("JSON changed settings")
		}
	}
}

func TestOldFieldsAndSceneLanguage(t *testing.T) {
	s, err := DecodeSettings(append([]byte{0xef, 0xbb, 0xbf}, []byte(`{"Scenes":[{"Id":"empty-scene"}]}`)...))
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, s.Scenes[0].Name, "新场景")
	if s.Scenes[0].Targets == nil || s.Scenes[0].Behavior == nil {
		t.Fatal("missing old fields were not defaulted")
	}
	scene := Scene{Name: "日常", DefaultName: ptr("日常")}
	requireEqual(t, SceneName(scene, "system", "zh-TW"), "日常")
	requireEqual(t, SceneName(scene, "system", "de-DE"), "Day")
	scene.Name = "My name"
	requireEqual(t, SceneName(scene, "en", "zh-CN"), "My name")
	requireEqual(t, ResolveLanguage("system", "zH-HK"), "zh-CN")
}

func TestFocusBoundariesAndReset(t *testing.T) {
	s := DefaultSettings()
	s.FocusEnabled = true
	s.FocusDelaySeconds = 2
	in := FocusInput{DisplayId: "secondary", NowMillis: 1000}
	state, dim := EvaluateFocus(s, FocusState{}, in)
	requireEqual(t, dim, false)
	in.NowMillis = 2999
	state, dim = EvaluateFocus(s, state, in)
	requireEqual(t, dim, false)
	in.NowMillis = 3000
	state, dim = EvaluateFocus(s, state, in)
	requireEqual(t, dim, true)
	for _, reason := range []string{"primary", "paused", "cursor", "fullscreen", "empty", "excluded", "disabled"} {
		t.Run(reason, func(t *testing.T) {
			next, input := s.Clone(), in
			switch reason {
			case "primary":
				input.IsPrimary = true
			case "paused":
				input.Paused = true
			case "cursor":
				input.CursorOnDisplay = true
			case "fullscreen":
				input.HasFullscreenWindow = true
			case "empty":
				next.ControlledDisplayIds = []string{}
			case "excluded":
				next.ControlledDisplayIds = []string{"offline"}
			case "disabled":
				next.FocusEnabled = false
			}
			reset, dim := EvaluateFocus(next, state, input)
			if dim || reset.LeftAt != nil {
				t.Fatal("must hide and reset timer")
			}
			input = in
			input.NowMillis = 5000
			reset, dim = EvaluateFocus(s, reset, input)
			requireEqual(t, dim, false)
			input.NowMillis = 7000
			_, dim = EvaluateFocus(s, reset, input)
			requireEqual(t, dim, true)
		})
	}
	s.KeepSecondaryAwakeOnFullscreen = false
	in.HasFullscreenWindow = true
	_, dim = EvaluateFocus(s, state, in)
	requireEqual(t, dim, true)
	s.FocusDelaySeconds = 0
	_, dim = EvaluateFocus(s, FocusState{}, in)
	requireEqual(t, dim, true)
	in.NowMillis = 0
	s.FocusDelaySeconds = 2
	_, dim = EvaluateFocus(s, state, in)
	requireEqual(t, dim, false)
}

func TestCalibrationInversePlateauAndPairIsolation(t *testing.T) {
	c := testCurve()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct{ source, target int }{{-1, 25}, {0, 25}, {10, 30}, {20, 35}, {95, 100}, {100, 100}, {101, 100}} {
		requireEqual(t, c.MapToTarget(v.source), v.target)
	}
	for _, v := range []struct{ target, current, want int }{{0, 50, 0}, {24, 50, 0}, {25, 80, 0}, {30, 0, 10}, {100, 98, 98}, {100, 94, 95}, {100, 101, 100}, {101, 96, 96}} {
		requireEqual(t, c.MapToSource(v.target, v.current), v.want)
	}
	flat := BrightnessLinkCalibration{SourceId: "a", TargetId: "b", Points: []BrightnessMatchPoint{{0, 40}, {20, 40}, {50, 40}, {100, 40}}}
	if err := flat.Validate(); err != nil {
		t.Fatal(err)
	}
	requireEqual(t, flat.MapToSource(10, 71), 71)
	middle := BrightnessLinkCalibration{SourceId: "a", TargetId: "b", Points: []BrightnessMatchPoint{{0, 0}, {20, 40}, {50, 40}, {100, 100}}}
	requireEqual(t, middle.MapToSource(40, 30), 30)
	requireEqual(t, middle.MapToSource(40, 70), 50)
	s := DefaultSettings()
	s.Linked = true
	s.LinkWeights = map[string]float64{"external": 1, "internal": 1, "other": 1}
	s.BrightnessLinkCalibration = c
	current := map[string]DisplayTarget{"external": {Brightness: 98}, "internal": {Brightness: 100}, "other": {Brightness: 80}}
	values, err := LinkedBrightness(s, []string{"external", "internal", "other"}, current, "internal", 100)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, values["external"], 98)
	values, err = LinkedBrightness(s, []string{"external", "other"}, current, "external", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, map[string]int{"external": 0}) {
		t.Fatal(values)
	}
	values, err = LinkedBrightness(s, []string{"external", "internal", "other"}, current, "other", 20)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, map[string]int{"other": 20}) {
		t.Fatal("calibrated devices leaked into ratio", values)
	}
	current["external"] = DisplayTarget{Brightness: 0}
	next, targets, err := SetLinked(s, true, []string{"external", "internal"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, targets["internal"].Brightness, 25)
	requireEqual(t, next.LinkWeights["external"], 1.0)
	s.BrightnessLinkCalibration = nil
	if _, _, err := SetLinked(s, true, []string{"external", "internal"}, current); err == nil {
		t.Fatal("uncalibrated zero baseline accepted")
	}
	if _, err := c.Calculate("other", 20, 0); err == nil {
		t.Fatal("unknown anchor accepted")
	}
}

func TestRatioAndBankersRounding(t *testing.T) {
	values, err := CalculateRatio(map[string]float64{"a": 20, "b": 60}, "a", 100)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, values["a"], 33)
	requireEqual(t, values["b"], 100)
	values, err = CalculateRatio(map[string]float64{"a": 2, "b": 1}, "a", 1)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, values["b"], 0)
	values, err = CalculateAvailableRatio(map[string]float64{"a": 20, "offline": 100}, []string{"a"}, "a", 100)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, values["a"], 100)
	for _, w := range []float64{0, -1, math.NaN(), math.Inf(1)} {
		if _, err := CalculateRatio(map[string]float64{"a": w}, "a", 20); err == nil {
			t.Fatal("invalid ratio accepted")
		}
	}
	requireEqual(t, *QuantizeKelvin(ptr(4450)), 4400)
	requireEqual(t, *QuantizeKelvin(ptr(4550)), 4600)
}

func TestCompensationBoundariesAndSeparation(t *testing.T) {
	c := testCompensation()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		brightness int
		kelvin     *int
		want       int
		limited    bool
	}{{20, ptr(3200), 30, false}, {40, ptr(3200), 58, false}, {10, ptr(3200), 15, false}, {70, ptr(3200), 95, false}, {90, ptr(3200), 100, true}, {20, ptr(4500), 25, false}, {20, ptr(5500), 22, false}, {20, ptr(2700), 30, false}, {20, nil, 20, false}, {20, ptr(6500), 20, false}, {0, ptr(3200), 0, false}} {
		got := c.Evaluate(v.brightness, v.kelvin)
		requireEqual(t, got.Value, v.want)
		requireEqual(t, got.Limited, v.limited)
	}
	s := DefaultSettings()
	s.TemperatureBrightnessCalibrations["panel"] = c
	scope := CompensationScope{Id: "panel", IsInternal: true, IdentityConfirmed: true, SupportsColor: true, ColorActive: true}
	got := ResolveBrightnessTargets(s, scope, 90, ptr(3200))
	requireEqual(t, got.UserTarget, 90)
	requireEqual(t, got.BacklightTarget, 100)
	requireEqual(t, got.Limited, true)
	for _, reason := range []string{"external", "primary", "identity", "support", "restored", "other-id"} {
		input := scope
		switch reason {
		case "external":
			input.IsInternal = false
		case "primary":
			input.IsPrimary = true
		case "identity":
			input.IdentityConfirmed = false
		case "support":
			input.SupportsColor = false
		case "restored":
			input.ColorActive = false
		case "other-id":
			input.Id = "other"
		}
		got := ResolveBrightnessTargets(s, input, 90, ptr(3200))
		requireEqual(t, got.BacklightTarget, 90)
		requireEqual(t, got.UserTarget, 90)
	}
	bad := c
	bad.Points = append([]TemperatureBrightnessPoint{}, c.Points...)
	bad.Points[3].CompensatedBrightness = 90
	if err := bad.Validate(); err == nil {
		t.Fatal("cooler temperature cannot need more boost")
	}
}

func planFixture() Settings {
	s := DefaultSettings()
	s.ScheduleEnabled = true
	s.Scenes = []Scene{CaptureScene(s, "day", "Day", map[string]DisplayTarget{"a": {Brightness: 80}}), CaptureScene(s, "night", "Night", map[string]DisplayTarget{"a": {Brightness: 20, Kelvin: ptr(3200)}})}
	s.Schedule = []PlanPoint{{MinuteOfDay: 8 * 60, SceneId: "day", TransitionMinutes: 30}, {MinuteOfDay: 23 * 60, SceneId: "night", TransitionMinutes: 120}}
	return s
}

var testLocation = time.FixedZone("test", 8*60*60)

func localClock(hour, minute, second int) time.Time {
	return time.Date(2026, 11, 12, hour, minute, second, 0, testLocation)
}

func TestPlanMidnightNativeColorAndBoundaries(t *testing.T) {
	s := planFixture()
	if err := Validate(s); err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		now        time.Time
		brightness int
		kelvin     *int
		progress   float64
	}{{localClock(23, 0, 0), 80, nil, 0}, {localClock(23, 30, 0), 71, ptr(5984), 0.15625}, {localClock(0, 0, 0).AddDate(0, 0, 1), 50, ptr(4850), 0.5}, {localClock(1, 0, 0).AddDate(0, 0, 1), 20, ptr(3200), 1}, {localClock(8, 30, 0), 80, nil, 1}} {
		p := EvaluatePlan(s, v.now)
		if p == nil {
			t.Fatal("missing plan")
		}
		target, ok := p.Target("a", nil)
		if !ok {
			t.Fatal("missing target")
		}
		requireEqual(t, target.Brightness, v.brightness)
		if !equalIntPointer(target.Kelvin, v.kelvin) {
			t.Fatalf("color %v, want %v", target.Kelvin, v.kelvin)
		}
		requireEqual(t, p.Progress, v.progress)
	}
	p := EvaluatePlan(s, localClock(0, 0, 0))
	requireEqual(t, p.StartsAt, localClock(23, 0, 0).AddDate(0, 0, -1))
	requireEqual(t, p.NextAt, localClock(8, 0, 0))
	if _, ok := p.Target("missing", nil); ok {
		t.Fatal("missing device invented")
	}
	s.Schedule = []PlanPoint{{MinuteOfDay: 120, SceneId: "day", TransitionMinutes: 0}}
	p = EvaluatePlan(s, localClock(2, 0, 0))
	requireEqual(t, p.Progress, 1.0)
	requireEqual(t, p.NextAt, localClock(2, 0, 0).AddDate(0, 0, 1))
	s.Schedule[0].TransitionMinutes = 1440
	if err := Validate(s); err != nil {
		t.Fatal(err)
	}
	s.Schedule[0].TransitionMinutes = 1441
	if err := Validate(s); err == nil {
		t.Fatal("overlap accepted")
	}
	s.ScheduleEnabled = false
	if EvaluatePlan(s, localClock(0, 0, 0)) != nil {
		t.Fatal("disabled plan evaluated")
	}
	s.ScheduleEnabled = true
	s.Schedule = []PlanPoint{}
	if EvaluatePlan(s, localClock(0, 0, 0)) != nil {
		t.Fatal("empty plan evaluated")
	}
}

func TestManualHoldLiveHandoffAndSleep(t *testing.T) {
	s := planFixture()
	current := map[string]DisplayTarget{"a": {Brightness: 60, Kelvin: ptr(5000)}, "offline": {Brightness: 17}}
	state := HoldManual(s, ScheduleState{}, localClock(22, 59, 0))
	r, err := EvaluateSchedule(s, state, localClock(22, 59, 59), []string{"a"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, r.Held, true)
	requireEqual(t, r.Targets["a"].Brightness, 60)
	r, err = EvaluateSchedule(s, state, localClock(23, 0, 0), []string{"a"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, r.ApplyBehavior, true)
	requireEqual(t, r.Targets["a"].Brightness, 60)
	r, err = EvaluateSchedule(r.Settings, r.State, localClock(0, 0, 0).AddDate(0, 0, 1), []string{"a"}, r.Targets)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, r.ApplyBehavior, false)
	requireEqual(t, r.Targets["a"].Brightness, 40)
	requireEqual(t, *r.Targets["a"].Kelvin, 4100)
	requireEqual(t, r.Targets["offline"].Brightness, 17)
	r, err = EvaluateSchedule(s, state, localClock(0, 0, 0).AddDate(0, 0, 1), []string{"a"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, r.Targets["a"].Brightness, 50) // missed live node, canonical
	r, err = EvaluateSchedule(s, ResumePlan(), localClock(0, 0, 0).AddDate(0, 0, 1), []string{"a"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, r.Targets["a"].Brightness, 50)
	s.ScheduleEnabled = false
	if HoldManual(s, ScheduleState{}, localClock(0, 0, 0)).ManualUntil != nil {
		t.Fatal("hold invented without a plan")
	}
}

func TestSceneDefaultsPlanIdentityAndIsolation(t *testing.T) {
	s := planFixture()
	s.ControlledDisplayIds = []string{}
	s.FocusEnabled = true
	s.Scenes[0].Behavior = nil
	s = WithSceneDefaults(s)
	if s.Scenes[0].Behavior.ControlledDisplayIds == nil || !s.Scenes[0].Behavior.FocusEnabled {
		t.Fatal("old behavior did not inherit current rules")
	}
	next := s.Clone()
	next.Language = "en"
	next.FocusEnabled = false
	next.Scenes[0].Name = "renamed"
	next.Schedule[0], next.Schedule[1] = next.Schedule[1], next.Schedule[0]
	if !SamePlanDefinition(s, next) {
		t.Fatal("unrelated save/reorder replays the plan")
	}
	state := HoldManual(s, ScheduleState{}, localClock(22, 0, 0))
	reconciled := ReconcileSchedule(state, s, next)
	if reconciled.ManualUntil == nil {
		t.Fatal("unrelated save cleared hold")
	}
	next.Scenes[0].Behavior.ControlledDisplayIds = nil
	if SamePlanDefinition(s, next) {
		t.Fatal("null and empty focus sets collapsed")
	}
	if ReconcileSchedule(state, s, next).ManualUntil != nil {
		t.Fatal("changed behavior did not clear hold")
	}
	next = s.Clone()
	next.Scenes[0].Targets["a"] = DisplayTarget{Brightness: 10}
	if SamePlanDefinition(s, next) {
		t.Fatal("target edit ignored")
	}
	if _, err := DeleteScene(s, "day"); err == nil {
		t.Fatal("referenced scene removed")
	}
	b := CaptureBehavior(s)
	b.ControlledDisplayIds = []string{"x", "y", "x"}
	other := b.Clone()
	other.ControlledDisplayIds = []string{"y", "x"}
	if !b.Equal(other) {
		t.Fatal("focus list order should not affect rules")
	}
	defaults := DefaultScenes(s, []DisplayState{{Id: "real", Brightness: 61, CanAdjustColor: true}}, [4]string{"one", "two", "three", "four"})
	requireEqual(t, defaults[1].Targets["real"].Brightness, 61)
	requireEqual(t, defaults[3].Targets["real"].Brightness, 24)
	requireEqual(t, defaults[0].Name, "早晨")
	defaults[0].Targets["real"] = DisplayTarget{Brightness: 1}
	requireEqual(t, defaults[1].Targets["real"].Brightness, 61)
	before, _ := json.Marshal(s)
	copy := s.Clone()
	*copy.Scenes[1].Targets["a"].Kelvin = 4000
	copy.Scenes[0].Behavior.ControlledDisplayIds = append(copy.Scenes[0].Behavior.ControlledDisplayIds, "new")
	after, _ := json.Marshal(s)
	if !bytes.Equal(before, after) {
		t.Fatal("clone mutated source")
	}
}

func TestSceneAndPlanCalibratedSourcePrecedence(t *testing.T) {
	s := planFixture()
	s.BrightnessLinkCalibration = testCurve()
	s.Linked = true
	s.LinkWeights = map[string]float64{"external": 1, "internal": 1}
	current := map[string]DisplayTarget{"external": {Brightness: 98}, "internal": {Brightness: 100}, "offline": {Brightness: 17}}
	scene := CaptureScene(s, "matched", "Matched", map[string]DisplayTarget{"external": {Brightness: 20}, "internal": {Brightness: 90}})
	next, targets, _, err := ApplyScene(s, scene, []string{"external", "internal"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, targets["internal"].Brightness, 35)
	requireEqual(t, targets["offline"].Brightness, 17)
	scene.Targets = map[string]DisplayTarget{"internal": {Brightness: 100}}
	_, targets, _, err = ApplyScene(next, scene, []string{"external", "internal"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, targets["external"].Brightness, 98)
	s.Scenes = []Scene{scene}
	s.Schedule = []PlanPoint{{MinuteOfDay: 0, SceneId: "matched", TransitionMinutes: 0}}
	r, err := EvaluateSchedule(s, ScheduleState{}, localClock(12, 0, 0), []string{"external", "internal"}, current)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, r.Targets["external"].Brightness, 98)
}

func TestValidationRejectsBadRules(t *testing.T) {
	for _, mutate := range []func(*Settings){
		func(s *Settings) { s.SchemaVersion = 2 }, func(s *Settings) { s.Language = "unknown" }, func(s *Settings) { s.FocusDelaySeconds = 601 },
		func(s *Settings) { s.EdgeWheelModifier = "win" }, func(s *Settings) { s.LinkWeights["a"] = 0 }, func(s *Settings) { s.Schedule = append(s.Schedule, s.Schedule[0]) },
		func(s *Settings) { s.Schedule[0].SceneId = "missing" }, func(s *Settings) { s.Schedule[1].TransitionMinutes = 541 },
		func(s *Settings) { s.Scenes[0].Targets["a"] = DisplayTarget{Brightness: 101} }, func(s *Settings) { s.Scenes[0].Targets["a"] = DisplayTarget{Kelvin: ptr(2699)} },
		func(s *Settings) { s.Scenes[1].Id = s.Scenes[0].Id }, func(s *Settings) { s.Scenes[0].Name = " " },
	} {
		s := planFixture()
		mutate(&s)
		if err := Validate(s); err == nil {
			t.Fatal("invalid rules accepted")
		}
	}
}

// Measure a regular tick after a node's behavior has already been applied.
func BenchmarkScheduleSteadyTick(b *testing.B) {
	s := planFixture()
	now := localClock(12, 0, 0)
	ids := []string{"a"}
	targets := map[string]DisplayTarget{"a": {Brightness: 60}}
	first, err := EvaluateSchedule(s, ScheduleState{}, now, ids, targets)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := EvaluateSchedule(first.Settings, first.State, now, ids, first.Targets); err != nil {
			b.Fatal(err)
		}
	}
}
