import { useEffect, useMemo, useSyncExternalStore } from 'react'

export type WeatherCity = { id: number; name: string; detail: string; latitude: number; longitude: number }
export type WeatherPreference = { enabled: boolean; city: WeatherCity | null }
export const WEATHER_KEY = 'monitors-focus.weather'
const CACHE_KEY = 'monitors-focus.weather-current'
const CHANGE = 'monitors-focus-weather'
const REFRESH = 15 * 60_000
const MAX_AGE = 30 * 60_000
type Sample = { city: string; at: number; rain: number }
type Status = 'off' | 'city' | 'loading' | 'rain' | 'dry' | 'error'
type WeatherState = { rain: number; status: Status; updatedAt: number }
let state: WeatherState = { rain: 0, status: 'off', updatedAt: 0 }
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

// Both endpoints are fixed and separately allowed by the production CSP.
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

export async function searchCities(query: string, language: string, signal: AbortSignal): Promise<WeatherCity[]> {
  const name = query.trim().slice(0, 80)
  if (name.length < 2) return []
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.search = new URLSearchParams({ name, count: '5', language: language.startsWith('zh') ? 'zh' : 'en', format: 'json' }).toString()
  const data = await readJSON(url, signal) as { results?: { id: number; name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] }
  if (!data || (data.results != null && !Array.isArray(data.results))) throw new Error('Invalid cities')
  return (data.results ?? []).slice(0, 5).map(city => ({
    id: city.id, name: city.name, detail: [city.admin1, city.country].filter(Boolean).join(' · '), latitude: city.latitude, longitude: city.longitude,
  })).filter(validCity)
}

function cityKey(city: WeatherCity) { return `${city.id}:${city.latitude}:${city.longitude}` }
function fresh(sample: Sample) { const age = Date.now() - sample.at; return age >= -60_000 && age < MAX_AGE }
function cached(city: WeatherCity): Sample | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Sample | null
    return value && value.city === cityKey(city) && Number.isFinite(value.at) && Number.isFinite(value.rain)
      && value.rain >= 0 && value.rain <= 1 && fresh(value) ? value : null
  } catch { return null }
}
async function currentWeather(city: WeatherCity, signal: AbortSignal): Promise<Sample> {
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.search = new URLSearchParams({ latitude: String(city.latitude), longitude: String(city.longitude), current: 'rain,showers,weather_code', forecast_days: '1', timeformat: 'unixtime' }).toString()
  const data = await readJSON(url, signal) as { current?: { time?: number; rain?: number; showers?: number; weather_code?: number } }
  const current = data?.current
  if (!current || !Number.isFinite(current.time) || !Number.isFinite(current.rain) || !Number.isFinite(current.showers)
    || !Number.isInteger(current.weather_code) || current.rain! < 0 || current.showers! < 0) throw new Error('Invalid weather')
  const amount = current.rain! + current.showers!
  const code = current.weather_code!
  if (![0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99].includes(code)
    || !Number.isFinite(amount)) throw new Error('Invalid weather code')
  const rainy = amount > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)
  const sample = { city: cityKey(city), at: current.time! * 1000, rain: rainy ? Math.min(1, .35 + amount * .13) : 0 }
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
export function useWeatherRain(active: boolean) {
  const text = useSyncExternalStore(subscribePreference, preferenceText)
  const preference = useMemo(() => { void text; return readWeatherPreference() }, [text])
  const weather = useWeatherStatus()
  const previewing = useRainPreview()
  useEffect(() => {
    const city = preference.city
    if (!active || !preference.enabled || !city) {
      publish({ rain: 0, status: preference.enabled && !city ? 'city' : 'off', updatedAt: 0 })
      return
    }
    let sample = cached(city)
    let request: AbortController | null = null
    let next = 0, expiry = 0, disposed = false
    function show(status?: Status) {
      window.clearTimeout(expiry)
      if (sample && fresh(sample)) {
        publish({ rain: sample.rain, status: status ?? (sample.rain ? 'rain' : 'dry'), updatedAt: sample.at })
        expiry = window.setTimeout(() => show('error'), Math.max(1, sample.at + MAX_AGE - Date.now()))
      } else publish({ rain: 0, status: status ?? 'loading', updatedAt: 0 })
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
        if (!disposed && !document.hidden) next = window.setTimeout(() => void refresh(), controller.signal.aborted ? 0 : REFRESH)
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
  }, [active, preference])
  useEffect(() => () => {
    window.clearTimeout(previewTimer)
    preview = false
    previewListeners.forEach(listener => listener())
  }, [active, preference.enabled])
  return active ? (previewing ? .65 : weather.rain) : 0
}
