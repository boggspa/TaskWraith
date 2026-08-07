/**
 * Host Arc Wave 5c Phase 3 — HostProductionQuestionShadow pins.
 *
 * RED-first discipline matches HostProductionApprovalShadow /
 * HostProductionProviderAdmission: pins assert the mapping contract
 * before (and after) the adapter lands.
 *
 * WHAT IS BEING PINNED. Agent questions live in RemoteQuestionRegistry
 * keyed by a registry-minted questionId. Host question cards on the wire
 * must reuse that id so clients can join. The adapter maps only allowlisted
 * fields and never invents threadId (required on HostQuestionProjection).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionQuestionShadow,
  mapPendingQuestionShadowsToHostQuestions,
  type HostPendingQuestionShadowEntry
} from './HostProductionQuestionShadow'

function entry(
  overrides: Partial<HostPendingQuestionShadowEntry> = {}
): HostPendingQuestionShadowEntry {
  return {
    questionId: 'q-1700000000000-abc123',
    question: 'Which approach should we take?',
    threadId: 'chat-1',
    createdAt: '2024-11-14T22:13:20.000Z',
    ...overrides
  }
}

describe('mapPendingQuestionShadowsToHostQuestions', () => {
  it('returns empty for zero pending entries (a measured none)', () => {
    expect(mapPendingQuestionShadowsToHostQuestions([])).toEqual([])
  })

  it('keeps the registry questionId verbatim — it is the client join key', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry()])
    expect(rows).toHaveLength(1)
    expect(rows[0].questionId).toBe('q-1700000000000-abc123')
  })

  it('carries threadId when present and valid', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry()])
    expect(rows[0].threadId).toBe('chat-1')
  })

  it('skips rows without a usable threadId — never invents one', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([
      entry({ threadId: undefined }),
      entry({ threadId: '' }),
      entry({ threadId: '   ' })
    ])
    expect(rows).toEqual([])
  })

  it('marks every shadow row open (pending registry only)', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry()])
    expect(rows[0].status).toBe('open')
  })

  it('parses createdAt ISO into askedAt ms', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry()])
    expect(rows[0].askedAt).toBe(Date.parse('2024-11-14T22:13:20.000Z'))
  })

  it('skips rows with unparseable createdAt', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([
      entry({ createdAt: '' }),
      entry({ createdAt: 'not-a-date' })
    ])
    expect(rows).toEqual([])
  })

  it('bounds an over-long promptPreview rather than forwarding it', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry({ question: 'x'.repeat(5000) })])
    expect(rows[0].promptPreview.length).toBeLessThanOrEqual(1000)
  })

  it('skips rows with empty question text', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([
      entry({ question: '' }),
      entry({ question: '   ' })
    ])
    expect(rows).toEqual([])
  })

  it('skips rows whose questionId cannot carry within the wire bound', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([
      entry({ questionId: '' }),
      entry({ questionId: '   ' }),
      entry({ questionId: 'y'.repeat(4096) })
    ])
    expect(rows).toEqual([])
  })

  it('allowlists fields — no options, context, provider, or answer leak onto the wire', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry()])
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['askedAt', 'promptPreview', 'questionId', 'status', 'threadId'].sort()
    )
  })

  it('does not emit answeredAt or receiptId on the open-pending shadow path', () => {
    const rows = mapPendingQuestionShadowsToHostQuestions([entry()])
    expect('answeredAt' in rows[0]).toBe(false)
    expect('receiptId' in rows[0]).toBe(false)
  })
})

describe('createHostProductionQuestionShadow', () => {
  it('requires a listPending function', () => {
    expect(() => createHostProductionQuestionShadow({} as never)).toThrow(
      'HostProductionQuestionShadow requires listPending to be a function'
    )
  })

  it('reads live on every listQuestions call (no caching of a moving set)', () => {
    const listPending = vi.fn(() => [entry()])
    const port = createHostProductionQuestionShadow({ listPending })
    expect(port.listQuestions()).toHaveLength(1)
    expect(port.listQuestions()).toHaveLength(1)
    expect(listPending).toHaveBeenCalledTimes(2)
  })

  it('lets a source throw propagate — fail closed, never a false empty', () => {
    const port = createHostProductionQuestionShadow({
      listPending: () => {
        throw new Error('registry unavailable')
      }
    })
    expect(() => port.listQuestions()).toThrow('registry unavailable')
  })
})
