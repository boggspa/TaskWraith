import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../store/types'
import {
  historyTextPage,
  historyValueText,
  readThreadHistory,
  searchThreadHistory
} from './ThreadHistory'

const detailRef = {
  schemaVersion: 1 as const,
  storage: 'run_event_artifact' as const,
  runId: 'run',
  activityId: 'tool',
  offset: 12,
  byteLength: 2_000,
  sha256: 'a'.repeat(64)
}
const activity: ToolActivity = {
  id: 'tool',
  toolName: 'run_shell_command',
  displayName: 'Test',
  category: 'shell',
  status: 'error',
  detailRef
}
const message: ChatMessage = {
  id: 'message',
  role: 'assistant',
  content: 'Investigate the regression.',
  timestamp: '2026-09-05T12:00:00Z',
  runId: 'run',
  toolActivities: [activity]
}

describe('thread history retrieval', () => {
  it('recovers a result beyond the old 600-character preview in bounded pages', async () => {
    const output = `${'x'.repeat(1_000)}\nExact failure: expected 17, received 3`
    const readDetail = async () => ({ ...activity, rawResultEvent: output })
    const result = await readThreadHistory(
      [message],
      { messageId: 'message', activityId: 'tool', offset: 1_001, maxBytes: 64 },
      readDetail
    )
    expect(result).toMatchObject({
      available: true,
      archived: true,
      text: 'Exact failure: expected 17, received 3',
      representation: 'captured_result'
    })
  })

  it('does not substitute a plausible preview when the referenced archive is missing', async () => {
    const result = await readThreadHistory(
      [{ ...message, toolActivities: [{ ...activity, resultSummary: 'Everything passed' }] }],
      { messageId: 'message', activityId: 'tool' },
      async () => null
    )
    expect(result).toEqual({ available: false, reason: 'archived_detail_unavailable' })
  })

  it('rejects an archive reference belonging to another run before reading it', async () => {
    let read = false
    const result = await readThreadHistory(
      [{ ...message, runId: 'other-run' }],
      { messageId: 'message', activityId: 'tool' },
      async () => {
        read = true
        return activity
      }
    )
    expect(result).toEqual({ available: false, reason: 'detail_reference_mismatch' })
    expect(read).toBe(false)
  })

  it('pages Unicode without replacement characters or exceeding its byte budget', () => {
    const text = 'a🦉é終z'
    let offset = 0
    let reconstructed = ''
    do {
      const page = historyTextPage(text, offset, 4)
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(4)
      reconstructed += page.text
      if (page.nextOffset === undefined) break
      offset = page.nextOffset
    } while (true)
    expect(reconstructed).toBe(text)
    expect(() => historyTextPage(text, 2, 4)).toThrow(/boundary/)
  })

  it('does not expand binary media or opaque reasoning into retrieval text', () => {
    const text = historyValueText([
      { type: 'text', text: 'failure details' },
      { type: 'image', data: 'binary-media' },
      { type: 'thinking', thinking: 'private', signature: 'opaque' }
    ])
    expect(text).toContain('failure details')
    expect(text).not.toMatch(/binary-media|private|opaque/)
  })
})

describe('thread history lookup', () => {
  it('searches captured result details when requested and returns a source reference', async () => {
    const result = await searchThreadHistory(
      [message],
      { query: 'expected 17', searchDetails: true },
      async () => ({ ...activity, rawResultEvent: `${'x'.repeat(1_000)} expected 17` })
    )
    expect(result.matches).toEqual([
      expect.objectContaining({
        messageId: 'message',
        activityId: 'tool',
        archived: true,
        excerpt: expect.stringContaining('expected 17')
      })
    ])
  })

  it('continues after the exact tool reference without skipping its parent message', async () => {
    const first = await searchThreadHistory([message], { limit: 1 })
    const second = await searchThreadHistory([message], { before: first.nextCursor, limit: 1 })
    expect(first.matches[0].activityId).toBe('tool')
    expect(second.matches[0].messageId).toBe('message')
    expect(second.matches[0].activityId).toBeUndefined()
    expect(second.hasMore).toBe(false)
  })

  it('reports unsearched large details instead of claiming an exhaustive miss', async () => {
    const result = await searchThreadHistory(
      [
        {
          ...message,
          toolActivities: [
            { ...activity, detailRef: { ...detailRef, byteLength: 8 * 1024 * 1024 } }
          ]
        }
      ],
      { query: 'missing', searchDetails: true },
      async () => {
        throw new Error('oversized archive must not be loaded by search')
      }
    )
    expect(result.skippedDetails).toBe(1)
    expect(result.matches).toEqual([])
  })

  it('returns a continuation for bounded scans with no matches', async () => {
    const messages = Array.from({ length: 250 }, (_, index) => ({
      ...message,
      id: `message-${index}`,
      toolActivities: []
    }))
    const result = await searchThreadHistory(messages, { query: 'absent' })
    expect(result.scanned).toBe(200)
    expect(result.hasMore).toBe(true)
    expect(result.nextCursor).toEqual({ messageId: 'message-50', activityId: undefined })
    await expect(
      searchThreadHistory(messages, { before: { messageId: 'deleted' } })
    ).rejects.toThrow(/no longer exists/)
  })
})
