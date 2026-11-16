import type { PlanPoint, SolarTimes } from './control'

export type ScheduleNode = PlanPoint & { key: ReturnType<typeof crypto.randomUUID> }
export const timeLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export const isSolarPoint = (point: PlanPoint) => point.TimeKind === 'sunrise' || point.TimeKind === 'sunset'

// Mixed solar schedules shorten effective transitions, without changing drafts.
export function validSchedule(points: PlanPoint[]) {
  if (points.some(point => point.TimeKind && !['fixed', 'sunrise', 'sunset'].includes(point.TimeKind))) return false
  if (points.some(point => !Number.isInteger(point.MinuteOfDay) || point.MinuteOfDay < 0 || point.MinuteOfDay >= 1440 || !Number.isInteger(point.TransitionMinutes) || point.TransitionMinutes < 0 || point.TransitionMinutes > 1440 || !Number.isInteger(point.OffsetMinutes ?? 0) || Math.abs(point.OffsetMinutes ?? 0) > 720 || (!isSolarPoint(point) && !!point.OffsetMinutes))) return false
  if (points.some(isSolarPoint)) {
    const fixed = points.filter(point => !isSolarPoint(point)).map(point => point.MinuteOfDay)
    return new Set(fixed).size === fixed.length
  }
  const sorted = [...points].sort((a, b) => a.MinuteOfDay - b.MinuteOfDay)
  return sorted.every((point, i) => Number.isInteger(point.MinuteOfDay) && point.MinuteOfDay >= 0 && point.MinuteOfDay < 1440 &&
    (i === 0 || sorted[i - 1].MinuteOfDay !== point.MinuteOfDay) && point.TransitionMinutes >= 0 &&
    point.TransitionMinutes <= ((sorted[(i + 1) % sorted.length].MinuteOfDay - point.MinuteOfDay + 1440) % 1440 || 1440))
}

export function moveScheduleNode(points: ScheduleNode[], key: string, minute: number) {
  return points.map(point => point.key === key ? { ...point, MinuteOfDay: minute, TimeKind: undefined, OffsetMinutes: undefined } : point)
}

export function solarMinute(point: PlanPoint, times: SolarTimes | null) {
  if (!isSolarPoint(point)) return point.MinuteOfDay
  if (!times) return null
  for (const day of times.Days) {
    const instant = point.TimeKind === 'sunrise' ? day.Sunrise : day.Sunset
    if (!instant) continue
    const at = new Date(Date.parse(instant) + (point.OffsetMinutes ?? 0) * 60_000)
    const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    if (date === times.Date) return at.getHours() * 60 + at.getMinutes()
  }
  return null
}

export function resolveSchedule(nodes: ScheduleNode[], times: SolarTimes | null) {
  const unresolved: ScheduleNode[] = []
  const sorted = nodes.flatMap(point => {
    const minute = solarMinute(point, times)
    if (minute === null) { unresolved.push(point); return [] }
    return [{ ...point, MinuteOfDay: minute }]
  }).sort((a, b) => a.MinuteOfDay - b.MinuteOfDay || priority(a) - priority(b))
  const merged = sorted.filter((point, i) => i > 0 && point.MinuteOfDay === sorted[i - 1].MinuteOfDay)
  const points = sorted.filter((point, i) => !i || point.MinuteOfDay !== sorted[i - 1].MinuteOfDay)
  let shortened = false
  const effective = points.map((point, i) => {
    const gap = (points[(i + 1) % points.length].MinuteOfDay - point.MinuteOfDay + 1440) % 1440 || 1440
    const duration = nodes.some(isSolarPoint) ? Math.min(point.TransitionMinutes, gap) : point.TransitionMinutes
    shortened ||= duration !== point.TransitionMinutes
    return { ...point, TransitionMinutes: duration }
  })
  return { points: effective, unresolved, merged, adjusted: shortened || points.length !== sorted.length }
}
function priority(point: PlanPoint) { return !isSolarPoint(point) ? 0 : point.TimeKind === 'sunrise' ? 1 : 2 }
