import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { parseWeatherDetails, validWeatherDetails, weatherCodes, weatherDay } from './weather-details'
import type { WeatherDetails } from './weather-details'
import { domesticQuery, parseDomesticWeather } from './weather-domestic'
import { openMeteoWind, validWind } from './weather-wind'
import type { WeatherWind } from './weather-wind'

export type WeatherCity = { id: number; name: string; detail: string; latitude: number; longitude: number }
export type WeatherPreference = { enabled: boolean; city: WeatherCity | null }
export const WEATHER_KEY = 'myscreen.weather'
const CACHE_KEY = 'myscreen.weather-current-v2'
const CHANGE = 'myscreen-weather'
const REFRESH = 15 * 60_000
const MAX_AGE = 30 * 60_000
type Sample = { city: string; at: number; rain: number; source: 'uapi' | 'open-meteo'; details?: WeatherDetails | null; wind?: WeatherWind | null }
type Status = 'off' | 'city' | 'loading' | 'rain' | 'dry' | 'error'
export type WeatherState = { city: string | null; rain: number; status: Status; updatedAt: number; details: WeatherDetails | null; source?: Sample['source']; wind?: WeatherWind | null }
let state: WeatherState = { city: null, rain: 0, status: 'off', updatedAt: 0, details: null }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => state
function publish(next: WeatherState) { state = next; listeners.forEach(listener => listener()) }
export function useWeatherStatus() { return useSyncExternalStore(subscribe, snapshot) }

function validCity(value: unknown): value is WeatherCity {
  if (!value || typeof value !== 'object') return false
  const city = value as WeatherCity
  return Number.isSafeInteger(city.id) && typeof city.name === 'string' && city.name.length <= 160
    && typeof city.detail === 'string' && city.detail.length <= 320
    && Number.isFinite(city.latitude) && Math.abs(city.latitude) <= 90
    && Number.isFinite(city.longitude) && Math.abs(city.longitude) <= 180
}
function preferenceText() { try { return localStorage.getItem(WEATHER_KEY) } catch { return null } }
export function readWeatherPreference(): WeatherPreference {
  try {
    const value = JSON.parse(preferenceText() ?? '{}')
    return { enabled: value.enabled === true, city: validCity(value.city) ? value.city : null }
  } catch { return { enabled: false, city: null } }
}
export function writeWeatherPreference(value: WeatherPreference) {
  const text = JSON.stringify(value)
  if (preferenceText() === text) return
  localStorage.setItem(WEATHER_KEY, text)
  window.dispatchEvent(new Event(CHANGE))
}
function subscribePreference(listener: () => void) {
  window.addEventListener(CHANGE, listener)
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener(CHANGE, listener); window.removeEventListener('storage', listener) }
}

// All endpoints are fixed and separately allowed by the production CSP.
async function readJSON(url: URL, parent: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  parent.addEventListener('abort', abort, { once: true })
  if (parent.aborted) controller.abort()
  const timeout = window.setTimeout(abort, 10_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' })
    if (!response.ok || !response.body) throw new Error('Weather request failed')
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = '', size = 0
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 65_536) throw new Error('Weather response too large')
      text += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    controller.abort()
    reader?.releaseLock()
    window.clearTimeout(timeout)
    parent.removeEventListener('abort', abort)
  }
}

type Place = WeatherCity & { admin1?: string; admin2?: string; admin3?: string; admin4?: string; country?: string }
const regionName = (name: string) => name.replace(/(特别行政区|自治区|省|市|区|县|街道|镇|乡)$/u, '')
function parents(place: Place) {
  return [place.admin4, place.admin3, place.admin2, place.admin1, place.country]
    .filter((part): part is string => typeof part === 'string' && !!part)
}
function weatherPlace(place: Place): WeatherCity {
  const hierarchy = [...new Set(parents(place))].filter(part => regionName(part) !== regionName(place.name))
  const parent = [place.admin3, place.admin2].find(part => part && regionName(part) !== regionName(place.name))
  return {
    id: place.id, name: parent ? `${parent} · ${place.name}` : place.name,
    detail: hierarchy.filter(part => part !== parent).join(' · '), latitude: place.latitude, longitude: place.longitude,
  }
}
async function findPlaces(name: string, language: string, signal: AbortSignal): Promise<Place[]> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.search = new URLSearchParams({ name, count: '20', language: language.startsWith('zh') ? 'zh' : 'en', format: 'json' }).toString()
  const data = await readJSON(url, signal) as { results?: Place[] }
  if (!data || (data.results != null && !Array.isArray(data.results))) throw new Error('Invalid places')
  return (data.results ?? []).slice(0, 20).filter(place => place && validCity({ ...place, detail: '' }))
}
export async function searchCities(query: string, language: string, signal: AbortSignal): Promise<WeatherCity[]> {
  const name = query.trim().slice(0, 80)
  if (name.length < 2) return []
  let places = await findPlaces(name, language, signal)
  // GeoNames often indexes 南山 rather than 南山区; compound searches must
  // match the returned parent hierarchy, never silently choose another city.
  const compact = name.replace(/[\s·/，,]+/gu, '')
  if (!places.length && /^\p{Script=Han}+$/u.test(compact)) {
    const locality = compact.replace(/(街道|地区|区|县|镇|乡)$/u, '')
    const searches = locality !== name && locality.length >= 2 ? [{ name: locality, parent: '' }] : []
    for (const length of [2, 3, 4]) {
      if (locality.length - length >= 2) searches.push({ name: locality.slice(-length), parent: locality.slice(0, -length) })
    }
    const fallback = await Promise.all(searches.map(async search => {
      const found = await findPlaces(search.name, language, signal)
      const parent = search.parent.split(/[省市]/u).map(regionName).join('')
      return parent ? found.filter(place => parents(place).reverse().map(regionName).join('').includes(parent)) : found
    }))
    places = fallback.flat()
  }
  return [...new Map(places.map(place => [place.id, weatherPlace(place)])).values()].filter(validCity).slice(0, 10)
}

function cityKey(city: WeatherCity) { return `${city.id}:${city.latitude}:${city.longitude}` }
function fresh(sample: Sample) { const age = Date.now() - sample.at; return age >= -60_000 && age < MAX_AGE }
function cached(city: WeatherCity): Sample | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Sample | null
    if (!value || !['uapi', 'open-meteo'].includes(value.source) || value.city !== cityKey(city) || !Number.isFinite(value.at) || !Number.isFinite(value.rain)
      || value.rain < 0 || value.rain > 1 || !fresh(value)) return null
    return { ...value, wind: validWind(value.wind), details: validWeatherDetails(value.details) && value.details.dayEndsAt > Date.now()
      && weatherDay(Date.now(), value.details.timezone) === value.details.day ? value.details : null }
  } catch { return null }
}
async function currentWeather(city: WeatherCity, signal: AbortSignal): Promise<Sample> {
  const query = domesticQuery(city)
  if (query) {
    try {
      const domestic = new URL('https://uapis.cn/api/v1/misc/weather')
      domestic.search = new URLSearchParams({ city: query, extended: 'true', forecast: 'true', hourly: 'true' }).toString()
      const data = await readJSON(domestic, signal)
      signal.throwIfAborted()
      return { ...parseDomesticWeather(data, city), city: cityKey(city), source: 'uapi' }
    } catch {
      // A cancelled panel must not start a fallback request.
      signal.throwIfAborted()
    }
  }
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.search = new URLSearchParams({ latitude: String(city.latitude), longitude: String(city.longitude),
    current: 'rain,showers,weather_code,temperature_2m,apparent_temperature,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m', daily: 'temperature_2m_min,temperature_2m_max',
    hourly: 'apparent_temperature,precipitation_probability,precipitation,weather_code,wind_gusts_10m',
    timezone: 'auto', forecast_days: '2', forecast_hours: '4', wind_speed_unit: 'kmh', temperature_unit: 'celsius', timeformat: 'unixtime' }).toString()
  const data = await readJSON(url, signal) as { current?: { time?: number; rain?: number; showers?: number; weather_code?: number } }
  const current = data?.current
  if (!current || !Number.isFinite(current.time) || !Number.isFinite(current.rain) || !Number.isFinite(current.showers)
    || !Number.isInteger(current.weather_code) || current.rain! < 0 || current.showers! < 0) throw new Error('Invalid weather')
  const amount = current.rain! + current.showers!
  const code = current.weather_code!
  if (!weatherCodes.includes(code)
    || !Number.isFinite(amount)) throw new Error('Invalid weather code')
  const rainy = amount > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)
  const sample: Sample = { city: cityKey(city), at: current.time! * 1000, rain: rainy ? Math.min(1, .35 + amount * .13) : 0, details: parseWeatherDetails(data), wind: openMeteoWind(current), source: 'open-meteo' }
  if (!fresh(sample)) throw new Error('Outdated weather')
  return sample
}

let preview = false
let previewTimer = 0
const previewListeners = new Set<() => void>()
const subscribePreview = (listener: () => void) => { previewListeners.add(listener); return () => { previewListeners.delete(listener) } }
const previewSnapshot = () => preview
export function previewRain() {
  window.clearTimeout(previewTimer)
  preview = !preview
  previewListeners.forEach(listener => listener())
  if (preview) previewTimer = window.setTimeout(() => { preview = false; previewListeners.forEach(listener => listener()) }, 30_000)
}
export function useRainPreview() { return useSyncExternalStore(subscribePreview, previewSnapshot) }

// A single owner in ScenePanel. No Go timer, background polling or extra canvas.
export function useWeatherRain(active: boolean, showDetails = false, windActive = false) {
  const text = useSyncExternalStore(subscribePreference, preferenceText)
  const preference = useMemo(() => { void text; return readWeatherPreference() }, [text])
  const weather = useWeatherStatus()
  const previewing = useRainPreview()
  const requested = active && preference.enabled || showDetails || windActive
  useEffect(() => {
    const city = preference.city
    if (!requested || !city) {
      publish({ city: city ? cityKey(city) : null, rain: 0, status: requested && !city ? 'city' : 'off', updatedAt: 0, details: null })
      return
    }
    let sample = cached(city)
    let request: AbortController | null = null
    let next = 0, expiry = 0, disposed = false
    function show(status?: Status) {
      window.clearTimeout(expiry)
      if (sample && fresh(sample)) {
        publish({ city: sample.city, rain: sample.rain, status: status ?? (sample.rain ? 'rain' : 'dry'), updatedAt: sample.at, source: sample.source,
          wind: sample.wind ?? null,
          details: sample.details && sample.details.dayEndsAt > Date.now() ? sample.details : null })
        expiry = window.setTimeout(() => show('error'), Math.max(1, sample.at + MAX_AGE - Date.now()))
      } else publish({ city: cityKey(city!), rain: 0, status: status ?? 'loading', updatedAt: 0, details: null })
    }
    async function refresh() {
      if (disposed || document.hidden || request) return
      window.clearTimeout(next)
      const controller = new AbortController()
      request = controller
      try {
        const value = await currentWeather(city!, controller.signal)
        if (disposed || controller.signal.aborted) return
        sample = value
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)) } catch { /* A missing cache does not invalidate weather. */ }
        show()
      } catch {
        if (!disposed && !controller.signal.aborted) show('error')
      } finally {
        request = null
        const dayRemaining = (sample?.details?.dayEndsAt ?? Infinity) - Date.now()
        if (!disposed && !document.hidden) next = window.setTimeout(() => void refresh(), controller.signal.aborted ? 0
          : Math.max(100, Math.min(REFRESH, dayRemaining > 0 ? dayRemaining : REFRESH)))
      }
    }
    function visibility() {
      window.clearTimeout(next)
      if (document.hidden) request?.abort()
      else { show(); void refresh() }
    }
    show()
    void refresh()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      request?.abort()
      window.clearTimeout(next)
      window.clearTimeout(expiry)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [requested, preference.city])
  useEffect(() => () => {
    window.clearTimeout(previewTimer)
    preview = false
    previewListeners.forEach(listener => listener())
  }, [active, preference.enabled])
  const selected = preference.city ? cityKey(preference.city) : null
  const matching = selected === weather.city
  return { rain: active && preference.enabled ? (previewing ? .65 : matching ? weather.rain : 0) : 0,
    city: preference.city, weather: matching ? weather : { city: selected, rain: 0, status: 'loading' as const, updatedAt: 0, details: null } }
}
