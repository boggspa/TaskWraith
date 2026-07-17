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
        model: 'kimi-k2.7-code',
        durationMs: 1234
      })
    ).toEqual({
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      duration_ms: 1234,
      _taskwraith_token_count_confidence: 'estimated',
      _taskwraith_usage_source: KIMI_ACP_TOKEN_ESTIMATE_SOURCE,
      _taskwraith_cost_rate_model: 'kimi-k2.7-code'
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
  it('keeps K3 on its own rate even if a stale fast tier is supplied', () => {
    expect(kimiCostRateModel('kimi-k3', 'fast')).toBe('kimi-k3')
    expect(kimiCostRateModel('kimi-code/k3', 'fast')).toBe('kimi-k3')
  })

  it('maps K2.7 fast mode to the published Highspeed pricing row', () => {
    expect(kimiCostRateModel('kimi-k2.7-code', 'fast')).toBe(
      'kimi-k2.7-code-highspeed'
    )
    expect(kimiCostRateModel('kimi-k2.7-code', 'standard')).toBe('kimi-k2.7-code')
  })
})

describe('kimiAcpVisiblePayloadChars', () => {
  it('counts strings and serialized tool payloads without retaining them', () => {
    expect(kimiAcpVisiblePayloadChars('hello')).toBe(5)
    expect(kimiAcpVisiblePayloadChars({ path: 'a.ts' })).toBe(15)
    expect(kimiAcpVisiblePayloadChars(undefined)).toBe(0)
  })
})
