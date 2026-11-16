import type { Language } from './i18n'
export interface Display { Id: string; Name: string; Brightness: number; CanAdjust: boolean; CanAdjustColor: boolean; Kelvin: number | null; Error: string | null; IsPrimary: boolean; BacklightTarget?: number | null }
export interface Target { Brightness: number; Kelvin: number | null }
export interface SceneBehavior { Linked: boolean; LinkWeights: Record<string, number>; FocusEnabled: boolean; ControlledDisplayIds: string[] | null }
export interface Scene { Id: string; Name: string; DefaultName?: string; Targets: Record<string, Target>; Behavior: SceneBehavior }
export interface SolarLocation { Name: string; Latitude: number; Longitude: number }
export interface SolarTimes { Days: { Sunrise: string | null; Sunset: string | null }[]; Date: string; Location: SolarLocation; Sunrise: number | null; Sunset: number | null }
export interface PlanPoint { TimeKind?: 'fixed' | 'sunrise' | 'sunset'; OffsetMinutes?: number; MinuteOfDay: number; SceneId: string; TransitionMinutes: number }
export interface TemperatureBrightnessPoint { Kelvin: number; ReferenceBrightness: number; CompensatedBrightness: number }
export interface BrightnessLinkCalibration { SourceId: string; TargetId: string; Points: { Source: number; Target: number }[] }
export type EdgeWheelModifier = 'alt' | 'ctrl' | 'shift'
export interface Settings extends SceneBehavior { SolarLocation?: SolarLocation; SchemaVersion: number; Revision: number; Language: Language; KeepSecondaryAwakeOnFullscreen: boolean; FocusDelaySeconds: number; ScheduleEnabled: boolean; ScheduleTransitionMinutes?: number; LaunchOnStartup: boolean; TopEdgeBrightnessEnabled: boolean; BottomEdgeVolumeEnabled: boolean; EdgeWheelModifier: EdgeWheelModifier; Scenes: Scene[]; Schedule: PlanPoint[]; TemperatureBrightnessCalibrations?: Record<string, { Points: TemperatureBrightnessPoint[] }>; BrightnessLinkCalibration?: BrightnessLinkCalibration | null }
export interface Snapshot { SolarTimes?: SolarTimes; Displays: Display[]; Settings: Settings; FocusPaused: boolean; Source: string; Error: string | null; Warning?: string | null; SystemLanguage?: string | null }
export interface Request { SolarLocation?: SolarLocation; Action: string; Id?: string; Value?: number; Settings?: Settings }

export function captureBehavior(settings: Settings): SceneBehavior {
  return structuredClone({ Linked: settings.Linked, LinkWeights: settings.LinkWeights,
    FocusEnabled: settings.FocusEnabled, ControlledDisplayIds: settings.ControlledDisplayIds ?? null })
}
type Reply = { Id: string; Snapshot?: Snapshot; Error?: string }
const inWails = location.hostname === 'wails.localhost'
const runtimeURL = '/wails/runtime.js'
const wailsRuntime = inWails ? import(/* @vite-ignore */ runtimeURL) : null
export const isDesktop = inWails
const pending = new Map<string, { resolve: (value: Snapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; started: number; action: string }>()
window.addEventListener('monitor-focus-reply', ((event: CustomEvent<Reply>) => {
  const data = event.detail, task = pending.get(data.Id)
  if (!task) return
  clearTimeout(task.timer); pending.delete(data.Id)
  void wailsRuntime?.then(runtime => runtime.System.invoke(JSON.stringify({ Id: data.Id, Request: { Action: 'ui-trace', Id: task.action, Value: performance.now() - task.started } })))
  if (data.Error) task.reject(new Error(data.Error))
  else if (data.Snapshot) task.resolve(data.Snapshot)
  else task.reject(new Error('控制核心未返回状态'))
}) as EventListener)
let readyReported = false
export async function request(Request: Request): Promise<Snapshot> {
  if (!wailsRuntime) throw new Error('浏览器预览未连接桌面程序')
  const runtime = await wailsRuntime
  const Id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(Id); reject(new Error('控制核心响应超时，请重试')) }, 12000)
    pending.set(Id, { resolve: snapshot => {
      resolve(snapshot)
      if (!readyReported) {
        readyReported = true
        requestAnimationFrame(() => requestAnimationFrame(() => runtime.System.invoke(JSON.stringify({ Id: crypto.randomUUID(), Request: { Action: 'ui-ready' } }))))
      }
    }, reject, timer, started: performance.now(), action: Request.Action })
    runtime.System.invoke(JSON.stringify({ Id, Request }))
  })
}
// The window keeps one fixed 16:9 aspect ratio on both pages; no resize request.
export function resizePanel(_settings: boolean) {}
export function windowCommand(command: 'window-minimise' | 'window-maximise' | 'window-close') {
  void wailsRuntime?.then(runtime => runtime.System.invoke(JSON.stringify({ Id: crypto.randomUUID(), Request: { Action: command } })))
}
// Explicit preview only; never substitute demo data when hardware requests fail.
export const preview: Snapshot = {
  Displays: [
    { Id: 'preview-external', Name: 'AOC U27G4', Brightness: 22, CanAdjust: true, CanAdjustColor: true, Kelvin: 4600, Error: null, IsPrimary: true },
    { Id: 'preview-internal', Name: '笔记本屏幕', Brightness: 52, CanAdjust: true, CanAdjustColor: true, Kelvin: 4600, Error: null, IsPrimary: false },
  ],
  Settings: { SchemaVersion: 1, Revision: 0, Language: 'system', Linked: false, LinkWeights: {}, FocusEnabled: false, ControlledDisplayIds: null, KeepSecondaryAwakeOnFullscreen: true, FocusDelaySeconds: 180, ScheduleEnabled: false, LaunchOnStartup: false, TopEdgeBrightnessEnabled: false, BottomEdgeVolumeEnabled: false, EdgeWheelModifier: 'alt',
    Scenes: ['早晨', '中午', '傍晚', '夜间'].map((Name, i) => ({ Id: `preview-${i}`, Name, DefaultName: Name, Behavior: { Linked: false, LinkWeights: {}, FocusEnabled: false, ControlledDisplayIds: null }, Targets: { 'preview-external': { Brightness: [30, 37, 22, 10][i], Kelvin: [5600, 6200, 4600, 3200][i] }, 'preview-internal': { Brightness: [60, 67, 52, 25][i], Kelvin: [5600, 6200, 4600, 3300][i] } } })), Schedule: [{ MinuteOfDay: 360, SceneId: 'preview-0', TransitionMinutes: 30 }, { MinuteOfDay: 720, SceneId: 'preview-1', TransitionMinutes: 30 }, { MinuteOfDay: 1080, SceneId: 'preview-2', TransitionMinutes: 30 }, { MinuteOfDay: 1260, SceneId: 'preview-3', TransitionMinutes: 30 }] },
  FocusPaused: false, Source: '时间计划 · 傍晚', Error: null,
}
