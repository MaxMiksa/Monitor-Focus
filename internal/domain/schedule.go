package domain

import (
	"maps"
	"slices"
	"time"
)

type PlanResult struct {
	StartsAt time.Time
	NextAt   time.Time
	Scene    Scene
	Prior    Scene
	Progress float64
}

// EvaluatePlan expects validated settings and the host's local wall clock. It
// inspects neighboring nodes only; startup/resume never replays missed frames.
func EvaluatePlan(s Settings, now time.Time) *PlanResult {
	if !s.ScheduleEnabled || len(s.Schedule) == 0 {
		return nil
	}
	var current, previous PlanPoint
	var startsAt, nextAt, priorAt time.Time
	for _, p := range s.Schedule {
		at := nodeOnDate(now, p.MinuteOfDay)
		prev, next := at, at
		if prev.After(now) {
			prev = nodeOnDate(now.AddDate(0, 0, -1), p.MinuteOfDay)
		}
		if !next.After(now) {
			next = nodeOnDate(now.AddDate(0, 0, 1), p.MinuteOfDay)
		}
		if startsAt.IsZero() || prev.After(startsAt) {
			startsAt, current = prev, p
		}
		if nextAt.IsZero() || next.Before(nextAt) {
			nextAt = next
		}
	}
	for _, p := range s.Schedule {
		at := nodeOnDate(startsAt, p.MinuteOfDay)
		if !at.Before(startsAt) {
			at = nodeOnDate(startsAt.AddDate(0, 0, -1), p.MinuteOfDay)
		}
		if priorAt.IsZero() || at.After(priorAt) {
			priorAt, previous = at, p
		}
	}
	r := &PlanResult{StartsAt: startsAt, NextAt: nextAt, Progress: 1}
	for _, scene := range s.Scenes {
		if scene.Id == current.SceneId {
			r.Scene = scene
		}
		if scene.Id == previous.SceneId {
			r.Prior = scene
		}
	}
	if current.TransitionMinutes > 0 {
		t := min(max(now.Sub(startsAt).Minutes()/float64(current.TransitionMinutes), 0), 1)
		r.Progress = t * t * (3 - 2*t)
	}
	return r
}

func nodeOnDate(day time.Time, minute int) time.Time {
	return time.Date(day.Year(), day.Month(), day.Day(), minute/60, minute%60, 0, 0, day.Location())
}

// Target interpolates null color against native white (6500) and restores null
// exactly at a native endpoint. A missing current target never erases an offline
// target. origins is used only for a live manual handoff.
func (r PlanResult) Target(id string, origins map[string]DisplayTarget) (DisplayTarget, bool) {
	target, ok := r.Scene.Targets[id]
	if !ok {
		return DisplayTarget{}, false
	}
	from, ok := origins[id]
	if !ok {
		from, ok = r.Prior.Targets[id]
		if !ok {
			from = target
		}
	}
	result := DisplayTarget{Brightness: rounded(float64(from.Brightness) + float64(target.Brightness-from.Brightness)*r.Progress)}
	if r.Progress <= 0 {
		result.Kelvin = clonePointer(from.Kelvin)
	} else if r.Progress >= 1 {
		result.Kelvin = clonePointer(target.Kelvin)
	} else if from.Kelvin != nil || target.Kelvin != nil {
		start, end := 6500, 6500
		if from.Kelvin != nil {
			start = *from.Kelvin
		}
		if target.Kelvin != nil {
			end = *target.Kelvin
		}
		value := rounded(float64(start) + float64(end-start)*r.Progress)
		result.Kelvin = &value
	}
	return result, true
}

// SamePlanDefinition ignores list order, scene names and unrelated settings, so
// saving a language/focus change or a reorder does not clear a manual hold.
func SamePlanDefinition(a, b Settings) bool {
	if a.ScheduleEnabled != b.ScheduleEnabled {
		return false
	}
	left, right := slices.Clone(a.Schedule), slices.Clone(b.Schedule)
	compare := func(a, b PlanPoint) int { return a.MinuteOfDay - b.MinuteOfDay }
	slices.SortFunc(left, compare)
	slices.SortFunc(right, compare)
	if !slices.Equal(left, right) {
		return false
	}
	for _, p := range left {
		var first, second *Scene
		for i := range a.Scenes {
			if a.Scenes[i].Id == p.SceneId {
				first = &a.Scenes[i]
				break
			}
		}
		for i := range b.Scenes {
			if b.Scenes[i].Id == p.SceneId {
				second = &b.Scenes[i]
				break
			}
		}
		if first == nil || second == nil || !maps.EqualFunc(first.Targets, second.Targets, func(x, y DisplayTarget) bool {
			return x.Brightness == y.Brightness && equalIntPointer(x.Kelvin, y.Kelvin)
		}) {
			return false
		}
		lb, rb := CaptureBehavior(a), CaptureBehavior(b)
		if first.Behavior != nil {
			lb = *first.Behavior
		}
		if second.Behavior != nil {
			rb = *second.Behavior
		}
		if !lb.Equal(rb) {
			return false
		}
	}
	return true
}
func equalIntPointer(a, b *int) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// ScheduleState is explicit per-host session state, never persisted in Settings.
type ScheduleState struct {
	ManualUntil    *time.Time
	ActivePlanAt   *time.Time
	TransitionFrom map[string]DisplayTarget
}
type ScheduleEvaluation struct {
	State           ScheduleState
	Settings        Settings
	Targets         map[string]DisplayTarget
	Plan            *PlanResult
	ApplyBehavior   bool // true once per node: host resets focus even if rules equal
	BehaviorChanged bool // host may need to persist the returned Settings
	Held            bool
}

func HoldManual(s Settings, state ScheduleState, now time.Time) ScheduleState {
	state.ManualUntil = nil
	if p := EvaluatePlan(s, now); p != nil {
		state.ManualUntil = clonePointer(&p.NextAt)
	}
	return state
}
func ResumePlan() ScheduleState { return ScheduleState{} }
func ReconcileSchedule(state ScheduleState, old, next Settings) ScheduleState {
	if !SamePlanDefinition(old, next) {
		return ScheduleState{}
	}
	return state
}

// EvaluateSchedule is a pure reducer. On a live node (within two seconds) manual
// targets become fade origins. After startup/sleep use canonical plan values.
// Calls during a fade do not keep applying behavior or resetting focus timers.
func EvaluateSchedule(s Settings, state ScheduleState, now time.Time, available []string, current map[string]DisplayTarget) (ScheduleEvaluation, error) {
	r := ScheduleEvaluation{State: state, Settings: s.Clone(), Targets: CloneTargets(current), Plan: EvaluatePlan(s, now)}
	if r.Plan == nil {
		return r, nil
	}
	if state.ManualUntil != nil && now.Before(*state.ManualUntil) {
		r.Held = true
		return r, nil
	}
	p := r.Plan
	if state.ActivePlanAt == nil || !state.ActivePlanAt.Equal(p.StartsAt) {
		r.State.TransitionFrom = nil
		if state.ManualUntil != nil && state.ManualUntil.Equal(p.StartsAt) && now.Sub(p.StartsAt) <= 2*time.Second {
			r.State.TransitionFrom = CloneTargets(current)
		}
		b := CaptureBehavior(s)
		if p.Scene.Behavior != nil {
			b = *p.Scene.Behavior
		}
		r.Settings, r.BehaviorChanged = ApplyBehavior(s, b)
		r.ApplyBehavior = true
		r.State.ActivePlanAt = clonePointer(&p.StartsAt)
	}
	r.State.ManualUntil = nil
	for id := range p.Scene.Targets {
		target, _ := p.Target(id, r.State.TransitionFrom)
		r.Targets[id] = target
	}
	var err error
	r.Targets, err = ApplyCalibratedLink(r.Settings, available, r.Targets, p.Scene.Targets)
	return r, err
}
