import type { SkySettings } from './sky-preference'

type Placement = { x: number; y: number; z: number; phase: number; amplitude: number; vertical: number }

// Time already includes the speed slider. Wrap only beyond the full cloud bank,
// not at the viewport edge, so no visible cloud is teleported across the sky.
export function cloudPosition(position: Placement, time: number, motion: SkySettings['clouds']['motion'], halfViewWidth: number) {
  if (motion === 'float') return {
    x: position.x + Math.sin(time * .3 + position.phase) * position.amplitude,
    y: position.y + Math.sin(time * .22 + position.phase) * Math.max(.08, position.vertical),
  }
  const edge = halfViewWidth + 14, span = edge * 2
  const x = position.x + time * (.3 + position.phase * .035)
  return { x: ((x + edge) % span + span) % span - edge, y: position.y }
}

export function legacyCloudOffset(time: number, motion: SkySettings['clouds']['motion']) {
  return motion === 'float'
    ? { x: Math.sin(time * .3) * .035, y: Math.sin(time * .22) * .008 }
    : { x: time * .012, y: 0 }
}
