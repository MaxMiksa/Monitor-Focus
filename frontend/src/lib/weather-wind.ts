export type WeatherWind = { speed: number; direction: number | null; gust: number | null; estimated: boolean }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function validWind(value: unknown): WeatherWind | null {
  if (!value || typeof value !== 'object') return null
  const wind = value as WeatherWind
  return finite(wind.speed) && wind.speed >= 0 && wind.speed <= 300
    && (wind.direction === null || finite(wind.direction) && wind.direction >= 0 && wind.direction <= 360)
    && (wind.gust === null || finite(wind.gust) && wind.gust >= 0 && wind.gust <= 400)
    && typeof wind.estimated === 'boolean' ? wind : null
}

export function openMeteoWind(value: unknown): WeatherWind | null {
  const current = value as Record<string, unknown> | undefined
  return validWind({ speed: current?.wind_speed_10m, direction: current?.wind_direction_10m ?? null,
    gust: current?.wind_gusts_10m ?? null, estimated: false })
}

export function domesticWind(data: Record<string, unknown>): WeatherWind | null {
  // The current source reports Beaufort force, not a measured km/h speed.
  // Midpoints are visual equivalents only; never use future hourly winds as current.
  const force = typeof data.wind_power === 'string' ? /^(\d{1,2})(?:[-~～至](\d{1,2}))?级$/u.exec(data.wind_power) : null
  const midpoints = [0, 3, 8.5, 15.5, 24, 33.5, 44, 55.5, 68, 81.5, 95.5, 110, 125]
  if (!force || Number(force[1]) > 12 || Number(force[2] ?? force[1]) > 12 || Number(force[1]) > Number(force[2] ?? force[1])) return null
  const directions: Record<string, number> = { 北风: 0, 东北风: 45, 东风: 90, 东南风: 135, 南风: 180, 西南风: 225, 西风: 270, 西北风: 315 }
  return { speed: (midpoints[Number(force[1])] + midpoints[Number(force[2] ?? force[1])]) / 2,
    direction: typeof data.wind_direction === 'string' ? directions[data.wind_direction] ?? null : null, gust: null, estimated: true }
}
