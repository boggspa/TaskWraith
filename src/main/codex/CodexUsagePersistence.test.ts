import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
import {
  codexUsageResponseText,
  mergeCodexExecUsageJsonLines,
  recordCodexUsageOnCompletion
} from './CodexUsagePersistence'

function chat(scope: 'workspace' | 'global' = 'workspace'): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    title: 'Codex',
    provider: 'codex',
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    scope,
    chatKind: 'single',
    archived: false,
    ...(scope === 'workspace' ? { workspaceId: 'ws-1', workspacePath: '/repo' } : {})
  } as ChatRecord
}

describe('recordCodexUsageOnCompletion', () => {
  it('durably records once and marks terminal stats so the renderer skips its fallback', () => {
    const recordUsage = vi.fn()
    const result = recordCodexUsageOnCompletion({
      chat: chat(),
      runId: 'run-1',
      model: 'gpt-5.6',
      stats: {
        input_tokens: 100,
        cache_read_input_tokens: 40,
        output_tokens: 20,
        total_tokens: 120,
        duration_ms: 500
      },
      fallbackDurationMs: 750,
      promptText: 'Safe display prompt',
      responseText: 'Final response',
      recordUsage
    })

    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        workspaceId: 'ws-1',
        chatId: 'chat-1',
        runId: 'run-1',
        model: 'gpt-5.6',
        totalTokens: 120,
        durationMs: 500,
        promptText: 'Safe display prompt',
        responseText: 'Final response'
      })
    )
    expect(result._taskwraith_usage_recorded).toBe(true)
  })

  it('keeps renderer fallback enabled if the durable append fails', () => {
    const stats = { total_tokens: 50, duration_ms: 100 }
    const result = recordCodexUsageOnCompletion({
      chat: chat(),
      runId: 'run-1',
      model: 'gpt-5.6',
      stats,
      fallbackDurationMs: 100,
      recordUsage: () => {
        throw new Error('disk unavailable')
      }
    })

    expect(result).toBe(stats)
    expect(result._taskwraith_usage_recorded).toBeUndefined()
  })

  it('uses the durable global-workspace bucket and records duration-only terminals', () => {
    const recordUsage = vi.fn()
    const result = recordCodexUsageOnCompletion({
      chat: chat('global'),
      runId: 'run-global',
      model: 'gpt-5.6',
      stats: { duration_ms: 250 },
      fallbackDurationMs: 250,
      recordUsage
    })

    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: '__taskwraith_global_chats__',
        totalTokens: 0,
        durationMs: 250
      })
    )
    expect(result._taskwraith_usage_recorded).toBe(true)
  })
})

describe('mergeCodexExecUsageJsonLines', () => {
  it('merges complete JSONL usage frames monotonically and ignores malformed output', () => {
    const first = mergeCodexExecUsageJsonLines(
      undefined,
      [
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            total_tokens: 120
          }
        }),
        'not-json'
      ].join('\n')
    )
    const merged = mergeCodexExecUsageJsonLines(
      first,
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 125,
          cached_input_tokens: 45,
          output_tokens: 25,
          total_tokens: 150
        }
      })
    )

    expect(merged).toMatchObject({
      input_tokens: 125,
      cache_read_input_tokens: 45,
      output_tokens: 25,
      total_tokens: 150
    })
  })
})

describe('codexUsageResponseText', () => {
  it('joins provider message items in their insertion order', () => {
    expect(codexUsageResponseText(['First', ' second'])).toBe('First second')
    expect(codexUsageResponseText([])).toBeUndefined()
  })
})
