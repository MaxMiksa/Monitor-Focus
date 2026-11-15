import { Cloud, ExternalLink, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { cloudCandidates, initialCloudLab } from '@/lib/cloud-lab'
import type { CloudLabSettings, CloudCandidate } from '@/lib/cloud-lab'
import type { StageKey } from '@/components/scene-panel'

export function CloudTestBar({ value, change }: { value: CloudLabSettings; change: (value: CloudLabSettings) => void }) {
  const index = cloudCandidates.findIndex(item => item.value === value.candidate)
  const candidate = cloudCandidates[index]
  const step = (offset: number) => change({ ...value, candidate: cloudCandidates[(index + offset + cloudCandidates.length) % cloudCandidates.length].value })
  return <section className="cloud-test-bar" aria-label="云朵测试栏" onKeyDown={event => event.stopPropagation()}>
    <div className="cloud-test-heading"><Cloud /><strong>云朵测试</strong></div>
    <Button variant="ghost" size="icon" aria-label="上一个云彩" onClick={() => step(-1)}><ChevronLeft /></Button>
    <Select aria-label="测试云彩" value={value.candidate} options={cloudCandidates.map(item => ({ value: item.value, label: item.label }))} onValueChange={candidate => change({ ...value, candidate: candidate as CloudCandidate })} />
    <Button variant="ghost" size="icon" aria-label="下一个云彩" onClick={() => step(1)}><ChevronRight /></Button>
    <Select aria-label="测试天空" value={value.scene} options={[{ value: 'morning', label: '早晨' }, { value: 'midday', label: '中午' }, { value: 'dusk', label: '傍晚' }, { value: 'night', label: '夜晚' }]} onValueChange={scene => change({ ...value, scene: scene as StageKey })} />
    <label className="cloud-test-slider">浓度<Slider aria-label="测试云彩浓度" value={[value.density]} min={0} max={100} step={1} onValueChange={([density]) => change({ ...value, density })} /><output>{value.density}%</output></label>
    <label className="cloud-test-slider">速度<Slider aria-label="测试云彩速度" value={[value.speed]} min={0} max={100} step={1} onValueChange={([speed]) => change({ ...value, speed })} /><output>{value.speed}%</output></label>
    {candidate.source && <a className="cloud-test-source" href={candidate.source} target="_blank" rel="noreferrer" aria-label="查看云彩原站" title="查看原站"><ExternalLink /></a>}
    <Button variant="ghost" size="icon" aria-label="恢复当前设置" title="恢复当前设置" onClick={() => change(initialCloudLab)}><RotateCcw /></Button>
  </section>
}
