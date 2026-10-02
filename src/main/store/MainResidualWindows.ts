import { MainDurabilityResiduals, type ResidualBaseline } from './MainDurabilityResiduals'

/** Issued baselines stay in this closure, never in renderer requests or records. */
export function createMainResidualWindows(collector: MainDurabilityResiduals) {
  let active: { id: string; baseline: ResidualBaseline } | undefined
  return {
    begin(id: string): void {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || active)
        throw new Error('Residual window unavailable')
      active = { id, baseline: collector.snapshot(id) }
    },
    end(id: string) {
      const held = active
      active = undefined
      if (!held || held.id !== id) throw new Error('Residual window identity mismatch')
      return collector.delta(held.baseline, id)
    },
    cancel(): void {
      active = undefined
    }
  }
}
