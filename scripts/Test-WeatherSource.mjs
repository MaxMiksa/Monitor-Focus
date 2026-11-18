// Run: node --experimental-vm-modules scripts/Test-WeatherSource.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { SourceTextModule, SyntheticModule } from 'node:vm'

const modules = new Map()
const react = new SyntheticModule(['useEffect', 'useMemo', 'useSyncExternalStore'], function () {
  for (const key of ['useEffect', 'useMemo', 'useSyncExternalStore']) this.setExport(key, () => {})
})
async function moduleFor(name) {
  if (modules.has(name)) return modules.get(name)
  let source = await readFile(new URL(`../frontend/src/lib/${name}.ts`, import.meta.url), 'utf8')
  if (name === 'weather') source += '\nexport { currentWeather, cached };'
  const mod = new SourceTextModule(stripTypeScriptTypes(source), { identifier: name })
  modules.set(name, mod)
  await mod.link(specifier => specifier === 'react' ? react : moduleFor(specifier.replace('./', '')))
  return mod
}
globalThis.window = { setTimeout, clearTimeout }
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null }
const weather = await moduleFor('weather')
await weather.evaluate()
const domestic = modules.get('weather-domestic').namespace
const details = modules.get('weather-details').namespace
const city = { id: 1916136, name: '深圳 · 南山', detail: '广东 · 中国', latitude: 22.538, longitude: 113.93889 }
const now = Date.parse('2026-11-16T15:20:00+08:00')
const sample = { province: '广东省', city: '深圳市', district: '南山区', adcode: '440305', weather: '多云',
  wind_direction: '东南风', wind_power: '3级',
  temperature: 28, feels_like: 29, precipitation: 0, report_time: '9 分钟前发布',
  forecast: [{ date: '2026-11-16', temp_min: 21, temp_max: 28, sunrise: '06:37', sunset: '17:40' }],
  hourly_forecast: [16, 17, 18].map(hour => ({ time: `2026-11-16 ${hour}:00:00`, weather: '阵雨', feels_like: 27, pop: 70, precip: 1 })) }
const parsed = domestic.parseDomesticWeather(sample, city, now)
assert.equal(parsed.rain, 0)
assert.equal(parsed.details.code, 2)
assert.equal(parsed.details.outlook.gust, null)
assert.equal(parsed.wind.direction, 135)
assert.equal(parsed.wind.estimated, true)
assert.equal(details.travelAdvice(parsed.details), '未来几小时有雨，记得带伞')
assert(domestic.parseDomesticWeather({ ...sample, weather: '小雨', precipitation: 1 }, city, now).rain > 0)
for (const invalid of [{ ...sample, city: '鹤岗市' }, { ...sample, report_time: '31 分钟前发布' },
  { ...sample, weather: '未知' }, { ...sample, temperature: null }]) {
  assert.throws(() => domestic.parseDomesticWeather(invalid, city, now))
}
const staleForecast = domestic.parseDomesticWeather({ ...sample, forecast: [{ ...sample.forecast[0], date: '2026-11-15' }] }, city, now)
assert.equal(staleForecast.details.minimum, null)
assert.equal(staleForecast.details.maximum, null)
const core = { province: sample.province, city: sample.city, district: sample.district, adcode: sample.adcode,
  weather: sample.weather, temperature: sample.temperature, report_time: sample.report_time }
const coreSample = domestic.parseDomesticWeather(core, city, now)
assert.equal(coreSample.details.temperature, 28)
assert.equal(coreSample.details.apparent, null)
assert.equal(coreSample.details.outlook, null)
assert.equal(coreSample.details.isDay, null)
assert.equal(coreSample.rain, 0)
assert.equal(domestic.parseDomesticWeather({ ...core, weather: '阵雨' }, city, now).rain, .35)
const hourlyOnly = domestic.parseDomesticWeather({ ...core, hourly_forecast: sample.hourly_forecast }, city, now)
assert.equal(hourlyOnly.rain, 0)
assert.equal(details.travelAdvice(hourlyOnly.details), '未来几小时有雨，记得带伞')
assert.equal(domestic.parseDomesticWeather({ ...sample, hourly_forecast: [] }, city, now).details.outlook, null)
assert.equal(domestic.domesticQuery(city), '深圳南山')
assert.equal(domestic.domesticQuery({ ...city, name: 'London' }), null)

const realNow = Date.now()
const liveDay = details.weatherDay(realNow, 'Asia/Shanghai')
const response = { ...core, report_time: '刚刚发布', forecast: [{ ...sample.forecast[0], date: liveDay }] }
const originalFetch = globalThis.fetch
let calls = []
globalThis.fetch = async url => {
  calls.push(url.hostname)
  if (url.hostname === 'uapis.cn') return Response.json(response)
  throw new Error('Unexpected fallback')
}
assert.equal((await weather.namespace.currentWeather(city, new AbortController().signal)).source, 'uapi')
assert.deepEqual(calls, ['uapis.cn'])
calls = []
globalThis.fetch = async url => {
  calls.push(url.hostname)
  if (url.hostname === 'uapis.cn') throw new Error('Offline')
  assert(url.searchParams.get('current').includes('wind_direction_10m'))
  return Response.json({ current: { time: realNow / 1000, rain: 0, showers: 0, weather_code: 2, wind_speed_10m: 18, wind_direction_10m: 270, wind_gusts_10m: 25 } })
}
const fallback = await weather.namespace.currentWeather(city, new AbortController().signal)
assert.equal(fallback.source, 'open-meteo')
assert.deepEqual(fallback.wind, { speed: 18, direction: 270, gust: 25, estimated: false })
assert.deepEqual(calls, ['uapis.cn', 'api.open-meteo.com'])
calls = []
const cancelled = new AbortController()
globalThis.fetch = async url => { calls.push(url.hostname); cancelled.abort(); throw new Error('Cancelled') }
await assert.rejects(weather.namespace.currentWeather(city, cancelled.signal))
assert.deepEqual(calls, ['uapis.cn'])
globalThis.fetch = originalFetch
assert.equal(weather.namespace.cached(city), null)
console.log('PASS: core-only primary, basic rain, stale forecast omission, missing advice, cloudy current / rainy outlook, region/freshness/unknown rejection, fallback, cancellation, cache isolation')
if (process.argv.includes('--live')) {
  const live = await weather.namespace.currentWeather(city, new AbortController().signal)
  assert.equal(live.source, 'uapi')
  console.log(JSON.stringify({ source: live.source, code: live.details.code, temperature: live.details.temperature,
    apparent: live.details.apparent, minimum: live.details.minimum, maximum: live.details.maximum,
    rain: live.rain, day: live.details.day, updatedAt: new Date(live.at).toISOString(), advice: details.travelAdvice(live.details) }))
}
