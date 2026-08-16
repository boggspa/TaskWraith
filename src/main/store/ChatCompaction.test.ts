import { describe, expect, it } from 'vitest'
import {
  CHAT_HISTORY_COMPACTION_GENERATION,
  compactChatForPersist,
  protectedRunIds
} from './ChatCompaction'
import type { ChatRecord, ChatMessage, ToolActivity } from './types'

const BIG = 'A'.repeat(80_000) // > default 64K image threshold
const fakeThumbnail = (): { data: string; mimeType: string } => ({
  data: 'tiny-jpeg',
  mimeType: 'image/jpeg'
})

function imageResult(data: string = BIG): unknown {
  return { content: [{ type: 'image', mimeType: 'image/png', data }] }
}

function activity(partial: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: `act-${Math.random().toString(36).slice(2)}`,
    toolName: 'attached_window_capture',
    displayName: 'Capture',
    category: 'read',
    status: 'success',
    startedAt: '2026-06-01T00:00:00.000Z',
    ...partial
  } as ToolActivity
}

function toolMessage(runId: string, activities: ToolActivity[]): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'tool',
    content: '',
    timestamp: '2026-06-01T00:00:00.000Z',
    runId,
    toolActivities: activities
  } as ChatMessage
}

function chat(
  messages: ChatMessage[],
  runs: Array<{ runId: string; status?: string }>
): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'T',
    workspaceId: 'ws',
    workspacePath: '/ws',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages,
    runs: runs as ChatRecord['runs']
  } as ChatRecord
}

describe('compactChatForPersist', () => {
  it('thumbnails historical inline images in place and drops text raw events', () => {
    const old = activity({
      rawResultEvent: imageResult(),
      rawUseEvent: { type: 'tool_use', huge: BIG }
    })
    const textOnly = activity({
      rawResultEvent: { output: 'plain text result' },
      rawUseEvent: { type: 'tool_use' }
    })
    const record = chat(
      [toolMessage('run-old', [old, textOnly]), toolMessage('run-new', [activity()])],
      [
        { runId: 'run-old', status: 'completed' },
        { runId: 'run-new', status: 'completed' }
      ]
    )
    const compacted = compactChatForPersist(record, { thumbnail: fakeThumbnail })
    const [oldMsg] = compacted.messages
    const [imgAct, textAct] = oldMsg.toolActivities!
    const block = (imgAct.rawResultEvent as { content: Record<string, unknown>[] }).content[0]
    expect(block.data).toBe('tiny-jpeg')
    expect(block.mimeType).toBe('image/jpeg')
    expect(block.compacted).toBe(true)
    expect(block.type).toBe('image') // renderer block shape preserved
    expect(imgAct.rawUseEvent).toBeUndefined()
    expect(textAct.rawResultEvent).toBeUndefined()
    expect(textAct.rawUseEvent).toBeUndefined()
  })

  it('protects the latest run and running runs', () => {
    const latest = activity({ rawResultEvent: imageResult(), rawUseEvent: { keep: true } })
    const running = activity({ rawResultEvent: { output: 'text' }, rawUseEvent: { keep: true } })
    const record = chat(
      [toolMessage('run-live', [running]), toolMessage('run-latest', [latest])],
      [
        { runId: 'run-live', status: 'running' },
        { runId: 'run-latest', status: 'completed' }
      ]
    )
    const compacted = compactChatForPersist(record, { thumbnail: fakeThumbnail })
    expect(compacted.messages).toBe(record.messages)
    expect(compacted.unattributedHistoryCompactionGeneration).toBe(
      CHAT_HISTORY_COMPACTION_GENERATION
    )
    expect(compactChatForPersist(compacted, { thumbnail: fakeThumbnail })).toBe(compacted)
  })

  it('keeps chats without runs[] untouched', () => {
    const orphan = { ...toolMessage('x', [activity({ rawUseEvent: { keep: true } })]) }
    delete (orphan as Record<string, unknown>).runId
    const noRuns = chat([orphan], [])
    expect(compactChatForPersist(noRuns, { thumbnail: fakeThumbnail })).toBe(noRuns)
  })

  it('compacts legacy unattributed messages older than the latest run, protects newer ones', () => {
    // Pre-T36 chats stamped no runId on tool messages — time decides instead.
    const runStart = Date.parse('2026-06-10T12:00:00.000Z')
    const oldMsg = {
      ...toolMessage('x', [activity({ rawUseEvent: { spam: true } })]),
      timestamp: '2026-06-09T00:00:00.000Z'
    }
    const newMsg = {
      ...toolMessage('x', [activity({ rawUseEvent: { keep: true } })]),
      timestamp: '2026-06-10T13:00:00.000Z'
    }
    delete (oldMsg as Record<string, unknown>).runId
    delete (newMsg as Record<string, unknown>).runId
    const record = chat(
      [oldMsg, newMsg],
      [{ runId: 'run-1', status: 'completed', startedAt: '2026-06-10T12:00:00.000Z' } as never]
    )
    const compacted = compactChatForPersist(record, {
      thumbnail: fakeThumbnail,
      now: runStart + 60 * 60 * 1000
    })
    expect(compacted.messages[0].toolActivities![0].rawUseEvent).toBeUndefined()
    expect(compacted.messages[1].toolActivities![0].rawUseEvent).toEqual({ keep: true })
  })

  it('amortizes image work via the per-pass budget and resumes next save', () => {
    const acts = [
      activity({ rawResultEvent: imageResult() }),
      activity({ rawResultEvent: imageResult() }),
      activity({ rawResultEvent: imageResult() })
    ]
    const record = chat(
      [toolMessage('run-old', acts), toolMessage('run-new', [activity()])],
      [
        { runId: 'run-old', status: 'completed' },
        { runId: 'run-new', status: 'completed' }
      ]
    )
    const first = compactChatForPersist(record, { thumbnail: fakeThumbnail, maxImagesPerPass: 2 })
    const firstBlocks = first.messages[0].toolActivities!.map(
      (a) => (a.rawResultEvent as { content: Record<string, unknown>[] }).content[0]
    )
    expect(firstBlocks.filter((b) => b.compacted === true)).toHaveLength(2)
    expect(first.runs[0].historyCompactionGeneration).toBeUndefined()
    const second = compactChatForPersist(first, { thumbnail: fakeThumbnail, maxImagesPerPass: 2 })
    const secondBlocks = second.messages[0].toolActivities!.map(
      (a) => (a.rawResultEvent as { content: Record<string, unknown>[] }).content[0]
    )
    expect(secondBlocks.filter((b) => b.compacted === true)).toHaveLength(3)
    expect(second.runs[0].historyCompactionGeneration).toBe(CHAT_HISTORY_COMPACTION_GENERATION)
    // Third pass: everything marked → steady-state no-op, same reference.
    const third = compactChatForPersist(second, { thumbnail: fakeThumbnail, maxImagesPerPass: 2 })
    expect(third).toBe(second)
  })

  it('does not iterate the transcript after historical generations are stamped', () => {
    const record = chat(
      [
        toolMessage('run-old', [activity({ rawUseEvent: { remove: true } })]),
        toolMessage('run-latest', [activity()])
      ],
      [
        { runId: 'run-old', status: 'completed' },
        { runId: 'run-latest', status: 'completed' }
      ]
    )
    const compacted = compactChatForPersist(record, { thumbnail: fakeThumbnail })
    expect(compacted.runs[0].historyCompactionGeneration).toBe(CHAT_HISTORY_COMPACTION_GENERATION)
    const guardedMessages = new Proxy(compacted.messages, {
      get(target, property, receiver) {
        if (
          property === Symbol.iterator ||
          property === 'map' ||
          (typeof property === 'string' && /^\d+$/.test(property))
        ) {
          throw new Error('steady-state compaction iterated the transcript')
        }
        return Reflect.get(target, property, receiver)
      }
    })
    const guarded = { ...compacted, messages: guardedMessages }

    expect(compactChatForPersist(guarded, { thumbnail: fakeThumbnail })).toBe(guarded)
  })

  it('compacts and stamps only the run that newly became historical', () => {
    const oldMessage = toolMessage('run-old', [activity({ rawUseEvent: { already: true } })])
    const latestMessage = toolMessage('run-latest', [
      activity({ rawUseEvent: { newlyHistorical: true } })
    ])
    const initial = compactChatForPersist(
      chat(
        [oldMessage, latestMessage],
        [
          { runId: 'run-old', status: 'completed' },
          { runId: 'run-latest', status: 'completed' }
        ]
      ),
      { thumbnail: fakeThumbnail }
    )
    const withNextRun = {
      ...initial,
      runs: [
        ...initial.runs,
        {
          runId: 'run-next',
          status: 'running',
          startedAt: '2026-06-02T00:00:00.000Z'
        }
      ]
    }
    const compacted = compactChatForPersist(withNextRun, { thumbnail: fakeThumbnail })

    expect(compacted.messages[0]).toBe(initial.messages[0])
    expect(compacted.messages[1].toolActivities![0].rawUseEvent).toBeUndefined()
    expect(compacted.runs[1].historyCompactionGeneration).toBe(CHAT_HISTORY_COMPACTION_GENERATION)
    expect(compacted.runs[2].historyCompactionGeneration).toBeUndefined()
  })

  it('parses JSON-stringified raw results and processes their images', () => {
    const old = activity({ rawResultEvent: JSON.stringify(imageResult()) })
    const record = chat(
      [toolMessage('run-old', [old]), toolMessage('run-new', [activity()])],
      [
        { runId: 'run-old', status: 'completed' },
        { runId: 'run-new', status: 'completed' }
      ]
    )
    const compacted = compactChatForPersist(record, { thumbnail: fakeThumbnail })
    const raw = compacted.messages[0].toolActivities![0].rawResultEvent as {
      content: Record<string, unknown>[]
    }
    expect(raw.content[0].data).toBe('tiny-jpeg')
  })

  it('marks unprocessable images as compacted so they are never retried', () => {
    const old = activity({ rawResultEvent: imageResult() })
    const record = chat(
      [toolMessage('run-old', [old]), toolMessage('run-new', [activity()])],
      [
        { runId: 'run-old', status: 'completed' },
        { runId: 'run-new', status: 'completed' }
      ]
    )
    const compacted = compactChatForPersist(record, { thumbnail: () => null })
    const block = (
      compacted.messages[0].toolActivities![0].rawResultEvent as {
        content: Record<string, unknown>[]
      }
    ).content[0]
    expect(block.compacted).toBe(true)
    expect(block.data).toBe(BIG) // original kept when conversion fails
  })

  it('dedupes the legacy summary triplication', () => {
    const old = activity({
      resultSummary: 'same text',
      outputPreview: 'same text',
      outputSummary: 'same text'
    })
    const record = chat(
      [toolMessage('run-old', [old]), toolMessage('run-new', [activity()])],
      [
        { runId: 'run-old', status: 'completed' },
        { runId: 'run-new', status: 'completed' }
      ]
    )
    const compacted = compactChatForPersist(record, { thumbnail: fakeThumbnail })
    const act = compacted.messages[0].toolActivities![0]
    expect(act.resultSummary).toBe('same text')
    expect(act.outputPreview).toBeUndefined()
    expect(act.outputSummary).toBeUndefined()
  })
})

describe('protectedRunIds', () => {
  it('protects the last run and every non-terminal run', () => {
    const record = chat(
      [],
      [
        { runId: 'a', status: 'completed' },
        { runId: 'b', status: 'running' },
        { runId: 'c', status: 'failed' },
        { runId: 'd', status: 'completed' }
      ]
    )
    const ids = protectedRunIds(record)
    expect(ids.has('b')).toBe(true)
    expect(ids.has('d')).toBe(true)
    expect(ids.has('a')).toBe(false)
    expect(ids.has('c')).toBe(false)
  })
})
