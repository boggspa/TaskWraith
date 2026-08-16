import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun, ToolActivity } from './types'
import {
  applyChatRecordMutation,
  deriveChatRecordMutation,
  estimateChatRecordMutationBytes
} from './ChatRecordMutation'

function message(id: string, content: string, toolActivities?: ToolActivity[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-08-16T00:00:00.000Z',
    ...(toolActivities ? { toolActivities } : {})
  }
}

function run(runId: string, status = 'running'): ChatRun {
  return {
    runId,
    startedAt: '2026-08-16T00:00:00.000Z',
    status
  }
}

function activity(id: string, resultSummary: string): ToolActivity {
  return {
    id,
    toolName: 'exec_command',
    displayName: 'Run command',
    category: 'shell',
    status: 'success',
    parameters: { command: 'npm test', cwd: '/workspace' },
    resultSummary
  }
}

function chat(
  messages: ChatMessage[],
  runs: ChatRun[] = [],
  revision = 1,
  overrides: Partial<ChatRecord> = {}
): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Performance chat',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    messages,
    runs,
    persistenceRevision: revision,
    ...overrides
  }
}

function advance(source: ChatRecord, mutate: (next: ChatRecord) => void): ChatRecord {
  const next = structuredClone(source)
  mutate(next)
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  next.updatedAt += 1
  return next
}

describe('ChatRecordMutation', () => {
  it('encodes streamed text as an append and replays to exact chat state', () => {
    const before = chat([message('assistant-1', 'Hello')])
    const after = advance(before, (next) => {
      next.messages[0].content = 'Hello from the streaming provider'
    })

    const batch = deriveChatRecordMutation(before, after, {
      savedAt: '2026-08-16T00:00:01.000Z'
    })

    expect(batch.operations).toContainEqual({
      type: 'message_content_append',
      messageId: 'assistant-1',
      content: ' from the streaming provider'
    })
    expect(batch).not.toHaveProperty('record')
    expect(applyChatRecordMutation(before, batch)).toEqual(after)
  })

  it('journals tool inserts and updates without replacing the transcript', () => {
    const first = activity('tool-1', 'initial')
    const before = chat([message('assistant-1', '', [first])])
    const after = advance(before, (next) => {
      next.messages[0].toolActivities![0].resultSummary = 'expanded result summary'
      next.messages[0].toolActivities!.push(activity('tool-2', 'second result'))
    })

    const batch = deriveChatRecordMutation(before, after)

    expect(batch.operations.map((operation) => operation.type)).toContain('tool_activity_put')
    expect(batch.operations.map((operation) => operation.type)).toContain('tool_activities_splice')
    expect(batch.operations.map((operation) => operation.type)).not.toContain('messages_splice')
    expect(applyChatRecordMutation(before, batch)).toEqual(after)
  })

  it('preserves absent versus empty tool arrays through replay', () => {
    const absent = chat([message('assistant-1', '')])
    const empty = advance(absent, (next) => {
      next.messages[0].toolActivities = []
    })
    const removed = advance(empty, (next) => {
      delete next.messages[0].toolActivities
    })

    const addPresence = deriveChatRecordMutation(absent, empty)
    const removePresence = deriveChatRecordMutation(empty, removed)

    expect(applyChatRecordMutation(absent, addPresence).messages[0]).toHaveProperty(
      'toolActivities',
      []
    )
    expect(applyChatRecordMutation(empty, removePresence).messages[0]).not.toHaveProperty(
      'toolActivities'
    )
  })

  it('replays message insertion/deletion and run append/update exactly', () => {
    const before = chat(
      [message('m-1', 'one'), message('m-2', 'two'), message('m-3', 'three')],
      [run('run-1')]
    )
    const after = advance(before, (next) => {
      next.messages.splice(1, 1, message('m-new', 'replacement'))
      next.runs[0].status = 'success'
      next.runs[0].endedAt = '2026-08-16T00:00:02.000Z'
      next.runs.push(run('run-2'))
    })

    const batch = deriveChatRecordMutation(before, after)

    expect(batch.operations.map((operation) => operation.type)).toEqual(
      expect.arrayContaining(['messages_splice', 'runs_splice', 'run_put'])
    )
    expect(applyChatRecordMutation(before, batch)).toEqual(after)
  })

  it('patches and clears non-transcript record fields', () => {
    const before = chat([message('m-1', 'hello')], [], 7, {
      archived: true,
      requestedModel: 'old-model'
    })
    const after = advance(before, (next) => {
      next.title = 'Renamed'
      next.archived = false
      delete next.requestedModel
    })

    const batch = deriveChatRecordMutation(before, after)
    const recordPatch = batch.operations.find((operation) => operation.type === 'record_patch')

    expect(recordPatch).toMatchObject({
      type: 'record_patch',
      set: { title: 'Renamed', archived: false },
      clear: expect.arrayContaining(['requestedModel'])
    })
    expect(applyChatRecordMutation(before, batch)).toEqual(after)
  })

  it('rejects replay against the wrong base revision', () => {
    const before = chat([message('m-1', 'before')], [], 3)
    const after = advance(before, (next) => {
      next.messages[0].content = 'after'
    })
    const batch = deriveChatRecordMutation(before, after)
    const stale = { ...before, persistenceRevision: 2 }

    expect(() => applyChatRecordMutation(stale, batch)).toThrow(/revision mismatch/)
  })

  it('keeps a streamed append bounded independently of transcript history size', () => {
    const messages = Array.from({ length: 5_000 }, (_, index) =>
      message(`message-${index}`, `historical-${index}-${'x'.repeat(100)}`)
    )
    const before = chat(messages)
    const after = advance(before, (next) => {
      next.messages[next.messages.length - 1].content += ' streamed-tail'
    })

    const batch = deriveChatRecordMutation(before, after)
    const mutationBytes = estimateChatRecordMutationBytes(batch)
    const fullRecordBytes = Buffer.byteLength(JSON.stringify(after), 'utf8')

    expect(batch.operations).toHaveLength(2)
    expect(batch.operations[1]).toMatchObject({ type: 'message_content_append' })
    expect(mutationBytes).toBeLessThan(1_000)
    expect(mutationBytes * 500).toBeLessThan(fullRecordBytes)
  })
})
