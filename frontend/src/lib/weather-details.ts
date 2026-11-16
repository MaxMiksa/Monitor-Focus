import type { TextKey } from './i18n'

export const weatherCodes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]
type Outlook = { low: number; high: number; probability: number; precipitation: number; gust: number; codes: number[] }
export type WeatherDetails = { temperature: number; apparent: number; minimum: number; maximum: number; code: number; isDay: boolean; timezone: string; day: string; dayEndsAt: number; outlook: Outlook | null }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const temperature = (value: unknown): value is number => finite(value) && value >= -100 && value <= 100
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const numbers = (value: unknown): unknown[] => Array.isArray(value) ? value : []
export function weatherDay(at: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}
export function validWeatherDetails(value: unknown): value is WeatherDetails {
  const details = record(value), outlook = record(details.outlook)
  return temperature(details.temperature) && temperature(details.apparent) && temperature(details.minimum) && temperature(details.maximum)
    && details.minimum <= details.maximum && finite(details.code) && weatherCodes.includes(details.code)
    && typeof details.isDay === 'boolean' && typeof details.timezone === 'string' && typeof details.day === 'string' && finite(details.dayEndsAt)
    && (details.outlook === null || (temperature(outlook.low) && temperature(outlook.high) && outlook.low <= outlook.high
      && finite(outlook.probability) && outlook.probability >= 0 && outlook.probability <= 100
      && finite(outlook.precipitation) && outlook.precipitation >= 0 && finite(outlook.gust) && outlook.gust >= 0
      && Array.isArray(outlook.codes) && outlook.codes.length >= 1 && outlook.codes.length <= 5 && outlook.codes.every(code => weatherCodes.includes(code))))
}
export function parseWeatherDetails(value: unknown): WeatherDetails | null {
  const data = record(value), current = record(data.current), daily = record(data.daily), hourly = record(data.hourly)
  if (!finite(current.time) || !temperature(current.temperature_2m) || !temperature(current.apparent_temperature)
    || !finite(current.weather_code) || !weatherCodes.includes(current.weather_code) || ![0, 1].includes(current.is_day as number)
    || typeof data.timezone !== 'string') return null
  let day: string
  try { day = weatherDay(current.time * 1000, data.timezone) } catch { return null }
  const index = numbers(daily.time).findIndex(time => finite(time) && weatherDay(time * 1000, data.timezone as string) === day)
  const minimum = numbers(daily.temperature_2m_min)[index], maximum = numbers(daily.temperature_2m_max)[index]
  const dayEnd = numbers(daily.time)[index + 1], at = current.time
  if (!temperature(minimum) || !temperature(maximum) || minimum > maximum || !finite(dayEnd) || dayEnd <= at || dayEnd - at > 26 * 3600) return null
  const hours = numbers(hourly.time).flatMap((time, i) => {
    if (!finite(time) || time < at || time > at + 3 * 3600) return []
    return [{ at: time, apparent: numbers(hourly.apparent_temperature)[i], probability: numbers(hourly.precipitation_probability)[i],
      precipitation: numbers(hourly.precipitation)[i], gust: numbers(hourly.wind_gusts_10m)[i], code: numbers(hourly.weather_code)[i] }]
  })
  const complete = hours.length >= 3 && hours.length <= 4 && hours.every((hour, i) => temperature(hour.apparent)
    && finite(hour.probability) && hour.probability >= 0 && hour.probability <= 100
    && finite(hour.precipitation) && hour.precipitation >= 0 && finite(hour.gust) && hour.gust >= 0
    && finite(hour.code) && weatherCodes.includes(hour.code) && (i === 0 || hour.at - hours[i - 1].at === 3600))
  const outlook = complete ? {
    low: Math.min(current.apparent_temperature, ...hours.map(hour => hour.apparent as number)),
    high: Math.max(current.apparent_temperature, ...hours.map(hour => hour.apparent as number)),
    probability: Math.max(...hours.map(hour => hour.probability as number)), precipitation: Math.max(...hours.map(hour => hour.precipitation as number)),
    gust: Math.max(...hours.map(hour => hour.gust as number)), codes: [...new Set([current.weather_code, ...hours.map(hour => hour.code as number)])],
  } : null
  return { temperature: current.temperature_2m, apparent: current.apparent_temperature, minimum, maximum, code: current.weather_code,
    isDay: current.is_day === 1, timezone: data.timezone, day, dayEndsAt: dayEnd * 1000, outlook }
}
export function weatherLabel(code: number): TextKey {
  if (code === 0) return '晴'
  if (code === 1) return '晴间多云'
  if (code === 2) return '多云'
  if (code === 3) return '阴'
  if (code <= 48) return '雾'
  if (code <= 55) return '毛毛雨'
  if ([56, 57, 66, 67].includes(code)) return '冻雨'
  if (code === 61) return '小雨'
  if (code === 63) return '中雨'
  if (code === 65) return '大雨'
  if (code <= 77) return '降雪'
  if (code <= 82) return '阵雨'
  if (code <= 86) return '阵雪'
  return '雷雨'
}
export function clothingAdvice(details: WeatherDetails): TextKey {
  if (!details.outlook) return '穿衣建议暂不可用'
  const { low, high } = details.outlook
  if (low < 5) return '厚外套叠穿，注意保暖'
  if (low < 12) return '外套叠穿，注意保暖'
  if (low < 18) return '长袖配薄外套'
  if (high - low >= 6) return '温差较大，备件薄外套'
  if (low < 24) return '薄衫舒适，早晚备外套'
  if (high >= 32) return '轻薄透气，注意防晒'
  return '轻薄透气，按需加衣'
}
export function travelAdvice(details: WeatherDetails): TextKey {
  if (!details.outlook) return '出行建议暂不可用'
  const { codes, gust, precipitation, probability, high } = details.outlook
  if (codes.some(code => code >= 95)) return '有雷雨，尽量减少户外活动'
  if (codes.some(code => [56, 57, 66, 67, 71, 73, 75, 77, 85, 86].includes(code))) return '雨雪路滑，出行留意'
  if (gust >= 50) return '阵风较强，出行注意防风'
  if (codes.some(code => code === 45 || code === 48)) return '有雾，出行注意慢行'
  if (precipitation >= 1 || probability >= 50 || codes.some(code => code >= 51 && code <= 82)) return '未来几小时有雨，记得带伞'
  if (probability >= 25 || precipitation > .1) return '可能有零星雨，随身备伞'
  if (high >= 32) return '天气较热，留意遮阳补水'
  return '未来几小时少雨，适合出行'
}
