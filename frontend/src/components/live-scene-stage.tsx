import { useEffect, useRef, useState } from 'react'
import type { StageKey } from '@/components/scene-panel'
import { AIR_OPACITY_EVENT, readAirOpacity } from '@/lib/stage-preference'
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
const NOISE_SIZE = 128
const canvasNoiseBytes = new WeakMap<HTMLCanvasElement, number>()
    function seededRandom(seed: number) {
      let value = seed >>> 0;
      return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        return value / 4294967296;
      };
    }

    // Small periodic value-noise tile; no image sequence and no runtime blur.
    function makeNoiseData(size: number) {
      const random = seededRandom(20261114);
      const octaves = [4, 7, 13, 29].map((cells, index) => {
        const lattice = new Float32Array(cells * cells);
        for (let i = 0; i < lattice.length; i += 1) lattice[i] = random();
        return { cells, lattice, weight: [.42, .28, .18, .12][index] };
      });
      function sample(octave: { cells: number; lattice: Float32Array; weight: number }, x: number, y: number) {
        const cells = octave.cells;
        const gx = x * cells;
        const gy = y * cells;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const tx = gx - ix;
        const ty = gy - iy;
        const u = tx * tx * (3 - 2 * tx);
        const v = ty * ty * (3 - 2 * ty);
        const x0 = ((ix % cells) + cells) % cells;
        const y0 = ((iy % cells) + cells) % cells;
        const x1 = (x0 + 1) % cells;
        const y1 = (y0 + 1) % cells;
        const a = octave.lattice[y0 * cells + x0] * (1 - u) + octave.lattice[y0 * cells + x1] * u;
        const b = octave.lattice[y1 * cells + x0] * (1 - u) + octave.lattice[y1 * cells + x1] * u;
        return a * (1 - v) + b * v;
      }
      const data = new Uint8Array(size * size);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const nx = (x + .5) / size;
          const ny = (y + .5) / size;
          let value = 0;
          for (const octave of octaves) value += sample(octave, nx, ny) * octave.weight;
          value = Math.max(0, Math.min(1, .5 + (value - .5) * 1.55));
          data[y * size + x] = Math.round(value * 255);
        }
      }
      return data;
    }

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
  uniform sampler2D airNoise;
  uniform sampler2D seedPatches;
  uniform vec2 seedRows;
  uniform vec2 seedOffsets[${seedPatches.origins.length}];
  uniform float progress;
  uniform float direction;
  uniform float airPhase;
  uniform float airOpacity;
  uniform vec2 coverScale;
  uniform vec2 coverOffset;
  uniform vec4 airFrom;
  uniform vec4 airTo;
  uniform vec3 tintFrom;
  uniform vec3 tintTo;
  varying vec2 uv;
  float ease(float x) { return x * x * (3.0 - 2.0 * x); }
  float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
  float veilLayer(vec2 p, float phase, float seed, float harmonic) {
    float a = phase * harmonic + seed;
    vec2 orbit = vec2(sin(a), cos(a + seed * .31)) * .035;
    vec2 warpUv = p * .43 + vec2(.17 + seed * .07, .61 - seed * .05) + orbit * .45;
    vec2 warp = vec2(texture2D(airNoise, warpUv).r, texture2D(airNoise, warpUv + vec2(.27, .43) - orbit * .30).r) - .5;
    float stretch = 1.0 + .13 * sin(a + 1.1);
    float gather = .38 + .13 * sin(a * 2.0 + seed) + .07 * cos(a + p.x * 3.1);
    vec2 q = (p + warp * (.14 + .060 * sin(a * 3.0))) * stretch + orbit;
    float n = texture2D(airNoise, q).r;
    float shape = smoothstep(gather, gather + .44, n);
    float veil = .30 + .70 * smoothstep(.08, .72, shape);
    float transmittance = .74 + .26 * sin(phase * (harmonic + 2.0) + p.x * 4.0 + p.y * 6.0 + seed);
    float dissolve = .76 + .24 * sin(phase * (harmonic + 1.0) + p.y * 2.2 - seed);
    return veil * transmittance * dissolve;
  }
  float starAt(vec2 p, float phase) {
    vec2 grid = vec2(29.0, 16.0);
    vec2 cell = floor(p * grid), f = fract(p * grid);
    float a = hash21(cell + vec2(11.3, 7.1)), b = hash21(cell + vec2(41.7, 23.9)), c = hash21(cell + vec2(83.2, 61.4));
    vec2 center = vec2(.18 + .64 * a, .18 + .64 * b);
    float d = length((f - center) * vec2(1.15, 1.0));
    return exp(-d * d * 280.0) * step(.958, c) * (.78 + .22 * sin(phase * 2.0 + a * 6.2831853));
  }
  void main() {
    vec2 imageUv = clamp(uv * coverScale + coverOffset, 0.0, 1.0);
    vec3 fromColor = texture2D(fromFrame, imageUv).rgb;
    vec3 toColor = texture2D(toFrame, imageUv).rgb;
    vec2 imagePixel = imageUv * imageSize;
    ${seedCalls('clearSeed')}
    ${seedCalls('driftSeed')}
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

    float airBlend = ease(clamp((progress - .035) / .58, 0.0, 1.0));
    vec4 air = mix(airFrom, airTo, airBlend);
    air.x = airOpacity;
    vec3 tint = mix(tintFrom, tintTo, airBlend);
    float side = abs((imageUv.x - .5) * 2.0);
    float horizon = .655 + .066 * pow(side, 1.45);
    float sky = 1.0 - smoothstep(horizon - .20, horizon + .006, imageUv.y);
    float centerCalm = exp(-pow((imageUv.x - .5) / .205, 2.0) - pow((imageUv.y - .545) / .235, 2.0));
    float seedCalm = exp(-pow((imageUv.y - .615) / .115, 2.0)) * (1.0 - smoothstep(.10, .55, abs(imageUv.x - .5)));
    float luma = dot(color, vec3(.2126, .7152, .0722));
    float brightGuard = 1.0 - .72 * smoothstep(.70, .95, luma);
    float area = sky * brightGuard * (1.0 - .70 * centerCalm) * (1.0 - .30 * seedCalm);
    vec2 p1 = vec2(imageUv.x * 1.42 + imageUv.y * .31, imageUv.y * 5.8 - imageUv.x * .18) + vec2(.12, .27);
    vec2 p2 = mat2(.93, -.36, .36, .93) * vec2(imageUv.x * 2.15 - imageUv.y * .44, imageUv.y * 8.0 + imageUv.x * .26) + vec2(.47, .13);
    vec2 p3 = mat2(.80, .60, -.60, .80) * vec2(imageUv.x * 2.85 + imageUv.y * .55, imageUv.y * 10.6 - imageUv.x * .33) + vec2(.71, .63);
    float w1 = veilLayer(p1, airPhase, .7, 1.0), w2 = veilLayer(p2, airPhase, 2.4, 2.0), w3 = veilLayer(p3, airPhase, 4.1, 3.0);
    float breath = .82 + .30 * (.5 + .5 * sin(airPhase + p1.y * .21)) + .07 * sin(airPhase * 2.0 - p2.x * .34);
    float wisps = clamp((w1 * .46 + w2 * .33 + w3 * .21) * breath, 0.0, 1.0);
    vec3 airColor = mix(color, tint * (.58 + .42 * luma) * air.z, .58);
    float daylight = 1.0 - clamp(air.y / .86, 0.0, 1.0);
    float density = clamp(air.x * area * wisps * daylight, 0.0, 1.0);
    float softShade = 1.0 - smoothstep(.30, .78, wisps) * .018 * area * daylight;
    color = mix(color * softShade, airColor, density);
    float goldEdge = area * smoothstep(.15, .55, wisps) * (1.0 - smoothstep(.55, .95, wisps));
    color += tint * vec3(air.w, air.w * .55, air.w * .12) * goldEdge * .004;
    float starSky = sky * (1.0 - smoothstep(.34, .62, imageUv.y)) * (1.0 - .75 * centerCalm) * smoothstep(.015, .09, imageUv.y);
    color += vec3(.55, .68, .94) * starAt(imageUv, airPhase) * starSky * air.y * .055;
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

function createNoiseTexture(gl: WebGLRenderingContext): WebGLTexture {
  const texture = gl.createTexture()
  if (!texture) throw new Error('无法创建空气层纹理')
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const noiseData = makeNoiseData(NOISE_SIZE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, NOISE_SIZE, NOISE_SIZE, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, noiseData)
  if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error('空气层纹理上传失败') }
  canvasNoiseBytes.set(gl.canvas as HTMLCanvasElement, noiseData.byteLength)
  return texture
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
  noise: WebGLTexture
  seeds: WebGLTexture
  seedPhase: number
  seedOffsets: Float32Array
  airOpacity: number
  airPhase: number
  periodNow: number
  periodTarget: number
  lastTick: number
  lastDraw: number
  transitionStart: number
  starsFrom: number
  starsTo: number
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
  uniforms: Record<'from' | 'to' | 'mask' | 'noise' | 'seeds' | 'seedRows' | 'seedOffsets' | 'progress' | 'direction' | 'phase' | 'opacity' | 'coverScale' | 'coverOffset' | 'airFrom' | 'airTo' | 'tintFrom' | 'tintTo', WebGLUniformLocation | null>
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
}

function draw(runtime: StageRuntime, progress: number) {
  const { gl, uniforms } = runtime
  runtime.canvas.dataset.scene = runtime.scene
  runtime.canvas.dataset.transition = String(runtime.running)
  runtime.canvas.dataset.textureCount = String(runtime.target ? 5 : 4)
  runtime.canvas.dataset.seedPhase = runtime.seedPhase.toFixed(5)
  resize(runtime)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, runtime.current)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, runtime.target ?? runtime.current)
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, runtime.mask)
  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, runtime.noise)
  gl.activeTexture(gl.TEXTURE4)
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
  gl.uniform1f(uniforms.phase, runtime.airPhase)
  gl.uniform1f(uniforms.opacity, runtime.airOpacity)
  gl.uniform4f(uniforms.airFrom, 0, runtime.starsFrom, AIR_PROFILES[runtime.previous].gain, AIR_PROFILES[runtime.previous].gold)
  gl.uniform4f(uniforms.airTo, 0, runtime.starsTo, AIR_PROFILES[runtime.scene].gain, AIR_PROFILES[runtime.scene].gold)
  gl.uniform3fv(uniforms.tintFrom, AIR_PROFILES[runtime.previous].tint)
  gl.uniform3fv(uniforms.tintTo, AIR_PROFILES[runtime.scene].tint)
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
    noise: gl.getUniformLocation(program, 'airNoise'),
    seeds: gl.getUniformLocation(program, 'seedPatches'),
    seedRows: gl.getUniformLocation(program, 'seedRows'),
    seedOffsets: gl.getUniformLocation(program, 'seedOffsets[0]'),
    progress: gl.getUniformLocation(program, 'progress'),
    direction: gl.getUniformLocation(program, 'direction'),
    phase: gl.getUniformLocation(program, 'airPhase'),
    opacity: gl.getUniformLocation(program, 'airOpacity'),
    coverScale: gl.getUniformLocation(program, 'coverScale'),
    coverOffset: gl.getUniformLocation(program, 'coverOffset'),
    airFrom: gl.getUniformLocation(program, 'airFrom'),
    airTo: gl.getUniformLocation(program, 'airTo'),
    tintFrom: gl.getUniformLocation(program, 'tintFrom'),
    tintTo: gl.getUniformLocation(program, 'tintTo'),
  }
  gl.uniform1i(uniforms.from, 0)
  gl.uniform1i(uniforms.to, 1)
  gl.uniform1i(uniforms.mask, 2)
  gl.uniform1i(uniforms.noise, 3)
  gl.uniform1i(uniforms.seeds, 4)
  gl.uniform1f(uniforms.direction, 1)
  gl.uniform1f(uniforms.opacity, readAirOpacity())

  const noise = createNoiseTexture(gl)
  canvas.dataset.airNoiseBytes = String(canvasNoiseBytes.get(canvas) ?? 0)
  const runtime: StageRuntime = {
    gl, canvas, program, buffer,
    mask: makeTexture(gl, maskImage),
    noise,
    seeds: makeTexture(gl, seedImage),
    seedPhase: 0,
    seedOffsets: new Float32Array(seedPatches.origins.length * 2),
    airOpacity: readAirOpacity(),
    airPhase: .62,
    periodNow: AIR_PROFILES[scene].period,
    periodTarget: AIR_PROFILES[scene].period,
    lastTick: 0,
    lastDraw: 0,
    transitionStart: 0,
    starsFrom: 0,
    starsTo: scene === 'night' ? .86 : 0,
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
    gl.deleteTexture(runtime.noise)
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
  const opacityChanged = () => {
    runtime.airOpacity = readAirOpacity()
    if (!signal.aborted && !document.hidden) draw(runtime, transitionProgress(runtime))
  }
  window.addEventListener(AIR_OPACITY_EVENT, opacityChanged, { signal })
  window.addEventListener('storage', opacityChanged, { signal })
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
  runtime.starsFrom = runtime.starsTo
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
  runtime.periodNow += (runtime.periodTarget - runtime.periodNow) * (1 - Math.exp(-delta / .45))
  runtime.airPhase = (runtime.airPhase + delta * TAU / runtime.periodNow) % TAU
  runtime.seedPhase = (runtime.seedPhase + delta * TAU / 120) % TAU
  const interval = 1000 / Math.min(MAX_FPS, runtime.running ? MAX_FPS : AIR_PROFILES[runtime.scene].idleFps)
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
    runtime.starsFrom = previous === 'night' ? .86 : 0
    runtime.starsTo = requested === 'night' ? .86 : 0
    runtime.periodTarget = AIR_PROFILES[requested].period
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

export function LiveSceneStage({ scene, reduced }: { scene: StageKey; reduced: boolean }) {
  const [unavailable, setUnavailable] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const runtimeRef = useRef<StageRuntime | null>(null)
  const signalRef = useRef<AbortController | null>(null)
  const latestRef = useRef({ scene, reduced })

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
    latestRef.current = { scene, reduced }
    const runtime = runtimeRef.current
    const signal = signalRef.current?.signal
    if (!runtime || !signal) return
    runtime.reduced = reduced
    runtime.wanted = scene
    if (idlePaused(runtime)) { stopAir(runtime); if (runtime.running) finish(runtime, signal) }
    else startAir(runtime, signal)
    void requestTransition(runtime, signal)
  }, [scene, reduced])

  return <canvas ref={canvasRef} className={`live-stage-canvas${unavailable ? ' live-stage-unavailable' : ''}`} style={unavailable ? { backgroundImage: `url('${sources[scene]}')` } : undefined} aria-hidden="true" />
}
