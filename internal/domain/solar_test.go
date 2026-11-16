package domain

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func solarFixture() Settings {
	s := planFixture()
	s.SolarLocation = &SolarLocation{Name: "深圳南山", Latitude: 22.5333, Longitude: 113.9333}
	s.Schedule = []PlanPoint{{TimeKind: "sunrise", SceneId: "day", TransitionMinutes: 30}, {TimeKind: "sunset", SceneId: "night", TransitionMinutes: 30}}
	return s
}

func TestSolarDayCacheAndLocation(t *testing.T) {
	s, now := solarFixture(), localClock(12, 0, 0)
	var c SolarCache
	times := c.Today(s.SolarLocation, now)
	if times == nil || times.Sunrise == nil || times.Sunset == nil || *times.Sunrise < 360 || *times.Sunrise > 450 || *times.Sunset < 1020 || *times.Sunset > 1140 {
		t.Fatalf("unexpected Shenzhen times: %+v", times)
	}
	days := c.days
	c.Today(s.SolarLocation, now.Add(time.Hour))
	if c.days != days {
		t.Fatal("same-day calendar changed")
	}
	*times.Sunrise = 0
	*times.Days[1].Sunrise = time.Time{}
	if c.Today(s.SolarLocation, now).Days[1].Sunrise.IsZero() {
		t.Fatal("snapshot aliases cache")
	}
	c.Today(s.SolarLocation, now.AddDate(0, 0, 1))
	if c.days[2].day == days[2].day {
		t.Fatal("date not refreshed")
	}
	west := &SolarLocation{Name: "乌鲁木齐", Latitude: 43.82, Longitude: 87.62}
	if *c.Today(west, now).Sunrise == *c.Today(s.SolarLocation, now).Sunrise {
		t.Fatal("location not refreshed")
	}
}

func TestSolarShorteningAndSameMinuteFixedPriority(t *testing.T) {
	s, now := solarFixture(), localClock(12, 0, 0)
	var c SolarCache
	at := *c.Today(s.SolarLocation, now).Days[1].Sunrise
	s.Schedule = []PlanPoint{{TimeKind: "sunrise", SceneId: "day", TransitionMinutes: 180}, {MinuteOfDay: at.Hour()*60 + at.Minute() + 20, SceneId: "night", TransitionMinutes: 0}}
	if err := Validate(s); err != nil {
		t.Fatal(err)
	}
	p := evaluatePlan(s, at.Add(10*time.Minute), &c)
	if p == nil || math.Abs(p.Progress-.5) > .000001 || p.Scene.Id != "day" || !p.NextAt.Equal(at.Add(20*time.Minute)) {
		t.Fatalf("bad shortening: %+v", p)
	}
	events := &c.events[0]
	evaluatePlan(s, at.Add(11*time.Minute), &c)
	if events != &c.events[0] {
		t.Fatal("events rebuilt within the day")
	}
	if s.Schedule[0].TransitionMinutes != 180 {
		t.Fatal("configured duration modified")
	}
	s.Schedule[1].MinuteOfDay -= 20
	p = evaluatePlan(s, at, &c)
	if p == nil || p.Scene.Id != "night" {
		t.Fatalf("fixed did not win: %+v", p)
	}
}

func TestSolarPreviousDayOffsetAndManualHold(t *testing.T) {
	s, now := solarFixture(), localClock(3, 0, 0)
	s.Schedule[1].OffsetMinutes = 720
	var c SolarCache
	c.refresh(s.SolarLocation, now)
	expected := c.days[1].set.Add(12 * time.Hour)
	p := evaluatePlan(s, expected.Add(time.Minute), &c)
	if p == nil || !p.StartsAt.Equal(expected) || p.Scene.Id != "night" {
		t.Fatalf("wrong prior-day sunset: %+v vs %v", p, expected)
	}
	state := HoldManual(s, ScheduleState{}, expected.Add(time.Minute))
	if state.ManualUntil == nil || !state.ManualUntil.Equal(p.NextAt) {
		t.Fatal("hold does not follow solar event")
	}
	result, err := EvaluateSchedule(s, state, expected.Add(2*time.Minute), []string{"a"}, map[string]DisplayTarget{"a": {Brightness: 42}})
	if err != nil || !result.Held || result.Targets["a"].Brightness != 42 {
		t.Fatal("manual hold lost")
	}
	result, err = EvaluateSchedule(s, state, *state.ManualUntil, []string{"a"}, map[string]DisplayTarget{"a": {Brightness: 42}})
	if err != nil || result.Held || result.Plan == nil || !result.ApplyBehavior || result.State.TransitionFrom["a"].Brightness != 42 {
		t.Fatal("live solar handoff lost")
	}
}

func TestSolarPolarAndForeignLongitude(t *testing.T) {
	s := solarFixture()
	s.SolarLocation = &SolarLocation{Name: "Tromsø", Latitude: 69.65, Longitude: 18.96}
	now := time.Date(2026, 6, 21, 12, 0, 0, 0, testLocation)
	var c SolarCache
	times := c.Today(s.SolarLocation, now)
	if times.Sunrise != nil || times.Sunset != nil || evaluatePlan(s, now, &c) != nil {
		t.Fatal("polar events fabricated")
	}
	s.Schedule = append(s.Schedule, PlanPoint{MinuteOfDay: 600, SceneId: "day"})
	if evaluatePlan(s, now, &c) == nil {
		t.Fatal("polar day removed fixed plan")
	}
	for _, lon := range []float64{-179, 179, -75, 120} {
		s.SolarLocation = &SolarLocation{Name: "test", Latitude: 20, Longitude: lon}
		result := c.Today(s.SolarLocation, localClock(12, 0, 0))
		for _, at := range []*time.Time{result.Days[1].Sunrise, result.Days[1].Sunset} {
			if at == nil || at.Format("2006-01-02") != result.Date {
				t.Fatalf("event outside host day: %v", at)
			}
		}
	}
}

func TestSolarPersistenceValidationAndDefinition(t *testing.T) {
	s := solarFixture()
	s.Schedule[0].OffsetMinutes = -30
	raw, _ := json.Marshal(s)
	restored, err := DecodeSettings(raw)
	if err != nil || restored.SolarLocation == nil || restored.Schedule[0].OffsetMinutes != -30 || restored.Schedule[0].TimeKind != "sunrise" {
		t.Fatalf("solar roundtrip: %s %v", raw, err)
	}
	clone := s.Clone()
	clone.SolarLocation.Latitude = 30
	if s.SolarLocation.Latitude == 30 || SamePlanDefinition(s, clone) {
		t.Fatal("location draft aliases or definition ignored")
	}
	clone = s.Clone()
	clone.Schedule[0], clone.Schedule[1] = clone.Schedule[1], clone.Schedule[0]
	if !SamePlanDefinition(s, clone) {
		t.Fatal("reorder changes solar definition")
	}
	for _, change := range []func(*Settings){
		func(s *Settings) { s.SolarLocation = nil },
		func(s *Settings) { s.SolarLocation.Latitude = math.NaN() },
		func(s *Settings) { s.Schedule[0].OffsetMinutes = 721 },
		func(s *Settings) { s.Schedule[0].TimeKind = "moonrise" },
		func(s *Settings) {
			s.Schedule = append(s.Schedule, PlanPoint{MinuteOfDay: 600, SceneId: "day"}, PlanPoint{MinuteOfDay: 600, SceneId: "night"})
		},
	} {
		bad := s.Clone()
		change(&bad)
		if Validate(bad) == nil {
			t.Fatal("invalid solar settings accepted")
		}
	}
}
