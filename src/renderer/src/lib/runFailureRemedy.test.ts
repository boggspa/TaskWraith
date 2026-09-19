/**
 * runFailureRemedy tests — the marker lists are the contract: drift here and
 * real provider failures silently lose their remedy buttons.
 */

import { describe, expect, it } from 'vitest'

import {
  classifyFailureRemedy,
  describeFailureRemedyCopy,
  extractProviderFromFailureText,
  providerLoginCapability
} from './runFailureRemedy'

describe('classifyFailureRemedy', () => {
  it('classifies observed auth failures', () => {
    expect(
      classifyFailureRemedy(
        'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses'
      )
    ).toBe('auth')
    expect(classifyFailureRemedy('token_revoked: invalidated oauth token')).toBe('auth')
    expect(classifyFailureRemedy('Not logged in. Please run /login')).toBe('auth')
    expect(classifyFailureRemedy('Error: status 401 Unauthorized')).toBe('auth')
    expect(classifyFailureRemedy('invalid_api_key')).toBe('auth')
  })

  it('classifies observed usage-limit failures', () => {
    expect(classifyFailureRemedy("You've hit your usage limit.")).toBe('usage-limit')
    expect(classifyFailureRemedy('insufficient_quota: quota exceeded')).toBe('usage-limit')
    expect(classifyFailureRemedy('Error code: 429 - too many requests')).toBe('usage-limit')
    expect(classifyFailureRemedy('no capacity available for model')).toBe('usage-limit')
    expect(classifyFailureRemedy('rate_limit_reached_error')).toBe('usage-limit')
  })

  it('lets auth win when both families match', () => {
    expect(classifyFailureRemedy('403 Forbidden while checking quota')).toBe('auth')
  })

  it('returns null for neutral and empty text', () => {
    expect(classifyFailureRemedy('')).toBeNull()
    expect(classifyFailureRemedy('Error: socket hang up')).toBeNull()
  })

  it('classifies retired models to their own family', () => {
    expect(
      classifyFailureRemedy(
        'gpt-5.3-codex-spark was retired on 2026-09-18. Choose an active Codex model to continue.'
      )
    ).toBe('model-retired')
    expect(classifyFailureRemedy('This model is deprecated')).toBe('model-retired')
  })

  it('classifies dispatch and network failures', () => {
    expect(
      classifyFailureRemedy('Codex failed. [participant-health] ⚠ Codex / Codex dispatch failed.')
    ).toBe('dispatch')
    expect(classifyFailureRemedy('connect ECONNREFUSED 127.0.0.1:11434')).toBe('network')
    expect(classifyFailureRemedy('spawn codex ENOENT')).toBe('missing-cli')
  })
})

describe('describeFailureRemedyCopy', () => {
  it('voices the seat surface with the seat name', () => {
    const copy = describeFailureRemedyCopy('model-retired', {
      subject: 'Review 1',
      providerLabel: 'Grok',
      surface: 'seat'
    })
    expect(copy.title).toBe('Review 1’s model was retired')
    expect(copy.note).toContain('Grok')
  })

  it('voices the run surface with run-level guidance', () => {
    const copy = describeFailureRemedyCopy('dispatch', {
      subject: 'The run',
      surface: 'run'
    })
    expect(copy.title).toBe('The run couldn’t start')
    expect(copy.body).toContain('Nothing was sent')
  })
})

describe('extractProviderFromFailureText', () => {
  it('reads the Failed-to-start label prefix back to a provider id', () => {
    expect(extractProviderFromFailureText('Failed to start Codex: Error: 401 Unauthorized')).toBe(
      'codex'
    )
    expect(extractProviderFromFailureText('Failed to start Mistral: boom')).toBe('mistral')
  })

  it('stays unidentified without the prefix', () => {
    expect(
      extractProviderFromFailureText('Run execution failed unexpectedly: Error: 401')
    ).toBeUndefined()
  })
})

describe('providerLoginCapability', () => {
  it('maps providers to their login lane', () => {
    expect(providerLoginCapability('codex')).toBe('terminal')
    expect(providerLoginCapability('grok')).toBe('terminal')
    expect(providerLoginCapability('gemini')).toBe('oauth')
    expect(providerLoginCapability('pi')).toBe('api-key-only')
  })
})
