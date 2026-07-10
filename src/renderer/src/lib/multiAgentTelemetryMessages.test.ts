import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { mergeMultiAgentTelemetryIntoMessages } from './multiAgentTelemetryMessages'

function messageWithAnchor(id: string): ChatMessage {
  return {
    id: 'msg_1',
    role: 'assistant',
    content: '',
    timestamp: '2026-07-10T00:00:00.000Z',
    toolActivities: [
      {
        id,
        toolName: 'codex_multi_agent',
        displayName: 'Codex Multi-agent',
        category: 'task',
        status: 'running'
      }
    ]
  } as unknown as ChatMessage
}

describe('mergeMultiAgentTelemetryIntoMessages', () => {
  it('merges telemetry onto the matching anchor anywhere in the list', () => {
    const messages = [messageWithAnchor('other'), messageWithAnchor('ma_1')]
    const next = mergeMultiAgentTelemetryIntoMessages(messages, 'ma_1', {
      provider: 'codex',
      status: 'working',
      detailLevel: 'full'
    })
    expect(next).not.toBe(messages)
    expect(next[1].toolActivities?.[0].multiAgentSummary).toMatchObject({
      provider: 'codex',
      status: 'working'
    })
    // Non-matching message is reference-stable.
    expect(next[0]).toBe(messages[0])
  })

  it('accumulates patches and never downgrades a terminal status', () => {
    let messages = [messageWithAnchor('ma_1')]
    messages = mergeMultiAgentTelemetryIntoMessages(messages, 'ma_1', {
      provider: 'codex',
      status: 'completed',
      synthesized: true
    })
    messages = mergeMultiAgentTelemetryIntoMessages(messages, 'ma_1', { status: 'working' })
    expect(messages[0].toolActivities?.[0].multiAgentSummary).toMatchObject({
      status: 'completed',
      synthesized: true
    })
  })

  it('is a reference-stable no-op when nothing matches', () => {
    const messages = [messageWithAnchor('ma_1')]
    expect(mergeMultiAgentTelemetryIntoMessages(messages, 'missing', { status: 'working' })).toBe(
      messages
    )
    expect(mergeMultiAgentTelemetryIntoMessages(messages, '', { status: 'working' })).toBe(messages)
    expect(mergeMultiAgentTelemetryIntoMessages(messages, 'ma_1', null)).toBe(messages)
  })
})
