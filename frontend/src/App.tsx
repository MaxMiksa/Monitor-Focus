import { useI18n } from '@/lib/i18n-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MotionConfig } from 'motion/react'
import { Monitor, Laptop, Sun, Thermometer, RotateCcw, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { isDesktop, preview, request, windowCommand } from '@/lib/control'
import type { Display, Request, Snapshot } from '@/lib/control'
import { SettingsEditor } from '@/components/settings-editor'
import type { SettingsEditorHandle } from '@/components/settings-editor'
import { ScenePanel } from '@/components/scene-panel'

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
    {onTemperatureCommit && <div className="display-row display-temperature">
      {onRestoreColor && <Button className="temperature-reset" variant="ghost" size="icon" aria-label={t('{0}恢复原色', displayName(display.Name))} title={t('恢复原色')} disabled={display.Kelvin === null} onClick={onRestoreColor}><RotateCcw /></Button>}
      <Level label={temperatureLabel ?? t('{0}色温', displayName(display.Name))} value={display.Kelvin ?? 6500} min={2700} max={6500} step={100} disabled={!display.CanAdjustColor || !!display.Error} temperature onCommit={onTemperatureCommit} /><Thermometer className="text-muted-foreground" /><output>{display.Kelvin ? `${display.Kelvin} K` : t('原色')}</output>
    </div>}
    {display.Error && <p className="error" role="status">{message(display.Error)}</p>}</div>
}
export default function App() {
  const { t, message, setLanguage, setSystemLanguage } = useI18n()
  const initialized = useRef(false)
  const connectionFailed = useRef(false)
  const demo = !isDesktop && new URLSearchParams(location.search).get('preview') === '1'
  const [snapshot, setSnapshot] = useState<Snapshot | null>(demo ? structuredClone(preview) : null)
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const editor = useRef<SettingsEditorHandle>(null)
  const queue = useRef(Promise.resolve())
  const busy = useRef(0)
  const send = useCallback<Send>((command) => {
    if (demo) {
      return new Promise<Snapshot | null>(resolve => setSnapshot(current => {
        if (!current) { resolve(null); return current }
        const next = structuredClone(current)
        if (command.Action === 'save' && command.Settings) {
          next.Settings = { ...structuredClone(command.Settings), Revision: current.Settings.Revision + 1 }
        }
        resolve(next)
        return next
      }))
    }
    busy.current++
    const task = queue.current.then(async () => {
      try {
        const next = await request(command)
        setSnapshot(next)
        if (next.SystemLanguage) setSystemLanguage(next.SystemLanguage)
        if (!initialized.current) {
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
  const sceneSend = useCallback<Send>(async command => {
    if (editor.current && !await editor.current.flush()) { setSettingsOpen(true); return null }
    return send(command)
  }, [send])
  useEffect(() => {
    if (demo || !isDesktop) return
    const initial = setTimeout(() => void send({ Action: 'snapshot' }), 0)
    const timer = setInterval(() => { if (!document.hidden && !busy.current) void send({ Action: 'snapshot' }) }, 2000)
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, [send, demo])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== 'Escape' || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      if (settingsOpen) { setSettingsOpen(false); return }
      void (async () => { if (!editor.current || await editor.current.flush()) windowCommand('window-close'); else setSettingsOpen(true) })()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen])
  return <MotionConfig reducedMotion="user"><div className="scene-shell-root">
    {!snapshot ? <div className="p-7"><h1>Monitors Focus</h1><p className="caption my-6">{message(error) || t('正在连接控制核心…')}</p><Button variant="outline" onClick={() => void send({ Action: 'snapshot' })}><RefreshCw />{t('重新连接')}</Button></div> : <ScenePanel snapshot={snapshot} send={sceneSend} error={error} demo={demo} settingsOpen={settingsOpen} openSettings={() => setSettingsOpen(true)}>
      <SettingsEditor ref={editor} open={settingsOpen} close={() => setSettingsOpen(false)} snapshot={snapshot} send={send} />
    </ScenePanel>}
  </div></MotionConfig>
}
