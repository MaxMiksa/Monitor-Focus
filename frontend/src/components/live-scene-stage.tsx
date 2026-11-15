import { useEffect, useRef, useState } from 'react'
import type { StageKey } from '@/components/scene-panel'
import seedPatches from '@/lib/seed-patches.json'

const WIDTH = 1672
const HEIGHT = 941
const DURATION = 1750
const sources: Record<StageKey, string> = {
  morning: '/scenes/live/morning.webp',
  midday: '/scenes/live/midday.webp',
  dusk: '/scenes/live/dusk.webp',
  night: '/scenes/live/night.webp',
}
const maskSource = '/scenes/live/mask.webp'
const seedPatchSource = '/scenes/live/seed-sky-patches.png'
const seedCalls = (operation: string) => seedPatches.origins.map(([x, y], index) =>
  `${operation}(fromColor, toColor, imagePixel, vec2(${x}.0, ${y}.0), ${index}.0${operation === 'driftSeed' ? `, seedOffsets[${index}]` : ''});`,
).join('\n')

const vertexSource = `
  attribute vec2 position;
  varying vec2 uv;
  void main() {
    uv = vec2(position.x * .5 + .5, .5 - position.y * .5);
    gl_Position = vec4(position, 0.0, 1.0);
  }
`

const AIR_PROFILES = {
  morning: { period: 40, idleFps: 18, gain: .96, gold: .06, tint: [1.00, .91, .76] },
  midday:  { period: 30, idleFps: 24, gain: 1.05, gold: .02, tint: [.88, .95, 1.00] },
  dusk:    { period: 60, idleFps: 14, gain: .92, gold: .32, tint: [1.00, .80, .56] },
  night:   { period: 90, idleFps: 10, gain: .50, gold: 0, tint: [.36, .50, .80] },
} as const
const TAU = Math.PI * 2
const MAX_FPS = 30
// Original seed detail moves by signed difference against tiny offline sky patches.
const fragmentSource = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
  precision highp float;
  #else
  precision mediump float;
  #endif
  uniform sampler2D fromFrame;
  uniform sampler2D toFrame;
  uniform sampler2D regionMask;
  uniform sampler2D seedPatches;
  uniform vec2 seedRows;
  uniform vec2 seedOffsets[${seedPatches.origins.length}];
  uniform float progress;
  uniform float direction;
  uniform float rainAmount;
  uniform float rainTime;
  uniform float viewAspect;
  uniform vec2 coverScale;
  uniform vec2 coverOffset;
  varying vec2 uv;
  float ease(float x) { return x * x * (3.0 - 2.0 * x); }
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float rainLayer(vec2 p, vec2 grid, float speed, float seed) {
    p.x += p.y * .16;
    p.y -= rainTime * speed;
    vec2 cell = floor(p * grid);
    vec2 f = fract(p * grid);
    float random = hash21(cell + seed);
    float center = .15 + .7 * hash21(cell + seed + 19.0);
    float line = 1.0 - smoothstep(.012, .055, abs(f.x - center));
    float streak = smoothstep(.05, .18, f.y) * (1.0 - smoothstep(.45, .85, f.y));
    return line * streak * step(.83 - rainAmount * .24, random);
  }
  const vec2 imageSize = vec2(${seedPatches.imageSize.join('.0, ')}.0);
  const vec2 seedCell = vec2(${seedPatches.cellSize.join('.0, ')}.0);
  const vec2 seedAtlasSize = vec2(${seedPatches.atlasSize.join('.0, ')}.0);
  bool inSeed(vec2 p) {
    return p.x >= .5 && p.y >= .5 && p.x <= seedCell.x - .5 && p.y <= seedCell.y - .5;
  }
  vec3 seedSky(vec2 p, float index, float row) {
    return texture2D(seedPatches, (vec2(index * seedCell.x, row * seedCell.y) + p) / seedAtlasSize).rgb;
  }
  void clearSeed(inout vec3 a, inout vec3 b, vec2 pixel, vec2 origin, float index) {
    vec2 p = pixel - origin;
    if (inSeed(p)) {
      a = seedSky(p, index, seedRows.x);
      b = seedSky(p, index, seedRows.y);
    }
  }
  void driftSeed(inout vec3 a, inout vec3 b, vec2 pixel, vec2 origin, float index, vec2 offset) {
    vec2 p = pixel - origin - offset;
    if (inSeed(p)) {
      vec2 originalUv = (origin + p) / imageSize;
      // Signed detail preserves both pale hairs and darker stems. No blue rectangle.
      a += texture2D(fromFrame, originalUv).rgb - seedSky(p, index, seedRows.x);
      b += texture2D(toFrame, originalUv).rgb - seedSky(p, index, seedRows.y);
    }
  }
  void main() {
    vec2 imageUv = clamp(uv * coverScale + coverOffset, 0.0, 1.0);
    vec3 fromColor = texture2D(fromFrame, imageUv).rgb;
    vec3 toColor = texture2D(toFrame, imageUv).rgb;
    vec2 imagePixel = imageUv * imageSize;
    ${seedCalls('clearSeed')}
    if (rainAmount < .01) {
      ${seedCalls('driftSeed')}
    }
    float difference = length(toColor - fromColor) / 1.732;
    float region = texture2D(regionMask, imageUv).r;
    float detail = difference * .28;
    float weight = clamp((progress - (1.0 - region) * .46 - (1.0 - detail) * .10) / .42, 0.0, 1.0);
    float soft = ease(weight);
    float phase = mix(-1.0, 1.0, step(0.0, direction));
    float lightPulse = sin((imageUv.y * 5.0 + imageUv.x * 1.4 + phase * progress * 2.4) * 3.14159) * .022
      * sin(progress * 3.14159) * difference;
    soft = clamp(soft + lightPulse, 0.0, 1.0);
    vec3 color = mix(fromColor, toColor, soft);
    float highlight = sin(progress * 3.14159) * difference * region * .018;
    color += vec3(highlight * .85, highlight, highlight * 1.15);

    if (rainAmount > .001) {
      float sky = clamp((region * 255.0 - 166.0) / 38.0, 0.0, 1.0);
      float grey = dot(color, vec3(.2126, .7152, .0722));
      color = mix(color, vec3(grey) * vec3(.91, .97, 1.02), rainAmount * .22);
      color *= 1.0 - rainAmount * (.06 + sky * .19);
      vec2 rainUv = vec2(uv.x * viewAspect, uv.y);
      float streaks = rainLayer(rainUv, vec2(73.0, 17.0), .39, 3.7) * .17
        + rainLayer(rainUv + vec2(.31, .19), vec2(111.0, 23.0), .26, 47.1) * .075;
      color += vec3(.76, .85, .94) * streaks * rainAmount * (.4 + .6 * sqrt(grey));
    }
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`

function loadImage(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
    const image = new Image()
    image.decoding = 'async'
    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal.removeEventListener('abort', abort)
    }
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('aborted', 'AbortError')) }
    image.onload = () => { cleanup(); resolve(image) }
    image.onerror = () => { cleanup(); reject(new Error(`无法加载场景图片：${url}`)) }
    signal.addEventListener('abort', abort, { once: true })
    image.src = url
  })
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('无法创建场景着色器')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? '着色器编译失败'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

type StageRuntime = {
  gl: WebGLRenderingContext
  canvas: HTMLCanvasElement
  program: WebGLProgram
  buffer: WebGLBuffer
  mask: WebGLTexture
  seeds: WebGLTexture
  seedPhase: number
  seedOffsets: Float32Array
  rain: number
  rainTime: number
  lastTick: number
  lastDraw: number
  transitionStart: number
  current: WebGLTexture
  target: WebGLTexture | null
  scene: StageKey
  previous: StageKey
  wanted: StageKey
  running: boolean
  loading: boolean
  animation: number
  direction: number
  reduced: boolean
  uniforms: Record<'from' | 'to' | 'mask' | 'seeds' | 'seedRows' | 'seedOffsets' | 'progress' | 'direction' | 'rain' | 'rainTime' | 'aspect' | 'coverScale' | 'coverOffset', WebGLUniformLocation | null>
  dispose: () => void
}

function makeTexture(gl: WebGLRenderingContext, image: TexImageSource): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('无法创建场景纹理')
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image)
  if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error('场景纹理上传失败') }
  return texture
}

function resize(runtime: StageRuntime) {
  const { gl, canvas, uniforms } = runtime
  const ratio = Math.min(window.devicePixelRatio || 1, 1.25)
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
    gl.viewport(0, 0, width, height)
  }
  const imageAspect = WIDTH / HEIGHT
  const viewAspect = width / height
  const scaleX = viewAspect > imageAspect ? 1 : viewAspect / imageAspect
  const scaleY = viewAspect > imageAspect ? imageAspect / viewAspect : 1
  gl.uniform2f(uniforms.coverScale, scaleX, scaleY)
  gl.uniform2f(uniforms.coverOffset, (1 - scaleX) * .5, (1 - scaleY) * .5)
  gl.uniform1f(uniforms.aspect, viewAspect)
}

function draw(runtime: StageRuntime, progress: number) {
  const { gl, uniforms } = runtime
  runtime.canvas.dataset.scene = runtime.scene
  runtime.canvas.dataset.transition = String(runtime.running)
  runtime.canvas.dataset.textureCount = String(runtime.target ? 4 : 3)
  runtime.canvas.dataset.seedPhase = runtime.seedPhase.toFixed(5)
  runtime.canvas.dataset.rain = runtime.rain.toFixed(3)
  resize(runtime)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, runtime.current)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, runtime.target ?? runtime.current)
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, runtime.mask)
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, runtime.seeds)
  gl.uniform2f(uniforms.seedRows, seedPatches.scenes.indexOf(runtime.previous), seedPatches.scenes.indexOf(runtime.scene))
  for (let index = 0; index < seedPatches.origins.length; index += 1) {
    const phase = index * 1.731
    const speed = 5 + index % 3
    // Evaluate once per seed per draw, rather than for every sky pixel.
    runtime.seedOffsets[index * 2] = (Math.sin(runtime.seedPhase * speed + phase) - Math.sin(phase))
      * (17 + index % 4 * 2) + Math.sin(runtime.seedPhase * 2) * 8
    runtime.seedOffsets[index * 2 + 1] = (Math.sin(runtime.seedPhase * (speed + 1) + phase * .7) - Math.sin(phase * .7)) * 3
  }
  gl.uniform2fv(uniforms.seedOffsets, runtime.seedOffsets)
  gl.uniform1f(uniforms.progress, progress)
  gl.uniform1f(uniforms.rain, runtime.rain)
  gl.uniform1f(uniforms.rainTime, runtime.rainTime)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
}

async function createRuntime(canvas: HTMLCanvasElement, scene: StageKey, reduced: boolean, signal: AbortSignal): Promise<StageRuntime> {
  // Finish decoding before allocating GPU resources, so aborts cannot strand a context.
  const [frame, maskImage, seedImage] = await Promise.all([
    loadImage(sources[scene], signal), loadImage(maskSource, signal), loadImage(seedPatchSource, signal),
  ])
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  const gl = canvas.getContext('webgl', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power',
  })
  if (!gl) throw new Error('当前环境不支持实时场景渲染')
  try {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  const buffer = gl.createBuffer()
  if (!program || !buffer) throw new Error('无法创建场景渲染资源')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? '场景程序链接失败')
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const uniforms = {
    from: gl.getUniformLocation(program, 'fromFrame'),
    to: gl.getUniformLocation(program, 'toFrame'),
    mask: gl.getUniformLocation(program, 'regionMask'),
    seeds: gl.getUniformLocation(program, 'seedPatches'),
    seedRows: gl.getUniformLocation(program, 'seedRows'),
    seedOffsets: gl.getUniformLocation(program, 'seedOffsets[0]'),
    progress: gl.getUniformLocation(program, 'progress'),
    direction: gl.getUniformLocation(program, 'direction'),
    rain: gl.getUniformLocation(program, 'rainAmount'),
    rainTime: gl.getUniformLocation(program, 'rainTime'),
    aspect: gl.getUniformLocation(program, 'viewAspect'),
    coverScale: gl.getUniformLocation(program, 'coverScale'),
    coverOffset: gl.getUniformLocation(program, 'coverOffset'),
  }
  gl.uniform1i(uniforms.from, 0)
  gl.uniform1i(uniforms.to, 1)
  gl.uniform1i(uniforms.mask, 2)
  gl.uniform1i(uniforms.seeds, 3)
  gl.uniform1f(uniforms.direction, 1)

  const runtime: StageRuntime = {
    gl, canvas, program, buffer,
    mask: makeTexture(gl, maskImage),
    seeds: makeTexture(gl, seedImage),
    seedPhase: 0,
    seedOffsets: new Float32Array(seedPatches.origins.length * 2),
    rain: 0,
    rainTime: 0,
    lastTick: 0,
    lastDraw: 0,
    transitionStart: 0,
    current: makeTexture(gl, frame),
    target: null,
    scene,
    previous: scene,
    wanted: scene,
    running: false,
    loading: false,
    animation: 0,
    direction: 1,
    reduced,
    uniforms,
    dispose: () => {},
  }
  canvas.dataset.seedPatchRgbBytes = String(seedPatches.atlasSize[0] * seedPatches.atlasSize[1] * 3)
  canvas.dataset.seedCount = String(seedPatches.origins.length)
  seedImage.src = ''
  runtime.dispose = () => {
    cancelAnimationFrame(runtime.animation)
    gl.deleteTexture(runtime.mask)
    gl.deleteTexture(runtime.seeds)
    gl.deleteTexture(runtime.current)
    if (runtime.target) gl.deleteTexture(runtime.target)
    gl.deleteBuffer(runtime.buffer)
    gl.deleteProgram(runtime.program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  draw(runtime, 1)
  const resizeListener = () => { if (!signal.aborted && !document.hidden) draw(runtime, transitionProgress(runtime)) }
  window.addEventListener('resize', resizeListener, { passive: true })
  signal.addEventListener('abort', () => window.removeEventListener('resize', resizeListener), { once: true })
  startAir(runtime, signal)
  document.addEventListener('visibilitychange', () => {
    if (signal.aborted) return
    if (idlePaused(runtime)) { stopAir(runtime); if (runtime.running) finish(runtime, signal) }
    else startAir(runtime, signal)
  }, { signal })
  return runtime
  } catch (error) {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw error
  }
}

function transitionProgress(runtime: StageRuntime) {
  return runtime.running ? Math.min(1, (performance.now() - runtime.transitionStart) / DURATION) : 1
}

function stopAir(runtime: StageRuntime) {
  cancelAnimationFrame(runtime.animation)
  runtime.animation = 0
  runtime.canvas.dataset.airPaused = 'true'
}

function finish(runtime: StageRuntime, signal: AbortSignal) {
  if (runtime.target) {
    runtime.gl.deleteTexture(runtime.current)
    runtime.current = runtime.target
    runtime.target = null
  }
  runtime.running = false
  runtime.previous = runtime.scene
  if (!signal.aborted && !document.hidden) draw(runtime, 1)
  if (!signal.aborted && runtime.wanted !== runtime.scene) {
    void requestTransition(runtime, signal)
  }
}

function idlePaused(runtime: StageRuntime) {
  return runtime.reduced || document.hidden || !runtime.canvas.isConnected
}

function tickAir(runtime: StageRuntime, signal: AbortSignal, now: number) {
  if (signal.aborted || idlePaused(runtime)) { runtime.animation = 0; return }
  const delta = Math.min((now - runtime.lastTick) / 1000, .2)
  runtime.lastTick = now
  runtime.seedPhase = (runtime.seedPhase + delta * TAU / 120) % TAU
  // Both layer speeds make an integer number of grid cells in 1000 seconds.
  runtime.rainTime = (runtime.rainTime + delta) % 1000
  const interval = 1000 / Math.min(MAX_FPS, runtime.running ? MAX_FPS : runtime.rain > 0 ? 24 : AIR_PROFILES[runtime.scene].idleFps)
  if (now - runtime.lastDraw >= interval - 1) {
    if (runtime.lastDraw) runtime.canvas.dataset.airMeasuredFps = (1000 / Math.max(now - runtime.lastDraw, 1)).toFixed(1)
    runtime.lastDraw = now
    if (runtime.running && transitionProgress(runtime) >= 1) finish(runtime, signal)
    else draw(runtime, transitionProgress(runtime))
  }
  runtime.animation = requestAnimationFrame(next => tickAir(runtime, signal, next))
}

function startAir(runtime: StageRuntime, signal: AbortSignal) {
  if (signal.aborted || idlePaused(runtime) || runtime.animation) return
  runtime.lastTick = performance.now()
  runtime.canvas.dataset.airPaused = 'false'
  runtime.lastDraw = 0
  runtime.animation = requestAnimationFrame(now => tickAir(runtime, signal, now))
}

async function playTransition(runtime: StageRuntime, requested: StageKey, reduced: boolean, signal: AbortSignal) {
  runtime.loading = true
  const previous = runtime.scene
  try {
    const image = await loadImage(sources[requested], signal)
    if (signal.aborted) return
    if (requested !== runtime.wanted) {
      runtime.loading = false
      void requestTransition(runtime, signal)
      return
    }
    runtime.target = makeTexture(runtime.gl, image)
    runtime.loading = false
    runtime.running = true
    runtime.previous = previous
    runtime.scene = requested
    const order = ['morning', 'midday', 'dusk', 'night']
    runtime.direction = order.indexOf(requested) > order.indexOf(previous) ? 1 : -1
    runtime.gl.uniform1f(runtime.uniforms.direction, runtime.direction)
    runtime.transitionStart = performance.now()
    if (runtime.animation) cancelAnimationFrame(runtime.animation)
    runtime.animation = 0
    if (reduced || idlePaused(runtime)) {
      finish(runtime, signal)
      startAir(runtime, signal)
      return
    }
    startAir(runtime, signal)
    return
  } catch (error) {
    if (!signal.aborted) console.warn(error)
  }
  runtime.running = false
  runtime.loading = false
  if (!signal.aborted && runtime.wanted !== requested) void requestTransition(runtime, signal)
}

function requestTransition(runtime: StageRuntime, signal: AbortSignal): Promise<void> {
  if (signal.aborted || runtime.wanted === runtime.scene || runtime.running || runtime.loading) return Promise.resolve()
  return playTransition(runtime, runtime.wanted, runtime.reduced, signal)
}

export function LiveSceneStage({ scene, reduced, rain = 0 }: { scene: StageKey; reduced: boolean; rain?: number }) {
  const [unavailable, setUnavailable] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const runtimeRef = useRef<StageRuntime | null>(null)
  const signalRef = useRef<AbortController | null>(null)
  const latestRef = useRef({ scene, reduced, rain })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const controller = new AbortController()
    signalRef.current = controller
    let live = true
    const initial = latestRef.current
    createRuntime(canvas, initial.scene, initial.reduced, controller.signal).then(runtime => {
      if (!live || controller.signal.aborted) { runtime.dispose(); return }
      runtimeRef.current = runtime
      runtime.reduced = latestRef.current.reduced
      runtime.rain = latestRef.current.rain
      if (!document.hidden) draw(runtime, transitionProgress(runtime))
      runtime.wanted = latestRef.current.scene
      if (idlePaused(runtime)) stopAir(runtime)
      void requestTransition(runtime, controller.signal)
    }).catch(error => {
      if (controller.signal.aborted) return
      setUnavailable(true)
      console.warn(error)
    })
    return () => {
      live = false
      controller.abort()
      runtimeRef.current?.dispose()
      runtimeRef.current = null
      signalRef.current = null
    }
    // The runtime is created once; scene/reduced changes are applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    latestRef.current = { scene, reduced, rain }
    const runtime = runtimeRef.current
    const signal = signalRef.current?.signal
    if (!runtime || !signal) return
    runtime.reduced = reduced
    runtime.rain = Math.max(0, Math.min(1, rain))
    if (!document.hidden) draw(runtime, transitionProgress(runtime))
    runtime.wanted = scene
    if (idlePaused(runtime)) { stopAir(runtime); if (runtime.running) finish(runtime, signal) }
    else startAir(runtime, signal)
    void requestTransition(runtime, signal)
  }, [scene, reduced, rain])

  return <canvas ref={canvasRef} className={`live-stage-canvas${unavailable ? ' live-stage-unavailable' : ''}`} style={unavailable ? { backgroundImage: `url('${sources[scene]}')` } : undefined} aria-hidden="true" />
}
