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
  return ENSEMBLE_FANOUT_POLICIES.has(value as EnsembleFanoutPolicy)
    ? (value as EnsembleFanoutPolicy)
    : legacyEnabled
      ? 'read_only'
      : 'off'
}

export function ensembleFanoutPolicyEnabled(policy: EnsembleFanoutPolicy): boolean {
  return policy !== 'off'
}
