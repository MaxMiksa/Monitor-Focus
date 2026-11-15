import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CloudLabSettings } from '@/lib/cloud-lab'
import type { CloudRuntime } from '@/lib/cloud-renderers'

export function CloudLabEffects({ value, reduced }: { value: CloudLabSettings; reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const state = useRef({ value, reduced })
  const refresh = useRef<(() => void) | null>(null)
  const [status, setStatus] = useState('')
  useEffect(() => { state.current = { value, reduced }; refresh.current?.() }, [value, reduced])
  useEffect(() => {
    if (['saved', 'none', 'pmndrs'].includes(value.candidate)) return
    const canvas = canvasRef.current
    if (!canvas) return
    const controller = new AbortController()
    let runtime: CloudRuntime | undefined
    let timer = 0, last = performance.now(), time = 0
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return
      window.clearTimeout(timer)
      canvas.dataset.ready = 'error'
      console.warn('云彩候选加载失败', error)
      setStatus('这款云彩暂时无法加载，请切换其他候选')
    }
    const draw = () => {
      window.clearTimeout(timer)
      if (!runtime || controller.signal.aborted || document.hidden) return
      try {
        const now = performance.now()
        const delta = Math.min((now - last) / 1000, .15)
        last = now
        if (!state.current.reduced) time += delta * state.current.value.speed / 100
        runtime.render(state.current.value, time, state.current.reduced ? 0 : delta * state.current.value.speed / 100)
        canvas.dataset.ready = 'true'
        if (!state.current.reduced && state.current.value.speed > 0 && state.current.value.density > 0) timer = window.setTimeout(draw, 50)
      } catch (error) { fail(error) }
    }
    const resume = () => { last = performance.now(); draw() }
    refresh.current = resume
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('resize', resume)
    void (async () => {
      setStatus('正在加载云彩…')
      try {
        const module = await import('@/lib/cloud-renderers')
        if (controller.signal.aborted) return
        const created = await module.createCloudRuntime(canvas, state.current.value, controller.signal)
        if (controller.signal.aborted) { created.dispose(); return }
        runtime = created
        setStatus('')
        resume()
      } catch (error) { fail(error) }
    })()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      refresh.current = null
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('resize', resume)
      runtime?.dispose()
    }
  }, [value.candidate])
  if (['saved', 'none', 'pmndrs'].includes(value.candidate)) return null
  return <><canvas key={value.candidate} ref={canvasRef} className="sky-effects-canvas" data-cloud-candidate={value.candidate} aria-hidden="true" />{status && createPortal(<div className="cloud-lab-status" role="status">{status}</div>, document.body)}</>
}
