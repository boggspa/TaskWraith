import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId, RunQueueJob } from '../../../main/store/types'
import { resolveActiveRunProviderDisplay } from './ActiveRunsSection'

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
