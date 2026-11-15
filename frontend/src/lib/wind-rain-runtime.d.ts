export type RainEdge = { left: number; right: number; top: number }
export type RainEdges = RainEdge[] & { settingsOpen?: boolean }
export type RainRuntime = {
  setAmount(value: number): void
  setPaused(value: boolean): void
  setSplashes(value: boolean): void
  setEdges(provider: () => RainEdges): void
  refreshEdges(): void
  dispose(): void
}
export function createWindRain(host: HTMLElement, report: (rain: number, fps?: number, splashes?: number) => void): RainRuntime
