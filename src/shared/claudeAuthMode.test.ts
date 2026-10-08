import { describe, expect, it } from 'vitest'
import { isClaudeAuthMode, resolveClaudeRunLane } from './claudeAuthMode'

describe('resolveClaudeRunLane', () => {
  it('keeps a stored key inert once the subscription is chosen', () => {
    expect(resolveClaudeRunLane({ claudeAuthMode: 'subscription', apiKeyConfigured: true })).toBe(
      'subscription'
    )
  })

  it('runs on the key only when one is stored, otherwise falls back to the subscription', () => {
    expect(resolveClaudeRunLane({ claudeAuthMode: 'api-key', apiKeyConfigured: true })).toBe(
      'api-key'
    )
    expect(resolveClaudeRunLane({ claudeAuthMode: 'api-key', apiKeyConfigured: false })).toBe(
      'subscription'
    )
  })

  it('preserves the pre-setting behaviour when no choice is recorded: a stored key wins', () => {
    expect(resolveClaudeRunLane({ apiKeyConfigured: true })).toBe('api-key')
    expect(resolveClaudeRunLane({ claudeAuthMode: null, apiKeyConfigured: true })).toBe('api-key')
    expect(resolveClaudeRunLane({ apiKeyConfigured: false })).toBe('subscription')
  })

  it('recognises only the two modes', () => {
    expect(isClaudeAuthMode('subscription')).toBe(true)
    expect(isClaudeAuthMode('api-key')).toBe(true)
    expect(isClaudeAuthMode('oauth')).toBe(false)
    expect(isClaudeAuthMode(undefined)).toBe(false)
  })
})
