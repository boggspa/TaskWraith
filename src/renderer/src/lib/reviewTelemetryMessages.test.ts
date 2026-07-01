import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { mergeReviewTelemetryIntoMessages } from './reviewTelemetryMessages'

function reviewActivity(id: string, overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id,
    toolName: 'codex_review',
    displayName: 'Codex review',
    category: 'task',
    status: 'running',
    ...overrides
  }
}

function toolMessage(activities: ToolActivity[]): ChatMessage {
  return {
    id: `m-${activities[0]?.id ?? 'x'}`,
    role: 'tool',
    content: '',
    timestamp: '2026-05-26T17:00:00Z',
    toolActivities: activities
  }
}

describe('mergeReviewTelemetryIntoMessages', () => {
  it('merges telemetry onto the matching anchor anywhere in the list', () => {
    const messages: ChatMessage[] = [
      toolMessage([reviewActivity('rev_1')]),
      { id: 'm-text', role: 'assistant', content: 'finding prose', timestamp: '2026-05-26T17:00:00Z' },
      toolMessage([{ ...reviewActivity('read-1'), toolName: 'read_file', category: 'read' }])
    ]
    const next = mergeReviewTelemetryIntoMessages(messages, 'rev_1', {
      provider: 'codex',
      target: 'uncommitted changes',
      status: 'running'
    })
    expect(next[0].toolActivities?.[0].reviewSummary?.target).toBe('uncommitted changes')
    expect(next[1]).toBe(messages[1])
    expect(next[2]).toBe(messages[2])
  })

  it('accumulates start → completion', () => {
    let messages: ChatMessage[] = [toolMessage([reviewActivity('rev_1')])]
    messages = mergeReviewTelemetryIntoMessages(messages, 'rev_1', {
      target: 'uncommitted changes',
      status: 'running'
    })
    messages = mergeReviewTelemetryIntoMessages(messages, 'rev_1', {
      status: 'completed',
      durationMs: 42000,
      totalTokens: 9000
    })
    const s = messages[0].toolActivities?.[0].reviewSummary
    expect(s?.target).toBe('uncommitted changes')
    expect(s?.status).toBe('completed')
    expect(s?.durationMs).toBe(42000)
  })

  it('returns the SAME array reference on a no-op', () => {
    const messages: ChatMessage[] = [toolMessage([reviewActivity('rev_1')])]
    expect(mergeReviewTelemetryIntoMessages(messages, 'missing', { status: 'running' })).toBe(messages)
    expect(mergeReviewTelemetryIntoMessages(messages, 'rev_1', null)).toBe(messages)
  })
})
