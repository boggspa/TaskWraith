import { describe, expect, it, vi } from 'vitest'
import type { ComposerContinuationProposalService } from './ComposerContinuationProposalService'
import {
  createComposerContinuationPrefetch,
  type ComposerContinuationPrefetchDeps
} from './ComposerContinuationPrefetch'

function harness(overrides: Partial<ComposerContinuationPrefetchDeps> = {}) {
  const propose = vi.fn(async (request) => ({
    schemaVersion: 2 as const,
    chatId: request.chatId,
    contextVersion: request.contextVersion,
    generatedAt: '2026-08-30T00:00:00.000Z',
    status: request.purpose === 'title' ? ('ready' as const) : ('abstained' as const),
    proposals: [],
    ...(request.purpose === 'title'
      ? {
          title: 'Focused Validation Repair',
          titleSourceMessageId: 'user-1',
          titleSourceFingerprint: 'title-source-v1:1234abcd',
          titleExpectedCurrent: 'Fix validation',
          fingerprint: `sha256:${'a'.repeat(64)}`
        }
      : {})
  }))
  const appliedChat = {
    appChatId: 'chat-1',
    title: 'Focused Validation Repair',
    threadTitle: { source: 'local-ai' as const },
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [],
    runs: []
  }
  const applyTitle = vi.fn(async () => ({ ok: true as const, chat: appliedChat }))
  const service = { propose, applyTitle } satisfies ComposerContinuationProposalService
  const scheduled: Array<() => void> = []
  const prefetch = createComposerContinuationPrefetch({
    service,
    schedule: (run) => scheduled.push(run),
    ...overrides
  })
  return { applyTitle, prefetch, propose, scheduled }
}

describe('ComposerContinuationPrefetch', () => {
  it('coalesces saves, waits for durability, warms drafts, and applies an issued title', async () => {
    const order: string[] = []
    const afterTitleApplied = vi.fn(async () => {
      order.push('broadcast')
    })
    const h = harness({
      beforePrefetch: async () => {
        order.push('durable')
      },
      afterTitleApplied
    })
    h.prefetch.observe('chat-1')
    h.prefetch.observe('chat-1')
    expect(h.scheduled).toHaveLength(1)

    h.scheduled.shift()?.()
    await h.prefetch.drainNow()
    expect(order).toEqual(['durable', 'broadcast'])
    expect(h.propose.mock.calls.map(([request]) => request.purpose).sort()).toEqual([
      'draft',
      'title'
    ])
    expect(h.applyTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Focused Validation Repair',
        expectedTitle: 'Fix validation'
      })
    )
    expect(afterTitleApplied).toHaveBeenCalledTimes(1)
  })

  it('does nothing while AutoDraft is disabled', async () => {
    const h = harness({ isEnabled: () => false })
    h.prefetch.observe('chat-1')
    await h.prefetch.drainNow()
    expect(h.propose).not.toHaveBeenCalled()
    expect(h.applyTitle).not.toHaveBeenCalled()
  })

  it('keeps deterministic fallback when title generation abstains', async () => {
    const h = harness()
    h.propose.mockImplementation(async (request) => ({
      schemaVersion: 2,
      chatId: request.chatId,
      contextVersion: request.contextVersion,
      generatedAt: '2026-08-30T00:00:00.000Z',
      status: 'abstained',
      proposals: []
    }))
    h.prefetch.observe('chat-1')
    await h.prefetch.drainNow()
    expect(h.applyTitle).not.toHaveBeenCalled()
  })
})
