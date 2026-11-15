export function rainMoodOpacity(amount: number, night: boolean): number {
  const rain = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0
  return (night ? .4 + rain * .25 : .8 + rain * .15) * rain ** .65
}
