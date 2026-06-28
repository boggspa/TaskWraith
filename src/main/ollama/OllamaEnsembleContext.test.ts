import { describe, expect, it } from 'vitest'
import {
  assessOllamaContextPressure,
  compactOllamaEnsemblePromptText,
  estimateOllamaEnsemblePromptTokens,
  resolveOllamaContextTokenLimit,
  resolveOllamaEnsembleTranscriptCharsForBudget
} from './OllamaEnsembleContext'

describe('OllamaEnsembleContext', () => {
  it('uses conservative defaults for unknown local models', () => {
    expect(resolveOllamaContextTokenLimit('unknown:7b')).toBe(4096)
    expect(resolveOllamaContextTokenLimit('gemma4:12b')).toBe(8192)
    expect(resolveOllamaContextTokenLimit('ornith:9b')).toBe(8192)
    expect(resolveOllamaContextTokenLimit('ornith:35b')).toBe(8192)
    expect(resolveOllamaContextTokenLimit('qwen3.6:35b')).toBe(8192)
    expect(resolveOllamaContextTokenLimit('granite4.1:30b')).toBe(8192)
    expect(resolveOllamaContextTokenLimit('nemotron3:33b')).toBe(8192)
  })

  it('shrinks transcript budget when the shell already consumes most context', () => {
    const budget = resolveOllamaEnsembleTranscriptCharsForBudget({
      configuredChars: 120_000,
      configuredTurns: 10,
      promptWithoutTranscriptChars: 7_500,
      modelId: 'qwen3.5:9b',
      toolsEnabled: true
    })
    expect(budget.contextChars).toBeLessThan(12_000)
    expect(budget.autoCompacted).toBe(true)
  })

  it('flags critical pressure near the context ceiling', () => {
    const estimated = estimateOllamaEnsemblePromptTokens({
      promptChars: 14_000,
      compactToolSchema: true,
      toolsEnabled: true
    })
    const pressure = assessOllamaContextPressure({
      estimatedPromptTokens: estimated,
      contextLimit: 4096
    })
    expect(pressure.severity).toBe('critical')
    expect(pressure.usagePercent).toBeGreaterThanOrEqual(95)
  })

  it('compacts only the tagged transcript section', () => {
    const prompt = [
      'TaskWraith Ensemble Mode',
      '',
      'Recent tagged transcript:',
      'x'.repeat(8_000),
      '',
      'Current user request:',
      'Add a smoke test.'
    ].join('\n')
    const compacted = compactOllamaEnsemblePromptText(prompt, 4_500)
    expect(compacted).toContain('Current user request:')
    expect(compacted).toContain('Add a smoke test.')
    expect(compacted).toContain('[transcript compacted for Ollama context]')
    expect(compacted.length).toBeLessThan(prompt.length)
  })
})
