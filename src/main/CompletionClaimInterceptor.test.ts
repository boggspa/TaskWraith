import { describe, expect, it } from 'vitest'
import { annotateChatCompletionClaimSupport } from './CompletionClaimInterceptor'
import type { ChatRecord, EvidencePackRecord } from './store/types'

const NOW = new Date('2026-07-02T20:00:00.000Z')

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'UI importer',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done. UI import is implemented.',
        runId: 'run-1',
        timestamp: '2026-07-02T19:59:00.000Z'
      }
    ],
    runs: [
      {
        runId: 'run-1',
        provider: 'codex',
        startedAt: '2026-07-02T19:58:00.000Z',
        endedAt: '2026-07-02T19:59:00.000Z',
        status: 'success'
      }
    ],
    ...overrides
  } as ChatRecord
}

function pack(overrides: Partial<EvidencePackRecord> = {}): EvidencePackRecord {
  return {
    schemaVersion: 1,
    id: 'pack-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    runId: 'run-1',
    provider: 'codex',
    mapEntries: [],
    capabilityCells: [],
    completionClaims: [],
    createdAt: '2026-07-02T19:58:30.000Z',
    updatedAt: '2026-07-02T19:58:30.000Z',
    ...overrides
  }
}

describe('annotateChatCompletionClaimSupport', () => {
  it('marks terminal completion language unsupported when no Evidence Pack backs it', () => {
    const result = annotateChatCompletionClaimSupport(chat(), [], { now: NOW })

    expect(result.changed).toBe(true)
    expect(result.chat.messages[0]?.metadata?.completionClaimSupport).toMatchObject({
      status: 'unsupported',
      hasCompletionLanguage: true,
      evidencePackIds: [],
      assessedAt: NOW.toISOString()
    })
  })

  it('marks completion language supported when the same run has backed evidence', () => {
    const result = annotateChatCompletionClaimSupport(
      chat(),
      [
        pack({
          completionClaims: [
            {
              claim: 'UI import buttons work.',
              supported: true,
              evidenceRefs: [{ path: 'src/import.test.ts', line: 12 }]
            }
          ]
        })
      ],
      { now: NOW }
    )

    expect(result.chat.messages[0]?.metadata?.completionClaimSupport).toMatchObject({
      status: 'supported',
      evidencePackIds: ['pack-1'],
      supportingEvidenceRefs: [{ path: 'src/import.test.ts', line: 12 }]
    })
  })

  it('marks completion language partial when only partial capability evidence exists', () => {
    const result = annotateChatCompletionClaimSupport(
      chat(),
      [
        pack({
          capabilityCells: [
            {
              capabilityKey: 'ui-import',
              status: 'partial',
              evidenceRefs: [{ path: 'fixtures/button.json' }]
            }
          ]
        })
      ],
      { now: NOW }
    )

    expect(result.chat.messages[0]?.metadata?.completionClaimSupport).toMatchObject({
      status: 'partial',
      recommendedCaveat:
        'Say this is partially implemented or still under validation, and list the missing proof.'
    })
  })

  it('does not annotate running runs or non-completion assistant text', () => {
    const running = annotateChatCompletionClaimSupport(
      chat({ runs: [{ runId: 'run-1', provider: 'codex', startedAt: 't', status: 'running' }] }),
      [],
      { now: NOW }
    )
    expect(running.changed).toBe(false)

    const exploratory = annotateChatCompletionClaimSupport(
      chat({
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I found the relevant importer files.',
            runId: 'run-1',
            timestamp: '2026-07-02T19:59:00.000Z'
          }
        ]
      }),
      [],
      { now: NOW }
    )
    expect(exploratory.changed).toBe(false)
  })

  it('removes stale completion metadata when a message no longer claims completion', () => {
    const result = annotateChatCompletionClaimSupport(
      chat({
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'I found the relevant importer files.',
            runId: 'run-1',
            timestamp: '2026-07-02T19:59:00.000Z',
            metadata: {
              completionClaimSupport: {
                status: 'unsupported',
                hasCompletionLanguage: true,
                completionPhrases: ['done'],
                evidencePackIds: [],
                supportingEvidenceRefs: [],
                message: 'stale',
                assessedAt: '2026-07-02T19:59:30.000Z'
              }
            }
          }
        ]
      }),
      [],
      { now: NOW }
    )

    expect(result.changed).toBe(true)
    expect(result.chat.messages[0]?.metadata?.completionClaimSupport).toBeUndefined()
  })

  it('does not churn an equivalent existing annotation just to refresh assessedAt', () => {
    const result = annotateChatCompletionClaimSupport(
      chat({
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done. UI import is implemented.',
            runId: 'run-1',
            timestamp: '2026-07-02T19:59:00.000Z',
            metadata: {
              completionClaimSupport: {
                status: 'unsupported',
                hasCompletionLanguage: true,
                completionPhrases: ['done', 'implemented'],
                evidencePackIds: [],
                supportingEvidenceRefs: [],
                message:
                  'Completion-style language is unsupported because no evidence-backed completion claim was found.',
                recommendedCaveat:
                  'Avoid done/implemented/ready wording until an Evidence Pack includes supported claims or verified cells.',
                assessedAt: '2026-07-02T19:59:30.000Z'
              }
            }
          }
        ]
      }),
      [],
      { now: NOW }
    )

    expect(result.changed).toBe(false)
  })
})
