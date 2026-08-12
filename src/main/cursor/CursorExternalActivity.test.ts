import { describe, expect, it } from 'vitest'
import { CURSOR_GROK_46_WIRE_MODEL_IDS } from '../../shared/grok45Models'
import {
  cursorExternalCostRateModelId,
  estimateTokensFromText,
  inferCursorModelFromText,
  isCursorSandboxProjectDir,
  normalizeCursorExternalModelId,
  parseCursorAgentTranscript,
  parseCursorBubbleValue,
  parseCursorDailyStatsValue
} from './CursorExternalActivity'

describe('normalizeCursorExternalModelId', () => {
  it('maps display labels and ids to canonical Composer ids', () => {
    expect(normalizeCursorExternalModelId('Composer 2.5 Fast')).toBe('composer-2.5-fast')
    expect(normalizeCursorExternalModelId('composer-2.5')).toBe('composer-2.5')
    expect(normalizeCursorExternalModelId('cursor')).toBe('composer-2.5-fast')
  })

  it('collapses every exact Cursor Grok 4.6 variant to its catalogue base id', () => {
    for (const modelId of CURSOR_GROK_46_WIRE_MODEL_IDS) {
      expect(normalizeCursorExternalModelId(modelId)).toBe('grok-4.6')
      expect(cursorExternalCostRateModelId(modelId)).toBe(
        modelId.endsWith('-fast') ? 'grok-4.6-fast' : 'grok-4.6'
      )
    }
    for (const label of [
      'Cursor Grok 4.6 Low',
      'Cursor Grok 4.6 Low Fast',
      'Cursor Grok 4.6 Medium',
      'Cursor Grok 4.6 Medium Fast',
      'Cursor Grok 4.6',
      'Cursor Grok 4.6 Fast',
      'Cursor Grok 4.6 Extra High',
      'Cursor Grok 4.6 Extra High Fast'
    ]) {
      expect(normalizeCursorExternalModelId(label)).toBe('grok-4.6')
    }
    expect(normalizeCursorExternalModelId('grok-4.5-fast-xhigh')).toBe('grok-4.5')
  })
})

describe('parseCursorAgentTranscript', () => {
  it('estimates tokens from user and assistant transcript text', () => {
    const text = [
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: 'a'.repeat(400) }] }
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'b'.repeat(200) }] }
      })
    ].join('\n')

    const parsed = parseCursorAgentTranscript(
      '/Users/me/.cursor/projects/Users-me/agent-transcripts/abc/abc.jsonl',
      text,
      Date.parse('2026-06-13T12:00:00.000Z')
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.inputTokens).toBe(100)
    expect(parsed!.outputTokens).toBe(50)
    expect(parsed!.inputTokens + parsed!.outputTokens).toBe(150)
    expect(parsed!.composerId).toBe('abc')
  })

  it('skips TaskWraith sandbox project transcripts', () => {
    const text = JSON.stringify({
      role: 'user',
      message: { content: [{ type: 'text', text: 'hello world' }] }
    })
    expect(
      parseCursorAgentTranscript(
        '/Users/me/.cursor/projects/tmp-agbench-mcp-test/agent-transcripts/abc/abc.jsonl',
        text,
        Date.now()
      )
    ).toBeNull()
  })

  it('infers Composer 2.5 (non-fast) from transcript text', () => {
    const text = JSON.stringify({
      role: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Running on composer-2.5 for this workspace.' }]
      }
    })
    const parsed = parseCursorAgentTranscript(
      '/Users/me/.cursor/projects/Users-me/agent-transcripts/abc/abc.jsonl',
      text,
      Date.now()
    )
    expect(parsed?.model).toBe('composer-2.5')
  })

  it('keeps Grok 4.6 Fast billing separate from its normalized transcript display model', () => {
    const text = JSON.stringify({
      role: 'assistant',
      message: { content: [{ type: 'text', text: 'completed' }] }
    })
    const parsed = parseCursorAgentTranscript(
      '/Users/me/.cursor/projects/Users-me/agent-transcripts/abc/abc.jsonl',
      text,
      Date.now(),
      'cursor-grok-4.6-xhigh-fast'
    )
    expect(parsed).toMatchObject({
      model: 'grok-4.6',
      costRateModel: 'grok-4.6-fast'
    })
  })

  it('infers an exact Fast wire id from transcript text without changing its display model', () => {
    const text = JSON.stringify({
      role: 'assistant',
      message: {
        content: [{ type: 'text', text: 'active model: cursor-grok-4.6-low-fast' }]
      }
    })
    const parsed = parseCursorAgentTranscript(
      '/Users/me/.cursor/projects/Users-me/agent-transcripts/abc/abc.jsonl',
      text,
      Date.now()
    )
    expect(parsed).toMatchObject({
      model: 'grok-4.6',
      costRateModel: 'grok-4.6-fast'
    })
  })
})

describe('parseCursorDailyStatsValue', () => {
  it('converts composer line counts into estimated tokens', () => {
    const event = parseCursorDailyStatsValue(
      {
        date: '2026-06-13',
        composerSuggestedLines: 100,
        composerAcceptedLines: 50
      },
      'cursor-ide-daily:2026-06-13'
    )
    expect(event?.totalTokens).toBe(6000)
    expect(event?.model).toBe('composer-2.5-fast')
  })
})

describe('parseCursorBubbleValue', () => {
  it('reads real per-bubble token counts when Cursor populates them', () => {
    const event = parseCursorBubbleValue(
      {
        createdAt: '2026-06-13T10:00:00.000Z',
        tokenCount: { inputTokens: 1200, outputTokens: 300 },
        modelInfo: { modelName: 'Composer 2.5 Fast' }
      },
      'cursor-ide-bubble:test'
    )
    expect(event?.totalTokens).toBe(1500)
    expect(event?.model).toBe('composer-2.5-fast')
  })

  it('groups Cursor Grok 4.6 bubbles under one row while retaining Fast billing', () => {
    const event = parseCursorBubbleValue(
      {
        createdAt: '2026-08-12T10:00:00.000Z',
        tokenCount: { inputTokens: 1200, outputTokens: 300 },
        modelInfo: { modelName: 'cursor-grok-4.6-high-fast' }
      },
      'cursor-ide-bubble:grok-46'
    )
    expect(event).toMatchObject({
      model: 'grok-4.6',
      costRateModel: 'grok-4.6-fast'
    })
  })
})

describe('helpers', () => {
  it('flags sandbox project dirs', () => {
    expect(isCursorSandboxProjectDir('tmp-agbench-mcp-test')).toBe(true)
    expect(isCursorSandboxProjectDir('Users-chrisizatt-Documents-AGBench')).toBe(false)
  })

  it('estimates tokens from char length', () => {
    expect(estimateTokensFromText('abcd')).toBe(1)
    expect(estimateTokensFromText('a'.repeat(40))).toBe(10)
  })

  it('infers model names from free text', () => {
    expect(inferCursorModelFromText('using Cursor Grok 4.6 Extra High Fast')).toBe('grok-4.6')
    expect(inferCursorModelFromText('use composer-2.5-fast here')).toBe('composer-2.5-fast')
    expect(inferCursorModelFromText('switch to Composer 2.5 mode')).toBe('composer-2.5')
  })
})
