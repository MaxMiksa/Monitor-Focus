package domain

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	sunrise "github.com/nathan-osman/go-sunrise"
)

type SolarLocation struct {
	Name      string
	Latitude  float64
	Longitude float64
}

func (l SolarLocation) Validate() error {
	if strings.TrimSpace(l.Name) == "" || len([]rune(l.Name)) > 160 || math.IsNaN(l.Latitude) || math.IsInf(l.Latitude, 0) || math.Abs(l.Latitude) > 90 || math.IsNaN(l.Longitude) || math.IsInf(l.Longitude, 0) || math.Abs(l.Longitude) > 180 {
		return fmt.Errorf("invalid solar location")
	}
	return nil
}

func equalSolarLocation(a, b *SolarLocation) bool {
	return a == nil && b == nil || a != nil && b != nil && a.Latitude == b.Latitude && a.Longitude == b.Longitude
}
func (p PlanPoint) IsSolar() bool { return p.TimeKind == "sunrise" || p.TimeKind == "sunset" }
func HasSolarPoints(s Settings) bool {
	return slices.ContainsFunc(s.Schedule, func(p PlanPoint) bool { return p.IsSolar() })
}

// Times are minutes on the physical host's local day, exactly like fixed nodes.
// Nil means no event on that day (including polar day/night), never a fallback.
type SolarEvents struct {
	Sunrise *time.Time
	Sunset  *time.Time
}

type SolarTimes struct {
	Days     [3]SolarEvents
	Date     string
	Location SolarLocation
	Sunrise  *int
	Sunset   *int
}
type solarDay struct{ day, rise, set time.Time }

// A fixed five-day window supports previous/prior/next events and ±12h offsets.
// It is refreshed only on a new date, location or local-zone offset, not per tick.
type SolarCache struct {
	date     string
	location SolarLocation
	zone     *time.Location
	offset   int
	days     [5]solarDay
	events   []solarOccurrence
	plan     []PlanPoint
}

func (c *SolarCache) refresh(location *SolarLocation, now time.Time) bool {
	if location == nil || location.Validate() != nil {
		return false
	}
	date := now.Format("2006-01-02")
	_, offset := now.Zone()
	if c.date == date && c.location.Latitude == location.Latitude && c.location.Longitude == location.Longitude && c.zone == now.Location() && c.offset == offset {
		return true
	}
	c.date, c.location, c.zone, c.offset = date, *location, now.Location(), offset
	c.events, c.plan = nil, nil
	for i := range c.days {
		day := nodeOnDate(now.AddDate(0, 0, i-2), 0)
		entry := solarDay{day: day}
		// The library uses the astronomical day at the selected longitude.
		// Search adjacent dates to select instants belonging to the host day.
		for delta := -1; delta <= 1; delta++ {
			candidate := day.AddDate(0, 0, delta)
			rise, set := sunrise.SunriseSunset(location.Latitude, location.Longitude, candidate.Year(), candidate.Month(), candidate.Day())
			for index, event := range []time.Time{rise, set} {
				if event.IsZero() {
					continue
				}
				event = event.Round(time.Minute).In(now.Location())
				if event.Before(day) || !event.Before(day.AddDate(0, 0, 1)) {
					continue
				}
				if index == 0 {
					entry.rise = event
				} else {
					entry.set = event
				}
			}
		}
		c.days[i] = entry
	}
	return true
}

func (c *SolarCache) Today(location *SolarLocation, now time.Time) *SolarTimes {
	if !c.refresh(location, now) {
		return nil
	}
	result := &SolarTimes{Date: c.date, Location: *location}
	for i := range result.Days {
		if at := c.days[i+1].rise; !at.IsZero() {
			value := at
			result.Days[i].Sunrise = &value
		}
		if at := c.days[i+1].set; !at.IsZero() {
			value := at
			result.Days[i].Sunset = &value
		}
	}
	if at := c.days[2].rise; !at.IsZero() {
		value := at.Hour()*60 + at.Minute()
		result.Sunrise = &value
	}
	if at := c.days[2].set; !at.IsZero() {
		value := at.Hour()*60 + at.Minute()
		result.Sunset = &value
	}
	return result
}

type solarOccurrence struct {
	at    time.Time
	point PlanPoint
	order int
}

func solarPriority(p PlanPoint) int {
	if !p.IsSolar() {
		return 0
	}
	if p.TimeKind == "sunrise" {
		return 1
	}
	return 2
}

func evaluateSolarPlan(s Settings, now time.Time, cache *SolarCache) *PlanResult {
	if !s.ScheduleEnabled || !cache.refresh(s.SolarLocation, now) {
		return nil
	}
	if c := cache; c.events == nil || !slices.Equal(c.plan, s.Schedule) {
		events := make([]solarOccurrence, 0, len(s.Schedule)*5)
		for _, day := range cache.days {
			for index, p := range s.Schedule {
				at := nodeOnDate(day.day, p.MinuteOfDay)
				if p.IsSolar() {
					at = day.rise
					if p.TimeKind == "sunset" {
						at = day.set
					}
					if at.IsZero() {
						continue
					}
					at = at.Add(time.Duration(p.OffsetMinutes) * time.Minute)
				}
				events = append(events, solarOccurrence{at, p, index})
			}
		}
		slices.SortStableFunc(events, func(a, b solarOccurrence) int {
			if n := a.at.Compare(b.at); n != 0 {
				return n
			}
			if n := solarPriority(a.point) - solarPriority(b.point); n != 0 {
				return n
			}
			return a.order - b.order
		})
		events = slices.CompactFunc(events, func(a, b solarOccurrence) bool { return a.at.Equal(b.at) })
		c.events, c.plan = events, slices.Clone(s.Schedule)
	}
	events := cache.events
	index := slices.IndexFunc(events, func(e solarOccurrence) bool { return e.at.After(now) }) - 1
	if index < 0 || index+1 >= len(events) {
		return nil
	}
	current, next := events[index], events[index+1]
	prior := current
	if index > 0 {
		prior = events[index-1]
	}
	result := &PlanResult{StartsAt: current.at, NextAt: next.at, Progress: 1}
	for _, scene := range s.Scenes {
		if scene.Id == current.point.SceneId {
			result.Scene = scene
		}
		if scene.Id == prior.point.SceneId {
			result.Prior = scene
		}
	}
	duration := min(float64(current.point.TransitionMinutes), next.at.Sub(current.at).Minutes())
	if duration > 0 {
		fraction := min(max(now.Sub(current.at).Minutes()/duration, 0), 1)
		result.Progress = fraction * fraction * (3 - 2*fraction)
	}
	return result
}
