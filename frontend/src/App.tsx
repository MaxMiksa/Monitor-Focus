import { pageLabels } from '@/lib/i18n'
import { useI18n } from '@/lib/i18n-context'
import type { Page } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { Monitor, Laptop, Sun, Moon, Focus, Thermometer, Link2, Unlink2, Pause, Play, Settings2, Clock3, RotateCcw, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { isDesktop, preview, request, resizePanel } from '@/lib/control'
import type { Display, Request, Snapshot } from '@/lib/control'
import { SettingsEditor } from '@/components/settings-editor'

const pages = [{ name: 'displays' as Page, icon: Monitor }, { name: 'scenes' as Page, icon: Sun }, { name: 'schedule' as Page, icon: Clock3 }, { name: 'focus' as Page, icon: Focus }, { name: 'general' as Page, icon: Settings2 }]
const sceneIcons = [Sun, Moon, Focus]
export type Send = (command: Request) => Promise<Snapshot | null>
export function Level({ value, max = 100, min = 0, step = 1, label, disabled, temperature, onCommit }: { value: number; max?: number; min?: number; step?: number; label: string; disabled?: boolean; temperature?: boolean; onCommit: (value: number) => void | Promise<unknown> }) {
  const [draft, setDraft] = useState<number | null>(null)
  return <Slider aria-label={label} aria-valuetext={`${draft ?? value}${temperature ? ' K' : '%'}`} className={temperature ? 'temperature' : ''} value={[draft ?? value]} min={min} max={max} step={step} disabled={disabled}
    onValueChange={([v]) => setDraft(v)} onValueCommit={async ([v]) => { try { await onCommit(v) } finally { setDraft(null) } }} />
}
export function DisplayRow({ display, onCommit, onTemperatureCommit, onRestoreColor, temperatureLabel }: { display: Display; onCommit: (value: number) => void | Promise<unknown>; onTemperatureCommit?: (value: number) => void | Promise<unknown>; onRestoreColor?: () => void; temperatureLabel?: string }) {
  const { t, message, displayName } = useI18n()
  const Icon = display.Name === t('笔记本屏幕') || display.Name === '笔记本屏幕' || display.Name === 'Laptop display' ? Laptop : Monitor
  return <div><div className="display-row"><Icon /><span>{displayName(display.Name)}</span><Level label={t('{0}亮度', displayName(display.Name))} value={display.Brightness} disabled={!display.CanAdjust || !!display.Error} onCommit={onCommit} /><Sun className="text-muted-foreground" /><output>{display.Brightness}%</output></div>
    {display.CanAdjustColor && onTemperatureCommit && <div className="display-row display-temperature">
      {onRestoreColor && <Button className="temperature-reset" variant="ghost" size="icon" aria-label={t('{0}恢复原色', displayName(display.Name))} title={t('恢复原色')} disabled={display.Kelvin === null} onClick={onRestoreColor}><RotateCcw /></Button>}
      <Level label={temperatureLabel ?? t('{0}色温', displayName(display.Name))} value={display.Kelvin ?? 6500} min={2700} max={6500} step={100} disabled={!!display.Error} temperature onCommit={onTemperatureCommit} /><Thermometer className="text-muted-foreground" /><output>{display.Kelvin ? `${display.Kelvin} K` : t('原色')}</output>
    </div>}
    {display.Error && <p className="error" role="status">{message(display.Error)}</p>}</div>
}
function QuickPanel({ snapshot, send, openSettings }: { snapshot: Snapshot; send: Send; openSettings: () => void }) {
  const { t, sceneName, message } = useI18n()
  const supported = snapshot.Displays.filter(d => d.CanAdjustColor)
  const [linkPending, setLinkPending] = useState(false)
  const linkLabel = snapshot.Settings.BrightnessLinkCalibration ? t('校准联动') : t('保持比例')
  async function toggleLink() {
    setLinkPending(true)
    try { await send({ Action: 'link', Value: snapshot.Settings.Linked ? 0 : 1 }) }
    finally { setLinkPending(false) }
  }
  return <div className="quick"><main className="quick-main">
    {snapshot.Displays.length === 0 && <p className="caption py-6">{t('正在检测显示器…')}</p>}
    {snapshot.Displays.map(display => <DisplayRow key={display.Id} display={display} onCommit={Value => send({ Action: 'brightness', Id: display.Id, Value })} onTemperatureCommit={Value => send({ Action: 'temperature', Id: display.Id, Value })} />)}
    <div className="binding"><Button variant="ghost" size="icon" className="binding-toggle" aria-label={linkLabel} title={snapshot.Settings.Linked ? t('解除亮度联动') : linkLabel} aria-pressed={snapshot.Settings.Linked} aria-busy={linkPending} disabled={linkPending || !snapshot.Settings.Linked && snapshot.Displays.filter(d => d.CanAdjust).length < 2} onClick={() => void toggleLink()}>{snapshot.Settings.Linked ? <Link2 /> : <Unlink2 />}</Button></div>
    <section className="scenes"><p className="text-sm font-medium">{t('场景')}</p><div className="scene-line"><div className="scene-buttons">{snapshot.Settings.Scenes.map((scene, i) => { const Icon = sceneIcons[i % sceneIcons.length]; return <Button variant="outline" key={scene.Id} onClick={() => void send({ Action: 'scene', Id: scene.Id })}><Icon />{sceneName(scene)}</Button> })}</div><div className="source"><p className="caption">{t('当前来源')}</p><p>{message(snapshot.Source)}</p></div></div></section>
  </main><footer className="footer"><Button variant="outline" onClick={() => void send({ Action: 'pause' })}>{snapshot.FocusPaused ? <Play /> : <Pause />}{snapshot.FocusPaused ? t('恢复专注') : t('暂停专注')}</Button><Button variant="ghost" disabled={!supported.length || supported.every(d => d.Kelvin === null)} onClick={() => void send({ Action: 'restore-color' })}><RotateCcw />{t('恢复原色')}</Button><Button variant="ghost" className="settings-button" onClick={openSettings}><Settings2 />{t('设置')}</Button></footer></div>
}
export default function App() {
  const { t, message, setLanguage, setSystemLanguage } = useI18n()
  const initialized = useRef(false)
  const connectionFailed = useRef(false)
  const demo = !isDesktop && new URLSearchParams(location.search).get('preview') === '1'
  const [snapshot, setSnapshot] = useState<Snapshot | null>(demo ? structuredClone(preview) : null)
  const [error, setError] = useState('')
  const [page, setPage] = useState<Page>('displays')
  const queue = useRef(Promise.resolve())
  const busy = useRef(0)
  const send = useCallback<Send>((command) => {
    if (demo) { setError('视觉预览不控制硬件；请在桌面窗口体验实际操作。'); return Promise.resolve(null) }
    busy.current++
    const task = queue.current.then(async () => {
      try {
        const next = await request(command)
        setSnapshot(next)
        if (next.SystemLanguage) setSystemLanguage(next.SystemLanguage)
        if (!initialized.current || command.Action === 'save' && !next.Error) {
          setLanguage(next.Settings.Language ?? 'system'); initialized.current = true
        }
        const reconnecting = connectionFailed.current
        connectionFailed.current = false
        setError(previous => command.Action !== 'snapshot' ? next.Error ?? '' : next.Error ?? (reconnecting ? '' : previous))
        return next.Error ? null : next
      }
      catch (e) { connectionFailed.current = true; setError('连接失败：' + (e instanceof Error ? e.message : String(e))); return null }
      finally { busy.current-- }
    })
    queue.current = task.then(() => {})
    return task
  }, [demo, setLanguage, setSystemLanguage])
  useEffect(() => {
    if (demo || !isDesktop) return
    const initial = setTimeout(() => void send({ Action: 'snapshot' }), 0)
    const timer = setInterval(() => { if (!document.hidden && !busy.current) void send({ Action: 'snapshot' }) }, 2000)
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, [send, demo])
  function navigate(next: Page) { setPage(next); if (next === 'displays') setLanguage(snapshot?.Settings.Language ?? 'system'); resizePanel(next !== 'displays'); setError('') }
  return <MotionConfig reducedMotion="user"><div className={page === 'displays' ? undefined : 'settings-shell'}><AnimatePresence mode="wait" initial={false}><motion.div className="app-view" key={page === 'displays' ? 'quick' : 'settings'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}>
    {!snapshot ? <div className="p-7"><h1>Monitors Focus</h1><p className="caption my-6">{message(error) || t('正在连接控制核心…')}</p><Button variant="outline" onClick={() => void send({ Action: 'snapshot' })}><RefreshCw />{t('重新连接')}</Button></div> : page === 'displays' ? <QuickPanel snapshot={snapshot} send={send} openSettings={() => navigate('schedule')} /> : <div className="settings"><nav className="sidebar" aria-label={t('设置导航')}>{pages.map(({ name, icon: Icon }) => <Button key={name} variant={page === name ? 'secondary' : 'ghost'} aria-current={page === name ? 'page' : undefined} onClick={() => navigate(name)}><Icon />{t(pageLabels[name])}</Button>)}</nav><main className="settings-main"><SettingsEditor page={page} snapshot={snapshot} send={send} /></main></div>}
  </motion.div></AnimatePresence>{snapshot?.Warning && <p className="caption px-6 py-2" role="status">{message(snapshot.Warning)}</p>}{snapshot && error && <p role="alert" className="error">{message(error)}</p>}{demo && <p className="caption px-7 pb-3">{t('视觉预览 · 示例数据 · 不连接硬件')}</p>}</div></MotionConfig>
}
