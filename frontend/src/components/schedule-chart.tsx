import { useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { Popover } from 'radix-ui'
import { Plus, Trash2, X } from 'lucide-react'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { useI18n } from '@/lib/i18n-context'
import type { Settings, Snapshot } from '@/lib/control'
import { moveScheduleNode, timeLabel, validSchedule } from '@/lib/schedule-edit'
import type { ScheduleNode } from '@/lib/schedule-edit'

type Editor = { key?: string; minute: number; scene: string }
type Drag = { key: string; x: number; moved: boolean; minute: number; pointer: number }

export function ScheduleChart({ settings, snapshot, onChange, active }: {
  active: boolean; settings: Omit<Settings, 'Schedule'> & { Schedule: ScheduleNode[] }; snapshot: Snapshot; onChange: (points: ScheduleNode[]) => void
}) {
  const { t, sceneName } = useI18n()
  const plot = useRef<HTMLDivElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const drag = useRef<Drag | null>(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState<{ key: string; minute: number } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [error, setError] = useState(false)
  const points = useMemo(() => [...(preview ? moveScheduleNode(settings.Schedule, preview.key, preview.minute) : settings.Schedule)].sort((a, b) => a.MinuteOfDay - b.MinuteOfDay), [preview, settings.Schedule])
  const display = snapshot.Displays.find(d => d.CanAdjustColor) ?? snapshot.Displays[0]
  const valid = display && points.length && points.every(p => settings.Scenes.some(s => s.Id === p.SceneId))
  const curves = useMemo(() => {
    const brightness: string[] = [], color: string[] = []
    if (valid) for (let minute = 0; minute <= 1440; minute += 2) {
      const time = minute % 1440
      let index = points.findLastIndex(p => p.MinuteOfDay <= time)
      if (index < 0) index = points.length - 1
      const point = points[index], prior = points[(index + points.length - 1) % points.length]
      const target = settings.Scenes.find(s => s.Id === point.SceneId)?.Targets[display.Id]
      const from = settings.Scenes.find(s => s.Id === prior.SceneId)?.Targets[display.Id] ?? target
      if (!target || !from) continue
      const elapsed = (time - point.MinuteOfDay + 1440) % 1440
      const progress = point.TransitionMinutes === 0 ? 1 : Math.min(1, elapsed / point.TransitionMinutes)
      const blend = progress * progress * (3 - 2 * progress)
      brightness.push(`${minute},${170 - (from.Brightness + (target.Brightness - from.Brightness) * blend) * 1.3}`)
      if (display.CanAdjustColor) {
        const k = (from.Kelvin ?? 6500) + ((target.Kelvin ?? 6500) - (from.Kelvin ?? 6500)) * blend
        color.push(`${minute},${170 - (k - 2700) / 3800 * 130}`)
      }
    }
    return { brightness: brightness.join(' '), color: color.join(' ') }
  }, [valid, points, settings.Scenes, display])
  function minuteAt(clientX: number) {
    const rect = plot.current!.getBoundingClientRect()
    return Math.max(0, Math.min(1439, Math.round((clientX - rect.left) / rect.width * 1440)))
  }
  function open(minute: number, key?: string) {
    const point = settings.Schedule.find(p => p.key === key || (!key && p.MinuteOfDay === minute))
    setError(false)
    setEditor({ key: point?.key, minute: point?.MinuteOfDay ?? minute, scene: point?.SceneId ?? settings.Scenes[0]?.Id ?? '' })
  }
  function finish(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const active = drag.current
    if (!active || active.pointer !== event.pointerId) return
    drag.current = null
    setPreview(null)
    setHover(active.minute)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    suppressClick.current = cancelled || active.moved
    if (cancelled || !active.moved) return
    const next = moveScheduleNode(settings.Schedule, active.key, active.minute)
    if (validSchedule(next)) {
      if (settings.Schedule.find(p => p.key === active.key)?.MinuteOfDay !== active.minute) onChange(next)
      setError(false)
    } else setError(true)
  }
  function save(scene = editor?.scene) {
    if (!editor || !scene) return
    const duration = settings.ScheduleTransitionMinutes ?? settings.Schedule[0]?.TransitionMinutes ?? 30
    const next = editor.key
      ? settings.Schedule.map(p => p.key === editor.key ? { ...p, MinuteOfDay: editor.minute, SceneId: scene } : p)
      : [...settings.Schedule, { key: crypto.randomUUID(), MinuteOfDay: editor.minute, SceneId: scene, TransitionMinutes: duration }]
    if (!validSchedule(next)) { setError(true); return }
    onChange(next.sort((a, b) => a.MinuteOfDay - b.MinuteOfDay))
    setEditor(null); setError(false)
  }
  const activeMinute = editor?.minute ?? preview?.minute ?? hover ?? 720
  return <Popover.Root open={active && !!editor} onOpenChange={value => { if (!value) setEditor(null) }}>
    <div className="chart schedule-chart" role="group" aria-label={t('当前编辑计划的亮度和色温曲线')}>
      <div className="schedule-plot" ref={plot} onPointerMove={event => { if (!drag.current && !editor) setHover(minuteAt(event.clientX)) }} onPointerLeave={() => { if (!drag.current) setHover(null) }}
        onClick={event => { if (event.target === event.currentTarget && settings.Scenes.length) open(minuteAt(event.clientX)) }}>
        <svg viewBox="0 0 1440 200" preserveAspectRatio="none" aria-hidden="true">
          {[40, 105, 170].map(y => <line key={y} x1="0" x2="1440" y1={y} y2={y} stroke="var(--color-border)" />)}
          {valid && <><polyline points={curves.brightness} fill="none" stroke="var(--color-primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" /><polyline points={curves.color} fill="none" stroke="var(--warm)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></>}
        </svg>
        <div className="schedule-cursor" data-visible={hover !== null || !!editor || !!preview} style={{ left: `${activeMinute / 1440 * 100}%` }}>
          <span className="schedule-hover-time" style={{ transform: `translateX(${activeMinute < 90 ? 0 : activeMinute > 1350 ? -100 : -50}%)` }}>{timeLabel(activeMinute)}</span>
          <Popover.Anchor asChild><span className="schedule-popover-anchor" /></Popover.Anchor>
          <button ref={addButton} className="schedule-add" disabled={!settings.Scenes.length} aria-label={t('添加时间点')} onClick={() => open(activeMinute)}><Plus /></button>
        </div>
        {points.map(point => {
          const scene = settings.Scenes.find(s => s.Id === point.SceneId)
          return <button key={point.key} className="schedule-node" data-dragging={preview?.key === point.key} style={{ left: `${point.MinuteOfDay / 1440 * 100}%`, top: '100%' }}
            aria-label={`${timeLabel(point.MinuteOfDay)} ${scene ? sceneName(scene) : ''}`} title={timeLabel(point.MinuteOfDay)}
            onClick={event => { if (event.detail === 0 || !suppressClick.current) open(point.MinuteOfDay, point.key) }}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key) || (event.key === 'Escape' && !drag.current)) return
              event.stopPropagation(); event.preventDefault()
              if (event.key === 'Escape') { drag.current = null; suppressClick.current = true; setPreview(null); return }
              const next = moveScheduleNode(settings.Schedule, point.key, Math.max(0, Math.min(1439, point.MinuteOfDay + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1))))
              if (validSchedule(next)) { onChange(next); setError(false) } else setError(true)
            }}
            onPointerDown={event => {
              if (event.button !== 0) return
              event.stopPropagation(); setEditor(null); suppressClick.current = false
              drag.current = { key: point.key, x: event.clientX, moved: false, minute: point.MinuteOfDay, pointer: event.pointerId }
              event.currentTarget.setPointerCapture(event.pointerId)
            }} onPointerMove={event => {
              const active = drag.current
              if (!active || active.pointer !== event.pointerId) return
              event.stopPropagation()
              if (Math.abs(event.clientX - active.x) > 3) active.moved = true
              if (active.moved) { active.minute = minuteAt(event.clientX); setPreview(value => value?.key === active.key && value.minute === active.minute ? value : { key: active.key, minute: active.minute }) }
            }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
            <span className="schedule-node-dot" /><span className="schedule-node-label" data-edge={point.MinuteOfDay < 90 ? 'start' : point.MinuteOfDay > 1350 ? 'end' : undefined}>{scene ? sceneName(scene) : timeLabel(point.MinuteOfDay)}</span>
          </button>
        })}
      </div>
      <div className="schedule-time-axis" aria-hidden="true">{[0, 6, 12, 18, 24].map(h => <span key={h} style={{ left: `${h / 24 * 100}%`, transform: `translateX(${h === 0 ? 0 : h === 24 ? -100 : -50}%)` }}>{String(h).padStart(2, '0')}:00</span>)}</div>
      {(error || !validSchedule(settings.Schedule)) && !editor && <p className="schedule-feedback" role="status">{t('时间点重复或渐变重叠，请调整时间或缩短渐变时长。')}</p>}
    </div>
    {editor && <Popover.Portal><Popover.Content className="schedule-popover glass-select-content" side="right" align="center" sideOffset={18} collisionPadding={20}
      aria-label={t(editor.key ? '编辑时间点' : '添加时间点')} onEscapeKeyDown={event => { event.stopPropagation() }} onCloseAutoFocus={event => { event.preventDefault(); addButton.current?.focus({ preventScroll: true }) }}
      onKeyDown={event => event.stopPropagation()}>
      <div className="schedule-popover-heading"><span>{t(editor.key ? '编辑时间点' : '添加时间点')}</span><Popover.Close asChild><Button size="icon" variant="ghost" aria-label={t('关闭')}><X /></Button></Popover.Close></div>
      <input aria-label={t('时间点时间')} type="time" required value={timeLabel(editor.minute)} onInput={event => {
        if (!event.currentTarget.value) return
        const [hour, minute] = event.currentTarget.value.split(':').map(Number)
        setEditor({ ...editor, minute: hour * 60 + minute }); setError(false)
      }} />
      <Select aria-label={t('时间点场景')} value={editor.scene} onValueChange={scene => setEditor({ ...editor, scene })} options={settings.Scenes.map(scene => ({ value: scene.Id, label: sceneName(scene) }))} />
      {error && <p role="status">{t('时间点重复或渐变重叠，请调整时间或缩短渐变时长。')}</p>}
      <div className="schedule-popover-actions">{editor.key && <Button variant="ghost" size="icon" aria-label={t('删除时间点')} onClick={() => { onChange(settings.Schedule.filter(p => p.key !== editor.key)); setEditor(null); setError(false) }}><Trash2 /></Button>}<Button variant="outline" disabled={!editor.scene} onClick={() => save()}>{t('确定')}</Button></div>
    </Popover.Content></Popover.Portal>}
  </Popover.Root>
}
