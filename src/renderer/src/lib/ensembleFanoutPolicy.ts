import type { EnsembleFanoutPolicy } from '../../../main/store/types'

const ENSEMBLE_FANOUT_POLICIES = new Set<EnsembleFanoutPolicy>([
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
])

export function normalizeEnsembleFanoutPolicy(
  value: unknown,
  legacyEnabled?: boolean
): EnsembleFanoutPolicy {
  const recognized = ENSEMBLE_FANOUT_POLICIES.has(value as EnsembleFanoutPolicy)
    ? (value as EnsembleFanoutPolicy)
    : legacyEnabled
      ? 'all'
      : 'off'
  // Fan-out is On/Off now: On carries the old 'all' semantics, and the
  // retired 'read_only' / 'locked_writers_*' levels collapse into it.
  return recognized === 'off' ? 'off' : 'all'
}

export function ensembleFanoutPolicyEnabled(policy: EnsembleFanoutPolicy): boolean {
  return policy !== 'off'
}
