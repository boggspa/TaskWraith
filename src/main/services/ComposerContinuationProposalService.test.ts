import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord, ContinuationProposalRequest } from '../store/types'
import type { ContinuationEvidenceSnapshot } from '../ContinuationProposal'
import { createComposerContinuationProposalService } from './ComposerContinuationProposalService'

function chat(assistant = 'The focused validation case is still failing.'): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Validation repair',
    threadTitle: { source: 'user' },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Fix the focused validation failure',
        timestamp: '2026-08-30T00:00:00.000Z'
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: assistant,
        timestamp: '2026-08-30T00:01:00.000Z'
      }
    ],
    runs: [
      {
        runId: 'run-1',
        promptMessageId: 'user-1',
        startedAt: '2026-08-30T00:00:00.000Z',
        endedAt: '2026-08-30T00:01:00.000Z',
        status: 'failed',
        warnings: [{ message: 'Focused validation is red', timestamp: '2026-08-30T00:01:00.000Z' }]
      }
    ]
  }
}

const request: ContinuationProposalRequest = {
  schemaVersion: 2,
  chatId: 'chat-1',
  contextVersion: 'continuation-v2:abc:draft',
  purpose: 'draft'
}

describe('ComposerContinuationProposalService', () => {
  it('builds evidence in main and caches a validated result by fingerprint', async () => {
    const getChat = vi.fn(() => chat())
    const bridgeRequest = vi.fn(async (_method: string, params: unknown) => {
      const snapshot = params as ContinuationEvidenceSnapshot
      const id = (kind: string) => snapshot.evidence.find((item) => item.kind === kind)!.id
      return {
        fingerprint: snapshot.fingerprint,
        abstain: false,
        candidates: [
          {
            body: 'Can you repair the focused validation failure and run the focused check?',
            intentKind: 'verify',
            evidenceIds: [id('user-request'), id('assistant-outcome'), id('run-warning')]
          }
        ]
      }
    })
    const service = createComposerContinuationProposalService({
      getChat,
      applyTitle: () => null,
      getBridgeDaemon: () => ({ status: () => ({ running: true }), request: bridgeRequest })
    })

    const first = await service.propose(request)
    const second = await service.propose({
      ...request,
      contextVersion: 'continuation-v2:def:draft'
    })
    expect(first.status).toBe('ready')
    expect(second.proposals).toEqual(first.proposals)
    expect(second.contextVersion).toBe('continuation-v2:def:draft')
    expect(bridgeRequest).toHaveBeenCalledTimes(1)
  })

  it('returns stale when canonical evidence changes during generation', async () => {
    let reads = 0
    const service = createComposerContinuationProposalService({
      getChat: () => (++reads === 1 ? chat() : chat('A newer assistant result arrived.')),
      applyTitle: () => null,
      getBridgeDaemon: () => ({
        status: () => ({ running: true }),
        request: async (_method, params) => ({
          fingerprint: (params as ContinuationEvidenceSnapshot).fingerprint,
          abstain: true,
          candidates: []
        })
      })
    })
    expect((await service.propose(request)).status).toBe('stale')
  })

  it('abstains without actionable evidence and handles an unavailable daemon', async () => {
    const noOutcome = chat('')
    noOutcome.messages = noOutcome.messages.slice(0, 1)
    noOutcome.runs = []
    const abstaining = createComposerContinuationProposalService({
      getChat: () => noOutcome,
      applyTitle: () => null,
      getBridgeDaemon: () => null
    })
    expect((await abstaining.propose(request)).status).toBe('abstained')

    const unavailable = createComposerContinuationProposalService({
      getChat: () => chat(),
      applyTitle: () => null,
      getBridgeDaemon: () => ({
        status: () => ({ running: false }),
        request: vi.fn()
      })
    })
    expect((await unavailable.propose(request)).status).toBe('unavailable')
  })

  it('applies only the exact title issued for the current evidence fingerprint', async () => {
    const titledChat = chat()
    titledChat.title = 'Fix the focused validation failure'
    titledChat.threadTitle = { source: 'prompt-fallback', sourceMessageId: 'user-1' }
    const applyTitle = vi.fn((input) => ({
      ...titledChat,
      title: input.title,
      threadTitle: {
        source: 'local-ai' as const,
        sourceMessageId: input.sourceMessageId,
        sourceFingerprint: input.sourceFingerprint,
        evidenceFingerprint: input.evidenceFingerprint
      }
    }))
    const service = createComposerContinuationProposalService({
      getChat: () => titledChat,
      applyTitle,
      getBridgeDaemon: () => ({
        status: () => ({ running: true }),
        request: async (_method, params) => ({
          fingerprint: (params as ContinuationEvidenceSnapshot).fingerprint,
          abstain: false,
          candidates: [],
          title: 'Focused Validation Repair'
        })
      })
    })
    const titleRequest: ContinuationProposalRequest = {
      ...request,
      contextVersion: 'continuation-title-v1:abc:title',
      purpose: 'title'
    }
    const proposed = await service.propose(titleRequest)
    expect(proposed.title).toBe('Focused Validation Repair')
    const input = {
      schemaVersion: 1 as const,
      chatId: 'chat-1',
      title: proposed.title!,
      sourceMessageId: proposed.titleSourceMessageId!,
      sourceFingerprint: proposed.titleSourceFingerprint!,
      evidenceFingerprint: proposed.fingerprint!,
      expectedTitle: proposed.titleExpectedCurrent!
    }
    expect(await service.applyTitle(input)).toMatchObject({ ok: true })
    expect(await service.applyTitle({ ...input, title: 'Unissued Different Title' })).toEqual({
      ok: false,
      reason: 'title-not-issued'
    })
  })
})
