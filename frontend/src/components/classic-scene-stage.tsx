import { useLayoutEffect, useRef } from 'react'
import type { StageKey } from './scene-panel'

const order: StageKey[] = ['morning', 'midday', 'dusk', 'night']

// Only the requested image is decoded. Keep the original layer order and CSS
// easing, including partially faded layers when the user reverses direction.
export function ClassicSceneStage({ scene }: { scene: StageKey }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = host.current!
    const layers = () => Array.from(root.querySelectorAll<HTMLImageElement>('img'))
    const find = layers().find(layer => layer.dataset.scene === scene)
    const image = find ?? new Image()
    let canceled = false
    const activate = () => {
      if (canceled) return
      for (const layer of layers()) {
        const active = layer === image
        if (layer.dataset.active === String(active)) continue
        layer.dataset.active = String(active)
        if (!active) {
          const animations = layer.getAnimations()
          void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
            if (layer.dataset.active === 'false' && layer.getAnimations().length === 0) layer.remove()
          })
        }
      }
    }
    if (find) activate()
    else {
      image.alt = ''
      image.className = 'scene-image'
      image.dataset.scene = scene
      image.dataset.active = String(!root.firstChild)
      const above = layers().find(layer => order.indexOf(layer.dataset.scene as StageKey) > order.indexOf(scene))
      root.insertBefore(image, above ?? null)
      image.src = '/scenes/' + scene + '.webp'
      void image.decode().then(() => {
        if (canceled) return
        // Establish the incoming opacity before starting the transition.
        void getComputedStyle(image).opacity
        activate()
      }, () => { if (!canceled) image.remove() })
    }
    return () => {
      canceled = true
      if (image.dataset.active === 'false') {
        image.remove()
        image.removeAttribute('src')
      }
    }
  }, [scene])
  return <div ref={host} />
}
