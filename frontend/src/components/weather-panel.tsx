import { motion, useIsPresent } from 'motion/react'
import { Footprints, Shirt } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n-context'
import { clothingAdvice, travelAdvice, weatherLabel } from '@/lib/weather-details'
import type { WeatherCity, WeatherState } from '@/lib/weather'

function WeatherIcon({ code, isDay, label }: { code: number; isDay: boolean; label: string }) {
  const clear = code === 0, partly = code === 1 || code === 2
  const snow = [71, 73, 75, 77, 85, 86].includes(code), thunder = code >= 95, fog = code === 45 || code === 48
  const rain = !snow && !fog && code >= 51
  return <svg className="weather-colored-icon" viewBox="0 0 48 48" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={label}>
    {(clear || partly) && (isDay ? <g stroke="#ffd078" fill="#ffc45f">
      <circle cx={clear ? 24 : 18} cy={clear ? 24 : 17} r={clear ? 9 : 7} />
      <path d={clear ? 'M24 4v5m0 30v5M4 24h5m30 0h5M10 10l4 4m20 20 4 4M10 38l4-4m20-20 4-4' : 'M18 2v3M3 17h3M7 6l3 3m19-3-3 3M18 29v3M4 28l4-3M31 16h3'} />
    </g> : <path d={clear ? 'M34 8A18 18 0 1 0 40 33 16 16 0 0 1 34 8Z' : 'M23 3A13 13 0 1 0 29 24 12 12 0 0 1 23 3Z'} fill="#b6ceef" stroke="#d5e8ff" />)}
    {!clear && <path d="M12 32h24a8 8 0 0 0 .6-16 12 12 0 0 0-22-2.5A9.5 9.5 0 0 0 12 32Z" fill={code === 3 || thunder ? '#a8bbd2' : '#d9e5ed'} stroke="#edf5ff" />}
    {fog && <g stroke="#b6d2e5"><path d="M8 36h29M12 41h28M5 46h28" /></g>}
    {rain && !thunder && <g stroke="#75c9ff" strokeWidth="2.8"><path d="m16 36-2 5m11-5-2 5m11-5-2 5" /></g>}
    {snow && <g stroke="#9de5ff"><path d="M15 36v9m-4-7 8 5m0-5-8 5m23-7v9m-4-7 8 5m0-5-8 5" /></g>}
    {thunder && <path d="m25 32-7 9h7l-2 6 10-11h-8l3-4" fill="#ffd36d" stroke="#ffe4a0" />}
  </svg>
}

export function WeatherPanel({ city, weather, reduced, chooseLocation }: { city: WeatherCity | null; weather: WeatherState; reduced: boolean; chooseLocation: () => void }) {
  const { t } = useI18n()
  const present = useIsPresent()
  const details = weather.status !== 'error' ? weather.details : null
  const status = !city ? t('未选择地区') : weather.status === 'error' ? t('天气获取失败，稍后重试')
    : weather.status === 'loading' || weather.status === 'off' ? t('正在获取天气…') : t('天气详情暂不可用')
  return <motion.aside className="weather-panel" aria-label={t('天气概览')} aria-hidden={!present} inert={!present}
    initial={{ y: reduced ? 0 : '-125%', opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: reduced ? 0 : '-125%', opacity: 0 }}
    transition={{ duration: reduced ? 0 : .32, ease: [.2, .8, .2, 1] }}>
    <div className="weather-panel-content" aria-live="polite">
      {details ? <>
        <div className="weather-panel-current">
          <WeatherIcon code={details.code} isDay={details.isDay} label={t(weatherLabel(details.code))} />
          <span className="weather-panel-temperature" aria-label={t('当前气温')}>{Math.round(details.temperature)}°C</span>
          <span>{t(weatherLabel(details.code))}</span>
          <span className="weather-panel-range">{t('今日 {0}–{1}°C', Math.round(details.minimum), Math.round(details.maximum))}</span>
        </div>
        <div className="weather-panel-advice">
          <p aria-label={t('穿衣建议')}><Shirt aria-hidden="true" /><span>{t(clothingAdvice(details))}</span></p>
          <p aria-label={t('出行建议')}><Footprints aria-hidden="true" /><span>{t(travelAdvice(details))}</span></p>
        </div>
      </> : <p className="weather-panel-status" role="status">{status}</p>}
    </div>
    <div className="weather-panel-location">
      <Button variant="ghost" title={city ? `${city.name} · ${city.detail}` : t('选择位置')} onClick={chooseLocation}>{city?.name ?? t('选择位置')}</Button>
      {city?.detail && <span>{city.detail}</span>}
    </div>
  </motion.aside>
}
