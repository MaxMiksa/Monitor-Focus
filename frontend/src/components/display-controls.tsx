import { useState } from 'react'
import { useI18n } from '@/lib/i18n-context'
import { Monitor, Laptop, Sun, Thermometer, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import type { Display } from '@/lib/control'

export function Level({ value, max = 100, min = 0, step = 1, label, disabled, temperature, onCommit }: { value: number; max?: number; min?: number; step?: number; label: string; disabled?: boolean; temperature?: boolean; onCommit: (value: number) => void | Promise<unknown> }) {
  const [draft, setDraft] = useState<number | null>(null)
  return <Slider aria-label={label} aria-valuetext={`${draft ?? value}${temperature ? ' K' : '%'}`} className={temperature ? 'temperature' : ''} value={[draft ?? value]} min={min} max={max} step={step} disabled={disabled}
    onValueChange={([v]) => setDraft(v)} onValueCommit={async ([v]) => { try { await onCommit(v) } finally { setDraft(null) } }} />
}
export function DisplayRow({ display, onCommit, onTemperatureCommit, onRestoreColor, temperatureLabel }: { display: Display; onCommit: (value: number) => void | Promise<unknown>; onTemperatureCommit?: (value: number) => void | Promise<unknown>; onRestoreColor?: () => void; temperatureLabel?: string }) {
  const { t, message, displayName } = useI18n()
  const Icon = display.Name === t('笔记本屏幕') || display.Name === '笔记本屏幕' || display.Name === 'Laptop display' ? Laptop : Monitor
  return <div><div className="display-row"><Icon /><span>{displayName(display.Name)}</span><Level label={t('{0}亮度', displayName(display.Name))} value={display.Brightness} disabled={!display.CanAdjust || !!display.Error} onCommit={onCommit} /><Sun className="text-muted-foreground" /><output>{display.Brightness}%</output></div>
    {onTemperatureCommit && <div className="display-row display-temperature">
      {onRestoreColor && <Button className="temperature-reset" variant="ghost" size="icon" aria-label={t('{0}恢复原色', displayName(display.Name))} title={t('恢复原色')} disabled={display.Kelvin === null} onClick={onRestoreColor}><RotateCcw /></Button>}
      <Level label={temperatureLabel ?? t('{0}色温', displayName(display.Name))} value={display.Kelvin ?? 6500} min={2700} max={6500} step={100} disabled={!display.CanAdjustColor || !!display.Error} temperature onCommit={onTemperatureCommit} /><Thermometer className="text-muted-foreground" /><output>{display.Kelvin ? `${display.Kelvin} K` : t('原色')}</output>
    </div>}
    {display.Error && <p className="error" role="status">{message(display.Error)}</p>}</div>
}
