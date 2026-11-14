package domain

import (
	"encoding/json"
	"testing"
)

func TestGlobalScheduleDurationEmptyRoundTrip(t *testing.T) {
	s := DefaultSettings()
	s.ScheduleTransitionMinutes = ptr(45)
	if err := Validate(s); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var restored Settings
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.ScheduleTransitionMinutes == nil || *restored.ScheduleTransitionMinutes != 45 || len(restored.Schedule) != 0 {
		t.Fatalf("duration lost on empty schedule: %s", data)
	}
	copy := restored.Clone()
	*copy.ScheduleTransitionMinutes = 60
	if *restored.ScheduleTransitionMinutes != 45 {
		t.Fatal("clone shares duration pointer")
	}
}

func TestGlobalScheduleDurationLegacyAndBounds(t *testing.T) {
	s := DefaultSettings()
	s.Scenes = []Scene{{Id: "one", Name: "One", Targets: map[string]DisplayTarget{}}}
	s.Schedule = []PlanPoint{{MinuteOfDay: 360, SceneId: "one", TransitionMinutes: 20}, {MinuteOfDay: 720, SceneId: "one", TransitionMinutes: 30}}
	data, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	var restored Settings
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.ScheduleTransitionMinutes != nil || restored.Schedule[0].TransitionMinutes != 20 || restored.Schedule[1].TransitionMinutes != 30 {
		t.Fatal("legacy durations changed during decode")
	}
	for _, value := range []int{-1, 0, 1440, 1441} {
		s.ScheduleTransitionMinutes = ptr(value)
		err := Validate(s)
		if (err == nil) != (value >= 0 && value <= 1440) {
			t.Fatalf("unexpected validation for %d: %v", value, err)
		}
	}
}
