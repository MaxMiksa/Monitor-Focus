import { shareTree } from '@/lib/share-tree'
import { useI18n } from '@/lib/i18n-context'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { MotionConfig } from 'motion/react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isDesktop, preview, reportPanelReady, request, windowCommand } from '@/lib/control'
import type { Request, Snapshot } from '@/lib/control'
import type { SettingsEditorHandle } from '@/components/settings-editor'
import { ScenePanel } from '@/components/scene-panel'
import { SettingsMorph, SettingsShell } from '@/components/settings-morph'

export type Send = (command: Request) => Promise<Snapshot | null>
const SettingsEditor = lazy(() => import('@/components/settings-editor').then(module => ({ default: module.SettingsEditor })))

export default function App() {
  const { t, message, setLanguage, setSystemLanguage } = useI18n()
  const initialized = useRef(false)
  const connectionFailed = useRef(false)
  const demo = !isDesktop && new URLSearchParams(location.search).get('preview') === '1'
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => demo ? structuredClone(preview) : null)
  const [error, setError] = useState('')
  const contentReady = snapshot !== null || error !== ''
  useEffect(() => {
    // Hidden WebViews can throttle animation frames. Signal after React commits
    // the home or error view, without waiting for images, weather or effects.
    if (isDesktop && contentReady) reportPanelReady()
  }, [contentReady])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorStarted, setEditorStarted] = useState(false)
  const [initialCitySearch, setInitialCitySearch] = useState(false)
  function openEditor(city = false) {
    if (!editor.current) setInitialCitySearch(city)
    else if (city) editor.current.chooseWeatherLocation()
    setEditorStarted(true)
    setWeatherOpen(false)
    setSettingsOpen(true)
  }
  const [weatherOpen, setWeatherOpen] = useState(false)
  useEffect(() => {
    if (!settingsOpen && !weatherOpen) return
    const region = settingsOpen ? 'settings' : 'weather'
    function onPointerDown(event: PointerEvent) {
      // Portalled controls belong to their panel, even outside its rectangle.
      if (event.composedPath().some(node => node instanceof Element && node.getAttribute('data-dismiss-region') === region)) return
      if (region === 'settings') setSettingsOpen(false)
      else setWeatherOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [settingsOpen, weatherOpen])
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
        setSnapshot(previous => previous ? shareTree(previous, next) : next)
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
    let disposed = false
    queueMicrotask(() => { if (!disposed) void send({ Action: 'snapshot' }) })
    const timer = setInterval(() => { if (!document.hidden && !busy.current) void send({ Action: 'snapshot' }) }, 2000)
    return () => { disposed = true; clearInterval(timer) }
  }, [send, demo])
  useEffect(() => {
    let closing = false
    async function closeFromShortcut() {
      if (closing) return
      closing = true
      const saved = !editor.current || await editor.current.flush()
      windowCommand(saved ? 'window-shortcut-close' : 'window-shortcut-cancel')
      if (!saved) { setSettingsOpen(true); closing = false }
    }
    window.addEventListener('monitor-focus-close-panel', closeFromShortcut)
    return () => window.removeEventListener('monitor-focus-close-panel', closeFromShortcut)
  }, [])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !document.hasFocus() || event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (document.querySelector('[data-slot=select-content]') || (event.target as HTMLElement | null)?.closest('[data-slot=select-content]')) return
      event.preventDefault()
      if (weatherOpen) { setWeatherOpen(false); return }
      if (settingsOpen) { setSettingsOpen(false); return }
      void (async () => {
        const saved = !editor.current || await editor.current.flush()
        if (!document.hasFocus()) return
        if (saved) windowCommand('window-close')
        else setSettingsOpen(true)
      })()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settingsOpen, weatherOpen])
  return <MotionConfig reducedMotion="user"><SettingsMorph open={settingsOpen}><div className="scene-shell-root">
    {!snapshot ? <div className="p-7 text-white"><h1>MyScreen</h1><p className="my-6">{message(error) || t('正在连接控制核心…')}</p><Button variant="outline" className="text-foreground" onClick={() => void send({ Action: 'snapshot' })}><RefreshCw />{t('重新连接')}</Button></div> : <ScenePanel snapshot={snapshot} send={sceneSend} error={error} demo={demo} settingsOpen={settingsOpen} weatherOpen={weatherOpen} setWeatherOpen={setWeatherOpen} openSettings={() => openEditor()} chooseWeatherLocation={() => openEditor(true)}>
      <SettingsShell open={settingsOpen}><Suspense fallback={null}>{editorStarted && <SettingsEditor initialCitySearch={initialCitySearch} ref={editor} open={settingsOpen} close={() => setSettingsOpen(false)} snapshot={snapshot} send={send} />}</Suspense></SettingsShell>
    </ScenePanel>}
  </div></SettingsMorph></MotionConfig>
}
