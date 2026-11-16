import { ArrowLeft, Sparkles, CloudSun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/lib/i18n-context'
import { cloudLayouts, skyScenes } from '@/lib/sky-preference'
import type { SkyPreferences, SkySettings } from '@/lib/sky-preference'
import type { StageKey } from '@/components/scene-panel'
import type { TextKey } from '@/lib/i18n'

const names = { morning: '早晨', midday: '中午', dusk: '傍晚', night: '夜晚' } as const

export function SkySettingsEditor({ scene, selectScene, value, change, back }: {
  scene: StageKey; selectScene: (scene: StageKey) => void; value: SkyPreferences
  change: (update: (value: SkySettings) => void) => void; back: () => void
}) {
  const { t } = useI18n()
  const sky = value[scene]
  return <div className="sky-settings">
    <div className="sky-settings-top">
      <Button variant="ghost" size="icon" aria-label={t('返回通用')} title={t('返回通用')} onClick={back}><ArrowLeft /></Button>
      <div className="sky-scene-selector" role="group" aria-label={t('预览场景')}>
        {skyScenes.map(key => <Button key={key} variant="ghost" aria-pressed={key === scene} onClick={() => selectScene(key)}>{t(names[key])}</Button>)}
      </div>
    </div>
    <div className="sky-settings-columns">
      <section className="sky-effect-card" aria-label={t('星星')}>
        <div className="sky-effect-heading"><h2><Sparkles />{t('星星')}</h2><Switch aria-label={t('显示星星')} checked={sky.stars.enabled} onCheckedChange={on => change(s => { s.stars.enabled = on })} /></div>
        <Select aria-label={t('星空样式')} value={sky.stars.style} onValueChange={v => change(s => { s.stars.style = v === 'dense' ? 'dense' : 'sparse' })} options={[{ value: 'sparse', label: t('稀疏清晰') }, { value: 'dense', label: t('满天繁星') }]} />
        <SkySlider label="数量" aria="星星数量" value={sky.stars.count} change={v => change(s => { s.stars.count = v })} />
        <SkySlider label="亮度" aria="星星亮度" value={sky.stars.brightness} change={v => change(s => { s.stars.brightness = v })} />
        <SkySlider label="闪烁" aria="星星闪烁" value={sky.stars.twinkle} change={v => change(s => { s.stars.twinkle = v })} />
      </section>
      <section className="sky-effect-card" aria-label={t('云彩')}>
        <div className="sky-effect-heading"><h2><CloudSun />{t('云彩')}</h2><Switch aria-label={t('显示云彩')} checked={sky.clouds.enabled} onCheckedChange={on => change(s => { s.clouds.enabled = on })} /></div>
        <Select aria-label={t('云彩样式')} value={sky.clouds.style} onValueChange={v => change(s => { s.clouds.style = v === 'legacy' || v === 'puffs' || v === 'layers' ? v : 'wisps' })} options={[{ value: 'legacy', label: '旧版薄云 · 增强' }, { value: 'wisps', label: t('轻薄流云') }, { value: 'puffs', label: t('蓬松云团') }, { value: 'layers', label: t('层叠云海') }]} />
        {sky.clouds.style !== 'legacy' && <Select aria-label={t('云彩分布')} value={sky.clouds.layout} onValueChange={v => change(s => { s.clouds.layout = cloudLayouts.find(layout => layout === v) ?? 'original' })} options={cloudLayouts.map((layout, index) => ({ value: layout, label: t((['原有分布', '自然散布', '错落高低', '弧形环绕', '远近云层'] as const)[index]) }))} />}
        <Select aria-label={t('云彩移动方式')} value={sky.clouds.motion} onValueChange={v => change(s => { s.clouds.motion = v === 'float' ? 'float' : 'drift' })} options={[{ value: 'drift', label: t('随风飘动') }, { value: 'float', label: t('原地轻浮') }]} />
        <SkySlider label="浓度" aria="云彩浓度" value={sky.clouds.density} change={v => change(s => { s.clouds.density = v })} />
        <SkySlider label="速度" aria="云彩速度" value={sky.clouds.speed} change={v => change(s => { s.clouds.speed = v })} />
      </section>
    </div>
  </div>
}

function SkySlider({ label, aria, value, change }: { label: TextKey; aria: TextKey; value: number; change: (value: number) => void }) {
  const { t } = useI18n()
  return <div className="sky-effect-slider"><span>{t(label)}</span><Slider aria-label={t(aria)} aria-valuetext={`${value}%`} min={0} max={100} step={1} value={[value]} onValueChange={values => change(values[0])} /><output>{value}%</output></div>
}
