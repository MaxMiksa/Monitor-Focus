import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react'
import { SettingsMorphContext, useSettingsMorph } from './settings-morph-context'
import type { MorphRect } from './settings-morph-context'

import { useI18n } from '@/lib/i18n-context'

// The empty shell is the stable measurement target for the capsule animation.
export function SettingsShell({ open, children }: { open: boolean; children: ReactNode }) {
  const { t } = useI18n()
  const { settingsOpacity, clipPath } = useSettingsMorph()
  return <motion.section className="settings-float" data-dismiss-region="settings" aria-label={t('设置')}
    aria-hidden={!open} inert={!open} style={{ opacity: settingsOpacity, clipPath, pointerEvents: open ? 'auto' : 'none' }}>
    {children}
  </motion.section>
}

const empty: MorphRect = { x: 0, y: 0, width: 0, height: 0 }

export function SettingsMorph({ open, children }: { open: boolean; children: ReactNode }) {
  const reduced = useReducedMotion()
  const target = useMotionValue(open ? 1 : 0)
  // Overdamped spring preserves velocity when reversing, without a bounce.
  const spring = useSpring(target, { stiffness: 420, damping: 44, mass: 1, restDelta: .0001, restSpeed: .001 })
  const progress = useTransform(spring, value => Math.max(0, Math.min(1, value)))
  const bounds = useMotionValue({ from: empty, to: empty })
  const capsuleOpacity = useTransform(progress, [0, .035, 1], [1, 0, 0])
  const settingsOpacity = useTransform(progress, [0, .68, 1], [0, 0, 1])
  const clipPath = useTransform(() => {
    const p = progress.get()
    const { from, to } = bounds.get()
    const q = 1 - p
    const radius = from.height / 2 * q + 28 * p
    return `inset(${(from.y - to.y) * q}px ${(to.x + to.width - from.x - from.width) * q}px ${(to.y + to.height - from.y - from.height) * q}px ${(from.x - to.x) * q}px round ${radius}px)`
  })
  useEffect(() => {
    target.set(open ? 1 : 0)
    if (reduced) spring.jump(open ? 1 : 0)
  }, [open, reduced, spring, target])
  return <SettingsMorphContext.Provider value={{ progress, bounds, capsuleOpacity, settingsOpacity, clipPath }}>{children}</SettingsMorphContext.Provider>
}

export function SettingsMorphSurface({ anchorKey }: { anchorKey: string }) {
  const surface = useRef<HTMLDivElement>(null)
  const { progress, bounds } = useSettingsMorph()
  useLayoutEffect(() => {
    const root = surface.current?.parentElement
    const anchor = root?.querySelector<HTMLElement>('.scene-capsule')
    const panel = root?.querySelector<HTMLElement>('.settings-float')
    if (!root || !anchor || !panel) return
    const measure = () => {
      const origin = root.getBoundingClientRect()
      const relative = (element: HTMLElement): MorphRect => {
        const rect = element.getBoundingClientRect()
        return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height }
      }
      bounds.set({ from: relative(anchor), to: relative(panel) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    for (const element of [root, anchor, panel]) observer.observe(element)
    return () => observer.disconnect()
  }, [anchorKey, bounds])
  const left = useTransform(() => bounds.get().from.x * (1 - progress.get()) + bounds.get().to.x * progress.get())
  const top = useTransform(() => bounds.get().from.y * (1 - progress.get()) + bounds.get().to.y * progress.get())
  const width = useTransform(() => bounds.get().from.width * (1 - progress.get()) + bounds.get().to.width * progress.get())
  const height = useTransform(() => bounds.get().from.height * (1 - progress.get()) + bounds.get().to.height * progress.get())
  const borderRadius = useTransform(() => bounds.get().from.height / 2 * (1 - progress.get()) + 28 * progress.get())
  const borderColor = useTransform(progress, [0, 1], ['rgba(255,255,255,.62)', 'rgba(255,255,255,.42)'])
  const boxShadow = useTransform(progress, [0, 1], ['inset 0 1px rgba(255,255,255,.28), inset 0 -1px rgba(255,255,255,.28), 0 0 28px rgba(3,14,25,.16)', 'inset 0 1px rgba(255,255,255,.32), inset 0 -1px rgba(255,255,255,.06), 0 18px 56px rgba(5,13,21,.22)'])
  const capsuleMaterial = useTransform(progress, value => 1 - value)
  return <motion.div ref={surface} className="settings-morph-surface" aria-hidden="true" style={{ left, top, width, height, borderRadius, borderColor, boxShadow }}>
    <motion.div className="settings-morph-material settings-morph-capsule" style={{ opacity: capsuleMaterial }} />
    <motion.div className="settings-morph-material settings-morph-panel" style={{ opacity: progress }} />
  </motion.div>
}
