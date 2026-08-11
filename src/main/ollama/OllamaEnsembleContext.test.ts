import { describe, expect, it } from 'vitest'
import {
  assessOllamaContextPressure,
  compactOllamaEnsemblePromptText,
  estimateOllamaEnsemblePromptTokens,
  estimateOllamaEnsembleUiPressure,
  estimateWorstOllamaEnsembleUiPressure,
  hasKnownOllamaContextTokenLimit,
  resolveOllamaContextTokenLimit,
  resolveOllamaEnsemblePromptShellChars,
  resolveOllamaEnsembleTranscriptCharsForBudget
} from './OllamaEnsembleContext'

describe('OllamaEnsembleContext', () => {
  it('uses the shared Ollama context windows instead of tiny provider-level fallbacks', () => {
    expect(resolveOllamaContextTokenLimit()).toBe(4096)
    expect(resolveOllamaContextTokenLimit('unknown:7b')).toBe(4096)
    expect(resolveOllamaContextTokenLimit('qwen3:4b-instruct')).toBe(262_144)
    expect(resolveOllamaContextTokenLimit('gemma4:12b')).toBe(262_144)
    expect(resolveOllamaContextTokenLimit('ornith:9b')).toBe(262_144)
    expect(resolveOllamaContextTokenLimit('ornith:35b')).toBe(262_144)
    expect(resolveOllamaContextTokenLimit('qwen3.6:35b')).toBe(262_144)
    expect(resolveOllamaContextTokenLimit('laguna-xs-2.1:q8_0')).toBe(262_144)
    expect(resolveOllamaContextTokenLimit('gpt-oss:20b')).toBe(131_072)
    // A round 128k, not 128Ki — corrected against the daemon 2026-07-30.
    expect(resolveOllamaContextTokenLimit('lfm2.5:8b')).toBe(128_000)
    expect(resolveOllamaContextTokenLimit('minicpm-v4.5:8b')).toBe(40_960)
    expect(resolveOllamaContextTokenLimit('granite4.1:30b')).toBe(131_072)
    expect(resolveOllamaContextTokenLimit('nemotron3:33b')).toBe(131_072)
    expect(resolveOllamaContextTokenLimit('llama3.1:8b')).toBe(131_072)
    expect(resolveOllamaContextTokenLimit('deepseek-r1:8b')).toBe(131_072)
    expect(resolveOllamaContextTokenLimit('rnj-1')).toBe(32_768)
    expect(resolveOllamaContextTokenLimit('glm-4.7-flash:q4_K_M')).toBe(202_752)
    expect(resolveOllamaContextTokenLimit('north-mini-code-1.0:q4_K_M')).toBe(500_000)
    expect(resolveOllamaContextTokenLimit('muse-glimmer:30b-mlx')).toBe(131_072)
    expect(resolveOllamaContextTokenLimit('llama3.2:3b')).toBe(131_072)
    expect(resolveOllamaContextTokenLimit('custom-local', 300_000)).toBe(300_000)
  })

  it('distinguishes unknown metadata from a genuinely small live context', () => {
    expect(hasKnownOllamaContextTokenLimit('unknown:7b')).toBe(false)
    expect(hasKnownOllamaContextTokenLimit('unknown:7b', 8192)).toBe(true)
    expect(hasKnownOllamaContextTokenLimit('ornith:35b')).toBe(true)
    expect(hasKnownOllamaContextTokenLimit('laguna-xs-2.1:q8_0')).toBe(true)
    expect(hasKnownOllamaContextTokenLimit('lfm2.5:8b')).toBe(true)
    for (const modelId of [
      'llama3.1:8b',
      'deepseek-r1:8b',
      'rnj-1',
      'glm-4.7-flash:q4_K_M',
      'north-mini-code-1.0:q4_K_M',
      'muse-glimmer:30b-mlx',
      'llama3.2:3b'
    ]) {
      expect(hasKnownOllamaContextTokenLimit(modelId)).toBe(true)
    }
  })

  it('keeps the default shared-history budget for known large-context Ollama models', () => {
    const budget = resolveOllamaEnsembleTranscriptCharsForBudget({
      configuredChars: 24_000,
      configuredTurns: 6,
      promptWithoutTranscriptChars: 7_500,
      modelId: 'qwen3:4b-instruct',
      toolsEnabled: true
    })
    expect(budget).toEqual({
      contextChars: 24_000,
      contextTurns: 6,
      autoCompacted: false
    })
  })

  it('shrinks transcript budget when the shell already consumes most of a small live context', () => {
    const budget = resolveOllamaEnsembleTranscriptCharsForBudget({
      configuredChars: 120_000,
      configuredTurns: 10,
      promptWithoutTranscriptChars: 7_500,
      modelId: 'qwen3.5:9b',
      contextLength: 8192,
      toolsEnabled: true
    })
    expect(budget.contextChars).toBeLessThan(16_000)
    expect(budget.autoCompacted).toBe(true)
  })

  it('does not show critical UI pressure for a 24K panel on a 262K local model', () => {
    const pressure = estimateOllamaEnsembleUiPressure({
      configuredContextChars: 24_000,
      participantCount: 6,
      ollamaModelId: 'qwen3:4b-instruct',
      ollamaContextLength: 262_144,
      toolsEnabled: true
    })
    expect(pressure.contextLimit).toBe(262_144)
    expect(pressure.effectiveTranscriptChars).toBe(24_000)
    expect(pressure.severity).toBe('ok')
  })

  it('uses the tightest Ollama participant when estimating UI pressure', () => {
    const pressure = estimateWorstOllamaEnsembleUiPressure({
      configuredContextChars: 24_000,
      participantCount: 6,
      ollamaParticipants: [
        { modelId: 'qwen3:4b-instruct', ollamaContextLength: 262_144 },
        { modelId: 'unknown-local:latest', ollamaContextLength: 4096 }
      ],
      toolsEnabled: true
    })
    expect(pressure?.contextLimit).toBe(4096)
    expect(pressure?.severity).toBe('critical')
    expect(pressure?.effectiveTranscriptChars).toBeLessThan(24_000)
  })

  it('does not treat missing context metadata for an unknown local tag as UI pressure', () => {
    const pressure = estimateWorstOllamaEnsembleUiPressure({
      configuredContextChars: 24_000,
      participantCount: 6,
      ollamaParticipants: [{ modelId: 'custom-local:latest' }],
      toolsEnabled: true
    })
    expect(pressure).toBeNull()
  })

  it('still warns when an unknown local tag reports a small live context', () => {
    const pressure = estimateWorstOllamaEnsembleUiPressure({
      configuredContextChars: 24_000,
      participantCount: 6,
      ollamaParticipants: [{ modelId: 'custom-local:latest', ollamaContextLength: 4096 }],
      toolsEnabled: true
    })
    expect(pressure?.contextKnown).toBe(true)
    expect(pressure?.severity).toBe('critical')
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

  it('preserves ensemble role and authority instructions when compacting transcripts', () => {
    const prompt = [
      'TaskWraith Ensemble Mode',
      '',
      'Role boundary contract:',
      '- Treat your role (LeadBoss / Codex) and your role instructions as your ownership boundary.',
      '- Authority rule: Bossman routing takes priority over advisory mentions.',
      '',
      'Recent tagged transcript:',
      'historical turn\n'.repeat(1_000),
      '',
      'Current user request:',
      'Continue the Plan Mode arc.'
    ].join('\n')
    const compacted = compactOllamaEnsemblePromptText(prompt, 4_500)

    expect(compacted).toContain('TaskWraith Ensemble Mode')
    expect(compacted).toContain('Role boundary contract:')
    expect(compacted).toContain('LeadBoss / Codex')
    expect(compacted).toContain('Bossman routing')
    expect(compacted).toContain('Current user request:')
    expect(compacted).toContain('Continue the Plan Mode arc.')
    expect(compacted).toContain('[transcript compacted for Ollama context]')
  })

  it('capsule-shaped over-budget prompt keeps the Current user request body', () => {
    const requestBody =
      'Ship request-preserving compaction so locals never lose the ask under panel noise.'
    const prompt = [
      'TaskWraith Ensemble Mode — Ollama context capsule',
      '',
      'Current user request:',
      requestBody,
      '',
      'You are a LOCAL model running through Ollama (ornith). You are Scout / ornith.',
      'Round id: round-capsule-1',
      'Participant roster:',
      '- Scout / ornith',
      '- Boss / Codex',
      '',
      'Do this turn:',
      '- Act on the Current user request above as your role.',
      '',
      'Recent panel context:',
      'panel-history\n'.repeat(800),
      '',
      'Respond now as [Scout / ornith].'
    ].join('\n')

    const compacted = compactOllamaEnsemblePromptText(prompt, 3_200)

    expect(compacted).toContain('Current user request:')
    expect(compacted).toContain(requestBody)
    expect(compacted).toContain('Respond now as [Scout / ornith].')
    expect(compacted).toMatch(/\[(?:panel context|transcript) compacted for Ollama context\]/)
    expect(compacted.length).toBeLessThan(prompt.length)
    expect(compacted.length).toBeLessThanOrEqual(3_200 + 80)
  })

  it('fallback compaction pins the request block instead of bare head-slicing through it', () => {
    const requestBody = 'UNIQUE_REQUEST_BODY_MUST_SURVIVE_COMPACTION_xyz'
    const prompt = [
      'TaskWraith Ensemble Mode',
      'x'.repeat(2_000),
      '',
      'Current user request:',
      requestBody,
      '',
      'You are a LOCAL model running through Ollama.',
      'y'.repeat(2_000)
    ].join('\n')

    const compacted = compactOllamaEnsemblePromptText(prompt, 1_200)

    expect(compacted).toContain('Current user request:')
    expect(compacted).toContain(requestBody)
    expect(compacted).not.toBe(
      `${prompt.slice(0, Math.max(0, 1_200 - 48))}\n[ensemble prompt compacted for Ollama context]`
    )
  })

  it('resolves shellChars from Recent panel context before tagged transcript', () => {
    const prompt = [
      'prefix shell',
      '',
      'Current user request:',
      'Do the thing.',
      '',
      'Recent panel context:',
      'panel'
    ].join('\n')
    expect(resolveOllamaEnsemblePromptShellChars(prompt)).toBe(prompt.indexOf('Recent panel context:'))
  })

  it('resolves shellChars carefully when neither transcript header is present', () => {
    const prompt = ['rules shell\n\n', 'Current user request:', 'Ask me.'].join('\n')
    expect(resolveOllamaEnsemblePromptShellChars(prompt)).toBe(prompt.indexOf('Current user request:'))
    expect(resolveOllamaEnsemblePromptShellChars('no markers at all')).toBe(5_800)
  })
})
