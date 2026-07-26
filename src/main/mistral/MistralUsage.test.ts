import { describe, expect, it } from 'vitest'
import { TOKEN_COUNT_CONFIDENCE_KEY, TOKEN_COUNT_ESTIMATED } from '../../shared/tokenEstimate'
import { estimateMistralTokenUsage, mistralModelRate } from './MistralUsage'

describe('mistralModelRate', () => {
  it('prices the two seat models from the CLI-bundled catalogue', () => {
    expect(mistralModelRate('devstral-small')).toEqual({
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.3
    })
    expect(mistralModelRate('mistral-medium-3.5')).toEqual({
      inputUsdPerMillion: 1.5,
      outputUsdPerMillion: 7.5
    })
  })

  it('prices an unknown model at the EXPENSIVE end, not the cheap one', () => {
    // The quota meter is the only signal a user has about plan burn (Mistral
    // publishes no numeric budget and no usage endpoint). Over-reporting makes
    // a user cautious; under-reporting walks them into the wall the meter
    // exists to prevent. This is also a deliberate departure from the
    // `resolveModelRate` fallback elsewhere in the codebase, whose `models[0]`
    // default silently mis-prices a missing row as whichever model sorts first.
    expect(mistralModelRate('some-future-mistral-model')).toEqual({
      inputUsdPerMillion: 1.5,
      outputUsdPerMillion: 7.5
    })
    expect(mistralModelRate('')).toEqual({ inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 })
    expect(mistralModelRate(null)).toEqual({ inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 })
  })

  it('is case- and whitespace-insensitive', () => {
    expect(mistralModelRate('  DEVSTRAL-SMALL ')).toEqual({
      inputUsdPerMillion: 0.1,
      outputUsdPerMillion: 0.3
    })
  })
})

describe('estimateMistralTokenUsage', () => {
  const prompt = 'x'.repeat(40_000)
  const response = 'y'.repeat(20_000)

  it('tags the projection as estimated, never metered truth', () => {
    const usage = estimateMistralTokenUsage('devstral-small', prompt, response)
    expect(usage[TOKEN_COUNT_CONFIDENCE_KEY]).toBe(TOKEN_COUNT_ESTIMATED)
  })

  it('totals input and output', () => {
    const usage = estimateMistralTokenUsage('devstral-small', prompt, response)
    expect(usage.input_tokens).toBeGreaterThan(0)
    expect(usage.output_tokens).toBeGreaterThan(0)
    expect(usage.total_tokens).toBe(usage.input_tokens + usage.output_tokens)
  })

  it('prices the same turn very differently per model', () => {
    // The whole reason this module is not a copy of GrokUsage's flat constants:
    // the two seat models are 15x apart on input and 25x apart on output, so a
    // single rate would be wrong by more than an order of magnitude.
    const cheap = estimateMistralTokenUsage('devstral-small', prompt, response)
    const flagship = estimateMistralTokenUsage('mistral-medium-3.5', prompt, response)
    expect(cheap.total_tokens).toBe(flagship.total_tokens)
    expect(flagship.total_cost_usd).toBeGreaterThan(cheap.total_cost_usd * 10)
  })

  it('counts streamed thinking/tool chars as output', () => {
    const without = estimateMistralTokenUsage('devstral-small', prompt, response)
    const with_ = estimateMistralTokenUsage('devstral-small', prompt, response, 20_000)
    expect(with_.output_tokens).toBeGreaterThan(without.output_tokens)
    expect(with_.total_cost_usd).toBeGreaterThan(without.total_cost_usd)
  })

  it('ignores a negative extra-char count rather than crediting cost back', () => {
    const base = estimateMistralTokenUsage('devstral-small', prompt, response)
    const negative = estimateMistralTokenUsage('devstral-small', prompt, response, -5_000)
    expect(negative.output_tokens).toBe(base.output_tokens)
  })

  it('handles an empty turn without producing NaN', () => {
    const usage = estimateMistralTokenUsage('devstral-small', undefined, undefined)
    expect(usage.input_tokens).toBe(0)
    expect(usage.output_tokens).toBe(0)
    expect(usage.total_cost_usd).toBe(0)
    expect(Number.isNaN(usage.total_cost_usd)).toBe(false)
  })
})
