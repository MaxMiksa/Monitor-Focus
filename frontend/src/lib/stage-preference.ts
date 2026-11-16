import { useEffect, useState } from 'react'

export type StageStyle = 'live' | 'classic'
export type SceneBarStyle = 'text' | 'icon' | 'both'
export const STAGE_STYLE_KEY = 'monitors-focus.background-style'
const OBSOLETE_STAGE_KEY = 'monitors-focus.stage-style'
export const SCENE_BAR_STYLE_KEY = 'monitors-focus.scene-bar-style'
export const AIR_OPACITY_KEY = 'monitors-focus.air-opacity'
export const PREFERENCE_EVENT = 'monitors-focus-preferences'
export const AIR_OPACITY_EVENT = 'monitors-focus-air-opacity'

export function readAirOpacity(): number {
  try {
    const value = Number(localStorage.getItem(AIR_OPACITY_KEY) ?? '8')
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : .08
  } catch {
    return .08
  }
}

export function writeAirOpacity(value: number) {
  const opacity = Math.max(0, Math.min(100, Math.round(value)))
  localStorage.setItem(AIR_OPACITY_KEY, String(opacity))
  window.dispatchEvent(new Event(AIR_OPACITY_EVENT))
}

export function useAirOpacity(): [number, (value: number) => void] {
  const [value, setValue] = useState(() => Math.round(readAirOpacity() * 100))
  useEffect(() => {
    const sync = () => setValue(Math.round(readAirOpacity() * 100))
    window.addEventListener('storage', sync)
    window.addEventListener(AIR_OPACITY_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(AIR_OPACITY_EVENT, sync)
    }
  }, [])
  return [value, (next: number) => { writeAirOpacity(next); setValue(Math.round(Math.max(0, Math.min(100, next)))) }]
}

export function readStageStyle(): StageStyle {
  try {
    // Preserve the chosen pictures, not the retired interface or its key.
    const previous = localStorage.getItem(OBSOLETE_STAGE_KEY)
    if (previous !== null) {
      if (localStorage.getItem(STAGE_STYLE_KEY) === null) localStorage.setItem(STAGE_STYLE_KEY, previous === 'classic' ? 'classic' : 'live')
      localStorage.removeItem(OBSOLETE_STAGE_KEY)
    }
    return localStorage.getItem(STAGE_STYLE_KEY) === 'classic' ? 'classic' : 'live'
  } catch {
    return 'live'
  }
}

export function writeStageStyle(style: StageStyle) {
  localStorage.setItem(STAGE_STYLE_KEY, style)
  window.dispatchEvent(new Event(PREFERENCE_EVENT))
}

export function readSceneBarStyle(): SceneBarStyle {
  try {
    const value = localStorage.getItem(SCENE_BAR_STYLE_KEY)
    return value === 'icon' || value === 'both' ? value : 'text'
  } catch {
    return 'text'
  }
}

export function writeSceneBarStyle(style: SceneBarStyle) {
  localStorage.setItem(SCENE_BAR_STYLE_KEY, style)
  window.dispatchEvent(new Event(PREFERENCE_EVENT))
}

export function useStageStyle(): [StageStyle, (style: StageStyle) => void] {
  const [style, setStyle] = useState(readStageStyle)
  useEffect(() => {
    const sync = () => setStyle(readStageStyle())
    window.addEventListener('storage', sync)
    window.addEventListener(PREFERENCE_EVENT, sync)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(PREFERENCE_EVENT, sync) }
  }, [])
  return [style, (next: StageStyle) => { writeStageStyle(next); setStyle(next) }]
}

export function useSceneBarStyle(): [SceneBarStyle, (style: SceneBarStyle) => void] {
  const [style, setStyle] = useState(readSceneBarStyle)
  useEffect(() => {
    const sync = () => setStyle(readSceneBarStyle())
    window.addEventListener('storage', sync)
    window.addEventListener(PREFERENCE_EVENT, sync)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(PREFERENCE_EVENT, sync) }
  }, [])
  return [style, (next: SceneBarStyle) => { writeSceneBarStyle(next); setStyle(next) }]
}
