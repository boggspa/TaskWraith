import { describe, expect, it } from 'vitest'
import { ensembleFanoutPolicyEnabled, normalizeEnsembleFanoutPolicy } from './ensembleFanoutPolicy'

describe('ensembleFanoutPolicy', () => {
  it('collapses every enabled policy to all (fan-out is On/Off now)', () => {
    expect(normalizeEnsembleFanoutPolicy('off')).toBe('off')
    for (const legacy of [
      'read_only',
      'all',
      'locked_writers_with_boss',
      'locked_writers_user_preflight'
    ] as const) {
      expect(normalizeEnsembleFanoutPolicy(legacy)).toBe('all')
    }
  })

  it('maps the legacy concurrent boolean to all when enabled', () => {
    expect(normalizeEnsembleFanoutPolicy(undefined, true)).toBe('all')
    expect(normalizeEnsembleFanoutPolicy('bogus', true)).toBe('all')
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
