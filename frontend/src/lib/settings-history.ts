import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings, Snapshot } from './control'
import type { Send } from '@/App'
import { readAirOpacity, readSceneBarStyle, readStageStyle, writeAirOpacity, writeSceneBarStyle, writeStageStyle } from './stage-preference'

function createDraft(settings: Settings) {
  return {
    ...structuredClone(settings),
    Schedule: settings.Schedule.map(point => ({ ...point, key: crypto.randomUUID() })),
    appearance: { stage: readStageStyle(), bar: readSceneBarStyle(), air: Math.round(readAirOpacity() * 100) },
  }
}
type Draft = ReturnType<typeof createDraft>
type History = { past: Draft[]; present: Draft; future: Draft[] }
function settingsOf(draft: Draft): Settings {
  const { appearance, ...settings } = draft
  void appearance
  return { ...settings, Schedule: draft.Schedule.map(({ key, ...point }) => { void key; return point }) }
}
function fingerprint(settings: Settings) {
  // Go and JS construct objects in different key orders (especially new scenes).
  return JSON.stringify({ ...settings, Revision: 0 }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
}

// One persistent history across tabs and collapse; saves are serialized and never
// replace edits made while a request is in flight. Revision conflicts remain drafts.
export function useSettingsHistory(snapshot: Snapshot, send: Send) {
  const [history, setHistory] = useState<History>(() => ({ past: [], present: createDraft(snapshot.Settings), future: [] }))
  const current = useRef(history)
  const saved = useRef(snapshot.Settings)
  const flight = useRef<Promise<boolean> | null>(null)
  const failed = useRef(false)
  const [status, setStatus] = useState('已自动保存')
  const [saving, setSaving] = useState(false)
  const [hasFailure, setHasFailure] = useState(false)

  const commit = useCallback((next: History) => {
    current.current = next
    failed.current = false
    setHasFailure(false)
    setHistory(next)
    setStatus('正在保存…')
    try {
      writeStageStyle(next.present.appearance.stage)
      writeSceneBarStyle(next.present.appearance.bar)
      writeAirOpacity(next.present.appearance.air)
    } catch {
      failed.current = true
      setHasFailure(true)
      setStatus('保存失败，改动已保留')
    }
  }, [])

  const flush = useCallback((retry = false): Promise<boolean> => {
    if (flight.current) return flight.current
    if (retry) failed.current = false
    if (failed.current) return Promise.resolve(false)
    const task = async () => {
      setSaving(true)
      try {
        const appearance = current.current.present.appearance
        writeStageStyle(appearance.stage)
        writeSceneBarStyle(appearance.bar)
        writeAirOpacity(appearance.air)
        while (fingerprint(settingsOf(current.current.present)) !== fingerprint(saved.current)) {
          const draft = current.current.present
          const settings = { ...settingsOf(draft), Revision: saved.current.Revision }
          const result = await send({ Action: 'save', Settings: settings })
          if (!result) {
            failed.current = true
            setHasFailure(true)
            setStatus('保存失败，改动已保留')
            return false
          }
          saved.current = result.Settings
        }
        setHasFailure(false)
        setStatus('已自动保存')
        return true
      } catch {
        failed.current = true
        setHasFailure(true)
        setStatus('保存失败，改动已保留')
        return false
      } finally { setSaving(false) }
    }
    flight.current = task().finally(() => { flight.current = null })
    return flight.current
  }, [send])

  useEffect(() => {
    const timer = window.setTimeout(() => void flush(), 500)
    return () => window.clearTimeout(timer)
  }, [history.present, flush])

  useEffect(() => {
    if (flight.current || snapshot.Settings.Revision === saved.current.Revision) return
    // Adopt external changes only while clean; never rebase an unsaved draft onto
    // another writer's revision, which would silently overwrite that writer.
    if (fingerprint(settingsOf(current.current.present)) !== fingerprint(saved.current)) return
    saved.current = snapshot.Settings
    const next = { past: [], present: createDraft(snapshot.Settings), future: [] }
    current.current = next
    setHistory(next)
  }, [snapshot.Settings, saving])

  function change(update: (draft: Draft) => void) {
    const old = current.current
    const next = structuredClone(old.present)
    update(next)
    if (JSON.stringify(next) !== JSON.stringify(old.present)) {
      commit({ past: [...old.past.slice(-99), old.present], present: next, future: [] })
    }
  }
  function undo() {
    const old = current.current
    if (old.past.length) commit({ past: old.past.slice(0, -1), present: old.past.at(-1)!, future: [old.present, ...old.future] })
  }
  function redo() {
    const old = current.current
    if (old.future.length) commit({ past: [...old.past, old.present], present: old.future[0], future: old.future.slice(1) })
  }
  function reload() {
    saved.current = snapshot.Settings
    commit({ past: [...current.current.past, current.current.present], present: createDraft(snapshot.Settings), future: [] })
  }
  return { draft: history.present, change, undo, redo, reload, flush, saving, status, hasFailure, canUndo: !!history.past.length, canRedo: !!history.future.length }
}
