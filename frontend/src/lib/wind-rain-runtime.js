import * as T from 'three'
import * as Q from 'three.quarks'

// Most additional rain stays in the distance, rather than filling the foreground.
const layers = [
  { z: -7, speed: 11, size: .035, rate: 200, extra: 670, opacity: .38 },
  { z: 0, speed: 15, size: .045, rate: 115, extra: 300, opacity: .48 },
  { z: 5, speed: 18, size: .052, rate: 30, extra: 65, opacity: .50 },
]
const rateAt = (layer, amount) => layer.rate * amount + layer.extra * amount ** 3
const MAX_RAIN = 2400
const MAX_SPLASH = 144
const MAX_ARCS = 24

function behavior(type, initialize, update) {
  return { type, initialize, update, frameUpdate() {}, reset() {}, clone() { return this }, toJSON() { return { type } } }
}
function texture(width, height, paint) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  paint(canvas.getContext('2d'))
  const result = new T.CanvasTexture(canvas)
  result.generateMipmaps = false
  result.minFilter = T.LinearFilter; result.magFilter = T.LinearFilter
  return result
}

export function createWindRain(slot, report) {
  if (!slot.isConnected) throw new Error('Preview switched during loading')
  const canvas = document.createElement('canvas')
  canvas.dataset.effect = 'wind-splash'
  slot.append(canvas)
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(1); renderer.setClearColor(0, 0)
  const scene = new T.Scene()
  const camera = new T.PerspectiveCamera(36, 16 / 9, .1, 70)
  camera.position.z = 18; camera.updateMatrixWorld()
  const batch = new Q.BatchedRenderer()
  scene.add(batch)
  const rainTexture = texture(128, 16, ctx => {
    const gradient = ctx.createLinearGradient(0, 0, 128, 0)
    gradient.addColorStop(0, 'rgba(225,239,250,0)')
    gradient.addColorStop(.35, 'rgba(225,239,250,.2)')
    gradient.addColorStop(.78, 'rgba(225,239,250,.9)')
    gradient.addColorStop(1, 'rgba(225,239,250,0)')
    ctx.fillStyle = gradient
    ctx.beginPath(); ctx.ellipse(64, 8, 64, 6, 0, 0, Math.PI * 2); ctx.fill()
  })
  const splashTexture = texture(16, 16, ctx => {
    const gradient = ctx.createRadialGradient(8, 8, 1, 8, 8, 8)
    gradient.addColorStop(0, 'rgba(227,243,250,.9)')
    gradient.addColorStop(.35, 'rgba(215,235,245,.65)')
    gradient.addColorStop(1, 'rgba(215,235,245,0)')
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 16, 16)
  })
  const arcTexture = texture(64, 64, ctx => {
    ctx.strokeStyle = 'rgba(223,246,255,.95)'; ctx.lineWidth = 2.6; ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(11, 43); ctx.quadraticCurveTo(10, 19, 26, 39)
    ctx.quadraticCurveTo(40, 12, 53, 38)
    ctx.stroke()
  })
  const materials = [rainTexture, splashTexture, arcTexture].map(map => new T.MeshBasicMaterial({ map, transparent: true, depthWrite: false, depthTest: false }))
  let amount = .75, paused = true, disposed = false, timer = 0, phase = 0, hits = 0, splashEnabled = true
  let width = 1, height = 1, scale = 1, offsetX = 0, offsetY = 0
  let lastTime = performance.now(), statsTime = lastTime, frames = 0
  const systems = []
  let getEdges = () => []
  const targets = [{ left: 722, right: 945, top: 378 }, { left: 0, right: 0, top: 0 }, { left: 0, right: 0, top: 0 }]
  let targetCount = 1, uiHits = 0, roofEnabled = true, splashSurface = 0
  const projected = new T.Vector3(), predicted = new T.Vector3(), impact = new T.Vector3()
  const impactMatrix = new T.Matrix4()
  const burst = { isBursting: false, burstParticleIndex: 0, burstParticleCount: 0, burstIndex: 0, burstWaveIndex: 0, time: 0, waitEmiting: 0, travelDistance: 0 }
  // Express splash dimensions in background pixels, independent of rain depth.
  const sourceUnit = particle => scale * 2 * (camera.position.z - particle.position.z) * Math.tan(Math.PI / 10) / height
  const splashes = new Q.ParticleSystem({
    duration: 1, looping: true, onlyUsedByOther: true, worldSpace: true,
    material: materials[1], renderMode: Q.RenderMode.BillBoard, renderOrder: 4,
    shape: new Q.PointEmitter(), emissionOverTime: new Q.ConstantValue(0),
    emissionBursts: [{ time: 0, count: new Q.ConstantValue(2), cycle: 1, interval: 0, probability: 1 }],
    startLife: new Q.IntervalValue(.3, .44), startSpeed: new Q.ConstantValue(0),
    startSize: new Q.IntervalValue(4, 7),
    startColor: new Q.ColorRange(new T.Vector4(.75, .92, 1, .85), new T.Vector4(.95, .99, 1, .98)),
    behaviors: [behavior('WindSplash', particle => {
      particle.splashSurface = splashSurface
      const unit = sourceUnit(particle)
      particle.splashUnit = unit
      particle.startSize.multiplyScalar(unit); particle.size.copy(particle.startSize)
      particle.velocity.set((-30 + (Math.random() - .5) * 140) * unit, (95 + Math.random() * 65) * unit, 0)
    }, (particle, delta) => {
      particle.velocity.y -= 650 * particle.splashUnit * delta
      particle.velocity.x -= 35 * particle.splashUnit * delta
      particle.color.w = particle.startColor.w * (1 - particle.age / particle.life)
    })],
  })
  const arcs = new Q.ParticleSystem({
    duration: 1, looping: true, onlyUsedByOther: true, worldSpace: true,
    material: materials[2], renderMode: Q.RenderMode.BillBoard, renderOrder: 5,
    shape: new Q.PointEmitter(), emissionOverTime: new Q.ConstantValue(0),
    emissionBursts: [{ time: 0, count: new Q.ConstantValue(1), cycle: 1, interval: 0, probability: 1 }],
    startLife: new Q.IntervalValue(.2, .28), startSpeed: new Q.ConstantValue(0),
    startSize: new Q.IntervalValue(20, 30), startColor: new Q.ConstantColor(new T.Vector4(.8, .94, 1, .85)),
    behaviors: [behavior('RoofArc', particle => {
      particle.splashSurface = splashSurface
      const unit = sourceUnit(particle)
      particle.startSize.multiplyScalar(unit); particle.size.copy(particle.startSize)
      particle.position.y += 4 * unit
    }, particle => {
      const progress = particle.age / particle.life
      particle.size.copy(particle.startSize).multiplyScalar(.75 + progress * .45)
      particle.color.w = particle.startColor.w * (1 - progress)
    })],
  })
  function emitAt(system, position) {
    burst.isBursting = false; burst.burstIndex = 0; burst.burstWaveIndex = 0
    burst.time = 0; burst.waitEmiting = 0
    impactMatrix.makeTranslation(position.x, position.y, position.z)
    system.emit(0, burst, impactMatrix)
  }
  // Project onto the same cover-fitted source image as the background.
  function sourcePoint(vector) {
    vector.project(camera)
    vector.x = ((vector.x + 1) * width / 2 - offsetX) / scale
    vector.y = ((1 - vector.y) * height / 2 - offsetY) / scale
  }
  layers.forEach((layer, index) => {
    const rate = new Q.ConstantValue(rateAt(layer, amount))
    const direction = behavior('WindAndImpact', particle => {
      particle.velocity.set(-.36 * particle.startSpeed, -particle.startSpeed, 0)
      particle.position.z += (Math.random() - .5) * 2
      if (systems.reduce((sum, entry) => sum + entry.system.particleNum, 0) >= MAX_RAIN) particle.life = 0
    }, (particle, delta) => {
      particle.velocity.x += Math.sin(phase * .8 + particle.position.z) * delta * .7
      particle.color.w = particle.startColor.w * Math.min(1, particle.age * 8) * Math.min(1, (particle.life - particle.age) * 6)
      projected.copy(particle.position)
      predicted.copy(particle.position).addScaledVector(particle.velocity, delta)
      sourcePoint(projected); sourcePoint(predicted)
      if (predicted.x < 0 || predicted.x > 1672 || predicted.y <= projected.y) return
      for (let index = 0; index < targetCount; index++) {
        if (index === 0 && !roofEnabled) continue
        const target = targets[index]
        if (projected.y > target.top || predicted.y < target.top) continue
        const fraction = (target.top - projected.y) / (predicted.y - projected.y)
        const sourceX = projected.x + (predicted.x - projected.x) * fraction
        if (sourceX < target.left || sourceX > target.right) continue
        impact.copy(particle.position).addScaledVector(particle.velocity, delta * fraction)
        hits++
        if (index > 0) uiHits++
        // A splash accent never blocks or changes the falling rain.
        if (splashEnabled) {
          splashSurface = index
          if (splashes.particleNum <= MAX_SPLASH - 2 && Math.random() < .35) emitAt(splashes, impact)
          if (arcs.particleNum < MAX_ARCS && Math.random() < .18) emitAt(arcs, impact)
        }
      }
    })
    const system = new Q.ParticleSystem({
      duration: 2, looping: true, worldSpace: true,
      shape: new Q.RectangleEmitter({ width: 36, height: .2, thickness: 1 }),
      emissionOverTime: rate, startLife: new Q.IntervalValue(1.65, 2),
      startSpeed: new Q.IntervalValue(layer.speed * .85, layer.speed * 1.15),
      startSize: new Q.IntervalValue(layer.size * .65, layer.size * 1.25),
      startColor: new Q.ColorRange(new T.Vector4(.84, .91, .98, layer.opacity * .65), new T.Vector4(.94, .97, 1, layer.opacity)),
      renderMode: Q.RenderMode.StretchedBillBoard,
      rendererEmitterSettings: { speedFactor: .85, lengthFactor: 0 },
      material: materials[0], behaviors: [direction], renderOrder: index,
    })
    system.emitter.position.set(3, 10, layer.z)
    scene.add(system.emitter); batch.addSystem(system)
    systems.push({ system, rate, layer })
  })
  scene.add(splashes.emitter); batch.addSystem(splashes)
  scene.add(arcs.emitter); batch.addSystem(arcs)
  function publish(fps) {
    const count = systems.reduce((sum, entry) => sum + entry.system.particleNum, 0)
    canvas.dataset.rain = String(count); canvas.dataset.splash = String(splashes.particleNum + arcs.particleNum)
    canvas.dataset.arcs = String(arcs.particleNum)
    canvas.dataset.uiHits = String(uiHits); canvas.dataset.uiEdges = String(targetCount - 1)
    canvas.dataset.roofEnabled = String(roofEnabled)
    canvas.dataset.roofSplash = String([splashes, arcs].reduce((sum, system) => {
      for (let index = 0; index < system.particleNum; index++) {
        const particle = system.particles[index]
        if (particle.splashSurface === 0 && particle.age < particle.life) sum++
      }
      return sum
    }, 0))
    canvas.dataset.edgeY = targetCount > 1 ? targets[1].top.toFixed(2) : ''
    canvas.dataset.hits = String(hits); canvas.dataset.phase = phase.toFixed(3)
    canvas.dataset.splashEnabled = String(splashEnabled)
    canvas.dataset.rainRate = String(Math.round(systems.reduce((sum, entry) => sum + entry.rate.value, 0)))
    canvas.dataset.textures = String(renderer.info.memory.textures)
    report(count, fps, splashes.particleNum + arcs.particleNum)
  }
  function resize() {
    width = Math.max(1, slot.clientWidth); height = Math.max(1, slot.clientHeight)
    scale = Math.max(width / 1672, height / 941)
    offsetX = (width - 1672 * scale) / 2; offsetY = (height - 941 * scale) / 2
    renderer.setSize(width, height, false)
    camera.aspect = width / height; camera.updateProjectionMatrix()
    systems.forEach(({ system }) => system.restart()); splashes.restart(); arcs.restart()
    batch.update(0); renderer.render(scene, camera)
  }
  function refreshTargets() {
    const edges = getEdges()
    const nextRoofEnabled = !edges.settingsOpen
    const changed = roofEnabled !== nextRoofEnabled
    if (roofEnabled && !nextRoofEnabled) {
      for (const system of [splashes, arcs]) {
        for (let index = 0; index < system.particleNum; index++) {
          const particle = system.particles[index]
          if (particle.splashSurface === 0) particle.age = particle.life
        }
      }
    }
    roofEnabled = nextRoofEnabled
    targetCount = Math.min(edges.length, 2) + 1
    for (let index = 1; index < targetCount; index++) {
      const edge = edges[index - 1], target = targets[index]
      target.left = (edge.left - offsetX) / scale; target.right = (edge.right - offsetX) / scale
      target.top = (edge.top - offsetY) / scale
    }
    return changed
  }
  function tick() {
    timer = 0
    if (disposed || paused || document.hidden || !slot.isConnected) return
    const now = performance.now(), delta = Math.min((now - lastTime) / 1000, .06)
    lastTime = now; phase += delta
    refreshTargets()
    batch.update(delta); renderer.render(scene, camera); frames++
    if (now - statsTime > 600) { publish(Math.round(frames * 1000 / (now - statsTime))); frames = 0; statsTime = now }
    timer = window.setTimeout(tick, Math.max(0, 1000 / 30 - (performance.now() - now)))
  }
  const observer = new ResizeObserver(resize)
  observer.observe(slot); resize()
  return {
    refreshEdges() {
      if (disposed) return
      const changed = refreshTargets()
      if (changed && paused) { splashes.restart(); arcs.restart() }
      batch.update(0); renderer.render(scene, camera); publish()
    },
    setEdges(provider) { getEdges = provider },
    setSplashes(value) {
      splashEnabled = value
      if (!value) { splashes.restart(); arcs.restart(); batch.update(0); renderer.render(scene, camera) }
      publish()
    },
    setAmount(value) {
      amount = Math.max(0, Math.min(1, value))
      systems.forEach(({ rate, layer }) => { rate.value = rateAt(layer, amount) })
      if (!amount) {
        systems.forEach(({ system }) => system.restart()); splashes.restart(); arcs.restart()
        batch.update(0); renderer.clear()
      }
      publish()
    },
    setPaused(value) {
      paused = value; clearTimeout(timer); timer = 0
      if (!paused) { lastTime = performance.now(); tick() }
      publish()
    },
    dispose() {
      disposed = true; clearTimeout(timer); observer.disconnect()
      systems.forEach(({ system }) => system.dispose()); splashes.dispose(); arcs.dispose()
      batch.batches.forEach(entry => entry.dispose())
      materials.forEach(entry => entry.dispose())
      rainTexture.dispose(); splashTexture.dispose(); arcTexture.dispose()
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove()
    },
  }
}
