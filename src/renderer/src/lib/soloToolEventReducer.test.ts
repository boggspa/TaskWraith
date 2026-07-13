import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { reduceSoloToolEventMessages } from './soloToolEventReducer'

const NOW = '2026-06-13T00:00:00.000Z'

function reduce(messages: ChatMessage[], event: any) {
  return reduceSoloToolEventMessages(messages, event, {
    createMessageId: () => 'tool-message-1',
    nowIso: () => NOW
  })
}

describe('reduceSoloToolEventMessages', () => {
  it('creates a tool message for a solo tool_use event', () => {
    const result = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: {
        type: 'tool_use',
        tool_id: 'call-1',
        tool_name: 'mcp_TaskWraith_git_status',
        parameters: {}
      }
    })

    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      id: 'tool-message-1',
      role: 'tool',
      timestamp: NOW
    })
    expect(result.messages[0].toolActivities?.[0]).toMatchObject({
      id: 'call-1',
      toolName: 'mcp_TaskWraith_git_status',
      displayName: 'Git status',
      status: 'running'
    })
    expect(result.latestToolActivity?.id).toBe('call-1')
    expect(result.isResult).toBe(false)
  })

  it('preserves provider attribution from solo tool events and reducer fallback', () => {
    const fromEvent = reduce([], {
      type: 'tool_event',
      provider: 'cursor',
      isUse: true,
      data: {
        type: 'tool_use',
        tool_id: 'call-provider-event',
        tool_name: 'read_file',
        parameters: {}
      }
    })
    expect(fromEvent.messages[0].toolActivities?.[0].metadata).toMatchObject({
      provider: 'cursor'
    })

    const fromFallback = reduceSoloToolEventMessages(
      [],
      {
        type: 'tool_event',
        isUse: true,
        data: {
          type: 'tool_use',
          tool_id: 'call-provider-fallback',
          tool_name: 'workspace_search',
          parameters: {}
        }
      },
      {
        createMessageId: () => 'tool-message-provider-fallback',
        nowIso: () => NOW,
        provider: 'ollama'
      }
    )
    expect(fromFallback.messages[0].toolActivities?.[0].metadata).toMatchObject({
      provider: 'ollama'
    })
  })

  it('stamps newly projected tool messages with their owning run id', () => {
    const result = reduceSoloToolEventMessages(
      [],
      {
        type: 'tool_event',
        isUse: true,
        data: {
          type: 'tool_use',
          tool_id: 'call-run-owned',
          tool_name: 'write_file',
          parameters: { path: 'sentinel.txt', content: 'owned' }
        }
      },
      {
        createMessageId: () => 'tool-message-run-owned',
        nowIso: () => NOW,
        runId: 'run-123'
      }
    )

    expect(result.messages[0].runId).toBe('run-123')
  })

  it('pairs a solo tool_result with the existing tool activity', () => {
    const first = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: {
        type: 'tool_use',
        tool_id: 'call-1',
        tool_name: 'read_file',
        parameters: { file_path: 'README.md' }
      }
    })
    const second = reduce(first.messages, {
      type: 'tool_event',
      isResult: true,
      data: {
        type: 'tool_result',
        tool_id: 'call-1',
        content: 'ok'
      }
    })

    expect(second.messages).toHaveLength(1)
    expect(second.messages[0].toolActivities).toHaveLength(1)
    expect(second.messages[0].toolActivities?.[0]).toMatchObject({
      id: 'call-1',
      toolName: 'read_file',
      status: 'success',
      resultSummary: 'ok'
    })
    expect(second.latestToolActivity?.status).toBe('success')
    expect(second.isResult).toBe(true)
  })

  it('appends a tool row AFTER trailing assistant text (true stream order)', () => {
    // The assistant text streamed first, then the tool ran — the tool card
    // belongs below the text, not pushed above it.
    const messages: ChatMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'I will check that.',
        timestamp: NOW
      }
    ]
    const result = reduce(messages, {
      type: 'tool_event',
      isUse: true,
      data: {
        type: 'tool_use',
        tool_id: 'call-1',
        tool_name: 'workspace_search',
        parameters: { query: 'needle' }
      }
    })

    expect(result.messages.map((message) => message.role)).toEqual(['assistant', 'tool'])
    expect(result.messages[0].id).toBe('assistant-1')
    expect(result.messages[1].toolActivities?.[0]?.id).toBe('call-1')
  })

  it('starts a NEW tool row when a tool burst is separated from a prior tool burst by assistant text', () => {
    // [tool burst 1] -> assistant text -> [new tool] must stay as TWO tool
    // groups in order. Reaching back past the assistant to merge into the
    // first burst is exactly the interleaving regression this guards against.
    const messages: ChatMessage[] = [
      {
        id: 'tool-1',
        role: 'tool',
        content: '',
        timestamp: NOW,
        toolActivities: [
          {
            id: 'call-1',
            toolName: 'read_file',
            displayName: 'Read file',
            status: 'success'
          } as any
        ]
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Found it. Now editing.',
        timestamp: NOW
      }
    ]
    const result = reduce(messages, {
      type: 'tool_event',
      isUse: true,
      data: {
        type: 'tool_use',
        tool_id: 'call-2',
        tool_name: 'edit_file',
        parameters: { file_path: 'a.ts' }
      }
    })

    // Three messages in stream order: tools, text, tools — NOT [tools+tools, text].
    expect(result.messages.map((message) => message.role)).toEqual(['tool', 'assistant', 'tool'])
    expect(result.messages[0].id).toBe('tool-1')
    expect(result.messages[0].toolActivities).toHaveLength(1)
    expect(result.messages[0].toolActivities?.[0]?.id).toBe('call-1')
    expect(result.messages[1].id).toBe('assistant-1')
    expect(result.messages[2].toolActivities).toHaveLength(1)
    expect(result.messages[2].toolActivities?.[0]?.id).toBe('call-2')
  })

  it('collapses consecutive tool events (no text between) into one row', () => {
    // The desirable collapse: back-to-back tools with no assistant text
    // between them stay in a single ActivityStack group.
    const first = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'call-1', tool_name: 'read_file', parameters: {} }
    })
    const second = reduce(first.messages, {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'call-2', tool_name: 'grep', parameters: {} }
    })

    expect(second.messages).toHaveLength(1)
    expect(second.messages[0].role).toBe('tool')
    expect(second.messages[0].toolActivities?.map((a) => a.id)).toEqual(['call-1', 'call-2'])
  })

  it('creates a paired orphan activity when a result arrives without its use event', () => {
    const result = reduce([], {
      type: 'tool_event',
      name: 'read_file',
      isResult: true,
      data: {
        type: 'tool_result',
        tool_id: 'missing-call',
        content: 'late result'
      }
    })

    expect(result.messages[0].toolActivities?.[0]).toMatchObject({
      id: 'missing-call',
      toolName: 'read_file',
      status: 'success',
      resultSummary: 'late result'
    })
    expect(result.isResult).toBe(true)
  })
})

describe('chronology-preserving result pairing', () => {
  const assistant = (id: string, content: string): ChatMessage => ({
    id,
    role: 'assistant',
    content,
    timestamp: NOW
  })
  const system = (id: string, content: string): ChatMessage => ({
    id,
    role: 'system',
    content,
    timestamp: NOW
  })
  const user = (id: string): ChatMessage => ({
    id,
    role: 'user',
    content: 'go',
    timestamp: NOW
  })

  it('pairs a result to its ORIGINAL stack across an intervening assistant bubble', () => {
    const afterUse = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'call-1', tool_name: 'run_shell_command', parameters: {} }
    })
    const withText = [...afterUse.messages, assistant('a-1', 'meanwhile, some prose')]
    const afterResult = reduce(withText, {
      type: 'tool_event',
      isResult: true,
      data: { type: 'tool_result', tool_id: 'call-1', content: 'done' }
    })

    // No new tool row after the text — the result settles the ORIGINAL
    // activity in place, exactly where the call rendered.
    expect(afterResult.messages).toHaveLength(2)
    expect(afterResult.messages[0].toolActivities?.[0]).toMatchObject({
      id: 'call-1',
      status: 'success'
    })
    expect(afterResult.messages[1]).toBe(withText[1])
    expect(afterResult.isResult).toBe(true)
  })

  it('pairs across an intervening system card too', () => {
    const afterUse = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'call-1', tool_name: 'read_file', parameters: {} }
    })
    const withSystem = [...afterUse.messages, system('s-1', 'Context compacted.')]
    const afterResult = reduce(withSystem, {
      type: 'tool_event',
      isResult: true,
      data: { type: 'tool_result', tool_id: 'call-1', content: 'file body' }
    })

    expect(afterResult.messages).toHaveLength(2)
    expect(afterResult.messages[0].toolActivities?.[0]).toMatchObject({
      id: 'call-1',
      status: 'success',
      resultSummary: 'file body'
    })
  })

  it('never reaches back across a USER message (turn boundary)', () => {
    const previousTurn = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'stale-call', tool_name: 'grep', parameters: {} }
    })
    const nextTurn = [...previousTurn.messages, user('u-1')]
    const result = reduce(nextTurn, {
      type: 'tool_event',
      name: 'grep',
      isResult: true,
      data: { type: 'tool_result', tool_id: 'stale-call', content: 'late' }
    })

    // The previous turn's activity is untouched; the late result orphans
    // into a fresh tail row instead of rewriting history.
    expect(result.messages[0].toolActivities?.[0].status).toBe('running')
    expect(result.messages).toHaveLength(3)
    expect(result.messages[2].role).toBe('tool')
    expect(result.messages[2].toolActivities?.[0]).toMatchObject({ id: 'stale-call' })
  })

  it('keeps a NEW tool burst after text in its own row (interleaving preserved)', () => {
    const afterUse = reduce([], {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'call-1', tool_name: 'read_file', parameters: {} }
    })
    const withText = [...afterUse.messages, assistant('a-1', 'prose between bursts')]
    const secondBurst = reduce(withText, {
      type: 'tool_event',
      isUse: true,
      data: { type: 'tool_use', tool_id: 'call-2', tool_name: 'grep', parameters: {} }
    })

    expect(secondBurst.messages).toHaveLength(3)
    expect(secondBurst.messages[2].role).toBe('tool')
    expect(secondBurst.messages[2].toolActivities?.map((a) => a.id)).toEqual(['call-2'])
  })
})
