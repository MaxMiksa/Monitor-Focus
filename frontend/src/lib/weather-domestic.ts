import { validWeatherDetails, weatherDay } from './weather-details'
import type { WeatherDetails } from './weather-details'
import type { WeatherCity } from './weather'
import { domesticWind } from './weather-wind'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const temp = (value: unknown): value is number => finite(value) && value >= -100 && value <= 100
const region = (value: string) => value.replace(/(特别行政区|自治区|省|市|区|县)$/u, '')
const parts = (value: string) => value.split(/[·,，/\s]+/u).filter(Boolean).map(region)
const zone = 'Asia/Shanghai'

// Unknown conditions must fall back, not silently become clear or rain.
export function domesticCode(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const codes: Record<string, number> = { 晴: 0, 晴间多云: 1, 多云: 2, 阴: 3, 雾: 45, 大雾: 45,
    毛毛雨: 51, 小雨: 61, 中雨: 63, 大雨: 65, 暴雨: 65, 大暴雨: 65, 特大暴雨: 65,
    阵雨: 80, 强阵雨: 82, 雷阵雨: 95, 雷阵雨伴有冰雹: 96, 冻雨: 66,
    小雪: 71, 中雪: 73, 大雪: 75, 暴雪: 75, 阵雪: 85, 雨夹雪: 77 }
  return codes[value] ?? null
}
function localTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/u.test(value)) return NaN
  return Date.parse(`${value.replace(' ', 'T')}+08:00`)
}
function reportTime(value: unknown, now: number) {
  const absolute = localTime(value)
  if (Number.isFinite(absolute)) return absolute
  if (typeof value !== 'string') return NaN
  if (/^刚刚(发布|更新)?$/u.test(value)) return now
  const relative = /^(\d+)\s*分钟前(发布|更新)?$/u.exec(value)
  return relative ? now - Number(relative[1]) * 60_000 : NaN
}
export function domesticQuery(city: WeatherCity): string | null {
  // Keep the user's explicit locality; never fall back to IP auto-location.
  return /^\p{Script=Han}+[·\s\p{Script=Han}]*$/u.test(city.name) ? parts(city.name).join('') : null
}
export function parseDomesticWeather(value: unknown, city: WeatherCity, now = Date.now()) {
  const data = record(value)
  const names = [data.province, data.city, data.district].filter((name): name is string => typeof name === 'string').map(region)
  const expected = [...parts(city.name), ...parts(city.detail)].filter(name => !['中国', '中华人民共和国'].includes(name))
  if (!expected.length || !expected.every(name => names.includes(name))
    || typeof data.adcode !== 'string' || !/^\d{6}$/u.test(data.adcode)) throw new Error('Weather region mismatch')
  const at = reportTime(data.report_time, now), code = domesticCode(data.weather)
  if (!Number.isFinite(at) || now - at < -60_000 || now - at >= 30 * 60_000
    || code === null || !temp(data.temperature)) throw new Error('Invalid domestic observation')
  const apparent = temp(data.feels_like) ? data.feels_like : null
  const day = weatherDay(now, zone)
  const daily = (Array.isArray(data.forecast) ? data.forecast : []).map(record).find(item => item.date === day)
  const range = daily && temp(daily.temp_min) && temp(daily.temp_max) && daily.temp_min <= daily.temp_max
    ? { minimum: daily.temp_min, maximum: daily.temp_max } : { minimum: null, maximum: null }
  const hours = (Array.isArray(data.hourly_forecast) ? data.hourly_forecast : []).map(record)
    .map(item => ({ at: localTime(item.time), feels_like: item.feels_like, pop: item.pop, precip: item.precip, weather: item.weather }))
    .filter(item => item.at > now && item.at <= now + 3 * 3600_000)
  const complete = hours.length === 3 && hours[0].at - now <= 3600_000 && hours.every((hour, index) => temp(hour.feels_like)
    && finite(hour.pop) && hour.pop >= 0 && hour.pop <= 100 && finite(hour.precip) && hour.precip >= 0
    && domesticCode(hour.weather) !== null && (index === 0 || hour.at - hours[index - 1].at === 3600_000))
  const apparentValues = complete ? hours.map(hour => hour.feels_like as number) : []
  if (complete && apparent !== null) apparentValues.push(apparent)
  const outlook = complete ? {
    low: Math.min(...apparentValues),
    high: Math.max(...apparentValues),
    probability: Math.max(...hours.map(hour => hour.pop as number)), precipitation: Math.max(...hours.map(hour => hour.precip as number)),
    // Wind speed is not a gust measurement; leave the gust check unavailable.
    gust: null, codes: [...new Set([code, ...hours.map(hour => domesticCode(hour.weather)!)])],
  } : null
  const minutes = new Date(now + 8 * 3600_000).getUTCHours() * 60 + new Date(now + 8 * 3600_000).getUTCMinutes()
  const clock = (value: unknown) => typeof value === 'string' && /^\d{2}:\d{2}$/u.test(value)
    ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN
  const sunrise = clock(daily?.sunrise), sunset = clock(daily?.sunset)
  const isDay = sunrise >= 0 && sunrise < sunset && sunset < 1440 ? minutes >= sunrise && minutes < sunset : null
  const details: WeatherDetails = { temperature: data.temperature, apparent, ...range, code, isDay,
    timezone: zone, day, dayEndsAt: Date.parse(`${day}T00:00:00+08:00`) + 24 * 3600_000, outlook }
  if (!validWeatherDetails(details)) throw new Error('Invalid domestic details')
  // Forecast rain belongs only to advice. A dry current condition never starts rain.
  const rainy = [51, 61, 63, 65, 66, 80, 82, 95, 96].includes(code)
  const amount = finite(data.precipitation) && data.precipitation >= 0 ? data.precipitation : null
  const rain = !rainy ? 0 : amount === null ? .35 : Math.min(1, .35 + amount * .13)
  return { at, rain, details, wind: domesticWind(data) }
}
