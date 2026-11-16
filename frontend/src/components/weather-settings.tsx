import { useEffect, useRef, useState } from 'react'
import { Search, CloudRain } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { useI18n } from '@/lib/i18n-context'
import { previewRain, searchCities, useRainPreview, useWeatherStatus } from '@/lib/weather'
import type { WeatherCity, WeatherPreference } from '@/lib/weather'

export type WeatherSearchDraft = { query: string; editing: boolean }

export function WeatherSettings({ value, live, active = true, searchDraft, onSearchDraftChange, onChange }: {
  value: WeatherPreference; live: boolean; active?: boolean; searchDraft?: WeatherSearchDraft; onSearchDraftChange?: (value: WeatherSearchDraft) => void; onChange: (value: WeatherPreference) => void
}) {
  const { t, language, systemLanguage } = useI18n()
  const weather = useWeatherStatus()
  const previewing = useRainPreview()
  const [localSearch, setLocalSearch] = useState<WeatherSearchDraft>({ query: '', editing: false })
  const { editing, query } = searchDraft ?? localSearch
  const changeSearch = onSearchDraftChange ?? setLocalSearch
  const [results, setResults] = useState<WeatherCity[]>([])
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!value.enabled || !active) request.current?.abort()
  }, [value.enabled, active])
  async function search() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setSearchState('loading')
    setResults([])
    const cancelled = () => {
      if (request.current === controller) setSearchState('idle')
    }
    controller.signal.addEventListener('abort', cancelled, { once: true })
    try {
      const cities = await searchCities(query, language === 'system' ? systemLanguage : language, controller.signal)
      if (controller.signal.aborted) return
      setResults(cities)
      setSearchState(cities.length ? 'idle' : 'empty')
    } catch {
      if (!controller.signal.aborted) setSearchState('error')
    } finally {
      controller.signal.removeEventListener('abort', cancelled)
      if (request.current === controller) request.current = null
    }
  }
  const status = !live ? t('雨景需使用实时换光') : previewing ? t('正在预览雨景（30 秒）')
    : weather.status === 'loading' ? t('正在获取天气…') : weather.status === 'error' ? t('天气获取失败，稍后重试')
      : weather.status === 'rain' ? t('当前有雨') : weather.status === 'dry' ? t('当前无雨') : t('选择位置后跟随天气')
  return <div className="weather-settings">
    <div className="form-row"><label htmlFor="weather-enabled">{t('天气雨景')}</label><Switch id="weather-enabled" checked={value.enabled} onCheckedChange={enabled => onChange({ ...value, enabled })} /></div>
    {value.enabled && <>
      <div className="form-row weather-city-row"><label>{t('天气位置')}</label><Button variant="outline" title={value.city ? `${value.city.name} · ${value.city.detail}` : undefined} onClick={() => { request.current?.abort(); changeSearch({ editing: !editing, query: '' }); setResults([]); setSearchState('idle') }}>{value.city?.name ?? t('选择位置')}</Button></div>
      {editing && <div className="weather-city-search">
        <div className="weather-search-input"><input aria-label={t('搜索城市或区县')} placeholder={t('城市、区县或拼音')} maxLength={80} value={query} onChange={event => { request.current?.abort(); changeSearch({ editing, query: event.target.value }); setResults([]); setSearchState('idle') }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && query.trim().length >= 2) { event.preventDefault(); void search() } }} /><Button variant="ghost" size="icon" aria-label={t('搜索城市或区县')} disabled={query.trim().length < 2 || searchState === 'loading'} onClick={() => void search()}><Search /></Button></div>
        {results.length > 0 && <Select aria-label={t('选择搜索结果')} value="choose" onValueChange={id => { const city = results.find(item => String(item.id) === id); if (city) { onChange({ ...value, city }); changeSearch({ editing: false, query }); setResults([]) } }} options={[{ value: 'choose', label: t('选择搜索结果'), disabled: true }, ...results.map(city => ({ value: String(city.id), label: `${city.name} · ${city.detail}` }))]} />}
        {searchState !== 'idle' && <p role="status">{searchState === 'loading' ? t('正在搜索…') : searchState === 'empty' ? t('未找到地点，请尝试区县名、拼音或英文') : t('地点搜索失败，请重试')}</p>}
      </div>}
      <div className="weather-state-row"><span role="status">{status}</span><Button variant="ghost" size="icon" aria-label={previewing ? t('停止雨景预览') : t('预览雨景')} title={previewing ? t('停止雨景预览') : t('预览雨景')} aria-pressed={previewing} disabled={!live} onClick={previewRain}><CloudRain /></Button></div>
      <a className="weather-source" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{t('天气数据：Open-Meteo')}</a>
    </>}
  </div>
}
