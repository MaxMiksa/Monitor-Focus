import { useEffect, useRef, useState } from 'react'
import { Scene, PerspectiveCamera, WebGLRenderer, TextureLoader, MeshBasicMaterial, Color, Vector3, SRGBColorSpace, Mesh, PlaneGeometry, ShaderMaterial } from 'three'
import { Cloud, Clouds } from '@pmndrs/vanilla/core/Cloud'
import { Stars } from '@pmndrs/vanilla/core/Stars'
import { readSkyPreferences, SKY_EVENT } from '@/lib/sky-preference'
import type { StageKey } from '@/components/scene-panel'
import type { SkySettings } from '@/lib/sky-preference'
import { createLegacyMaterial } from '@/lib/cloud-legacy'
import { cloudPlacements } from '@/lib/cloud-placement'
import { independentStarTwinkle } from '@/lib/star-twinkle'

const colors = { morning: '#fff1dc', midday: '#eef8ff', dusk: '#ffbb9a', night: '#7583b0' }

const starCount = (settings: SkySettings) => settings.stars.enabled && settings.stars.brightness > 0
  ? Math.round((settings.stars.style === 'dense' ? 18000 : 1800) * settings.stars.count / 100) : 0
const hasClouds = (settings: SkySettings) => settings.clouds.enabled && settings.clouds.density > 0

// Upstream pmndrs components own the cloud particles and star shaders. This
// adapter supplies presets, independent star twinkle, clipping and a paused clock.
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
  if (!starCount(settings) && !hasClouds(settings)) return null
  return <SkyCanvas scene={scene} reduced={reduced} settings={settings} />
}

function SkyCanvas({ scene, reduced, settings }: { scene: StageKey; reduced: boolean; settings: SkySettings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const current = useRef({ scene, reduced, settings })
  const refresh = useRef<(() => void) | null>(null)
  useEffect(() => { current.current = { scene, reduced, settings }; refresh.current?.() }, [scene, reduced, settings])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
    } catch (error) { console.warn('天空效果初始化失败', error); return }
    renderer.setClearColor(0, 0)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25))
    const world = new Scene()
    const camera = new PerspectiveCamera(36, 16 / 9, .1, 250)
    camera.position.set(0, 0, 18)
    camera.updateMatrixWorld()
    let stars: { object: Stars; material: ShaderMaterial; baseColors: Float32Array; count: number; style: string } | null = null
    let particles: { object: Clouds; groups: Cloud[]; texture: ReturnType<TextureLoader['load']>; ready: boolean } | null = null
    let legacy: { object: Mesh; resources: ReturnType<typeof createLegacyMaterial> } | null = null
    let disposed = false
    let activeSettings = current.current.settings
    let placements = cloudPlacements(activeSettings.clouds, current.current.scene)
    let timer = 0
    let lastTime = performance.now()
    let cloudTime = 0
    let starTime = 0
    let lastBrightness = -1

    const releaseStars = () => {
      if (!stars) return
      world.remove(stars.object)
      stars.object.geometry.dispose()
      stars.material.dispose()
      stars = null
      lastBrightness = -1
      renderer.renderLists.dispose()
    }
    const releaseParticles = () => {
      if (!particles) return
      world.remove(particles.object)
      particles.object.instance.geometry.dispose()
      particles.object.instance.dispose()
      particles.object.cloudMaterial.dispose()
      particles.texture.dispose()
      particles = null
      renderer.renderLists.dispose()
    }
    const releaseLegacy = () => {
      if (!legacy) return
      world.remove(legacy.object)
      legacy.object.geometry.dispose()
      legacy.resources.material.dispose()
      legacy.resources.noise.dispose()
      legacy = null
      renderer.renderLists.dispose()
    }

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight)
      renderer.setSize(width, height, false)
      // Match the original image's centered cover crop, including fractional sizes.
      camera.aspect = width / height
      camera.fov = width / height < 1672 / 941 ? 36 : 2 * Math.atan(Math.tan(Math.PI / 10) * (1672 / 941) / camera.aspect) * 180 / Math.PI
      camera.updateProjectionMatrix()
    }

    const configure = () => {
      activeSettings = current.current.settings
      const { stars: s, clouds: c } = activeSettings
      placements = cloudPlacements(c, current.current.scene)
      const count = starCount(activeSettings)
      if (stars && (stars.count !== count || stars.style !== s.style)) releaseStars()
      if (count && !stars) {
        const object = new Stars({ radius: 90, depth: 20, count, factor: 4, saturation: 0, fade: true, speed: 1 })
        const material = object.material as ShaderMaterial
        independentStarTwinkle(object.geometry, material)
        stars = { object, material, baseColors: Float32Array.from(object.geometry.getAttribute('color').array), count, style: s.style }
        world.add(object)
      }
      if (stars) stars.material.uniforms.twinkleStrength.value = current.current.reduced ? 0 : s.twinkle / 100
      if (stars && lastBrightness !== s.brightness) {
        const starColors = stars.object.geometry.getAttribute('color')
        const intensity = s.brightness / 100
        for (let index = 0; index < starColors.array.length; index++) starColors.array[index] = stars.baseColors[index] * intensity
        starColors.needsUpdate = true
        lastBrightness = s.brightness
      }
      const cloudsEnabled = hasClouds(activeSettings)
      if (!cloudsEnabled || c.style === 'legacy') releaseParticles()
      if (!cloudsEnabled || c.style !== 'legacy') releaseLegacy()
      if (cloudsEnabled && c.style === 'legacy' && !legacy) {
        const resources = createLegacyMaterial()
        const object = new Mesh(new PlaneGeometry(2, 2), resources.material)
        object.frustumCulled = false
        object.renderOrder = 2
        legacy = { object, resources }
        world.add(object)
      }
      if (cloudsEnabled && c.style !== 'legacy' && !particles) {
        // A late image load must never revive a released cloud system.
        const texture = new TextureLoader().load('/scenes/live/cloud.png', () => {
          if (disposed || particles?.texture !== texture) { texture.dispose(); return }
          particles.ready = true
          refresh.current?.()
        }, undefined, error => { if (!disposed && particles?.texture === texture) console.warn('云纹理加载失败', error) })
        texture.colorSpace = SRGBColorSpace
        const object = new Clouds({ texture, limit: 72, material: MeshBasicMaterial, frustumCulled: false })
        const groups = Array.from({ length: 3 }, (_, index) => {
          const cloud = new Cloud({ seed: 142 + index * 31, segments: 24, fade: 0, bounds: new Vector3(2.5, .9, .4), volume: 3, growth: .3 })
          object.add(cloud)
          return cloud
        })
        particles = { object, groups, texture, ready: false }
        world.add(object)
      }
      if (particles) particles.object.visible = particles.ready
      if (legacy) {
        legacy.resources.material.uniforms.density.value = c.density / 100
        legacy.resources.material.uniforms.tint.value.set(colors[current.current.scene])
      }
      particles?.groups.forEach((cloud, index) => {
        cloud.color = new Color(colors[current.current.scene])
        cloud.opacity = c.density / 100 * (c.style === 'wisps' ? .38 : .70)
        cloud.speed = c.speed / 100 * .35
        cloud.growth = c.style === 'puffs' ? .65 : .22
        cloud.volume = c.style === 'puffs' ? 3.2 : c.style === 'layers' ? 1.8 : 1.15
        cloud.bounds.set(c.style === 'puffs' ? 2.5 : 5.2, c.style === 'puffs' ? .8 : .12, .4)
        cloud.scale.setScalar(1)
        const position = placements[index]
        cloud.position.set(position.x, position.y, position.z)
        cloud.updateCloud()
        if (c.style !== 'puffs') cloud.cloudStateArray.forEach((particle, particleIndex) => {
          // Flattened wisps and strata keep horizontal billboards instead of
          // rotating narrow cloud cards into a fan of diagonal streaks.
          particle.rotation = -.025 + particleIndex * .002
          particle.rotationFactor = 0
        })
      })
      canvas.dataset.scene = current.current.scene
      canvas.dataset.starStyle = s.style
      canvas.dataset.cloudStyle = c.style
      canvas.dataset.cloudLayout = c.style === 'legacy' ? 'legacy' : c.layout
      canvas.dataset.starCount = String(stars?.count ?? 0)
      canvas.dataset.cloudResource = legacy ? 'legacy' : particles ? 'particles' : 'none'
    }

    const render = () => {
      stars?.object.update(starTime)
      if (legacy) legacy.resources.material.uniforms.phase.value = cloudTime * .19
      particles?.groups.forEach((cloud, index) => {
        const position = placements[index]
        cloud.position.x = position.x + Math.sin(cloudTime * .09 + position.phase) * position.amplitude
        cloud.position.y = position.y + Math.sin(cloudTime * .07 + position.phase) * position.vertical
      })
      world.updateMatrixWorld(true)
      particles?.object.update(camera, cloudTime, 0)
      renderer.render(world, camera)
      canvas.dataset.ready = 'true'
    }
    const paused = () => current.current.reduced || document.hidden || !canvas.isConnected
    const animated = () => ((particles?.ready || legacy) && activeSettings.clouds.speed > 0) || (stars && activeSettings.stars.twinkle > 0)
    const tick = () => {
      timer = 0
      if (disposed || paused()) return
      const now = performance.now(), delta = Math.min((now - lastTime) / 1000, .2)
      lastTime = now
      cloudTime += delta * activeSettings.clouds.speed / 100
      starTime += delta
      render()
      if (animated()) timer = window.setTimeout(tick, 50)
    }
    const update = () => {
      window.clearTimeout(timer)
      timer = 0
      configure()
      if (document.hidden) { canvas.dataset.paused = 'true'; return }
      resize()
      render()
      canvas.dataset.paused = String(paused())
      if (!paused() && animated()) { lastTime = performance.now(); timer = window.setTimeout(tick, 50) }
    }
    refresh.current = update
    window.addEventListener('resize', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      disposed = true
      refresh.current = null
      window.clearTimeout(timer)
      window.removeEventListener('resize', update)
      document.removeEventListener('visibilitychange', update)
      releaseStars()
      releaseParticles()
      releaseLegacy()
      renderer.dispose()
      // React development StrictMode immediately remounts the same canvas.
      // Lose the context only once it is actually detached.
      queueMicrotask(() => { if (!canvas.isConnected) renderer.forceContextLoss() })
    }
  }, [])
  return <canvas ref={canvasRef} className="sky-effects-canvas" aria-hidden="true" />
}
