import type { MainDurabilityRuntime } from '../store/MainDurabilityRuntime'

/** Read the measured child's environment, never the runner's requested flags. */
export function actualMainDurabilityPerf(
  runtime: Pick<MainDurabilityRuntime, 'snapshot'> | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const flags = Object.fromEntries(
    ['TASKWRAITH_RUN_EVENT_FLUSHER', 'TASKWRAITH_JOURNAL_FLUSHER'].map((name) => [
      name,
      { token: env[name] ?? null, enabled: env[name] === '1' }
    ])
  )
  return {
    schemaVersion: 1,
    flags,
    sharedPool: runtime?.snapshot() ?? null,
    // Pool totals span both owners and omit legacy fsync paths. They cannot
    // stand in for measured per-owner fsyncs or the complete X3 fallback list.
    mainFsyncsByOwner: null,
    unmeasured: ['main_fsyncs_by_owner', 'complete_x3_fallback_counters']
  }
}
