import { performance } from 'node:perf_hooks'

export interface MainPerfClock {
  clockId: string
  identity: string
  provenance: 'node-performance-now' | 'injected-unverified' | 'injected-monotonic'
  nowMs(): number
}

/** Identity distinguishes process time origins; it is not a profile anchor. */
export const productionMainPerfClock: MainPerfClock = {
  clockId: 'node.performance.now',
  identity: `main:${process.pid}:performance.timeOrigin:${performance.timeOrigin}`,
  provenance: 'node-performance-now',
  nowMs: () => performance.now()
}

export function resolveMainPerfClock(
  clock?: MainPerfClock,
  legacyNow?: () => number
): MainPerfClock {
  if (clock) return clock
  if (legacyNow)
    return {
      clockId: 'injected.nowMs',
      identity: 'unverified',
      provenance: 'injected-unverified',
      nowMs: legacyNow
    }
  return productionMainPerfClock
}

/** Only a measured same-clock anchor may map inspector profile microseconds. */
export function profileUsToMonotonicMs(
  profileUs: number,
  clock: MainPerfClock,
  anchor: {
    clockId: string
    identity: string
    profileUs: number
    monotonicMs: number
    measured: boolean
  }
): number | null {
  if (
    clock.provenance === 'injected-unverified' ||
    !anchor.measured ||
    anchor.clockId !== clock.clockId ||
    anchor.identity !== clock.identity ||
    ![profileUs, anchor.profileUs, anchor.monotonicMs].every(
      (value) => Number.isFinite(value) && value >= 0
    )
  )
    return null
  const mapped = anchor.monotonicMs + (profileUs - anchor.profileUs) / 1000
  return Number.isFinite(mapped) && mapped >= 0 ? mapped : null
}
