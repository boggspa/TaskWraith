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
  it('does not traverse fields beyond the requested result page', async () => {
    const raw = {
      output: 'x'.repeat(100_000),
      get unrelated() {
        throw new Error('unrequested field was traversed')
      }
    }
    const result = await readThreadHistory(
      [
        { ...message, toolActivities: [{ ...activity, detailRef: undefined, rawResultEvent: raw }] }
      ],
      { messageId: 'message', activityId: 'tool', maxBytes: 64 }
    )
    expect(result).toMatchObject({ available: true, nextOffset: 64 })
  })

  it('reports arguments that were never captured as unavailable', async () => {
    const result = await readThreadHistory(
      [{ ...message, toolActivities: [{ ...activity, detailRef: undefined }] }],
      { messageId: 'message', activityId: 'tool', field: 'arguments' }
    )
    expect(result).toEqual({ available: false, reason: 'field_not_captured' })
  })

  it('omits media in historical stringified result envelopes', () => {
    const value = JSON.stringify({
      type: 'tool_result',
      result: JSON.stringify({ content: [{ type: 'image', data: 'base64-secret-blob' }] })
    })
    expect(historyValueText(value)).not.toContain('base64-secret-blob')
  })
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
    } while (offset < Buffer.byteLength(text))
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
  it('does not lose matches when the response budget fills before the requested count', async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      ...message,
      id: `message-${index}`,
      content: '',
      toolActivities: [
        {
          ...activity,
          detailRef: undefined,
          filePath: 'x'.repeat(256),
          resultSummary: 'a'.repeat(320)
        }
      ]
    }))
    const found: string[] = []
    let before: { messageId: string; activityId?: string } | undefined
    do {
      const page = await searchThreadHistory(messages, { limit: 10, before })
      found.push(...page.matches.map((m) => m.messageId))
      before = page.nextCursor
    } while (before)
    expect(new Set(found).size).toBe(30)
  })

  it('does not invent null output for a tool whose fields were never captured', async () => {
    const result = await searchThreadHistory(
      [{ ...message, toolActivities: [{ ...activity, detailRef: undefined }] }],
      { query: 'null', searchDetails: true }
    )
    expect(result.matches).toEqual([])
  })

  it('marks clipped tool previews partial and bounds oversized source references', async () => {
    const partial = await searchThreadHistory(
      [
        {
          ...message,
          toolActivities: [
            { ...activity, detailRef: undefined, resultSummary: `${'x'.repeat(1500)}needle` }
          ]
        }
      ],
      { query: 'needle' }
    )
    expect(partial.complete).toBe(false)
    const huge = await readThreadHistory([{ ...message, id: 'x'.repeat(20_000) }], {
      messageId: 'x'.repeat(20_000),
      maxBytes: 4
    })
    expect(huge).toMatchObject({
      available: false,
      reason: 'history_reference_exceeds_response_budget'
    })
  })
  it('bounds the response even when stored display metadata is enormous', async () => {
    const result = await searchThreadHistory(
      [{ ...message, toolActivities: [{ ...activity, filePath: 'x'.repeat(20_000) }] }],
      {}
    )
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8_192)
  })

  it('uses original Unicode positions and never splits a surrogate pair in an excerpt', async () => {
    for (const prefix of ['İ'.repeat(1_000), `😀${'a'.repeat(79)}`]) {
      const result = await searchThreadHistory(
        [{ ...message, content: `${prefix}needle`, toolActivities: [] }],
        { query: 'needle' }
      )
      expect(result.matches[0].excerpt).toContain('needle')
      expect(result.matches[0].excerpt).not.toContain('\uFFFD')
    }
  })

  it('continues searching intact messages after a detail reader fails', async () => {
    const result = await searchThreadHistory(
      [message],
      { query: 'regression', searchDetails: true },
      async () => {
        throw new Error('I/O failure')
      }
    )
    expect(result.skippedDetails).toBe(1)
    expect(result.matches[0].messageId).toBe('message')
    expect(result.matches[0].activityId).toBeUndefined()
  })

  it('reports partial coverage for large messages without scanning their entire bodies', async () => {
    const result = await searchThreadHistory(
      [{ ...message, content: `${'x'.repeat(100_000)}needle`, toolActivities: [] }],
      { query: 'needle' }
    )
    expect(result.complete).toBe(false)
    expect(result.partialSources).toEqual([{ messageId: 'message', activityId: undefined }])
  })
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
