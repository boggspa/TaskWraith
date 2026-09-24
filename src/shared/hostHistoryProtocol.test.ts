import { describe, expect, it } from 'vitest'

import {
  decodeHostHistoryDeltasFrame,
  decodeHostHistorySinceRequest,
  decodeHostHistorySinceResult,
  decodeHostThreadHistoryPage,
  decodeHostThreadHistoryRequest,
  HOST_HISTORY_MAX_ENTRY_TEXT
} from './hostHistoryProtocol'

const ENTRY = { entryId: 'message-1', role: 'assistant', createdAt: 1, text: 'Hello' }

describe('host history protocol', () => {
  it('decodes a bounded page and independent history cursors', () => {
    const page = {
      threadId: 'thread-1',
      generation: 2,
      cursor: 4,
      entries: [ENTRY],
      nextBefore: { generation: 2, cursor: 3 }
    }
    expect(decodeHostThreadHistoryPage(page)).toEqual({ ok: true, value: page })
    expect(
      decodeHostThreadHistoryRequest({
        threadId: 'thread-1',
        before: { generation: 2, cursor: 3 },
        limit: 25
      })
    ).toMatchObject({ ok: true })
    expect(
      decodeHostHistorySinceRequest({ threadId: 'thread-1', since: { generation: 2, cursor: 4 } })
    ).toMatchObject({ ok: true })
  })

  it('decodes display-only tool activity without accepting raw payloads', () => {
    const entry = {
      ...ENTRY,
      tools: [
        {
          id: 'tool-1',
          name: 'Edit File',
          category: 'write',
          status: 'success',
          file: 'src/example.ts',
          additions: 4,
          deletions: 2
        }
      ]
    }
    expect(
      decodeHostThreadHistoryPage({
        threadId: 'thread-1',
        generation: 2,
        cursor: 4,
        entries: [entry]
      })
    ).toMatchObject({ ok: true, value: { entries: [entry] } })
    expect(
      decodeHostThreadHistoryPage({
        threadId: 'thread-1',
        generation: 2,
        cursor: 4,
        entries: [{ ...entry, tools: [{ ...entry.tools[0], output: 'raw' }] }]
      })
    ).toEqual({ ok: false, error: 'thread history page is invalid' })
  })

  it('decodes bounded diff and command presentation fields', () => {
    const entry = {
      ...ENTRY,
      tools: [
        {
          id: 'tool-rich',
          name: 'Edit File',
          category: 'write',
          status: 'success',
          diff: {
            hunks: [
              {
                header: '@@ -2,1 +2,2 @@',
                lines: [
                  { type: 'del', text: 'old', oldLine: 2 },
                  { type: 'add', text: 'new', newLine: 2 },
                  { type: 'add', text: 'next', newLine: 3 }
                ]
              }
            ]
          },
          command: { command: 'npm test', output: 'passed', exitCode: 0 }
        }
      ]
    }
    expect(
      decodeHostThreadHistoryPage({
        threadId: 'thread-1',
        generation: 2,
        cursor: 4,
        entries: [entry]
      })
    ).toMatchObject({ ok: true, value: { entries: [entry] } })
  })

  it('decodes separate history deltas and their event frame', () => {
    const result = {
      kind: 'deltas',
      threadId: 'thread-1',
      generation: 2,
      fromCursor: 4,
      toCursor: 5,
      deltas: [{ kind: 'append', entry: ENTRY }]
    } as const
    expect(decodeHostHistorySinceResult(result)).toEqual({ ok: true, value: result })
    expect(
      decodeHostHistoryDeltasFrame({
        type: 'host.history',
        protocolVersion: 2,
        threadId: 'thread-1',
        result
      })
    ).toEqual({
      ok: true,
      value: { type: 'host.history', protocolVersion: 2, threadId: 'thread-1', result }
    })
  })

  it('preserves ordinary formatting but rejects terminal controls, oversized bodies, and cursor corruption', () => {
    expect(
      decodeHostThreadHistoryPage({
        threadId: 'thread-1',
        generation: 0,
        cursor: 0,
        entries: [{ ...ENTRY, text: 'line one\n\tline two\r\nline three' }]
      })
    ).toMatchObject({ ok: true })
    for (const text of ['escape\u001b[2J', 'bell\u0007', 'delete\u007f']) {
      expect(
        decodeHostThreadHistoryPage({
          threadId: 'thread-1',
          generation: 0,
          cursor: 0,
          entries: [{ ...ENTRY, text }]
        })
      ).toEqual({ ok: false, error: 'thread history page is invalid' })
    }
    expect(
      decodeHostThreadHistoryPage({
        threadId: 'thread-1',
        generation: 0,
        cursor: 0,
        entries: [{ ...ENTRY, text: 'x'.repeat(HOST_HISTORY_MAX_ENTRY_TEXT + 1) }]
      })
    ).toEqual({ ok: false, error: 'thread history page is invalid' })
    expect(
      decodeHostThreadHistoryPage({
        threadId: 'thread-1',
        generation: 0,
        cursor: 0,
        entries: [ENTRY, ENTRY]
      })
    ).toEqual({ ok: false, error: 'thread history page is invalid' })
    expect(
      decodeHostHistoryDeltasFrame({
        type: 'host.history',
        protocolVersion: 2,
        threadId: 'thread-2',
        result: {
          kind: 'deltas',
          threadId: 'thread-1',
          generation: 0,
          fromCursor: 0,
          toCursor: 0,
          deltas: []
        }
      })
    ).toEqual({ ok: false, error: 'history frame is invalid' })
  })
})
