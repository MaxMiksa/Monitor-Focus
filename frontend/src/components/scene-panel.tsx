import type { ReactNode } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Sunrise, Sun, Sunset, Moon, Link2, Unlink2, Pause, Play, RotateCcw, AlertCircle, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n-context'
import { useSceneBarStyle, useStageStyle } from '@/lib/stage-preference'
import { LiveSceneStage } from '@/components/live-scene-stage'
import { useWeatherRain } from '@/lib/weather'
import { SkyEffects } from '@/components/sky-effects'
import { RainAtmosphere, WeatherRainOverlay } from '@/components/weather-rain'
import { SettingsMorphSurface } from '@/components/settings-morph'
import { useSettingsMorph } from '@/components/settings-morph-context'
import { SKY_PREVIEW_EVENT, skyScenes } from '@/lib/sky-preference'
import type { Display, Snapshot } from '@/lib/control'
import type { Send } from '@/App'

const WeatherPanel = lazy(() => import('./weather-panel').then(module => ({ default: module.WeatherPanel })))

type SceneKey = 'morning' | 'midday' | 'dusk' | 'night'
export type StageKey = SceneKey
const sceneKeys = ['morning', 'midday', 'dusk', 'night'] as const
const sceneIcons = { morning: Sunrise, midday: Sun, dusk: Sunset, night: Moon }
const sceneNames = { morning: '早晨', midday: '中午', dusk: '傍晚', night: '夜间' } as const
const sceneAssets = Object.fromEntries(sceneKeys.map(key => [key, `/scenes/${key}.webp`])) as Record<StageKey, string>

function sceneKeyByName(scene: { Name: string; DefaultName?: string }): SceneKey | null {
  const name = (scene.DefaultName ?? scene.Name).toLowerCase()
  if (/早晨|morning/.test(name)) return 'morning'
  if (/中午|正午|midday/.test(name)) return 'midday'
  if (/傍晚|黄昏|dusk|evening|sunset/.test(name)) return 'dusk'
  if (/夜间|夜晚|night/.test(name)) return 'night'
  if (/日常|day|白天/.test(name)) return 'midday'
  return null
}
function brightnessOf(scene: { Targets: Record<string, { Brightness: number; Kelvin: number | null }> }, displays: Display[]): number {
  const values = displays.map(d => scene.Targets[d.Id]?.Brightness).filter((v): v is number => typeof v === 'number')
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 50
}
function inferSceneKeys(snapshot: Snapshot): Record<SceneKey, string | null> {
  const scenes = snapshot.Settings.Scenes
  const ids = { morning: '', midday: '', dusk: '', night: '' } as Record<SceneKey, string>
  for (const scene of scenes) {
    const key = sceneKeyByName(scene)
    if (key && !ids[key]) ids[key] = scene.Id
  }
  const byBrightness = scenes.map(scene => ({ id: scene.Id, value: brightnessOf(scene, snapshot.Displays) })).sort((a, b) => b.value - a.value)
  for (const key of ['midday', 'morning', 'night', 'dusk'] as SceneKey[]) {
    if (ids[key]) continue
    const remaining = byBrightness.filter(item => !Object.values(ids).includes(item.id))
    const match = key === 'night' ? [...remaining].sort((a, b) => a.value - b.value)[0] : remaining[0]
    if (match) { ids[key] = match.id; continue }
    if (key === 'morning') ids[key] = ids.midday || ids.dusk || ids.night
    if (key === 'dusk') ids[key] = ids.night || ids.midday || ids.morning
    if (key === 'night') ids[key] = ids.dusk || ids.midday || ids.morning
  }
  return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, id || null])) as Record<SceneKey, string | null>
}
function inferSceneFromSource(snapshot: Snapshot, ids: Record<SceneKey, string | null>): SceneKey | null {
  const source = snapshot.Source
  if (/手动|Manual|调节|adjust/i.test(source)) return null
  const scene = [...snapshot.Settings.Scenes].sort((a, b) => b.Name.length - a.Name.length)
    .find(item => source.includes(item.Name) || item.DefaultName && source.includes(item.DefaultName))
  if (scene) {
    const match = (Object.keys(ids) as SceneKey[]).find(key => ids[key] === scene.Id)
    if (match) return match
  }
  const hour = new Date().getHours()
  return /时间计划|Schedule/i.test(source) ? hour < 11 ? 'morning' : hour < 17 ? 'midday' : hour < 21 ? 'dusk' : 'night' : null
}

export function GlassStatus({ snapshot, error, send, sceneIds }: { snapshot: Snapshot; error: string; send: Send; sceneIds: Record<SceneKey, string | null> }) {
  const { t, message, sceneName, displayName } = useI18n()
  const [linkPending, setLinkPending] = useState(false)
  const supported = snapshot.Displays.filter(d => d.CanAdjustColor)
  const linkLabel = snapshot.Settings.BrightnessLinkCalibration ? t('校准联动') : t('保持比例')
  const status = [snapshot.Warning && message(snapshot.Warning), error && message(error), snapshot.Error && message(snapshot.Error),
    ...snapshot.Displays.filter(d => d.Error).map(d => `${displayName(d.Name)} · ${message(d.Error ?? '')}`),
    snapshot.Displays.length === 0 && t('正在检测显示器…')].filter(Boolean).join(' · ')
  const extraScenes = snapshot.Settings.Scenes.filter(scene => !Object.values(sceneIds).includes(scene.Id) && !sceneKeyByName(scene))
  return <div className="glass-status" role="status">
    <div className="glass-status-source"><span>{t('当前来源')}</span><strong>{message(snapshot.Source)}</strong></div>
    {status && <p className="glass-alert"><AlertCircle />{status}</p>}
    <div className="glass-status-actions">
      <Button variant="ghost" size="icon" aria-label={linkLabel} aria-pressed={snapshot.Settings.Linked} aria-busy={linkPending} title={snapshot.Settings.Linked ? t('解除亮度联动') : linkLabel}
        disabled={linkPending || !snapshot.Settings.Linked && snapshot.Displays.filter(d => d.CanAdjust).length < 2}
        onClick={() => { setLinkPending(true); void send({ Action: 'link', Value: snapshot.Settings.Linked ? 0 : 1 }).finally(() => setLinkPending(false)) }}>
        {snapshot.Settings.Linked ? <Link2 /> : <Unlink2 />}<span>{t('亮度联动')}</span>
      </Button>
      <Button variant="ghost" size="icon" aria-label={snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')} title={snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')} onClick={() => void send({ Action: 'pause' })}>{snapshot.FocusPaused ? <Play /> : <Pause />}<span>{snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')}</span></Button>
      <Button variant="ghost" size="icon" aria-label={t('恢复原色')} title={t('恢复原色')} disabled={!supported.length || supported.every(d => d.Kelvin === null)} onClick={() => void send({ Action: 'restore-color' })}><RotateCcw /><span>{t('恢复原色')}</span></Button>
    </div>
    {extraScenes.length > 0 && <div className="glass-extra-scenes">{extraScenes.map(scene => <Button key={scene.Id} variant="ghost" onClick={() => void send({ Action: 'scene', Id: scene.Id })}>{sceneName(scene)}</Button>)}</div>}
  </div>
}

export function ScenePanel({ snapshot, send, error, openSettings, demo, settingsOpen, weatherOpen, setWeatherOpen, chooseWeatherLocation, children }: { snapshot: Snapshot; send: Send; error: string; openSettings: () => void; demo: boolean; settingsOpen: boolean; weatherOpen: boolean; setWeatherOpen: (open: boolean) => void; chooseWeatherLocation: () => void; children: ReactNode }) {
  const { capsuleOpacity } = useSettingsMorph()
  const { t } = useI18n()
  const reduced = useReducedMotion()
  const [style] = useStageStyle()
  const [barStyle] = useSceneBarStyle()
  const [skyPreview, setSkyPreview] = useState<StageKey | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      const value = (event as CustomEvent).detail
      setSkyPreview(skyScenes.includes(value) ? value : null)
    }
    window.addEventListener(SKY_PREVIEW_EVENT, listener)
    return () => window.removeEventListener(SKY_PREVIEW_EVENT, listener)
  }, [])
  const { rain, weather, city } = useWeatherRain(true, weatherOpen && !settingsOpen)
  const ids = useMemo(() => inferSceneKeys(snapshot), [snapshot])
  const sourceScene = useMemo(() => inferSceneFromSource(snapshot, ids), [snapshot, ids])
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60000)
    return () => window.clearInterval(id)
  }, [])
  const timeScene = useMemo(() => {
    const minute = now.getHours() * 60 + now.getMinutes()
    const active = snapshot.Settings.Schedule.filter(point => point.MinuteOfDay <= minute).sort((a, b) => b.MinuteOfDay - a.MinuteOfDay)[0]
    const scene = snapshot.Settings.Scenes.find(item => item.Id === active?.SceneId)
    if (!scene) return null
    return (Object.keys(ids) as SceneKey[]).find(key => ids[key] === scene.Id) ?? null
  }, [snapshot, ids, now])
  const fallback = useCallback((): SceneKey => { const hour = now.getHours(); return hour < 11 ? 'morning' : hour < 17 ? 'midday' : hour < 21 ? 'dusk' : 'night' }, [now])
  const initial = () => sourceScene ?? timeScene ?? fallback()
  const [scene, setScene] = useState<SceneKey>(initial)
  const [missing, setMissing] = useState('')
  const previousExternal = useRef<SceneKey | null>(sourceScene ?? timeScene)
  const syncedScene = useRef<SceneKey>(initial())
  const requestSerial = useRef(0)
  const pendingRequest = useRef<number | null>(null)
  const externalNow = sourceScene ?? timeScene

  const presentScene = useCallback((next: SceneKey) => {
    if (next === syncedScene.current) return
    // Advance immediately: several events can arrive before React paints.
    syncedScene.current = next
    setScene(next)
  }, [])

  const change = useCallback((next: SceneKey) => {
    if (next === syncedScene.current) return
    const id = ids[next]
    if (!id) { setMissing(t('未找到对应场景，可在设置中添加')); return }
    setMissing('')
    const serial = ++requestSerial.current
    pendingRequest.current = serial
    presentScene(next)
    const settle = (result: Snapshot | null) => {
      if (pendingRequest.current !== serial) return
      pendingRequest.current = null
      if (!result && previousExternal.current) presentScene(previousExternal.current)
    }
    void send({ Action: 'scene', Id: id }).then(settle, () => settle(null))
  }, [ids, presentScene, send, t])

  useEffect(() => {
    const changed = externalNow !== previousExternal.current
    previousExternal.current = externalNow
    // Native writes remain serialized. Their intermediate acknowledgements
    // must not replace a newer local selection while requests are pending.
    if (!changed || !externalNow || pendingRequest.current !== null) return
    const next = externalNow
    const task = window.setTimeout(() => {
      if (pendingRequest.current === null && previousExternal.current === next) presentScene(next)
    }, 0)
    return () => window.clearTimeout(task)
  }, [externalNow, presentScene])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (settingsOpen || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target?.closest('input, select, textarea, [role=slider], [role=switch], [role=combobox], [role=option], [contenteditable=true]')) return
      {
        const index = sceneKeys.indexOf(syncedScene.current)
        if (['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'].includes(event.key)) {
          event.preventDefault()
          change(sceneKeys[(index + (['ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1) + sceneKeys.length) % sceneKeys.length])
          return
        }
        if (['ArrowDown', 's', 'S'].includes(event.key)) { event.preventDefault(); if (!event.repeat) setWeatherOpen(true); return }
        if (['ArrowUp', 'w', 'W'].includes(event.key)) { event.preventDefault(); if (!event.repeat) { if (weatherOpen) setWeatherOpen(false); else openSettings() } return }
      }
      const index = Number(event.key) - 1
      if (index >= 0 && index < sceneKeys.length) change(sceneKeys[index])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [change, settingsOpen, openSettings, weatherOpen, setWeatherOpen])

  const visibleStage = settingsOpen && skyPreview ? skyPreview : scene
  return <div className="scene-shell" data-scene={visibleStage} data-stage="live" data-background={style} data-settings-open={settingsOpen} data-weather-open={weatherOpen && !settingsOpen} data-raining={rain > 0}>
    <div className="scene-backdrop" aria-hidden="true">
      {style === 'live' ? <LiveSceneStage key="live" scene={visibleStage} reduced={!!reduced} /> : sceneKeys.map(key => <div key={key} className="scene-image" data-active={visibleStage === key} style={{ backgroundImage: `url('${sceneAssets[key]}')` }} />)}
      <SkyEffects scene={visibleStage} reduced={!!reduced} /><RainAtmosphere rain={rain} scene={visibleStage} />
    </div>
    <div className="window-drag-region" data-app-region="drag" aria-hidden="true" />
    <div className="scene-wash" aria-hidden="true" />
    {!reduced && <div className="live-stage-breath" aria-hidden="true" data-scene={visibleStage} />}
      <motion.section className="scene-capsule" aria-label={t('场景')} data-bar-style={barStyle} aria-hidden={settingsOpen} inert={settingsOpen} style={{ opacity: capsuleOpacity }}>
        {sceneKeys.map(key => {
          const Icon = sceneIcons[key]
          return <Button key={key} variant="ghost" className="scene-capsule-button" data-active={scene === key} aria-label={t(sceneNames[key])} aria-pressed={scene === key} title={t(sceneNames[key])} onClick={() => change(key)}>
            <span className="scene-capsule-focus">{barStyle !== 'text' && <Icon aria-hidden="true" />}{barStyle !== 'icon' && <span>{t(sceneNames[key])}</span>}</span>
          </Button>
        })}
      </motion.section>
      <motion.button type="button" className="scene-expand-hint" aria-label={t('设置')} title={t('设置')} aria-hidden={settingsOpen} inert={settingsOpen} style={{ opacity: capsuleOpacity }} onClick={openSettings}><ChevronUp /></motion.button>

    {!settingsOpen && <AnimatePresence initial={false}>{weatherOpen && <Suspense key="weather" fallback={null}><WeatherPanel city={city} weather={weather} reduced={!!reduced} chooseLocation={chooseWeatherLocation} /></Suspense>}</AnimatePresence>}
    {children}
    <SettingsMorphSurface anchorKey={barStyle} />
    <WeatherRainOverlay rain={rain} reduced={!!reduced} settingsOpen={settingsOpen} background={style} />
    {missing && <p className="scene-missing" role="status">{missing}</p>}
    {demo && <p className="scene-demo" role="status">{t('此浏览器预览只展示界面，不控制硬件。')}</p>}
    {(snapshot.Warning || snapshot.Error || error || snapshot.Displays.some(d => d.Error)) && <p className="scene-alert" role="alert"><AlertCircle />{[snapshot.Warning, snapshot.Error, error, ...snapshot.Displays.filter(d => d.Error).map(d => d.Error)].filter(Boolean).join(' · ')}</p>}
  </div>
}
