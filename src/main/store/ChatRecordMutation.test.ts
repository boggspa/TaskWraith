import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun, ToolActivity } from './types'
import {
  applyChatRecordMutation,
  deriveChatRecordMutation,
  deriveChatRecordMutationWithProjection,
  estimateChatRecordMutationBytes,
  rebaseChatRecordUpdate
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

  it('authors append/update/delete transport operations during the same mutation walk', () => {
    const before = chat([message('m-1', 'one'), message('m-2', 'two'), message('m-3', 'three')])
    const after = advance(before, (next) => {
      next.messages.splice(1, 1)
      next.messages[1].content = 'three updated'
      next.messages.push(message('m-4', 'four'))
    })

    const derived = deriveChatRecordMutationWithProjection(before, after)

    expect(derived.transcriptOps).toEqual([
      { op: 'delete', id: 'm-2' },
      { op: 'update', id: 'm-3', message: message('m-3', 'three updated') },
      { op: 'append', messages: [message('m-4', 'four')] }
    ])
    expect(derived.changedMessageCount).toBe(3)
    expect(applyChatRecordMutation(before, derived.batch)).toEqual(after)
  })

  it('marks an insert-before-survivor for snapshot recovery', () => {
    const before = chat([message('m-1', 'one'), message('m-2', 'two')])
    const after = advance(before, (next) => {
      next.messages.splice(1, 0, message('m-new', 'inserted'))
    })

    const derived = deriveChatRecordMutationWithProjection(before, after)

    expect(derived.transcriptOps).toBeNull()
    expect(derived.changedMessageCount).toBe(1)
    expect(applyChatRecordMutation(before, derived.batch)).toEqual(after)
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

  it('rebases Desktop intent onto a Host-advanced record without losing Host messages or runs', () => {
    const base = chat([message('m-1', 'base')], [run('run-1')], 3, {
      ensemble: {
        enabled: true,
        maxParticipants: 8,
        participants: [
          {
            id: 'seat-1',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: '',
            order: 0,
            permissionPresetId: 'default'
          }
        ]
      },
      providerMetadata: { approvalMode: 'default' }
    })
    const desired = advance(base, (next) => {
      next.title = 'Desktop follow-up'
      next.ensemble = {
        ...next.ensemble!,
        activeRound: { roundId: 'round-2', status: 'running', participants: [] }
      } as never
      next.messages[0].content = 'desktop update'
      next.messages.push(message('m-desktop', 'desktop addition'))
      next.runs.push(run('run-desktop'))
    })
    const source = structuredClone(base)
    source.persistenceRevision = 7
    source.providerMetadata = { approvalMode: 'default', hostReceipt: 'preserve' } as never
    const sourceParticipant = source.ensemble!.participants[0] as unknown as Record<string, unknown>
    sourceParticipant.hostSession = 'preserve'
    source.messages[0].metadata = { host: true }
    source.messages.push(message('m-host', 'host addition'))
    source.runs[0].status = 'success'
    source.runs.push(run('run-host', 'success'))

    const rebased = rebaseChatRecordUpdate(base, desired, source)

    expect(rebased.persistenceRevision).toBe(8)
    expect(rebased.title).toBe('Desktop follow-up')
    expect(rebased.providerMetadata).toEqual({
      approvalMode: 'default',
      hostReceipt: 'preserve'
    })
    expect(rebased.messages.map((item) => item.id)).toEqual(['m-1', 'm-host', 'm-desktop'])
    expect(rebased.messages[0]).toMatchObject({
      content: 'desktop update',
      metadata: { host: true }
    })
    expect(rebased.runs.map((item) => item.runId)).toEqual(['run-1', 'run-host', 'run-desktop'])
    expect(rebased.runs[0].status).toBe('success')
    expect(rebased.ensemble?.activeRound?.roundId).toBe('round-2')
    expect(rebased.ensemble?.participants[0]).toMatchObject({ hostSession: 'preserve' })
  })

  it('fails closed when Desktop changed an item the Host removed', () => {
    const base = chat([message('m-1', 'base')], [], 3)
    const desired = advance(base, (next) => {
      next.messages[0].content = 'desktop update'
    })
    const source = { ...structuredClone(base), messages: [], persistenceRevision: 5 }

    expect(() => rebaseChatRecordUpdate(base, desired, source)).toThrow(/after Host removal/)
  })

  it('rebases independent tail appends across a large follow-up transcript', () => {
    const base = chat(
      Array.from({ length: 5_000 }, (_, index) => message(`m-${index}`, `historical-${index}`)),
      [],
      40
    )
    const desired = advance(base, (next) => {
      next.messages.push(message('m-desktop-follow-up', 'new user follow-up'))
    })
    const source = structuredClone(base)
    source.persistenceRevision = 43
    source.messages.push(message('m-host-terminal', 'prior Host terminal update'))

    const rebased = rebaseChatRecordUpdate(base, desired, source)

    expect(rebased.persistenceRevision).toBe(44)
    expect(rebased.messages).toHaveLength(5_002)
    expect(rebased.messages.slice(-2).map((item) => item.id)).toEqual([
      'm-host-terminal',
      'm-desktop-follow-up'
    ])
  })

  it('bounds recursive merging of unknown future record fields', () => {
    const nested = (leaf: string): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf }
      for (let depth = 0; depth < 66; depth += 1) value = { child: value }
      return value
    }
    const base = chat([], [], 3, { unknownFutureField: nested('base') } as never)
    const desired = advance(base, (next) => {
      const record = next as unknown as Record<string, unknown>
      record.unknownFutureField = nested('desired')
    })
    const source = { ...structuredClone(base), persistenceRevision: 5 }

    expect(() => rebaseChatRecordUpdate(base, desired, source)).toThrow(/depth exceeds/)
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
