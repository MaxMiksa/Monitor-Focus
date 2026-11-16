import type { PlanPoint } from './control'

export type ScheduleNode = PlanPoint & { key: ReturnType<typeof crypto.randomUUID> }
export const timeLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

// Keep the native scheduler's cyclic-day and transition constraints unchanged.
export function validSchedule(points: PlanPoint[]) {
  const sorted = [...points].sort((a, b) => a.MinuteOfDay - b.MinuteOfDay)
  return sorted.every((point, i) => Number.isInteger(point.MinuteOfDay) && point.MinuteOfDay >= 0 && point.MinuteOfDay < 1440 &&
    (i === 0 || sorted[i - 1].MinuteOfDay !== point.MinuteOfDay) && point.TransitionMinutes >= 0 &&
    point.TransitionMinutes <= ((sorted[(i + 1) % sorted.length].MinuteOfDay - point.MinuteOfDay + 1440) % 1440 || 1440))
}

export function moveScheduleNode(points: ScheduleNode[], key: string, minute: number) {
  return points.map(point => point.key === key ? { ...point, MinuteOfDay: minute } : point)
}
