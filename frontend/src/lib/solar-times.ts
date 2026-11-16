import { useEffect, useMemo, useState } from 'react'
import { isDesktop, request } from './control'
import type { SolarLocation, SolarTimes } from './control'

export function localDate() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
export function sameSolarLocation(a: SolarLocation | null | undefined, b: SolarLocation | null | undefined) {
  return !!a && !!b && a.Latitude === b.Latitude && a.Longitude === b.Longitude
}

export function useSolarTimes(location: SolarLocation | null, initial: SolarTimes | undefined, active: boolean) {
  // Scalars prevent status snapshots or unrelated edits from restarting a query.
  const latitude = location?.Latitude, longitude = location?.Longitude, name = location?.Name
  const city = useMemo(() => latitude != null && longitude != null && name != null ? { Latitude: latitude, Longitude: longitude, Name: name } : null, [latitude, longitude, name])
  const [sample, setSample] = useState<SolarTimes | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active || !city) return
    let cancelled = false, date = ''
    let midnight: ReturnType<typeof setTimeout>
    async function refresh() {
      const today = localDate()
      if (date === today) return
      date = today
      setFailed(false)
      try {
        let result: SolarTimes | undefined
        if (isDesktop) result = (await request({ Action: 'solar-times', SolarLocation: city! })).SolarTimes
        else if (new URLSearchParams(window.location.search).get('preview') === '1') {
          // Existing explicit browser demo only. Production always uses the Go
          // calculator; these sample times are never persisted or used by hardware.
          const days = [-1, 0, 1].map(offset => {
            const rise = new Date(); rise.setDate(rise.getDate() + offset); rise.setHours(6, 30, 0, 0)
            const set = new Date(rise); set.setHours(17, 30, 0, 0)
            return { Sunrise: rise.toISOString(), Sunset: set.toISOString() }
          })
          result = { Date: today, Location: city!, Sunrise: 390, Sunset: 1050, Days: days }
        }
        if (!result || result.Date !== today || !sameSolarLocation(result.Location, city)) throw new Error('Invalid solar times')
        if (!cancelled) setSample(result)
      } catch { if (!cancelled) setFailed(true) }
      finally {
        if (!cancelled) {
          const next = new Date(); next.setHours(24, 0, 1, 0)
          midnight = setTimeout(() => void refresh(), Math.max(1000, next.getTime() - Date.now()))
        }
      }
    }
    const visible = () => { if (!document.hidden) void refresh() }
    void refresh()
    document.addEventListener('visibilitychange', visible)
    return () => { cancelled = true; clearTimeout(midnight); document.removeEventListener('visibilitychange', visible) }
  }, [city, active])
  const today = localDate()
  const result = [sample, initial].find(value => value?.Date === today && sameSolarLocation(value.Location, city)) ?? null
  return { times: result, failed }
}
