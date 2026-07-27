import { describe, expect, it } from 'vitest'
import {
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
} from './piCerebrasCompletionCap'

describe('normalizePiCerebrasMaxCompletionTokens', () => {
  it('accepts a positive whole-token cap through Pi’s bundled model maximum', () => {
    expect(normalizePiCerebrasMaxCompletionTokens(16_384)).toBe(16_384)
    expect(normalizePiCerebrasMaxCompletionTokens(PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS)).toBe(
      PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS
    )
  })

  it('rejects unset, fractional, non-finite, and out-of-range values', () => {
    for (const value of [undefined, null, 0, -1, 1.5, Infinity, NaN, 40_961, '16384']) {
      expect(normalizePiCerebrasMaxCompletionTokens(value)).toBeUndefined()
    }
  })
})
