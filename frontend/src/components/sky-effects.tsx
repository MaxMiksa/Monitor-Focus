import { lazy, Suspense } from 'react'
import type { SkySettings } from '@/lib/sky-preference'
import type { StageKey } from '@/components/scene-panel'

// No Three.js or pmndrs code is loaded until an effective sky resource is needed.
const SkyCanvas = lazy(() => import('./sky-canvas').then(module => ({ default: module.SkyCanvas })))

export function SkyEffects({ scene, reduced, settings }: { scene: StageKey; reduced: boolean; settings: SkySettings }) {
  if (!(settings.stars.enabled && settings.stars.brightness > 0 && settings.stars.count > 0) && !(settings.clouds.enabled && settings.clouds.density > 0)) return null
  return <Suspense fallback={null}><SkyCanvas scene={scene} reduced={reduced} settings={settings} /></Suspense>
}
