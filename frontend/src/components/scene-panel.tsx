import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Sunrise, Sun, Sunset, Moon, Settings2, SlidersHorizontal, Monitor, Laptop, Link2, Unlink2, Pause, Play, RotateCcw, RefreshCw, Thermometer, X, AlertCircle, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useI18n } from '@/lib/i18n-context'
import { useSceneBarStyle, useStageStyle } from '@/lib/stage-preference'
import { LiveSceneStage } from '@/components/live-scene-stage'
import type { Display, Snapshot } from '@/lib/control'
import type { Send } from '@/App'

type SceneKey = 'morning' | 'midday' | 'dusk' | 'night'
export type StageKey = SceneKey
const sceneKeys = ['morning', 'midday', 'dusk', 'night'] as const
const sceneIcons = { morning: Sunrise, midday: Sun, dusk: Sunset, night: Moon }
const sceneNames = { morning: '早晨', midday: '中午', dusk: '傍晚', night: '夜间' } as const
const stageNames = { morning: 'MORNING', midday: 'MIDDAY', dusk: 'DUSK', night: 'NIGHT' } as const
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

function GlassSlider({ display, label, onCommit }: { display: Display; label: string; onCommit: (value: number) => void | Promise<unknown> }) {
  const [draft, setDraft] = useState<number | null>(null)
  const [reveal, setReveal] = useState(false)
  const value = draft ?? display.Brightness
  return <div className="glass-level" onPointerEnter={() => setReveal(true)} onPointerLeave={() => setReveal(false)} onFocus={() => setReveal(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setReveal(false) }}>
    <Moon className="glass-end" aria-hidden="true" />
    <Slider aria-label={label} aria-valuetext={`${value}%`} value={[value]} min={0} max={100} step={1} disabled={!display.CanAdjust || !!display.Error}
      onValueChange={([v]) => { setDraft(v); setReveal(true) }} onValueCommit={async ([v]) => { try { await onCommit(v) } finally { setDraft(null) } }} />
    <Sun className="glass-end" aria-hidden="true" />
    <output className="glass-value" data-visible={reveal || draft !== null} aria-hidden={!reveal && draft === null}>{value}%</output>
  </div>
}

export function GlassStatus({ snapshot, error, send, close, sceneIds, embedded = false }: { snapshot: Snapshot; error: string; send: Send; close?: () => void; sceneIds: Record<SceneKey, string | null>; embedded?: boolean }) {
  const { t, message, sceneName, displayName } = useI18n()
  const [linkPending, setLinkPending] = useState(false)
  const supported = snapshot.Displays.filter(d => d.CanAdjustColor)
  const linkLabel = snapshot.Settings.BrightnessLinkCalibration ? t('校准联动') : t('保持比例')
  const status = [snapshot.Warning && message(snapshot.Warning), error && message(error), snapshot.Error && message(snapshot.Error),
    ...snapshot.Displays.filter(d => d.Error).map(d => `${displayName(d.Name)} · ${message(d.Error ?? '')}`),
    snapshot.Displays.length === 0 && t('正在检测显示器…')].filter(Boolean).join(' · ')
  const extraScenes = snapshot.Settings.Scenes.filter(scene => !Object.values(sceneIds).includes(scene.Id) && (!embedded || !sceneKeyByName(scene)))
  return <div className="glass-status" role="status">
    {!embedded && <div className="glass-status-head"><span>{t('设备状态')}</span><Button variant="ghost" size="icon" aria-label={t('收起更多控制')} onClick={close}><X /></Button></div>}
    <div className="glass-status-source"><span>{t('当前来源')}</span><strong>{message(snapshot.Source)}</strong></div>
    {status && <p className="glass-alert"><AlertCircle />{status}</p>}
    <div className="glass-status-actions">
      <Button variant="ghost" size="icon" aria-label={linkLabel} aria-pressed={snapshot.Settings.Linked} aria-busy={linkPending} title={snapshot.Settings.Linked ? t('解除亮度联动') : linkLabel}
        disabled={linkPending || !snapshot.Settings.Linked && snapshot.Displays.filter(d => d.CanAdjust).length < 2}
        onClick={() => { setLinkPending(true); void send({ Action: 'link', Value: snapshot.Settings.Linked ? 0 : 1 }).finally(() => setLinkPending(false)) }}>
        {snapshot.Settings.Linked ? <Link2 /> : <Unlink2 />}{embedded && <span>{t('亮度联动')}</span>}
      </Button>
      <Button variant="ghost" size="icon" aria-label={snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')} title={snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')} onClick={() => void send({ Action: 'pause' })}>{snapshot.FocusPaused ? <Play /> : <Pause />}{embedded && <span>{snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')}</span>}</Button>
      <Button variant="ghost" size="icon" aria-label={t('恢复原色')} title={t('恢复原色')} disabled={!supported.length || supported.every(d => d.Kelvin === null)} onClick={() => void send({ Action: 'restore-color' })}><RotateCcw />{embedded && <span>{t('恢复原色')}</span>}</Button>
      {!embedded && <Button variant="ghost" size="icon" aria-label={t('重新检测显示器')} title={t('重新检测显示器')} onClick={() => void send({ Action: 'rescan' })}><RefreshCw /></Button>}
    </div>
    {!embedded && snapshot.Displays.map(display => <div className="glass-temperature" key={display.Id}>
      <Thermometer aria-hidden="true" /><span>{displayName(display.Name)}</span>
      <Slider aria-label={t('{0}色温', displayName(display.Name))} aria-valuetext={`${display.Kelvin ?? 6500} K`} className="temperature" value={[display.Kelvin ?? 6500]} min={2700} max={6500} step={100} disabled={!display.CanAdjustColor || !!display.Error}
        onValueCommit={([v]) => void send({ Action: 'temperature', Id: display.Id, Value: v })} />
      <output>{display.Kelvin ? `${display.Kelvin} K` : t('原色')}</output>
    </div>)}
    {extraScenes.length > 0 && <div className="glass-extra-scenes">{extraScenes.map(scene => <Button key={scene.Id} variant="ghost" onClick={() => void send({ Action: 'scene', Id: scene.Id })}>{sceneName(scene)}</Button>)}</div>}
  </div>
}

export function ScenePanel({ snapshot, send, error, openSettings, demo, settingsOpen, children }: { snapshot: Snapshot; send: Send; error: string; openSettings: () => void; demo: boolean; settingsOpen: boolean; children: ReactNode }) {
  const { t } = useI18n()
  const reduced = useReducedMotion()
  const [style] = useStageStyle()
  const [barStyle] = useSceneBarStyle()
  const live = style === 'live'
  const fullBarOpen = !live && !settingsOpen
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
  const [stage, setStage] = useState<StageKey>(initial)
  const [transition, setTransition] = useState(0)
  const [more, setMore] = useState(false)
  const [missing, setMissing] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleScene = useRef<SceneKey | null>(null)
  const previousExternal = useRef<SceneKey | null>(sourceScene ?? timeScene)
  const syncedScene = useRef<SceneKey>(initial())
  const externalNow = sourceScene ?? timeScene
  const [external, setExternal] = useState<SceneKey | null>(externalNow)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const change = useCallback((next: SceneKey) => {
    if (next === scene) return
    const id = ids[next]
    if (!id) { setMissing(t('未找到对应场景，可在设置中添加')); return }
    setMissing('')
    const from = scene
    setScene(next)
    syncedScene.current = next
    scheduleScene.current = null
    setTransition(value => value + 1)
    if (reduced) setStage(next)
    if (timer.current) clearTimeout(timer.current)
    const longJump = from !== 'dusk' && next !== 'dusk' && Math.abs(sceneKeys.indexOf(from) - sceneKeys.indexOf(next)) > 1
    if (!reduced && !live && longJump) {
      setStage('dusk')
      timer.current = setTimeout(() => { setStage(next); timer.current = null }, 300)
    } else setStage(next)
    void send({ Action: 'scene', Id: id }).catch(() => {})
  }, [ids, live, reduced, scene, send, t])

  useEffect(() => {
    if (externalNow !== previousExternal.current) {
      previousExternal.current = externalNow
      const task = window.setTimeout(() => setExternal(externalNow), 0)
      return () => window.clearTimeout(task)
    }
    const next = external
    if (!next || next === syncedScene.current || scheduleScene.current) return
    scheduleScene.current = next
    const task = window.setTimeout(() => {
      if (scheduleScene.current !== next) return
      const from = syncedScene.current
      syncedScene.current = next
      setScene(next)
      if (timer.current) clearTimeout(timer.current)
      if (reduced) { setStage(next); scheduleScene.current = null; return }
      if (!live && sceneKeys.indexOf(next) - sceneKeys.indexOf(from) > 1) {
        setStage('dusk')
        timer.current = setTimeout(() => {
          if (scheduleScene.current !== next) return
          setStage(next); scheduleScene.current = null; timer.current = null
        }, 300)
      } else {
        setStage(next)
        scheduleScene.current = null
      }
    }, 0)
    return () => window.clearTimeout(task)
  }, [externalNow, external, live, reduced])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (settingsOpen || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || target?.closest('input, select, textarea, [role=slider], [contenteditable=true]')) return
      {
        const index = sceneKeys.indexOf(scene)
        if (['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'].includes(event.key)) {
          event.preventDefault()
          change(sceneKeys[(index + (['ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1) + sceneKeys.length) % sceneKeys.length])
          return
        }
        if (['ArrowUp', 'w', 'W'].includes(event.key)) { event.preventDefault(); openSettings(); return }
      }
      const index = Number(event.key) - 1
      if (index >= 0 && index < sceneKeys.length) change(sceneKeys[index])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [change, scene, settingsOpen, openSettings])

  const displays = snapshot.Displays.slice(0, 2)
  const caption = stageNames[stage]
  return <div className="scene-shell" data-scene={stage} data-stage={style} data-settings-open={settingsOpen}>
    <div className="scene-backdrop" aria-hidden="true">
      {live ? <LiveSceneStage key="live" scene={stage} reduced={!!reduced} /> : (Object.keys(sceneAssets) as StageKey[]).map(key => <div key={key} className="scene-image" data-active={stage === key} style={{ backgroundImage: `url('${sceneAssets[key]}')` }} />)}
    </div>
    <div className="window-drag-region" data-app-region="drag" aria-hidden="true" />
    <div className="scene-wash" aria-hidden="true" />
    {live && !reduced && <div className="live-stage-breath" aria-hidden="true" data-scene={stage} />}
    <h1 className="scene-title" aria-live="polite">{caption}</h1>
    <AnimatePresence mode="wait" initial={false}>
      {!live && !reduced && <motion.div key={transition} className="scene-kinetic" aria-hidden="true" initial={{ opacity: 0, filter: 'blur(14px)', letterSpacing: '.02em' }} animate={{ opacity: [0, .18, 0], filter: ['blur(14px)', 'blur(0px)', 'blur(10px)'], letterSpacing: ['.02em', '.08em', '.32em'] }} exit={{ opacity: 0 }} transition={{ duration: 1.05, ease: [.2, .7, .2, 1] }}>{caption}</motion.div>}
    </AnimatePresence>
    <AnimatePresence mode="wait" initial={false}>
      {!live && !reduced && <motion.div key={`wipe-${transition}`} className="scene-wipe" aria-hidden="true" initial={{ x: '-55%', opacity: 0 }} animate={{ x: '55%', opacity: [0, 1, 0] }} exit={{ opacity: 0 }} transition={{ duration: 1, ease: [.3, 0, .2, 1] }} />}
    </AnimatePresence>

    <div className="scene-display-hint" aria-hidden="true">{displays.map((display, index) => {
      const Icon = index === 1 ? Laptop : Monitor
      return <Icon key={display.Id} className="scene-display-icon" data-index={index} />
    })}</div>

    {live ? <>
      <section className="scene-capsule" aria-label={t('场景')} data-bar-style={barStyle} hidden={fullBarOpen || settingsOpen}>
        {sceneKeys.map(key => {
          const Icon = sceneIcons[key]
          return <Button key={key} variant="ghost" className="scene-capsule-button" data-active={scene === key} aria-label={t(sceneNames[key])} aria-pressed={scene === key} title={t(sceneNames[key])} onClick={() => change(key)}>
            {barStyle !== 'text' && <Icon aria-hidden="true" />}{barStyle !== 'icon' && <span>{t(sceneNames[key])}</span>}
          </Button>
        })}
      </section>
      <AnimatePresence>{!fullBarOpen && !settingsOpen && <motion.button type="button" className="scene-expand-hint" aria-label={t('设置')} title={t('设置')} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={openSettings}><ChevronUp /></motion.button>}</AnimatePresence>
    </> : null}

    <section className={`glass-strip${live ? ' glass-strip-expanded' : ''}`} aria-label={t('场景')} hidden={!fullBarOpen}>
      <div className="glass-levels">
        {displays.map((display, index) => <GlassSlider key={display.Id} display={display} label={t('{0}亮度', index === 1 ? t('笔记本屏幕') : display.Name)} onCommit={Value => send({ Action: 'brightness', Id: display.Id, Value })} />)}
        {displays.length === 0 && <p className="glass-empty">{t('正在检测显示器…')}</p>}
        {displays.length === 1 && <p className="glass-empty">{t('正在检测显示器…')}</p>}
      </div>
      <div className="glass-controls">
        <div className="glass-scenes">
        {sceneKeys.map(key => {
          const Icon = sceneIcons[key]
          return <Button key={key} variant="ghost" className="glass-scene-button" data-active={scene === key} aria-label={t(sceneNames[key])} aria-pressed={scene === key} title={t(sceneNames[key])} onClick={() => change(key)}><Icon /></Button>
        })}
        </div>
        <div className="glass-secondary">

          <Button variant="ghost" size="icon" className="glass-icon-button" aria-label={more ? t('收起更多控制') : t('更多控制')} aria-expanded={more} title={more ? t('收起更多控制') : t('更多控制')} onClick={() => setMore(value => !value)}><SlidersHorizontal /></Button>
          <Button variant="ghost" size="icon" className="glass-icon-button" aria-label={t('设置')} title={t('设置')} onClick={openSettings}><Settings2 /></Button>
        </div>
      </div>
    </section>

    <AnimatePresence>{more && fullBarOpen && <motion.div className={`glass-more${live ? ' glass-more-live' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: .18 }}><GlassStatus snapshot={snapshot} error={error} send={send} sceneIds={ids} close={() => setMore(false)} /></motion.div>}</AnimatePresence>
    {children}
    {missing && <p className="scene-missing" role="status">{missing}</p>}
    {demo && <p className="scene-demo" role="status">{t('此浏览器预览只展示界面，不控制硬件。')}</p>}
    {!(more && fullBarOpen) && (snapshot.Warning || snapshot.Error || error || snapshot.Displays.some(d => d.Error)) && <p className="scene-alert" role="alert"><AlertCircle />{[snapshot.Warning, snapshot.Error, error, ...snapshot.Displays.filter(d => d.Error).map(d => d.Error)].filter(Boolean).join(' · ')}</p>}
  </div>
}
