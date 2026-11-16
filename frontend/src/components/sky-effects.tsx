import { lazy, Suspense, useEffect, useState } from 'react'
import { readSkyPreferences, SKY_EVENT } from '@/lib/sky-preference'
import type { StageKey } from '@/components/scene-panel'

// No Three.js or pmndrs code is loaded until an effective sky resource is needed.
const SkyCanvas = lazy(() => import('./sky-canvas').then(module => ({ default: module.SkyCanvas })))

export function SkyEffects({ scene, reduced }: { scene: StageKey; reduced: boolean }) {
  const [preferences, setPreferences] = useState(readSkyPreferences)
  useEffect(() => {
    const update = () => setPreferences(readSkyPreferences())
    window.addEventListener(SKY_EVENT, update)
    window.addEventListener('storage', update)
    update()
    return () => {
      window.removeEventListener(SKY_EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])
  const settings = preferences[scene]
  if (!(settings.stars.enabled && settings.stars.brightness > 0 && settings.stars.count > 0) && !(settings.clouds.enabled && settings.clouds.density > 0)) return null
  return <Suspense fallback={null}><SkyCanvas scene={scene} reduced={reduced} settings={settings} /></Suspense>
}
