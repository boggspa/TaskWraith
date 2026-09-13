import { describe, expect, it } from 'vitest'
import {
  estimateKimiAcpTokenUsage,
  kimiAcpVisiblePayloadChars,
  kimiCostRateModel,
  KIMI_ACP_TOKEN_ESTIMATE_SOURCE
} from './KimiAcpUsage'

describe('estimateKimiAcpTokenUsage', () => {
  it('estimates the visible input and output independently at four characters per token', () => {
    expect(
      estimateKimiAcpTokenUsage({
        inputChars: 9,
        outputChars: 5,
        model: 'kimi-k2.8-preview',
        durationMs: 1234,
        totalTokenLimit: 262_144
      })
    ).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      duration_ms: 1234,
      totalTokenLimit: 262_144,
      _taskwraith_token_count_confidence: 'estimated',
      _taskwraith_usage_source: KIMI_ACP_TOKEN_ESTIMATE_SOURCE,
      _taskwraith_cost_rate_model: 'kimi-k2.8-preview'
    })
  })

  it('clamps invalid character counts and keeps estimate provenance', () => {
    const usage = estimateKimiAcpTokenUsage({
      inputChars: Number.NaN,
      outputChars: -20,
      model: 'kimi-k3',
      durationMs: Number.POSITIVE_INFINITY
    })

    expect(usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      duration_ms: 0,
      _taskwraith_token_count_confidence: 'estimated',
      _taskwraith_cost_rate_model: 'kimi-k3'
    })
  })
})

describe('kimiCostRateModel', () => {
  it('keeps each K3 route on its own rate even if a stale fast tier is supplied', () => {
    expect(kimiCostRateModel('kimi-k3', 'fast')).toBe('kimi-k3')
    expect(kimiCostRateModel('kimi-code/k3', 'fast')).toBe('kimi-k3')
    expect(kimiCostRateModel('kimi-k3-256k', 'fast')).toBe('kimi-k3-256k')
    expect(kimiCostRateModel('k3-256k', 'fast')).toBe('kimi-k3-256k')
    expect(kimiCostRateModel('kimi-code/k3-256k', 'fast')).toBe('kimi-k3-256k')
  })

  it('prices each managed route by its own id, whatever a stale serviceTier says', () => {
    // Highspeed is a model now, not a speed tier, so an explicit selection wins
    // outright: a record still carrying `fast` must not re-price the row the
    // user actually chose at Moonshot's 2x Highspeed rate.
    expect(kimiCostRateModel('kimi-k2.8-preview', 'fast')).toBe('kimi-k2.8-preview')
    expect(kimiCostRateModel('kimi-k2.7-code-highspeed', 'standard')).toBe(
      'kimi-k2.7-code-highspeed'
    )
    // The retired combined id resolves forward to the route it dispatched.
    expect(kimiCostRateModel('kimi-k2.7-code', 'standard')).toBe('kimi-k2.8-preview')
  })

  it('still honours serviceTier when the record names no known route', () => {
    // Pre-split records that stored only an upstream spelling or nothing at all
    // have no model to resolve; the tier is the last signal left.
    expect(kimiCostRateModel('', 'fast')).toBe('kimi-k2.7-code-highspeed')
    expect(kimiCostRateModel('', 'standard')).toBe('kimi-k2.8-preview')
  })
})

describe('kimiAcpVisiblePayloadChars', () => {
  it('counts strings and serialized tool payloads without retaining them', () => {
    expect(kimiAcpVisiblePayloadChars('hello')).toBe(5)
    expect(kimiAcpVisiblePayloadChars({ path: 'a.ts' })).toBe(15)
    expect(kimiAcpVisiblePayloadChars(undefined)).toBe(0)
  })
})
