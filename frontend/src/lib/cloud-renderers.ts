import { ACESFilmicToneMapping, AmbientLight, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer } from 'three'
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js'
import type { CloudLabSettings } from '@/lib/cloud-lab'
import { createLegacyMaterial } from '@/lib/cloud-legacy'
import { createVolumeClouds } from '@/lib/cloud-volume'

export type CloudRuntime = { render: (settings: CloudLabSettings, time: number, delta: number) => void; dispose: () => void }
const tints = { morning: '#fff1dc', midday: '#ffffff', dusk: '#ffc19f', night: '#889cce' }

export async function createCloudRuntime(canvas: HTMLCanvasElement, settings: CloudLabSettings, signal: AbortSignal): Promise<CloudRuntime> {
  if (settings.candidate.startsWith('takram')) {
    const { createTakramClouds } = await import('@/lib/cloud-takram')
    signal.throwIfAborted()
    return createTakramClouds(canvas, settings, signal)
  }
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, depth: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25))
  renderer.setClearColor(0, 0)
  renderer.toneMapping = ACESFilmicToneMapping
  const scene = new Scene()
  const camera = new PerspectiveCamera(36, 16 / 9, .1, 100)
  camera.position.set(0, 0, 18)
  let disposed = false
  let legacy: ReturnType<typeof createLegacyMaterial> | undefined
  let volume: ReturnType<typeof createVolumeClouds> | undefined
  const groups: Group[] = []
  const toonMaterial = new MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 })
  const resources: Array<{ dispose: () => void }> = [toonMaterial]
  const soft = settings.candidate === 'toon-soft'
  if (settings.candidate === 'legacy') {
    legacy = createLegacyMaterial()
    const geometry = new PlaneGeometry(2, 2)
    scene.add(new Mesh(geometry, legacy.material))
    resources.push(geometry, legacy.material, legacy.noise)
  } else if (settings.candidate === 'volume') {
    volume = createVolumeClouds()
    scene.add(volume.group)
    resources.push(...volume.resources)
  } else {
    scene.add(new HemisphereLight('#ffffff', '#9caccc', 2.5), new AmbientLight('#ffffff', .25))
    const sun = new DirectionalLight('#fff5e7', 3.2)
    sun.position.set(-4, 9, 8)
    scene.add(sun)
    for (let i = 0; i < 3; i++) {
      // Reuse Three.js's maintained metaball surface generator. Sculpt once;
      // drifting changes transforms, not a CPU surface rebuild every frame.
      const cloud = new MarchingCubes(64, toonMaterial, false, false, 24000)
      cloud.isolation = 55
      const balls = soft
        ? [[.23,.44,.50,.65],[.38,.48,.52,.9],[.54,.58,.50,1.2],[.70,.49,.50,.85],[.81,.43,.50,.5],[.51,.39,.49,.7]]
        : [[.22,.43,.5,.65],[.35,.50,.51,.95],[.49,.58,.51,1.25],[.64,.54,.50,1],[.78,.44,.5,.7],[.49,.39,.49,1]]
      for (const [x,y,z,r] of balls) cloud.addBall(x,y,z,.53 * r, 12)
      cloud.update()
      cloud.scale.set(soft ? 4.3 : 4.8, soft ? 3.7 : 4.1, 2.8)
      cloud.position.set((i - 1) * 6.4, 2.8 + (i % 2) * 1.05, -2 - i * .5)
      const group = new Group()
      group.add(cloud)
      scene.add(group)
      groups.push(group)
      resources.push(cloud.geometry)
    }
  }
  const flatCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 2)
  flatCamera.position.z = 1
  let lastWidth = 0, lastHeight = 0
  return {
    render(value, time) {
      if (disposed) return
      const width = Math.max(1,canvas.clientWidth), height = Math.max(1,canvas.clientHeight)
      if (width !== lastWidth || height !== lastHeight) {
        lastWidth = width; lastHeight = height
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
      }
      canvas.style.opacity = String(value.candidate === 'legacy' ? 1 : value.density / 100)
      if (legacy) {
        legacy.material.uniforms.phase.value = time * .19
        legacy.material.uniforms.density.value = value.density / 100
        legacy.material.uniforms.tint.value.set(tints[value.scene])
        renderer.render(scene, flatCamera)
      } else {
        toonMaterial.color.set(tints[value.scene])
        groups.forEach((group, index) => {
          group.position.x = Math.sin(time * .10 + index * 1.7) * .8
          group.position.y = Math.sin(time * .38 + index) * (soft ? .18 : .07)
          group.rotation.z = Math.sin(time * .25 + index) * (soft ? .018 : .003)
        })
        volume?.update(value, time, camera)
        renderer.render(scene, camera)
      }
    },
    dispose() {
      disposed = true
      resources.forEach(resource => resource.dispose())
      renderer.dispose()
      // The candidate owns its canvas; never lose a StrictMode replacement.
      queueMicrotask(() => { if (!canvas.isConnected) renderer.forceContextLoss() })
    },
  }
}
