import { useEffect, useRef } from 'react'
import { Scene, PerspectiveCamera, WebGLRenderer, TextureLoader, MeshBasicMaterial, Color, Vector3, SRGBColorSpace } from 'three'
import { Cloud, Clouds } from '@pmndrs/vanilla/core/Cloud'
import { Stars } from '@pmndrs/vanilla/core/Stars'
import { readSkyPreferences, SKY_EVENT } from '@/lib/sky-preference'
import type { StageKey } from '@/components/scene-panel'
import type { SkySettings } from '@/lib/sky-preference'

const colors = { morning: '#fff1dc', midday: '#eef8ff', dusk: '#ffbb9a', night: '#7583b0' }

// Upstream pmndrs components own the cloud particles and star shaders. This
// adapter only supplies presets, scene clipping and our paused/throttled clock.
export function SkyEffects({ scene, reduced }: { scene: StageKey; reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const current = useRef({ scene, reduced })
  const refresh = useRef<(() => void) | null>(null)
  useEffect(() => { current.current = { scene, reduced }; refresh.current?.() }, [scene, reduced])

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
    const stars = new Stars({ radius: 90, depth: 20, count: 18000, factor: 4, saturation: 0, fade: true, speed: 1 })
    world.add(stars)
    const starColors = stars.geometry.getAttribute('color')
    const baseColors = Float32Array.from(starColors.array)
    // Loading is local even in an offline production WebView.
    let disposed = false
    let cloudsReady = false
    const texture = new TextureLoader().load('/scenes/live/cloud.png', () => {
      if (disposed) { texture.dispose(); return }
      cloudsReady = true
      refresh.current?.()
    }, undefined, error => console.warn('云纹理加载失败', error))
    texture.colorSpace = SRGBColorSpace
    const clouds = new Clouds({ texture, limit: 72, material: MeshBasicMaterial, frustumCulled: false })
    const groups = Array.from({ length: 3 }, (_, index) => {
      const cloud = new Cloud({ seed: 142 + index * 31, segments: 24, fade: 0, bounds: new Vector3(2.5, .9, .4), volume: 3, growth: .3 })
      clouds.add(cloud)
      return cloud
    })
    world.add(clouds)
    let settings: SkySettings = readSkyPreferences()[current.current.scene]
    let timer = 0
    let lastTime = performance.now()
    let cloudTime = 0
    let starTime = 0
    let lastBrightness = -1

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight)
      renderer.setSize(width, height, false)
      // Match the original image's centered cover crop, including fractional sizes.
      camera.aspect = width / height
      camera.fov = width / height < 1672 / 941 ? 36 : 2 * Math.atan(Math.tan(Math.PI / 10) * (1672 / 941) / camera.aspect) * 180 / Math.PI
      camera.updateProjectionMatrix()
    }

    const configure = () => {
      settings = readSkyPreferences()[current.current.scene]
      const { stars: s, clouds: c } = settings
      stars.visible = s.enabled && s.count > 0 && s.brightness > 0
      stars.geometry.setDrawRange(0, Math.round((s.style === 'dense' ? 18000 : 1800) * s.count / 100))
      if (lastBrightness !== s.brightness) {
        const intensity = s.brightness / 100
        for (let index = 0; index < starColors.array.length; index++) starColors.array[index] = baseColors[index] * intensity
        starColors.needsUpdate = true
        lastBrightness = s.brightness
      }
      clouds.visible = c.enabled && c.density > 0 && cloudsReady
      groups.forEach((cloud, index) => {
        cloud.color = new Color(colors[current.current.scene])
        cloud.opacity = c.density / 100 * (c.style === 'wisps' ? .38 : .70)
        cloud.speed = c.speed / 100 * .35
        cloud.growth = c.style === 'puffs' ? .65 : .22
        cloud.volume = c.style === 'puffs' ? 3.2 : c.style === 'layers' ? 1.8 : 1.15
        cloud.bounds.set(c.style === 'puffs' ? 2.5 : 5.2, c.style === 'puffs' ? .8 : .12, .4)
        cloud.scale.setScalar(1)
        cloud.position.set((index - 1) * (c.style === 'puffs' ? 6.8 : 4.6), c.style === 'layers' ? .2 + index * 1.7 : 2.7 + (index % 2) * 1.2, -2 - index * .3)
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
      canvas.dataset.starCount = String(stars.geometry.drawRange.count)
    }

    const render = () => {
      world.updateMatrixWorld(true)
      stars.update(starTime)
      groups.forEach((cloud, index) => { cloud.position.x = (index - 1) * (settings.clouds.style === 'puffs' ? 6.8 : 4.6) + Math.sin(cloudTime * .09 + index * 1.7) * 1.6 })
      clouds.update(camera, cloudTime, 0)
      renderer.render(world, camera)
      canvas.dataset.ready = 'true'
    }
    const paused = () => current.current.reduced || document.hidden || !canvas.isConnected
    const animated = () => (clouds.visible && settings.clouds.speed > 0) || (stars.visible && settings.stars.twinkle > 0)
    const tick = () => {
      timer = 0
      if (disposed || paused()) return
      const now = performance.now(), delta = Math.min((now - lastTime) / 1000, .2)
      lastTime = now
      cloudTime += delta * settings.clouds.speed / 100
      starTime += delta * settings.stars.twinkle / 100
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
    window.addEventListener(SKY_EVENT, update)
    window.addEventListener('storage', update)
    window.addEventListener('resize', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      disposed = true
      refresh.current = null
      window.clearTimeout(timer)
      window.removeEventListener(SKY_EVENT, update)
      window.removeEventListener('storage', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('visibilitychange', update)
      stars.geometry.dispose()
      const materials = Array.isArray(stars.material) ? stars.material : [stars.material]
      materials.forEach(material => material.dispose())
      clouds.instance.geometry.dispose()
      clouds.instance.dispose()
      clouds.cloudMaterial.dispose()
      texture.dispose()
      renderer.dispose()
      // React development StrictMode immediately remounts the same canvas.
      // Lose the context only once it is actually detached.
      queueMicrotask(() => { if (!canvas.isConnected) renderer.forceContextLoss() })
    }
  }, [])
  return <canvas ref={canvasRef} className="sky-effects-canvas" aria-hidden="true" />
}
