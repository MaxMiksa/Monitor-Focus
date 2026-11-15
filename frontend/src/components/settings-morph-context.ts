import { createContext, useContext } from 'react'
import type { MotionValue } from 'motion/react'

export type MorphRect = { x: number; y: number; width: number; height: number }
export const SettingsMorphContext = createContext<{
  progress: MotionValue<number>
  bounds: MotionValue<{ from: MorphRect; to: MorphRect }>
  capsuleOpacity: MotionValue<number>
  settingsOpacity: MotionValue<number>
  clipPath: MotionValue<string>
} | null>(null)

export function useSettingsMorph() {
  const value = useContext(SettingsMorphContext)
  if (!value) throw new Error('SettingsMorph provider missing')
  return value
}
