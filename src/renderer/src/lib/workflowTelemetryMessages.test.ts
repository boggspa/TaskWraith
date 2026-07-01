import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { mergeWorkflowTelemetryIntoMessages } from './workflowTelemetryMessages'

function workflowActivity(id: string, overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id,
    toolName: 'Workflow',
    displayName: 'Workflow',
    category: 'task',
    status: 'success',
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

describe('mergeWorkflowTelemetryIntoMessages', () => {
  it('merges telemetry onto the matching activity anywhere in the list', () => {
    const messages: ChatMessage[] = [
      toolMessage([workflowActivity('toolu_1')]),
      { id: 'm-text', role: 'assistant', content: 'hi', timestamp: '2026-05-26T17:00:00Z' },
      toolMessage([{ ...workflowActivity('read-1'), toolName: 'read_file', category: 'read' }])
    ]
    const next = mergeWorkflowTelemetryIntoMessages(messages, 'toolu_1', {
      workflowName: 'audit',
      status: 'running',
      totalTokens: 1234
    })
    const activity = next[0].toolActivities?.[0]
    expect(activity?.workflowSummary?.workflowName).toBe('audit')
    expect(activity?.workflowSummary?.totalTokens).toBe(1234)
    // Unrelated messages keep their reference.
    expect(next[1]).toBe(messages[1])
    expect(next[2]).toBe(messages[2])
  })

  it('accumulates across successive frames', () => {
    let messages: ChatMessage[] = [toolMessage([workflowActivity('toolu_1')])]
    messages = mergeWorkflowTelemetryIntoMessages(messages, 'toolu_1', {
      workflowName: 'audit',
      status: 'running'
    })
    messages = mergeWorkflowTelemetryIntoMessages(messages, 'toolu_1', {
      status: 'completed',
      summary: 'done',
      totalTokens: 500
    })
    const summary = messages[0].toolActivities?.[0].workflowSummary
    expect(summary?.workflowName).toBe('audit')
    expect(summary?.status).toBe('completed')
    expect(summary?.summary).toBe('done')
    expect(summary?.totalTokens).toBe(500)
  })

  it('returns the SAME array reference when nothing matches (no-op)', () => {
    const messages: ChatMessage[] = [toolMessage([workflowActivity('toolu_1')])]
    expect(mergeWorkflowTelemetryIntoMessages(messages, 'missing', { status: 'running' })).toBe(
      messages
    )
    expect(mergeWorkflowTelemetryIntoMessages(messages, '', { status: 'running' })).toBe(messages)
    expect(mergeWorkflowTelemetryIntoMessages(messages, 'toolu_1', null)).toBe(messages)
  })
})
