/** Env-backed runtime gates shared by main + renderer snapshots. */

export type RuntimeFeatureGateEnv = Record<string, string | undefined>

export interface RuntimeFeatureGateSnapshot {
  concurrentLanes: boolean
  concurrentWriteLanes: boolean
}

function envFlagEnabled(
  env: RuntimeFeatureGateEnv | undefined,
  key: string,
  defaultEnabled: boolean
): boolean {
  const value = env?.[key]
  if (value === '0' || value === 'false' || value === 'no') return false
  if (value === '1' || value === 'true' || value === 'yes') return true
  return defaultEnabled
}

export function buildRuntimeFeatureGateSnapshot(
  env: RuntimeFeatureGateEnv | undefined = undefined
): RuntimeFeatureGateSnapshot {
  return {
    concurrentLanes: envFlagEnabled(env, 'TASKWRAITH_CONCURRENT_LANES', true),
    concurrentWriteLanes: envFlagEnabled(env, 'TASKWRAITH_CONCURRENT_WRITE_LANES', true)
  }
}
