import type { WeatherWind } from './weather-wind'

export type SeedMotion = 'float' | 'wind'
export type SeedFlow = { time: number; vx: number; vy: number }
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const random = (x: number) => { const n = Math.sin(x * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n) }

// The existing 10 vec4 uniforms ARE the particle state: offset XY, angle, opacity.
// No per-frame objects, history, textures or additional animation owner.
export function advanceSeedFlow(flow: SeedFlow, transforms: Float32Array, origins: number[][], delta: number, wind: WeatherWind | null, rain: number) {
  const dt = clamp(delta, 0, .2)
  flow.time += dt
  const time = flow.time
  const measured = !!wind && wind.speed >= 2 && wind.direction !== null
  const angle = measured ? wind!.direction! * Math.PI / 180 : 0
  const speed = measured ? 4 + Math.min(80, wind!.speed) * .48 : 5.5
  const gust = 1 + Math.sin(time * .17) * .12 + Math.sin(time * .43 + 1.3) * .07
    + (measured && wind!.gust !== null ? Math.min(.45, Math.max(0, wind!.gust! - wind!.speed) / 100) * (.5 + .5 * Math.sin(time * .29)) : 0)
  const targetX = measured ? -Math.sin(angle) * speed * gust : speed * gust * Math.cos(Math.sin(time * .023) * .45)
  const targetY = measured ? Math.cos(angle) * speed * gust * .32 : Math.sin(time * .023) * 1.2
  const follow = 1 - Math.exp(-dt / 5)
  flow.vx += (targetX - flow.vx) * follow
  flow.vy += (targetY - flow.vy) * follow
  for (let index = 0; index < origins.length; index++) {
    const slot = index * 4, phase = index * 1.731
    const individual = .72 + index % 5 * .12
    transforms[slot] += (flow.vx * individual + Math.sin(time * .51 + phase) * (1 + rain * 2)) * dt
    transforms[slot + 1] += (flow.vy * individual + Math.sin(time * .37 + phase) * (1.1 + rain * 2)) * dt
    let x = origins[index][0] + 32 + transforms[slot], y = origins[index][1] + 40 + transforms[slot + 1]
    if (x < -100 || x > 1772 || y < -100 || y > 700) {
      // Re-enter beyond the upstream edge; stagger by seed and elapsed time.
      const scatter = random(index * 17 + time)
      if (Math.abs(flow.vx) > Math.abs(flow.vy) * 2) {
        x = flow.vx >= 0 ? -90 : 1762; y = 80 + scatter * 450
      } else {
        x = 80 + scatter * 1512; y = flow.vy >= 0 ? -90 : 690
      }
      transforms[slot] = x - origins[index][0] - 32
      transforms[slot + 1] = y - origins[index][1] - 40
      transforms[slot + 3] = 0
    }
    const targetAngle = Math.sin(time * .29 + phase) * .13 + Math.sin(time * .61 + phase * .7) * .045
      + clamp(flow.vx / 180, -.22, .22)
    transforms[slot + 2] += (targetAngle - transforms[slot + 2]) * (1 - Math.exp(-dt / 2))
    const threshold = .12 + (index * 7 % 10) * .055
    const opacity = (1 - smooth(threshold, threshold + .2, rain)) * smooth(-65, 20, y) * (1 - smooth(590, 690, y))
    transforms[slot + 3] += (opacity - transforms[slot + 3]) * (1 - Math.exp(-dt / 2.5))
  }
}
