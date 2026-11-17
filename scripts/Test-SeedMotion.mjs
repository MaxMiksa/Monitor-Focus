// node scripts/Test-SeedMotion.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { advanceSeedFlow } from '../frontend/src/lib/seed-motion.ts'
import { domesticWind, openMeteoWind, validWind } from '../frontend/src/lib/weather-wind.ts'
import { readSkyPreferences, SKY_KEY } from '../frontend/src/lib/sky-preference.ts'

const { origins } = JSON.parse(await readFile(new URL('../frontend/src/lib/seed-patches.json', import.meta.url)))
const storage = new Map()
globalThis.localStorage = { getItem: key => storage.get(key) ?? null }
assert.equal(readSkyPreferences().morning.seeds.motion, 'float')
storage.set(SKY_KEY, JSON.stringify({ morning: { seeds: { motion: 'wind' } }, midday: { seeds: { motion: 'invalid' } } }))
assert.equal(readSkyPreferences().morning.seeds.motion, 'wind')
assert.equal(readSkyPreferences().midday.seeds.motion, 'float')
assert.equal(readSkyPreferences().night.seeds.motion, 'float')
assert.equal(JSON.parse(storage.get(SKY_KEY)).midday.seeds.motion, 'invalid')

assert.deepEqual(domesticWind({ wind_direction: '东南风', wind_power: '3级' }), { direction: 135, speed: 15.5, gust: null, estimated: true })
assert.equal(domesticWind({ wind_direction: '北风', wind_power: '3-4级' }).speed, 19.75)
assert.equal(domesticWind({ wind_power: '99级' }), null)
assert.equal(domesticWind({ wind_power: '5-2级' }), null)
assert.equal(domesticWind({ wind_direction: '旋转风', wind_power: '2级' }).direction, null)
assert.equal(openMeteoWind({ wind_speed_10m: 10, wind_direction_10m: 270 }).speed, 10)
assert.equal(openMeteoWind({ wind_speed_10m: -1 }), null)
assert.equal(validWind({ speed: 20, direction: NaN, gust: null, estimated: false }), null)

const initial = () => { const data = new Float32Array(40); for (let i = 3; i < 40; i += 4) data[i] = 1; return data }
const west = { speed: 20, direction: 270, gust: null, estimated: false }
function run(seconds, wind, rain = 0) {
  const data = initial(), flow = { time: 0, vx: 0, vy: 0 }
  for (let frame = 0; frame < seconds * 20; frame++) advanceSeedFlow(flow, data, origins, .05, wind, rain)
  return { data, flow }
}
const right = run(30, west), left = run(30, { ...west, direction: 90 })
assert(right.data[0] > 200 && left.data[0] < -200)
assert(run(15, { ...west, speed: 60 }).data[0] > run(15, { ...west, speed: 5 }).data[0] * 2)
assert(run(30, null).data[0] > 40)
assert(run(30, { ...west, speed: 0 }).data[0] > 40)
const priorVx = right.flow.vx
advanceSeedFlow(right.flow, right.data, origins, .05, { ...west, direction: 90 }, 0)
assert(right.flow.vx > 0 && Math.abs(right.flow.vx - priorVx) < 1)
assert(new Set(Array.from(right.data).filter((_, i) => i % 4 === 2).map(x => x.toFixed(4))).size > 7)
const alphaSum = data => Array.from(data).filter((_, i) => i % 4 === 3).reduce((sum, x) => sum + x, 0)
assert(alphaSum(run(30, null, .35).data) < alphaSum(run(30, null, 0).data) - 2)
assert(alphaSum(run(30, null, .85).data) < .001)
const recovery = run(30, null, .85)
for (let frame = 0; frame < 600; frame++) advanceSeedFlow(recovery.flow, recovery.data, origins, .05, null, 0)
assert(alphaSum(recovery.data) > 5)

const data = initial(), buffer = data.buffer, flow = { time: 0, vx: 0, vy: 0 }
let wraps = 0
for (let frame = 0; frame < 36_000; frame++) {
  const previousX = data[0], direction = Math.floor(frame / 3000) * 45 % 360
  advanceSeedFlow(flow, data, origins, .05, { ...west, direction, speed: 65 }, frame % 2000 > 1000 ? .85 : 0)
  if (Math.abs(data[0] - previousX) > 100) wraps++
  for (let i = 0; i < origins.length; i++) {
    const x = origins[i][0] + 32 + data[i * 4], y = origins[i][1] + 40 + data[i * 4 + 1]
    assert(Number.isFinite(x) && Number.isFinite(y) && x >= -101 && x <= 1773 && y >= -101 && y <= 701)
    assert(data[i * 4 + 3] >= 0 && data[i * 4 + 3] <= 1)
  }
}
assert(wraps > 1)
assert.equal(data.buffer, buffer)
assert.equal(data.byteLength, 160)
console.log(JSON.stringify({ passed: true, checks: 'preference compatibility, weather validation, wind direction/strength, calm fallback, smooth reversal, independent rotation, rain fade/recovery, 30-minute simulated bounds/respawn', seeds: origins.length, particleStateBytes: data.byteLength, newTextures: 0, wraps }))
