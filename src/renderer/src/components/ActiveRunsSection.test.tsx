import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId, RunQueueJob } from '../../../main/store/types'
import {
  getActiveRunChatLabel,
  resolveActiveRunProviderDisplay
} from './ActiveRunsSection'

function job(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'job-1',
    runId: 'run-1',
    provider: 'gemini',
    source: 'manual',
    status: 'active',
    priority: 0,
    attempt: 1,
    createdAt: '2026-07-05T01:00:00.000Z',
    updatedAt: '2026-07-05T01:00:00.000Z',
    ...overrides
  } as RunQueueJob
}

function chat(provider: ProviderId, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider,
    title: 'General',
    messages: [],
    runs: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ChatRecord
}

describe('getActiveRunChatLabel', () => {
  it('prefers the chat title over workspace-only labeling', () => {
    expect(
      getActiveRunChatLabel(
        job({
          workspacePath: '/Users/me/Documents/AGBench',
          promptPreview: 'ignored when title exists'
        }),
        chat('codex', { title: 'Auth rewrite' })
      )
    ).toBe('Auth rewrite')
  })

  it('falls back to prompt preview when chat title is missing', () => {
    expect(
      getActiveRunChatLabel(
        job({ promptPreview: 'Investigate launch stall' }),
        chat('codex', { title: '   ' })
      )
    ).toBe('Investigate launch stall')
  })

  it('falls back to Untitled chat when no title or preview exists', () => {
    expect(getActiveRunChatLabel(job(), null)).toBe('Untitled chat')
  })
})

describe('resolveActiveRunProviderDisplay', () => {
  it('uses the chat provider and Ollama display brand when a stale job says Gemini', () => {
    const display = resolveActiveRunProviderDisplay(
      job({
        provider: 'gemini',
        request: {
          selectedModelType: 'custom',
          customModel: 'laguna-xs-2.1:q8_0'
        } as RunQueueJob['request']
      }),
      chat('ollama')
    )

    expect(display.provider).toBe('ollama')
    expect(display.label).toBe('Poolside')
    expect(display.providerClass).toBe('poolside')
    expect(display.style).toMatchObject({
      '--active-run-provider-color':
        'var(--provider-poolside-color, var(--provider-ollama-color, var(--accent)))'
    })
  })

  it('keeps real Gemini jobs on the Gemini label', () => {
    const display = resolveActiveRunProviderDisplay(job({ provider: 'gemini' }), chat('gemini'))

    expect(display.provider).toBe('gemini')
    expect(display.label).toBe('Gemini')
    expect(display.providerClass).toBe('gemini')
  })
})
