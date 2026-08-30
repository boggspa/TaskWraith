import { describe, expect, it } from 'vitest'

import type { TaskWraithControlThreadSnapshot } from '../shared/taskWraithControlProtocol'
import { classifyHistoryResult, preserveAuthoritativeHistoryRows } from './historyReconcile'

const history = {
  threadId: 'thread-1',
  generation: 2,
  cursor: 5,
  previewOnly: false
} as const

describe('TUI history reconciliation', () => {
  it('ignores a late caught-up response after a newer event already advanced the cursor', () => {
    expect(
      classifyHistoryResult(history, {
        kind: 'deltas',
        threadId: 'thread-1',
        generation: 2,
        fromCursor: 4,
        toCursor: 4,
        deltas: []
      })
    ).toBe('ignore')
  })

  it('reloads only a resnapshot request bound to the cursor that is current now', () => {
    expect(
      classifyHistoryResult(history, {
        kind: 'full_resnapshot_required',
        threadId: 'thread-1',
        generation: 3,
        cursor: 0,
        clientGeneration: 2,
        clientCursor: 5,
        reason: 'generation_mismatch'
      })
    ).toBe('reload')
    expect(
      classifyHistoryResult(history, {
        kind: 'full_resnapshot_required',
        threadId: 'thread-1',
        generation: 3,
        cursor: 0,
        clientGeneration: 2,
        clientCursor: 4,
        reason: 'generation_mismatch'
      })
    ).toBe('ignore')
  })

  it('keeps full transcript rows while refreshing bounded thread metadata', () => {
    const current = {
      thread: { id: 'thread-1', title: 'Old' },
      rows: [{ id: 'history-1', text: 'kept' }],
      totalRows: 1,
      hasMoreAbove: false
    } as TaskWraithControlThreadSnapshot
    const incoming = {
      thread: { id: 'thread-1', title: 'New' },
      rows: [{ id: 'host-preview:thread-1', text: 'preview' }],
      totalRows: 1,
      hasMoreAbove: true
    } as TaskWraithControlThreadSnapshot
    expect(preserveAuthoritativeHistoryRows(current, incoming, history)).toMatchObject({
      thread: { title: 'New' },
      rows: [{ id: 'history-1', text: 'kept' }],
      hasMoreAbove: false
    })
  })
})
