import { describe, expect, it } from 'vitest'
import type { ChatRecord, ProviderId, RunQueueJob } from '../../../main/store/types'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import {
  getActiveRunChatLabel,
  isActiveRunVisibleOnSurface,
  resolveActiveRunChat,
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

describe('active run chat attribution', () => {
  it('recovers an Ensemble thread from the participant run id when chatId is absent', () => {
    const ensemble = chat('codex', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review',
      runs: [
        {
          runId: 'participant-run',
          provider: 'claude',
          startedAt: '2026-07-05T01:00:00.000Z',
          ensembleParticipantId: 'participant-2'
        }
      ]
    })
    const participantJob = job({
      id: 'participant-run',
      runId: 'participant-run',
      chatId: undefined,
      promptPreview: 'First few lines of the latest prompt'
    })

    const resolved = resolveActiveRunChat(participantJob, [ensemble])

    expect(resolved).toBe(ensemble)
    expect(getActiveRunChatLabel(participantJob, resolved)).toBe('Release review')
  })

  it('uses the exact app chat id before the run-id fallback', () => {
    const exact = chat('codex', { appChatId: 'exact-chat', title: 'Exact' })
    const historical = chat('claude', {
      appChatId: 'historical-chat',
      title: 'Historical',
      runs: [
        {
          runId: 'run-1',
          startedAt: '2026-07-05T00:00:00.000Z'
        }
      ]
    })

    expect(resolveActiveRunChat(job({ chatId: exact.appChatId }), [historical, exact])).toBe(exact)
  })
})

describe('isActiveRunVisibleOnSurface', () => {
  it('partitions resolved General and workspace threads between Chat and Code', () => {
    const globalChat = chat('claude', { appChatId: 'global-chat', scope: 'global' })
    const workspaceChat = chat('codex', {
      appChatId: 'workspace-chat',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo'
    })

    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), globalChat, 'chat')).toBe(true)
    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), globalChat, 'code')).toBe(false)
    expect(isActiveRunVisibleOnSurface(job({ scope: 'workspace' }), workspaceChat, 'code')).toBe(
      true
    )
    expect(isActiveRunVisibleOnSurface(job({ scope: 'workspace' }), workspaceChat, 'chat')).toBe(
      false
    )
  })

  it('uses durable job scope when the chat record is temporarily unavailable', () => {
    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), null, 'chat')).toBe(true)
    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), null, 'code')).toBe(false)
    expect(
      isActiveRunVisibleOnSurface(
        job({ scope: undefined, workspaceId: 'workspace-1', workspacePath: '/repo' }),
        null,
        'code'
      )
    ).toBe(true)
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

  it('uses every Pi upstream hue for an active run', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const modelId = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(modelId, `missing representative Pi model for ${upstream}`).toBeTruthy()
      const display = resolveActiveRunProviderDisplay(
        job({
          provider: 'pi',
          request: {
            selectedModelType: 'custom',
            customModel: modelId
          } as RunQueueJob['request']
        }),
        chat('pi')
      )

      expect(display.label).toBe('Pi')
      expect(display.providerClass).toBe(brand.hueClass)
      expect(display.style['--active-run-provider-color']).toContain(
        `--provider-${brand.hueClass}-color`
      )
    }
  })
})
