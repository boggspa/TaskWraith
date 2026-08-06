import { describe, expect, it } from 'vitest'
import {
  CURSOR_CONTEXT_PRESSURE_QUIET_MS,
  buildCursorPathBCompactionSummary,
  decideCursorContextPressureRecovery
} from './CursorContextPressureRecovery'
import type { ChatMessage } from '../store/types'

function msg(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-08-06T00:00:00.000Z' }
}

describe('decideCursorContextPressureRecovery', () => {
  const base = {
    transportLiveness: 'alive' as const,
    hasActiveToolOrApproval: false,
    contextPressurePercent: 100,
    nowMs: CURSOR_CONTEXT_PRESSURE_QUIET_MS,
    lastTokenGrowthAt: 0
  }

  it('recovers only when alive, critical, and quiet', () => {
    expect(decideCursorContextPressureRecovery(base)).toMatchObject({ kind: 'recover' })
  })

  it('waits while tools/approvals are active or occupancy is below critical', () => {
    expect(decideCursorContextPressureRecovery({ ...base, hasActiveToolOrApproval: true })).toEqual(
      { kind: 'wait' }
    )
    expect(decideCursorContextPressureRecovery({ ...base, contextPressurePercent: 90 })).toEqual({
      kind: 'wait'
    })
    expect(decideCursorContextPressureRecovery({ ...base, transportLiveness: 'unknown' })).toEqual({
      kind: 'wait'
    })
  })

  it('waits until the quiet window elapses', () => {
    expect(
      decideCursorContextPressureRecovery({
        ...base,
        nowMs: CURSOR_CONTEXT_PRESSURE_QUIET_MS - 1
      })
    ).toEqual({ kind: 'wait' })
  })
})

describe('buildCursorPathBCompactionSummary', () => {
  it('covers a contiguous prefix and retains the trailing window', () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      msg(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', `row ${index}`)
    )
    const summary = buildCursorPathBCompactionSummary({
      messages,
      roundPrompt: 'Keep going on the feature.',
      nowIso: '2026-08-06T21:00:00.000Z',
      preTokens: 26_000_000,
      retainRecentMessages: 4
    })
    expect(summary).toMatchObject({
      provider: 'cursor',
      preTokens: 26_000_000,
      provenance: {
        kind: 'contiguous_prompt_prefix',
        throughMessageId: 'm15',
        coveredMessageIds: messages.slice(0, 16).map((message) => message.id)
      }
    })
    expect(summary?.text).toContain('Keep going on the feature.')
    expect(summary?.text).toContain('row 0')
  })

  it('falls back to a bounded note when the transcript is already short', () => {
    const summary = buildCursorPathBCompactionSummary({
      messages: [msg('a', 'user', 'hi'), msg('b', 'assistant', 'hello')],
      roundPrompt: 'Short thread',
      nowIso: '2026-08-06T21:00:00.000Z',
      retainRecentMessages: 12
    })
    expect(summary?.provenance.kind).toBe('bounded_prompt_window')
    expect(summary?.text).toContain('Short thread')
  })
})
