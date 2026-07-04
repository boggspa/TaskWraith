import { describe, expect, it } from 'vitest'
import {
  ensembleFanoutPolicyEnabled,
  normalizeEnsembleFanoutPolicy
} from './ensembleFanoutPolicy'

describe('ensembleFanoutPolicy', () => {
  it('accepts known fanout policies', () => {
    for (const policy of [
      'off',
      'read_only',
      'all',
      'locked_writers_with_boss',
      'locked_writers_user_preflight'
    ] as const) {
      expect(normalizeEnsembleFanoutPolicy(policy)).toBe(policy)
    }
  })

  it('falls back to read_only when legacy concurrent mode is enabled', () => {
    expect(normalizeEnsembleFanoutPolicy(undefined, true)).toBe('read_only')
    expect(normalizeEnsembleFanoutPolicy('bogus', true)).toBe('read_only')
  })

  it('falls back to off when legacy concurrent mode is disabled', () => {
    expect(normalizeEnsembleFanoutPolicy(undefined)).toBe('off')
    expect(normalizeEnsembleFanoutPolicy(undefined, false)).toBe('off')
    expect(normalizeEnsembleFanoutPolicy('bogus')).toBe('off')
    expect(normalizeEnsembleFanoutPolicy('bogus', false)).toBe('off')
  })

  it('reports whether concurrent fanout is enabled', () => {
    expect(ensembleFanoutPolicyEnabled('off')).toBe(false)
    expect(ensembleFanoutPolicyEnabled('read_only')).toBe(true)
    expect(ensembleFanoutPolicyEnabled('all')).toBe(true)
    expect(ensembleFanoutPolicyEnabled('locked_writers_with_boss')).toBe(true)
    expect(ensembleFanoutPolicyEnabled('locked_writers_user_preflight')).toBe(true)
  })
})
