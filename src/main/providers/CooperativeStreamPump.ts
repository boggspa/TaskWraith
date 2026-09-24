/**
 * Safety net for provider stdout pumps: one OnUvRead callback must not hold
 * the Cocoa / Electron main loop for seconds. Work stays the same; leftover
 * lines yield to the next macrotask once the G-lag budget is spent.
 */

export const COOPERATIVE_STREAM_TURN_BUDGET_MS = 25

export interface CooperativeForEachOptions {
  budgetMs?: number
  now?: () => number
  schedule?: (resume: () => void) => void
}

export function forEachCooperative<T>(
  items: readonly T[],
  visit: (item: T) => void,
  options: CooperativeForEachOptions = {}
): void {
  const budgetMs = options.budgetMs ?? COOPERATIVE_STREAM_TURN_BUDGET_MS
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((resume) => setImmediate(resume))
  let index = 0
  const pump = (): void => {
    const started = now()
    while (index < items.length) {
      visit(items[index])
      index += 1
      if (index < items.length && now() - started >= budgetMs) {
        schedule(pump)
        return
      }
    }
  }
  pump()
}
