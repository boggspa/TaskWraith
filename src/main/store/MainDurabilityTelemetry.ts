import type { MainDurabilityFlusher } from './MainDurabilityFlusher'

/** Fixed X3 gaps. Null means no production measurement was supplied. */
export const UNMEASURED_X3_COUNTERS = [
  'legacyMainFsyncs',
  'acknowledgedRevisionGapReanchors',
  'unacknowledgedRevisionGapReanchors',
  'conflictReanchors',
  'forcedSynchronousCheckpoints',
  'preparationRefusals',
  'promptWorkerDisables',
  'bytesOverCaps',
  'baselineVerifies',
  'fallbackMaterializations',
  'conflictRebasedMaterializations',
  'oversizeMaterializations',
  'conflictRecoveryRereads',
  'shadowReconcileReparses',
  'promptWorkerTimeouts',
  'orphanArtifactReclaims'
] as const

/** Additive diagnostics only. This projection never decides M5 acceptance. */
export function readMainDurabilityTelemetry(
  pool: Pick<MainDurabilityFlusher, 'ownerSnapshot'> | null
): {
  poolOwners: ReturnType<MainDurabilityFlusher['ownerSnapshot']> | null
  unmeasured: Record<(typeof UNMEASURED_X3_COUNTERS)[number], null>
} {
  return {
    poolOwners: pool?.ownerSnapshot() ?? null,
    unmeasured: Object.fromEntries(UNMEASURED_X3_COUNTERS.map((name) => [name, null])) as Record<
      (typeof UNMEASURED_X3_COUNTERS)[number],
      null
    >
  }
}
