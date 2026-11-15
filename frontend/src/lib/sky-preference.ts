import type { StageKey } from '@/components/scene-panel'

export type SkySettings = {
  stars: { enabled: boolean; style: 'sparse' | 'dense'; count: number; brightness: number; twinkle: number }
  clouds: { enabled: boolean; style: 'legacy' | 'wisps' | 'puffs' | 'layers'; density: number; speed: number }
}
export type SkyPreferences = Record<StageKey, SkySettings>
export const SKY_KEY = 'monitors-focus.' + 'sky-settings-v1'
export const SKY_EVENT = 'monitors-focus-sky'
export const SKY_PREVIEW_EVENT = 'monitors-focus-sky-preview'
export const skyScenes = ['morning', 'midday', 'dusk', 'night'] as const

function percent(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : fallback
}

export function readSkyPreferences(): SkyPreferences {
  let stored: Partial<SkyPreferences> = {}
  try { stored = JSON.parse(localStorage.getItem(SKY_KEY) ?? '{}') ?? {} } catch { /* Keep malformed storage untouched until an explicit edit. */ }
  return Object.fromEntries(skyScenes.map(scene => {
    const value = stored?.[scene]
    return [scene, {
      stars: {
        enabled: typeof value?.stars?.enabled === 'boolean' ? value.stars.enabled : scene === 'night',
        style: value?.stars?.style === 'dense' ? 'dense' : 'sparse',
        count: percent(value?.stars?.count, 30), brightness: percent(value?.stars?.brightness, 65), twinkle: percent(value?.stars?.twinkle, 20),
      },
      clouds: {
        enabled: typeof value?.clouds?.enabled === 'boolean' ? value.clouds.enabled : scene !== 'night',
        style: value?.clouds?.style === 'legacy' || value?.clouds?.style === 'puffs' || value?.clouds?.style === 'layers' ? value.clouds.style : 'wisps',
        density: percent(value?.clouds?.density, 35), speed: percent(value?.clouds?.speed, 20),
      },
    }]
  })) as SkyPreferences
}

export function writeSkyPreferences(value: SkyPreferences) {
  const encoded = JSON.stringify(value)
  if (localStorage.getItem(SKY_KEY) === encoded) return
  localStorage.setItem(SKY_KEY, encoded)
  window.dispatchEvent(new Event(SKY_EVENT))
}

export function previewSky(scene: StageKey | null) {
  window.dispatchEvent(new CustomEvent(SKY_PREVIEW_EVENT, { detail: scene }))
}
