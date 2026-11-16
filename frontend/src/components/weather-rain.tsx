import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StageKey } from '@/components/scene-panel'
import type { RainEdges, RainRuntime } from '@/lib/wind-rain-runtime'
import { rainMoodOpacity } from '@/lib/rain-appearance'

export function RainAtmosphere({ rain, scene }: { rain: number; scene: StageKey }) {
  if (rain <= 0) return null
  return <div className="weather-rain-atmosphere" data-night={scene === 'night'} aria-hidden="true" style={{ opacity: rainMoodOpacity(rain, scene === 'night') }} />
}

export function WeatherRainOverlay({ rain, reduced, settingsOpen, background = 'live' }: { rain: number; reduced: boolean; settingsOpen: boolean; background?: 'live' | 'classic' }) {
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<RainRuntime | null>(null)
  const current = useRef({ rain, settingsOpen, background })
  const [visible, setVisible] = useState(!document.hidden)
  const active = rain > 0 && !reduced && visible
  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  useLayoutEffect(() => {
    current.current = { rain, settingsOpen, background }
    runtime.current?.setAmount(rain)
    runtime.current?.refreshEdges()
  }, [rain, settingsOpen, background])
  useEffect(() => {
    const element = host.current
    if (!active || !element) return
    let disposed = false
    const edges: RainEdges = []
    const pool = [{ left: 0, right: 0, top: 0 }, { left: 0, right: 0, top: 0 }]
    const getEdges = () => {
      edges.length = 0; edges.settingsOpen = current.current.settingsOpen
      edges.background = current.current.background
      const root = element.parentElement
      if (!root) return edges
      const origin = element.getBoundingClientRect()
      const surface = root.querySelector<HTMLElement>('.settings-morph-surface')
      const hint = root.querySelector<HTMLElement>('.scene-expand-hint:not([inert])')
      for (const [index, target] of [surface, hint].entries()) {
        if (!target) continue
        const rect = target.getBoundingClientRect()
        if (rect.width < 4 || rect.height < 4) continue
        const radius = index === 0 ? Math.min(rect.height / 2, parseFloat(target.style.borderRadius) || 28) : rect.width * .4
        const edge = pool[index]
        edge.left = rect.left + radius - origin.left; edge.right = rect.right - radius - origin.left
        edge.top = rect.top - origin.top; edges.push(edge)
      }
      return edges
    }
    void import('@/lib/wind-rain-runtime.js').then(({ createWindRain }) => {
      if (disposed) return
      const effect = createWindRain(element, () => {})
      runtime.current = effect
      effect.setEdges(getEdges)
      effect.setAmount(current.current.rain)
      effect.setPaused(false)
    }).catch(error => console.warn('雨景初始化失败', error))
    return () => {
      disposed = true
      runtime.current?.dispose(); runtime.current = null
      // The runtime owns a canvas, while React retains its host for later rain.
      element.replaceChildren()
    }
  }, [active])
  return <div ref={host} className="weather-rain-overlay" aria-hidden="true" />
}
