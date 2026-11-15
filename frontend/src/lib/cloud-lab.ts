import type { StageKey } from '@/components/scene-panel'

// Deliberately ephemeral: comparing clouds must never overwrite saved scenes.
export const cloudCandidates = [
  { value: 'saved', label: '当前设置', source: '' },
  { value: 'none', label: '无云 · 对照', source: '' },
  { value: 'legacy', label: '旧版薄云 · 增强', source: '' },
  { value: 'takram', label: '写实 · Takram 积云', source: 'https://takram-design-engineering.github.io/three-geospatial/?path=/story/clouds-clouds--basic' },
  { value: 'takram-soft', label: '写实 · Takram 高层云', source: 'https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds' },
  { value: 'volume', label: '写实 · Three.js 体积云', source: 'https://threejs.org/examples/webgl_volume_cloud.html' },
  { value: 'toon', label: '卡通 · 圆润棉花云', source: 'https://threejs.org/docs/#MarchingCubes' },
  { value: 'toon-soft', label: '卡通 · 软糖白云', source: 'https://threejs.org/docs/#MarchingCubes' },
  { value: 'pmndrs', label: '现版 · pmndrs 云团', source: 'https://drei.docs.pmnd.rs/staging/cloud' },
] as const
export type CloudCandidate = typeof cloudCandidates[number]['value']
export type CloudLabSettings = { candidate: CloudCandidate; scene: StageKey; density: number; speed: number }
export const initialCloudLab: CloudLabSettings = { candidate: 'saved', scene: 'midday', density: 65, speed: 30 }
