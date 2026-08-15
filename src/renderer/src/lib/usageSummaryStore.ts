import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { ModelUsageAggregate } from './usageAggregateTypes'
import { fingerprintUsageSummary } from './usageRefresh'

type UsageSummaryListener = () => void

const EMPTY_USAGE_SUMMARY: ModelUsageAggregate[] = []
export const UsageSummaryStoreContext = createContext<UsageSummaryStore | null>(null)

/**
 * App-instance-owned usage telemetry. Publishing wakes only components that
 * render usage data; App itself deliberately reads this store without
 * subscribing so a sidebar heartbeat cannot rebuild the primary view.
 */
export class UsageSummaryStore {
  private snapshot: ModelUsageAggregate[] = EMPTY_USAGE_SUMMARY
  private signature = fingerprintUsageSummary(EMPTY_USAGE_SUMMARY)
  private readonly listeners = new Set<UsageSummaryListener>()

  getSnapshot = (): ModelUsageAggregate[] => this.snapshot

  subscribe = (listener: UsageSummaryListener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(next: ModelUsageAggregate[], options: { force?: boolean } = {}): boolean {
    const nextSignature = fingerprintUsageSummary(next)
    if (options.force !== true && nextSignature === this.signature) return false
    this.snapshot = next
    this.signature = nextSignature
    for (const listener of Array.from(this.listeners)) listener()
    return true
  }
}

/**
 * Prefer the nearest App-owned store, with a direct prop as a compatibility
 * fallback for standalone surfaces and static component tests.
 */
export function useUsageSummary(
  fallback: ModelUsageAggregate[] = EMPTY_USAGE_SUMMARY
): ModelUsageAggregate[] {
  const store = useContext(UsageSummaryStoreContext)
  const subscribe = useCallback(
    (listener: UsageSummaryListener) => store?.subscribe(listener) ?? (() => undefined),
    [store]
  )
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? fallback, [fallback, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
