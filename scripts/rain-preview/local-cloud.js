import * as T from 'three'
import * as Q from 'three.quarks'

const IMAGE = { width: 1672, height: 941 }
const REGION = { left: 566, top: 65, width: 540, height: 420 }
const ROOF = { left: 722, right: 945, y: 378 }
const CLOUD = { x: 836, y: 204, width: 410 }
const MAX_RAIN = 320
const MAX_DROPLETS = 128
const MAX_CROWNS = 32
const FPS = 30
// Keep fine rain sparse, then open up the upper end to four times the old rate.
const rainPerSecond = strength => 180 * strength + 540 * strength ** 3

function sprite(width, height, paint) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  paint(canvas.getContext('2d'))
  const texture = new T.CanvasTexture(canvas)
  texture.generateMipmaps = false
  texture.minFilter = T.LinearFilter
  texture.magFilter = T.LinearFilter
  return texture
}

function behavior(type, initialize, update) {
  return { type, initialize, update, frameUpdate() {}, reset() {}, clone() { return this }, toJSON() { return { type } } }
}

export async function createLocalCloud(slot, report) {
  const aborter = new AbortController()
  const onPageHide = () => aborter.abort()
  window.addEventListener('pagehide', onPageHide, { once: true })
  let bitmap
  try {
    const response = await fetch('/raincloud.png', { signal: aborter.signal })
    if (!response.ok) throw new Error('雨云图片加载失败')
    const blob = await response.blob()
    bitmap = await createImageBitmap(blob, { resizeWidth: 512, resizeQuality: 'high', imageOrientation: 'flipY', premultiplyAlpha: 'none' })
    if (!slot.isConnected) throw new Error('Preview switched during loading')
  } catch (error) { bitmap?.close(); throw error }
  finally { window.removeEventListener('pagehide', onPageHide) }

  const canvas = document.createElement('canvas')
  canvas.className = 'local-rain-canvas'
  canvas.dataset.effect = 'local-cloud'
  slot.append(canvas)
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(1)
  renderer.setClearColor(0, 0)
  const scene = new T.Scene()
  // All anchors use source-image coordinates, so resize cannot detach the roof.
  const camera = new T.OrthographicCamera(REGION.left, REGION.left + REGION.width, -REGION.top, -REGION.top - REGION.height, .1, 200)
  camera.position.z = 100
  camera.updateMatrixWorld()
  const cloudTexture = new T.Texture(bitmap)
  cloudTexture.colorSpace = T.SRGBColorSpace
  cloudTexture.generateMipmaps = false
  cloudTexture.minFilter = T.LinearFilter
  cloudTexture.magFilter = T.LinearFilter
  cloudTexture.needsUpdate = true
  const cloudGeometry = new T.PlaneGeometry(CLOUD.width, CLOUD.width * bitmap.height / bitmap.width)
  const cloudMaterial = new T.MeshBasicMaterial({ map: cloudTexture, transparent: true, opacity: .8, depthWrite: false, depthTest: false })
  // Trim the remaining matte fringe and feather alpha without another texture.
  cloudMaterial.onBeforeCompile = shader => {
    shader.uniforms.cloudTexel = { value: new T.Vector2(1 / bitmap.width, 1 / bitmap.height) }
    shader.fragmentShader = 'uniform vec2 cloudTexel;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      vec2 feather = cloudTexel * 2.0;
      float edgeAlpha = min(
        min(texture2D(map, vMapUv + vec2(feather.x, 0.0)).a, texture2D(map, vMapUv - vec2(feather.x, 0.0)).a),
        min(texture2D(map, vMapUv + vec2(0.0, feather.y)).a, texture2D(map, vMapUv - vec2(0.0, feather.y)).a)
      );
      diffuseColor.a *= smoothstep(0.08, 0.95, edgeAlpha);
    `)
  }
  const cloud = new T.Mesh(cloudGeometry, cloudMaterial)
  cloud.position.set(CLOUD.x, -CLOUD.y, 3)
  cloud.renderOrder = 5
  scene.add(cloud)

  const rainTexture = sprite(64, 8, context => {
    const gradient = context.createLinearGradient(0, 0, 64, 0)
    gradient.addColorStop(0, 'rgba(223,239,250,0)')
    gradient.addColorStop(.7, 'rgba(230,245,255,.9)')
    gradient.addColorStop(1, 'rgba(244,251,255,0)')
    context.fillStyle = gradient
    context.beginPath(); context.ellipse(32, 4, 32, 3, 0, 0, Math.PI * 2); context.fill()
  })
  const dropTexture = sprite(16, 16, context => {
    const gradient = context.createRadialGradient(8, 8, 0, 8, 8, 8)
    gradient.addColorStop(0, '#f2fbff')
    gradient.addColorStop(.45, '#cfebfa')
    gradient.addColorStop(1, 'rgba(215,239,255,0)')
    context.fillStyle = gradient; context.fillRect(0, 0, 16, 16)
  })
  const crownTexture = sprite(64, 64, context => {
    context.strokeStyle = 'rgba(223,245,255,.95)'
    context.lineWidth = 2
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(7, 42); context.quadraticCurveTo(16, 18, 32, 42)
    context.quadraticCurveTo(46, 17, 57, 42)
    context.moveTo(19, 41); context.quadraticCurveTo(24, 24, 32, 41)
    context.quadraticCurveTo(40, 25, 45, 41)
    context.stroke()
  })
  const textures = [cloudTexture, rainTexture, dropTexture, crownTexture]
  const makeMaterial = map => new T.MeshBasicMaterial({ map, transparent: true, depthWrite: false, depthTest: false, blending: T.NormalBlending })
  const materials = [makeMaterial(rainTexture), makeMaterial(dropTexture), makeMaterial(crownTexture)]
  const batch = new Q.BatchedRenderer()
  scene.add(batch)
  let strength = .65, phase = 0, hits = 0, disposed = false, paused = true, timer = 0
  let lastTime = performance.now(), lastStats = lastTime, frames = 0
  const impactMatrix = new T.Matrix4()
  // Reuse one burst descriptor and matrix; never allocate a system per hit.
  const burst = { isBursting: false, burstParticleIndex: 0, burstParticleCount: 0, burstIndex: 0, burstWaveIndex: 0, time: 0, waitEmiting: 0, travelDistance: 0 }
  function emitAt(system, x, y) {
    burst.isBursting = false; burst.burstIndex = 0; burst.burstWaveIndex = 0
    burst.time = 0; burst.waitEmiting = 0
    impactMatrix.makeTranslation(x, y, 1)
    system.emit(0, burst, impactMatrix)
  }
  const droplets = new Q.ParticleSystem({
    duration: 1, looping: true, onlyUsedByOther: true, worldSpace: true,
    material: materials[1], renderMode: Q.RenderMode.BillBoard, renderOrder: 2,
    shape: new Q.PointEmitter(), emissionOverTime: new Q.ConstantValue(0),
    emissionBursts: [{ time: 0, count: new Q.ConstantValue(3), cycle: 1, interval: 0, probability: 1 }],
    startLife: new Q.IntervalValue(.24, .38), startSpeed: new Q.ConstantValue(0),
    startSize: new Q.IntervalValue(3, 4.8),
    startColor: new Q.ConstantColor(new T.Vector4(.88, .96, 1, .85)),
    behaviors: [behavior('SplashBallistics', particle => {
      particle.velocity.set((Math.random() - .5) * 160, 55 + Math.random() * 60, 0)
    }, (particle, delta) => {
      particle.velocity.y -= 340 * delta
      particle.color.w = particle.startColor.w * Math.max(0, 1 - particle.age / particle.life)
    })],
  })
  const crowns = new Q.ParticleSystem({
    duration: 1, looping: true, onlyUsedByOther: true, worldSpace: true,
    material: materials[2], renderMode: Q.RenderMode.BillBoard, renderOrder: 3,
    shape: new Q.PointEmitter(), emissionOverTime: new Q.ConstantValue(0),
    emissionBursts: [{ time: 0, count: new Q.ConstantValue(1), cycle: 1, interval: 0, probability: 1 }],
    startLife: new Q.IntervalValue(.12, .19), startSpeed: new Q.ConstantValue(0),
    startSize: new Q.IntervalValue(24, 34),
    startColor: new Q.ConstantColor(new T.Vector4(.87, .95, 1, .9)),
    behaviors: [behavior('CrownFade', particle => { particle.position.y += 3 }, particle => {
      const progress = particle.age / particle.life
      particle.size.copy(particle.startSize).multiplyScalar(.65 + progress * .7)
      particle.color.w = particle.startColor.w * Math.max(0, 1 - progress)
    })],
  })
  const rainRate = new Q.ConstantValue(rainPerSecond(strength))
  const roofY = x => ROOF.y + Math.max(0, 732 - x) * .35 + Math.max(0, x - 936) * .35
  const rain = new Q.ParticleSystem({
    duration: 1, looping: true, worldSpace: true, material: materials[0],
    shape: new Q.PointEmitter(), emissionOverTime: rainRate,
    startLife: new Q.ConstantValue(1), startSpeed: new Q.IntervalValue(200, 290),
    startSize: new Q.IntervalValue(1.6, 2.3),
    startColor: new Q.ColorRange(new T.Vector4(.82, .92, 1, .65), new T.Vector4(.96, .99, 1, .95)),
    renderMode: Q.RenderMode.StretchedBillBoard,
    rendererEmitterSettings: { speedFactor: .075, lengthFactor: 0 }, renderOrder: 1,
    behaviors: [behavior('RoofContact', particle => {
      const drift = Math.sin(phase * .5) * 9
      particle.position.set(Math.max(ROOF.left, Math.min(ROOF.right, CLOUD.x + drift + (Math.random() - .5) * 216)), -281 - Math.sin(phase * .8) * 4, 0)
      particle.velocity.set(0, -particle.startSpeed, 0)
      particle.life = 1
      if (rain.particleNum >= MAX_RAIN) particle.life = 0
    }, (particle, delta) => {
      const impactY = -roofY(particle.position.x)
      if (particle.position.y + particle.velocity.y * delta > impactY) return
      particle.position.y = impactY
      particle.velocity.set(0, 0, 0)
      particle.age = particle.life
      hits++
      if (droplets.particleNum <= MAX_DROPLETS - 3) emitAt(droplets, particle.position.x, impactY)
      if (crowns.particleNum < MAX_CROWNS) emitAt(crowns, particle.position.x, impactY)
      canvas.dataset.lastImpactX = particle.position.x.toFixed(2)
      canvas.dataset.lastImpactY = (-impactY).toFixed(2)
    })],
  })
  // Rain first so its contact event is consumed by the splash systems this frame.
  const systems = [rain, droplets, crowns]
  systems.forEach(system => { scene.add(system.emitter); batch.addSystem(system) })
  const publish = fps => {
    canvas.dataset.rain = String(rain.particleNum)
    canvas.dataset.rainRate = String(Math.round(rainRate.value))
    canvas.dataset.splash = String(droplets.particleNum + crowns.particleNum)
    canvas.dataset.hits = String(hits)
    canvas.dataset.phase = phase.toFixed(3)
    canvas.dataset.cloudVisible = String(cloud.visible)
    canvas.dataset.buffers = String(renderer.info.memory.geometries)
    canvas.dataset.textures = String(renderer.info.memory.textures)
    report(rain.particleNum, fps, droplets.particleNum + crowns.particleNum)
  }
  function resize() {
    if (disposed) return
    const width = slot.clientWidth, height = slot.clientHeight
    const scale = Math.min(width / IMAGE.width, height / IMAGE.height)
    const left = (width - IMAGE.width * scale) / 2 + REGION.left * scale
    const top = (height - IMAGE.height * scale) / 2 + REGION.top * scale
    canvas.style.setProperty('--rain-left', `${left}px`)
    canvas.style.setProperty('--rain-top', `${top}px`)
    canvas.style.setProperty('--rain-width', `${REGION.width * scale}px`)
    canvas.style.setProperty('--rain-height', `${REGION.height * scale}px`)
    renderer.setSize(Math.max(1, Math.round(REGION.width * scale)), Math.max(1, Math.round(REGION.height * scale)), false)
    renderer.render(scene, camera)
    canvas.dataset.imageScale = scale.toFixed(5)
  }
  function tick() {
    timer = 0
    if (disposed || paused || document.hidden || !slot.isConnected) return
    const now = performance.now(), delta = Math.min((now - lastTime) / 1000, .06)
    lastTime = now
    phase += delta
    cloud.position.x = CLOUD.x + Math.sin(phase * .5) * 9
    cloud.position.y = -CLOUD.y + Math.sin(phase * .8) * 4
    batch.update(delta)
    renderer.render(scene, camera)
    frames++
    if (now - lastStats >= 500) { publish(Math.round(frames * 1000 / (now - lastStats))); frames = 0; lastStats = now }
    timer = window.setTimeout(tick, Math.max(0, 1000 / FPS - (performance.now() - now)))
  }
  const observer = new ResizeObserver(resize)
  observer.observe(slot)
  resize()
  return {
    setAmount(value) {
      strength = Math.max(0, Math.min(1, value))
      rainRate.value = rainPerSecond(strength)
      cloud.visible = strength > 0
      if (!strength) {
        systems.forEach(system => system.restart())
        batch.update(0)
        renderer.clear()
      }
    },
    setPaused(value) {
      paused = value
      clearTimeout(timer)
      timer = 0
      if (!paused) { lastTime = performance.now(); tick() }
      publish()
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      observer.disconnect()
      systems.forEach(system => system.dispose())
      batch.batches.forEach(entry => entry.dispose())
      materials.forEach(material => material.dispose())
      textures.forEach(texture => texture.dispose())
      cloudGeometry.dispose(); cloudMaterial.dispose(); bitmap.close()
      renderer.dispose(); renderer.forceContextLoss()
      slot.remove()
    },
  }
}
