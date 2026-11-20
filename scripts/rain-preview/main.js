import { createActualUI } from './actual-ui.js'
import { rainMoodOpacity } from '../../frontend/src/lib/rain-appearance.ts'

const $ = selector => document.querySelector(selector)
const host = $('#effect')
const actualUI = createActualUI($('#stage'))
const presets = [
  { id: 'fine', name: '轻细雨', engine: 'tsParticles', detail: '细短、清透、轻盈。雨丝克制，草坡最清晰。', kind: 'ts', url: 'https://github.com/tsparticles/tsparticles' },
  { id: 'soft', name: '柔和雨幕', engine: 'tsParticles', detail: '柔边雨丝，疏密有致。比轻细雨更有存在感。', kind: 'ts', url: 'https://github.com/tsparticles/tsparticles' },
  { id: 'natural', name: '立体自然雨', engine: 'three.quarks', detail: '远近三层，细雨有空间。近处稍快，远处更轻。', kind: 'quarks', url: 'https://github.com/Alchemist0823/three.quarks' },
  { id: 'cinema', name: '电影感雨丝', engine: 'three.quarks', detail: '稀疏长雨丝，柔光拖尾。更安静，也更有氛围。', kind: 'quarks', url: 'https://github.com/Alchemist0823/three.quarks' },
  { id: 'wind', name: '斜风雨', engine: 'three.quarks', detail: '远密近疏，随风斜落；机顶细碎水珠短暂散开，雨丝自然飘过。', kind: 'quarks', url: 'https://github.com/Alchemist0823/three.quarks' },
  { id: 'cloud', name: '小乌云淋雨', engine: 'three.quarks', detail: '一朵乌云轻飘，局部落雨，击中机顶溅起小水花。', kind: 'local', url: 'https://github.com/Alchemist0823/three.quarks' },
]
let selected = 4, amount = .75, paused = false, baseline = false
let active = null, revision = 0, saved = null
let splashEnabled = true
let moodEnabled = true, currentScene = 'midday'
let uiEnabled = true
actualUI.onChange(() => active?.refreshEdges?.())
actualUI.onScene(scene => {
  if (!['morning', 'midday', 'dusk', 'night'].includes(scene)) return
  currentScene = scene
  $('#backdrop').style.backgroundImage = `url('/scenes/live/${scene}.webp')`
  present()
})
const frameBudget = 30
try {
  const remembered = JSON.parse(localStorage.getItem('myscreen.rain-gallery-choice') || 'null')
  const index = presets.findIndex(preset => preset.id === remembered?.id)
  if (index >= 0 && Number.isFinite(remembered.intensity) && remembered.intensity >= 0 && remembered.intensity <= 100) {
    selected = index; amount = remembered.intensity / 100
    saved = { id: presets[index].id, name: presets[index].name, intensity: remembered.intensity }
    $('#intensity').value = String(remembered.intensity)
  }
} catch { /* A stale preview preference must not block viewing. */ }
function report(count, fps, splashes) {
  const state = baseline ? '原景对照' : paused ? '已暂停' : amount === 0 ? '无雨' : document.hidden ? '已暂停' : fps ? `${fps} 帧` : `上限 ${frameBudget} 帧`
  $('#render-status').textContent = splashes === undefined
    ? `${presets[selected].engine} · ${count} 雨丝 · ${state}`
    : `${count} 雨滴 · ${splashes} 水花 · ${state}`
  host.dataset.particles = String(count)
  host.dataset.paused = String(paused || baseline || document.hidden || amount === 0)
}
// Open this review on the selected wind-rain direction.
if (!saved || saved.id !== 'wind') { selected = 4; amount = .75 }
$('#intensity').value = String(Math.round(amount * 100))
const chooseButtons = presets.map((preset, index) => {
  const button = document.createElement('button')
  button.className = 'choice'
  button.dataset.preset = preset.id
  button.innerHTML = `<span class="number">0${index + 1}</span><span class="name">${preset.name}</span><span class="engine">${preset.engine}</span>`
  button.addEventListener('click', () => { selected = index; void switchEffect() })
  $('.choices').append(button)
  return button
})

function present() {
  chooseButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === selected)))
  $('#current-title').textContent = `0${selected + 1} · ${presets[selected].name}`
  $('#description').textContent = presets[selected].detail
  $('#source').href = presets[selected].url
  $('#splash').hidden = presets[selected].id !== 'wind'
  $('#splash').setAttribute('aria-pressed', String(splashEnabled))
  $('#mood').hidden = presets[selected].id !== 'wind'
  $('#mood').setAttribute('aria-pressed', String(moodEnabled))
  $('#ui-mode').hidden = presets[selected].id !== 'wind'
  $('#ui-mode').setAttribute('aria-pressed', String(uiEnabled))
  actualUI.setEnabled(uiEnabled && presets[selected].id === 'wind')
  const rainyMood = presets[selected].id === 'wind' && moodEnabled && !baseline && amount > 0
  document.body.classList.toggle('rainy-mood', rainyMood)
  document.body.dataset.scene = currentScene
  document.body.classList.toggle('local-cloud', presets[selected].kind === 'local')
  const value = Math.round(amount * 100)
  $('#intensity-value').textContent = `${value} · ${value === 0 ? '无雨' : value < 30 ? '小雨' : value < 70 ? '中雨' : '大雨'}`
  $('#baseline').setAttribute('aria-pressed', String(baseline))
  $('#pause').setAttribute('aria-pressed', String(paused))
  $('#pause').textContent = paused ? '继续' : '暂停'
  $('#atmosphere').style.opacity = baseline || presets[selected].kind === 'local' || (presets[selected].id === 'wind' && !rainyMood)
    ? '0' : String(rainyMood ? rainMoodOpacity(amount, currentScene === 'night') : .25 + amount * .55)
  host.style.visibility = baseline ? 'hidden' : 'visible'
  $('#chosen').textContent = saved ? `已记住：${saved.name} · 雨量 ${saved.intensity}` : ''
}
function synchronize() {
  active?.setEdges?.(actualUI.getEdges)
  active?.setSplashes?.(splashEnabled)
  active?.setAmount(baseline ? 0 : amount)
  active?.setPaused(paused || baseline || document.hidden || amount === 0)
  present()
}
async function switchEffect() {
  const token = ++revision
  // Sequential disposal prevents piling up canvases, GPU contexts and clocks.
  active?.dispose()
  active = null
  host.replaceChildren()
  document.body.dataset.ready = 'false'
  present()
  $('#render-status').textContent = '正在准备雨景…'
  const slot = document.createElement('div')
  slot.style.cssText = 'position:absolute;inset:0'
  host.append(slot)
  try {
    const preset = presets[selected]
    const runtime = preset.kind === 'local'
      ? await (await import('./local-cloud.js')).createLocalCloud(slot, report)
      : preset.id === 'wind' ? await (await import('./wind-rain.js')).createWindRain(slot, report)
      : preset.kind === 'ts' ? await createParticles(slot, preset) : await createQuarks(slot, preset)
    if (token !== revision) { runtime.dispose(); slot.remove(); return }
    active = runtime
    document.body.dataset.effect = preset.id
    document.body.dataset.ready = 'true'
    synchronize()
  } catch (error) {
    if (token !== revision) return
    document.body.dataset.ready = 'error'
    $('#render-status').textContent = '效果未能加载，请换一款试试'
    console.error(error)
  }
}
let particleImports
async function createParticles(slot, preset) {
  particleImports ??= Promise.all([import('@tsparticles/engine'), import('@tsparticles/slim')]).then(async ([engine, slim]) => {
    await slim.loadSlim(engine.tsParticles)
    return engine.tsParticles
  })
  const engine = await particleImports
  if (!slot.isConnected) throw new Error('Preview switched during loading')
  const soft = preset.id === 'soft'
  // Small vector sprite, not a full-screen texture or frame-by-frame animation.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="8" viewBox="0 0 96 8"><defs><linearGradient id="g"><stop stop-color="#e0edf5" stop-opacity="0"/><stop offset=".6" stop-color="#e0edf5" stop-opacity=".75"/><stop offset="1" stop-color="#e0edf5" stop-opacity="0"/></linearGradient><radialGradient id="r"><stop stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient><mask id="m"><rect width="96" height="8" fill="url(#r)"/></mask></defs><rect x="0" y="1" width="96" height="6" rx="3" fill="url(#g)" mask="url(#m)"/></svg>`
  slot.id = `particles-${Math.random().toString(36).slice(2)}`
  const maximum = soft ? 240 : 180
  const count = strength => Math.round(maximum * strength)
  const container = await engine.load({
    id: slot.id, element: slot,
    options: {
      fullScreen: { enable: false }, detectRetina: false, fpsLimit: frameBudget,
      pauseOnBlur: false, pauseOnOutsideViewport: true,
      interactivity: { events: { onClick: { enable: false }, onHover: { enable: false } } },
      particles: {
        number: { value: count(amount), density: { enable: false } },
        paint: { color: { value: '#d5e4ef' }, fill: { enable: soft }, stroke: soft ? { width: 0 } : { width: { min: .55, max: .9 }, opacity: { min: .3, max: .65 } } },
        shape: soft ? { type: 'image', options: { image: { src: `data:image/svg+xml,${encodeURIComponent(svg)}`, width: 96, height: 8, replaceColor: false } } } : { type: 'line', options: { line: { cap: 'round' } } },
        opacity: { value: soft ? { min: .25, max: .60 } : { min: .45, max: .85 } },
        size: { value: soft ? { min: 8, max: 20 } : { min: 3, max: 7 } },
        rotate: { value: soft ? { min: 97, max: 103 } : { min: 98, max: 102 }, animation: { enable: false } },
        zIndex: { value: { min: 0, max: soft ? 55 : 20 }, opacityRate: .4, sizeRate: .4, velocityRate: .25 },
        move: { enable: true, direction: 100, speed: soft ? { min: 15, max: 24 } : { min: 12, max: 18 }, straight: true, random: false, outModes: { default: 'out' }, angle: { value: 0, offset: 0 } },
      },
    },
  })
  if (!container) throw new Error('tsParticles initialization failed')
  let stopped = false
  const stats = window.setInterval(() => {
    if (!stopped && slot.isConnected) report(container.particles.count)
  }, 600)
  return {
    setAmount(strength) {
      const delta = count(strength) - container.particles.count
      if (delta > 0) container.particles.push(delta)
      if (delta < 0) container.particles.removeQuantity(-delta)
      // Keep the target after resize's density recalculation, too.
      container.options.particles.number.value = count(strength)
      container.actualOptions.particles.number.value = count(strength)
    },
    setPaused(value) { if (value) container.pause(); else container.play(); report(container.particles.count) },
    dispose() { stopped = true; clearInterval(stats); container.destroy(); slot.remove() },
  }
}

let quarkImports
async function createQuarks(slot, preset) {
  quarkImports ??= Promise.all([import('three'), import('three.quarks')])
  const [T, Q] = await quarkImports
  if (!slot.isConnected) throw new Error('Preview switched during loading')
  const canvas = document.createElement('canvas')
  slot.append(canvas)
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0, 0)
  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(36, 16 / 9, .1, 70)
  camera.position.z = 18
  camera.updateMatrixWorld()
  const batched = new Q.BatchedRenderer()
  scene.add(batched)
  // 128 × 16 tapered soft sprite shared by all depth layers.
  const sprite = document.createElement('canvas')
  sprite.width = 128; sprite.height = 16
  const context = sprite.getContext('2d')
  const gradient = context.createLinearGradient(0, 0, 128, 0)
  gradient.addColorStop(0, 'rgba(225,239,250,0)')
  gradient.addColorStop(.35, 'rgba(225,239,250,.2)')
  gradient.addColorStop(.78, 'rgba(225,239,250,.9)')
  gradient.addColorStop(1, 'rgba(225,239,250,0)')
  context.fillStyle = gradient
  context.beginPath(); context.ellipse(64, 8, 64, 6, 0, 0, Math.PI * 2); context.fill()
  const texture = new T.CanvasTexture(sprite)
  texture.generateMipmaps = false
  texture.minFilter = T.LinearFilter
  texture.magFilter = T.LinearFilter
  const material = new T.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, blending: T.NormalBlending })
  const cinema = preset.id === 'cinema', windy = preset.id === 'wind'
  let strength = amount
  const systems = []
  const layers = [
    { z: -7, speed: 11, size: .035, rate: cinema ? 100 : 200, opacity: .38 },
    { z: 0, speed: 15, size: cinema ? .055 : .045, rate: cinema ? 65 : 115, opacity: .48 },
    { z: 5, speed: 18, size: cinema ? .065 : .052, rate: cinema ? 18 : 30, opacity: .50 },
  ]
  layers.forEach((layer, index) => {
    const wind = windy ? .36 : cinema ? .13 : .08
    // Adapter only sets wind and depth; upstream owns simulation and rendering.
    const direction = {
      type: 'RainDirection',
      initialize(particle) {
        particle.velocity.set(-wind * particle.startSpeed, -particle.startSpeed, 0)
        particle.position.z += (Math.random() - .5) * 2
      },
      update(particle, delta) {
        if (windy) particle.velocity.x += Math.sin(particle.age * 1.8 + particle.position.z) * delta * .7
        const fadeIn = Math.min(1, particle.age * 8)
        const fadeOut = Math.min(1, (particle.life - particle.age) * 6)
        particle.color.w = particle.startColor.w * fadeIn * fadeOut
      },
      frameUpdate() {}, reset() {}, clone() { return this }, toJSON() { return { type: this.type } },
    }
    const rate = new Q.ConstantValue(layer.rate * strength)
    const system = new Q.ParticleSystem({
      duration: 2, looping: true, prewarm: true, worldSpace: true,
      shape: new Q.RectangleEmitter({ width: 36, height: .2, thickness: 1 }),
      emissionOverTime: rate,
      startLife: new Q.IntervalValue(1.65, 2),
      startSpeed: new Q.IntervalValue(layer.speed * .85, layer.speed * 1.15),
      startSize: new Q.IntervalValue(layer.size * .65, layer.size * 1.25),
      startColor: new Q.ColorRange(new T.Vector4(.84, .91, .98, layer.opacity * .65), new T.Vector4(.94, .97, 1, layer.opacity)),
      renderMode: Q.RenderMode.StretchedBillBoard,
      rendererEmitterSettings: { speedFactor: cinema ? 1.3 : windy ? .85 : .55, lengthFactor: 0 },
      material, behaviors: [direction], renderOrder: index,
    })
    system.emitter.position.set(windy ? 3 : 1, 10, layer.z)
    scene.add(system.emitter)
    batched.addSystem(system)
    systems.push({ system, rate, layer })
  })
  let timer = 0, disposed = false, isPaused = false, lastTime = performance.now(), frameCount = 0, fps = 0, lastStats = performance.now()
  const resize = () => {
    const width = Math.max(1, slot.clientWidth), height = Math.max(1, slot.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.render(scene, camera)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(slot)
  resize()
  const tick = () => {
    timer = 0
    if (disposed || isPaused || document.hidden || !slot.isConnected) return
    const now = performance.now(), delta = Math.min((now - lastTime) / 1000, .08)
    lastTime = now
    batched.update(delta)
    renderer.render(scene, camera)
    frameCount++
    if (now - lastStats > 800) {
      fps = Math.round(frameCount * 1000 / (now - lastStats))
      frameCount = 0; lastStats = now
      const count = systems.reduce((sum, { system }) => sum + system.particleNum, 0)
      report(count, fps)
    }
    timer = window.setTimeout(tick, Math.max(0, 1000 / frameBudget - (performance.now() - now)))
  }
  return {
    setAmount(value) {
      strength = value
      systems.forEach(({ rate, layer }) => { rate.value = layer.rate * strength })
      if (!value) { renderer.clear(); slot.style.visibility = 'hidden' }
      else slot.style.visibility = 'visible'
    },
    setPaused(value) {
      isPaused = value
      window.clearTimeout(timer)
      timer = 0
      if (!value && !disposed) { lastTime = performance.now(); tick() }
      report(systems.reduce((sum, { system }) => sum + system.particleNum, 0), fps)
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      systems.forEach(({ system }) => system.dispose())
      batched.batches.forEach(batch => batch.dispose())
      material.dispose(); texture.dispose(); renderer.dispose(); renderer.forceContextLoss()
      slot.remove()
    },
  }
}
function updateAmount(value) {
  amount = Math.max(0, Math.min(1, Number(value) / 100))
  $('#intensity').value = String(Math.round(amount * 100))
  synchronize()
}
$('#intensity').addEventListener('input', event => updateAmount(event.target.value))
document.querySelectorAll('[data-intensity]').forEach(button => button.addEventListener('click', () => updateAmount(button.dataset.intensity)))
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => {
  currentScene = button.dataset.scene
  $('#backdrop').style.backgroundImage = `url('/scenes/live/${button.dataset.scene}.webp')`
  document.querySelectorAll('[data-scene]').forEach(other => other.setAttribute('aria-pressed', String(other === button)))
  present()
}))
$('#baseline').addEventListener('click', () => { baseline = !baseline; synchronize() })
$('#pause').addEventListener('click', () => { paused = !paused; synchronize() })
$('#splash').addEventListener('click', () => { splashEnabled = !splashEnabled; synchronize() })
$('#mood').addEventListener('click', () => { moodEnabled = !moodEnabled; present() })
$('#ui-mode').addEventListener('click', () => { uiEnabled = !uiEnabled; present() })
$('#choose').addEventListener('click', () => {
  saved = { id: presets[selected].id, name: presets[selected].name, intensity: Math.round(amount * 100) }
  // Preview choice is isolated from application weather/settings state.
  localStorage.setItem('myscreen.rain-gallery-choice', JSON.stringify(saved))
  present()
})
function clean(value) { document.body.classList.toggle('clean-view', value); $('#restore').hidden = !value; $('#clean').setAttribute('aria-pressed', String(value)) }
$('#clean').addEventListener('click', () => clean(true))
$('#restore').addEventListener('click', () => clean(false))
document.addEventListener('keydown', event => { if (event.key === 'Escape') clean(false) })
document.addEventListener('visibilitychange', synchronize)
window.addEventListener('pagehide', () => { ++revision; active?.dispose(); active = null; actualUI.dispose() })
present()
void switchEffect()
