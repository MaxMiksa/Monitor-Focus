import type { StageKey } from '@/components/scene-panel'
import type { SkySettings } from '@/lib/sky-preference'

// Three existing cloud groups share 72 particles. Change their placement only;
// keep the component's textures, shapes and animation, and never move legacy.
export function cloudPlacements(clouds: SkySettings['clouds'], scene: StageKey) {
  let seed = `${scene}:${clouds.style}`.split('').reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0, 47)
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  return Array.from({ length: 3 }, (_, index) => {
    const side = index - 1
    const jitter = random() - .5
    const drift = { phase: index * 1.7, amplitude: 1.6, vertical: 0 }
    switch (clouds.layout) {
      case 'scatter':
        // Stratified sampling avoids three random groups piling up together.
        return { x: side * 6 + jitter * 1.8, y: 1.6 + random() * 3.2, z: -2 - random() * 2, ...drift, vertical: .10 }
      case 'stagger':
        return { x: side * 6.1, y: [2.0, 4.5, 2.8][index] + jitter * .5, z: -2 - index * .6, ...drift, amplitude: 1.1, vertical: .12 }
      case 'arc':
        return { x: side * 6.3, y: 4.8 - side * side * 2.1, z: -2 - Math.abs(side) * .6, ...drift, amplitude: .9, vertical: .08 }
      case 'depth':
        // Perspective shrinks the far bank naturally, without changing shapes.
        return { x: [-7, 1, 8][index], y: [1.5, 3.2, 5.1][index], z: [-7, -4, -1.5][index], ...drift, amplitude: [.6, 1, 1.4][index] }
      default:
        return { x: side * (clouds.style === 'puffs' ? 6.8 : 4.6), y: clouds.style === 'layers' ? .2 + index * 1.7 : 2.7 + (index % 2) * 1.2, z: -2 - index * .3, ...drift }
    }
  })
}
