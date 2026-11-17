import { useI18n } from '@/lib/i18n-context'
import type { Page, Language } from '@/lib/i18n'
import { lazy, Suspense, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'
import { motion } from 'motion/react'
import { pageLabels } from '@/lib/i18n'
import { useSettingsHistory } from '@/lib/settings-history'
import { GlassStatus } from '@/components/scene-panel'
import { useSettingsMorph } from '@/components/settings-morph-context'
import { Plus, Trash2, RefreshCw, RotateCcw, Undo2, Redo2, Check, LoaderCircle, CircleAlert, Monitor, Laptop, Sun, Thermometer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import type { WeatherSearchDraft } from '@/components/weather-settings'
import { previewSky } from '@/lib/sky-preference'
import type { StageKey } from '@/components/scene-panel'
import { SortableList } from '@/components/sortable-list'
import { DisplayRow, Level } from '@/App'
import type { Send } from '@/App'
import { captureBehavior } from '@/lib/control'
import type { Display, EdgeWheelModifier, Snapshot } from '@/lib/control'

const ScheduleChart = lazy(() => import('./schedule-chart').then(module => ({ default: module.ScheduleChart })))
const WeatherSettings = lazy(() => import('./weather-settings').then(module => ({ default: module.WeatherSettings })))
const SkySettingsEditor = lazy(() => import('./sky-settings').then(module => ({ default: module.SkySettingsEditor })))

export type SettingsEditorHandle = { flush: () => Promise<boolean>; chooseWeatherLocation: () => void }
const tabs = ['displays', 'scenes', 'schedule', 'focus', 'general'] as const
export function SettingsEditor({ open, close, snapshot, send, ref }: { open: boolean; close: () => void; snapshot: Snapshot; send: Send; ref: Ref<SettingsEditorHandle> }) {
  const { progress, settingsOpacity, clipPath } = useSettingsMorph()
  const { t, sceneName, setLanguage, displayName, message: translateMessage } = useI18n()
  const [page, setPage] = useState<Page>('displays')
  const [collapsed, setCollapsed] = useState(!open)
  useEffect(() => progress.on('change', value => setCollapsed(value <= .0001)), [progress])
  const contentMounted = open || !collapsed
  const [skyOpen, setSkyOpen] = useState(false)
  const [skyScene, setSkyScene] = useState<StageKey>('night')
  const editingSky = page === 'general' && skyOpen
  useEffect(() => {
    previewSky(open && editingSky ? skyScene : null)
    return () => previewSky(null)
  }, [open, editingSky, skyScene])
  const navigation = useRef<HTMLElement>(null)
  const [weatherSearch, setWeatherSearch] = useState<WeatherSearchDraft>({ query: '', editing: false })
  const { draft, change, undo, redo, reload, flush, saving, status, hasFailure, canUndo, canRedo } = useSettingsHistory(snapshot, send)
  const weatherCity = draft.appearance.weather.city
  const solarLocation = weatherCity ? { Name: weatherCity.name, Latitude: weatherCity.latitude, Longitude: weatherCity.longitude } : draft.SolarLocation ?? null
  const chooseCity = () => { setPage('general'); setSkyOpen(false); setWeatherSearch(value => ({ ...value, editing: true })) }
  const { stage: stageStyle, bar: barStyle } = draft.appearance
  const mixedTransition = draft.ScheduleTransitionMinutes == null && new Set(draft.Schedule.map(point => point.TransitionMinutes)).size > 1
  const transitionMinutes = draft.ScheduleTransitionMinutes ?? draft.Schedule[0]?.TransitionMinutes ?? 30
  useImperativeHandle(ref, () => ({ flush: () => flush(), chooseWeatherLocation: () => { setPage('general'); setSkyOpen(false); setWeatherSearch(value => ({ ...value, editing: true })) } }), [flush])
  useEffect(() => { setLanguage(draft.Language ?? 'system') }, [draft.Language, setLanguage])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => navigation.current?.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [open])
  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, select, textarea, [role=slider], [role=switch], [role=combobox], [role=option], [contenteditable=true]')) return
      if (['ArrowDown', 's', 'S'].includes(event.key)) { event.preventDefault(); close(); return }
      if (['ArrowLeft', 'ArrowRight', 'a', 'A', 'd', 'D'].includes(event.key)) {
        event.preventDefault()
        const next = tabs[(tabs.indexOf(page as typeof tabs[number]) + (['ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length]
        setPage(next)
        navigation.current?.querySelector<HTMLButtonElement>(`[data-page=${next}]`)?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, page, close])
  const deviceSend: Send = async command => await flush() ? send(command) : null
  return <motion.section className="settings-float" data-dismiss-region="settings" aria-label={t('设置')} aria-hidden={!open} inert={!open}
    style={{ opacity: settingsOpacity, clipPath, pointerEvents: open ? 'auto' : 'none' }}>
    <Suspense fallback={null}>{contentMounted && <div className={`settings-content settings-page-${page}${editingSky ? ' settings-editing-sky' : ''}`} key={page}>
    {editingSky && <SkySettingsEditor scene={skyScene} selectScene={setSkyScene} value={draft.appearance.sky} change={update => change(s => update(s.appearance.sky[skyScene]))} back={() => setSkyOpen(false)} seedsAvailable={stageStyle === 'live'} />}
    {page === 'displays' && <>
      <div className="device-brightness">{snapshot.Displays.map(display => <CurrentDisplay key={display.Id} display={display} send={deviceSend} />)}</div>
      <GlassStatus snapshot={snapshot} send={deviceSend} error="" sceneIds={{ morning: null, midday: null, dusk: null, night: null }} />
    </>}
    {page === 'schedule' && <>
      <ScheduleChart active={open} location={solarLocation} chooseCity={chooseCity} settings={draft} snapshot={snapshot} onChange={points => change(s => { s.Schedule = points; if (solarLocation && points.some(p => p.TimeKind === 'sunrise' || p.TimeKind === 'sunset')) s.SolarLocation = solarLocation })} />
      <div className="actions schedule-actions"><div className="schedule-enable"><label htmlFor="schedule">{t('自动渐变')}</label><Switch id="schedule" checked={draft.ScheduleEnabled} onCheckedChange={on => change(s => { s.ScheduleEnabled = on })} /></div><div className="global-transition"><input aria-label={t('渐变时长（分钟）')} type="number" min={0} max={1440} placeholder="—" value={mixedTransition ? '' : transitionMinutes} onChange={e => { const minutes = e.target.valueAsNumber; if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) return; change(s => { s.ScheduleTransitionMinutes = minutes; s.Schedule.forEach(point => { point.TransitionMinutes = minutes }) }) }} /><span>{t('分钟')}</span></div></div>
    </>}
    {page === 'scenes' && <>
      <div className="scene-edit-list"><SortableList items={draft.Scenes} getKey={scene => scene.Id} getLabel={(scene) => t('调整场景「{0}」的顺序', sceneName(scene))} onReorder={scenes => change(s => { s.Scenes = scenes })}>
      {(scene, i, handle) => <section className="scene-editor" key={scene.Id} aria-label={t('场景 {0}', i + 1)}>
        <div className="scene-heading">{handle}<input aria-label={t('场景 {0} 名称', i + 1)} value={sceneName(scene)} onChange={e => change(s => { s.Scenes[i].Name = e.target.value; s.Scenes[i].DefaultName = undefined })} /><Button variant="ghost" size="icon" aria-label={t('删除场景')} disabled={draft.Schedule.some(p => p.SceneId === scene.Id)} title={draft.Schedule.some(p => p.SceneId === scene.Id) ? t('先移除时间计划中的引用，再删除场景。') : t('删除场景')} onClick={() => change(s => { s.Scenes.splice(i, 1) })}><Trash2 /></Button></div>
        {snapshot.Displays.map(display => { const target = scene.Targets[display.Id] ?? { Brightness: display.Brightness, Kelvin: display.Kelvin }; return <DisplayRow key={display.Id} display={{ ...display, Brightness: target.Brightness, Kelvin: target.Kelvin, Error: null, CanAdjust: true }} onCommit={Brightness => change(s => { s.Scenes[i].Targets[display.Id] = { ...target, Brightness } })} onTemperatureCommit={Kelvin => change(s => { s.Scenes[i].Targets[display.Id] = { ...target, Kelvin } })} temperatureLabel={t('{0} {1} 色温', sceneName(scene), displayName(display.Name))} /> })}
      </section>}
      </SortableList></div>
      <div className="scene-list-actions">
      <Button className="new-scene" variant="outline" onClick={() => change(s => { s.Scenes.push({ Id: crypto.randomUUID(), Name: '自定义', DefaultName: '自定义', Behavior: captureBehavior(snapshot.Settings), Targets: Object.fromEntries(snapshot.Displays.map(d => [d.Id, { Brightness: d.Brightness, Kelvin: d.Kelvin }])) }) })}><Plus />{t('保存当前设置为新场景')}</Button></div>
    </>}
    {page === 'focus' && <>
      <div className="settings-function-group">
      <div className="form-row"><label htmlFor="focus">{t('离开副屏后自动变暗')}</label><Switch id="focus" checked={draft.FocusEnabled} onCheckedChange={on => change(s => { s.FocusEnabled = on })} /></div>
      <ControlledDisplays id="current" snapshot={snapshot} value={draft.ControlledDisplayIds ?? null} onChange={ids => change(s => { s.ControlledDisplayIds = ids })} />
      </div>
      <div className="settings-function-group">
      <div className="form-row"><label htmlFor="delay">{t('等待时间（秒）')}</label><input id="delay" type="number" min={0} max={600} value={draft.FocusDelaySeconds} onChange={e => change(s => { s.FocusDelaySeconds = e.target.valueAsNumber || 0 })} /></div>
      <div className="form-row"><label htmlFor="fullscreen">{t('副屏全屏或最大化时保持亮屏')}</label><Switch id="fullscreen" checked={draft.KeepSecondaryAwakeOnFullscreen} onCheckedChange={on => change(s => { s.KeepSecondaryAwakeOnFullscreen = on })} /></div>
      </div>
    </>}
    {page === 'general' && !editingSky && <>
      <div className="settings-function-group">
      <div className="form-row"><label htmlFor="stage-style">{t('首页背景')}</label><Select id="stage-style" value={stageStyle} onValueChange={value => change(s => { s.appearance.stage = value === 'classic' ? 'classic' : 'live' })} options={[{ value: 'live', label: t('单机器背景') }, { value: 'classic', label: t('双机器背景') }]} /></div>
      <div className="form-row"><label htmlFor="scene-bar-style">{t('场景栏样式')}</label><Select id="scene-bar-style" value={barStyle} onValueChange={value => change(s => { s.appearance.bar = value === 'icon' ? 'icon' : value === 'both' ? 'both' : 'text' })} options={[{ value: 'text', label: t('仅文字') }, { value: 'icon', label: t('仅图标') }, { value: 'both', label: t('文字与图标') }]} /></div>
      <div className="form-row"><span>{t('天空效果')}</span><Button variant="outline" onClick={() => setSkyOpen(true)}>{t('星星与云彩')}</Button></div>
      <div className="form-row"><label htmlFor="language">{t('语言')}</label><Select id="language" value={draft.Language ?? 'system'} onValueChange={value => { const language = value as Language; change(s => { s.Language = language }); setLanguage(language) }} options={[{ value: 'system', label: t('跟随系统') }, { value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }]} /></div>
      </div>
      <div className="settings-function-group">
      <div className="form-row"><label htmlFor="startup">{t('登录后自动启动')}</label><Switch id="startup" checked={draft.LaunchOnStartup} onCheckedChange={on => change(s => { s.LaunchOnStartup = on })} /></div>
      <div className="form-row"><label htmlFor="edge-brightness">{t('顶部滚轮调节亮度')}</label><Switch id="edge-brightness" checked={draft.TopEdgeBrightnessEnabled ?? false} onCheckedChange={on => change(s => { s.TopEdgeBrightnessEnabled = on })} /></div>
      <div className="form-row"><label htmlFor="edge-volume">{t('底部滚轮调节音量')}</label><Switch id="edge-volume" checked={draft.BottomEdgeVolumeEnabled ?? false} onCheckedChange={on => change(s => { s.BottomEdgeVolumeEnabled = on })} /></div>
      <div className="form-row"><label htmlFor="edge-modifier">{t('色温／应用音量按键')}</label><Select id="edge-modifier" value={draft.EdgeWheelModifier ?? 'alt'} onValueChange={value => change(s => { s.EdgeWheelModifier = value as EdgeWheelModifier })} options={[{ value: 'alt', label: 'Alt' }, { value: 'ctrl', label: 'Ctrl' }, { value: 'shift', label: 'Shift' }]} /></div>
      <WeatherSettings active={open} searchDraft={weatherSearch} onSearchDraftChange={setWeatherSearch} value={draft.appearance.weather} onChange={weather => change(s => { s.appearance.weather = weather; if (weather.city) s.SolarLocation = { Name: weather.city.name, Latitude: weather.city.latitude, Longitude: weather.city.longitude } })} />
      </div>
    </>}
    </div>}</Suspense>
    <footer className="settings-bottom">
      <div className="settings-bottom-status">
        <Button variant="ghost" size="icon" aria-label={t('重新检测显示器')} title={t('重新检测显示器')} onClick={() => void deviceSend({ Action: 'rescan' })}><RefreshCw /></Button>
        <div className="settings-save-status" role="status" data-failed={hasFailure}>
          <motion.span className="save-state-icon" key={hasFailure ? 'failed' : saving || status === '正在保存…' ? 'saving' : 'saved'} initial={{ opacity: 0, scale: .7 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: .18 }}>
            {hasFailure ? <CircleAlert /> : saving || status === '正在保存…' ? <LoaderCircle className="save-state-spinning" /> : <Check />}
          </motion.span>
          <span>{translateMessage(status)}</span>
          {hasFailure && <><Button variant="ghost" size="icon" aria-label={t('重试')} title={t('重试')} onClick={() => void flush(true)}><RefreshCw /></Button><Button variant="ghost" size="icon" aria-label={t('重新载入')} title={t('重新载入')} onClick={reload}><RotateCcw /></Button></>}
        </div>
      </div>
      <nav ref={navigation} className="settings-tabs" role="tablist" aria-label={t('设置导航')}>
        {tabs.map(tab => <Button key={tab} role="tab" data-page={tab} aria-selected={page === tab} tabIndex={page === tab ? 0 : -1} variant="ghost" onClick={() => { setPage(tab) }}>{t(pageLabels[tab])}</Button>)}
      </nav>
      <div className="settings-history" role="group" aria-label={t('编辑历史')}>
        <Button variant="ghost" size="icon" aria-label={t('撤销')} title={t('撤销')} disabled={!canUndo} onClick={undo}><Undo2 /></Button>
        <Button variant="ghost" size="icon" aria-label={t('重做')} title={t('重做')} disabled={!canRedo} onClick={redo}><Redo2 /></Button>
      </div>
    </footer>
  </motion.section>
}

function CurrentDisplay({ display, send }: { display: Display; send: Send }) {
  const { t, displayName, message } = useI18n()
  const name = displayName(display.Name)
  const Icon = display.Name === '笔记本屏幕' || display.Name === 'Laptop display' ? Laptop : Monitor
  return <section className="current-device" aria-label={name}>
    <h2><Icon aria-hidden="true" /><span>{name}</span></h2>
    <div className="current-level">
      <Sun aria-hidden="true" />
      <Level label={t('{0}亮度', name)} value={display.Brightness} disabled={!display.CanAdjust || !!display.Error} onCommit={Value => send({ Action: 'brightness', Id: display.Id, Value })} />
      <output>{display.Brightness}%</output>
    </div>
    <div className="current-level">
      <Thermometer aria-hidden="true" />
      <Level label={t('{0}色温', name)} value={display.Kelvin ?? 6500} min={2700} max={6500} step={100} temperature disabled={!display.CanAdjustColor || !!display.Error} onCommit={Value => send({ Action: 'temperature', Id: display.Id, Value })} />
      <output>{!display.CanAdjustColor ? t('不支持') : display.Kelvin ? `${display.Kelvin} K` : t('原色')}</output>
    </div>
    {display.Error && <p className="error" role="status">{message(display.Error)}</p>}
  </section>
}
function ControlledDisplays({ id, snapshot, value, onChange }: { id: string; snapshot: Snapshot; value: string[] | null; onChange: (ids: string[] | null) => void }) {
  const { t, displayName } = useI18n()
  const displays = snapshot.Displays.filter(d => !d.IsPrimary)
  const offline = (value ?? []).filter(key => !snapshot.Displays.some(d => d.Id === key))
  return <>
    <div className="form-row"><label htmlFor={`${id}-controlled`}>{t('参与专注的副屏')}</label><Select id={`${id}-controlled`} value={value === null ? 'all' : 'selected'} onValueChange={selected => onChange(selected === 'all' ? null : displays.map(d => d.Id))} options={[{ value: 'all', label: t('全部副屏') }, { value: 'selected', label: t('指定副屏') }]} /></div>
    {value !== null && [...displays.map(d => ({ Id: d.Id, Name: displayName(d.Name) })), ...offline.map(Id => ({ Id, Name: t('{0}（离线）', Id) }))].map(d => <div className="form-row" key={d.Id}><label htmlFor={`${id}-controlled-${d.Id}`}>{d.Name}</label><Switch id={`${id}-controlled-${d.Id}`} checked={value.includes(d.Id)} onCheckedChange={on => onChange(on ? [...value, d.Id] : value.filter(key => key !== d.Id))} /></div>)}
  </>
}
