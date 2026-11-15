import { Float32BufferAttribute } from 'three'
import type { BufferGeometry, ShaderMaterial } from 'three'

// Keep pmndrs Stars' point geometry, fade and color pipeline. Its default
// shared size pulse is replaced by independent, stable per-star light curves.
export function independentStarTwinkle(geometry: BufferGeometry, material: ShaderMaterial) {
  let seed = 20261116
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const attributes = new Float32Array(geometry.getAttribute('position').count * 3)
  for (let index = 0; index < attributes.length; index += 3) {
    attributes[index] = random() * Math.PI * 2
    attributes[index + 1] = .55 + random() * 1.65
    attributes[index + 2] = .25 + random() * .65
  }
  geometry.setAttribute('twinkle', new Float32BufferAttribute(attributes, 3))
  material.uniforms.twinkleStrength = { value: 0 }
  material.vertexShader = `
    uniform float time;
    uniform float twinkleStrength;
    attribute float size;
    attribute vec3 twinkle;
    varying vec3 vColor;
    void main() {
      float wave = .5 + .5 * sin(time * twinkle.y + twinkle.x);
      float light = 1.0 - twinkleStrength * twinkle.z * wave;
      vColor = color * light;
      vec4 mvPosition = modelViewMatrix * vec4(position, 0.5);
      gl_PointSize = size * (30.0 / -mvPosition.z) * (3.0 + sin(100.0));
      gl_Position = projectionMatrix * mvPosition;
    }
  `
  material.needsUpdate = true
}
