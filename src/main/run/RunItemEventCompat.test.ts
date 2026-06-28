import { describe, expect, it } from 'vitest'
import { RunItemEventCompatMapper, type CompatRunItemIdentity } from './RunItemEventCompat'

const identity: CompatRunItemIdentity = {
  chatId: 'chat-1',
  runId: 'run-1',
  provider: 'codex',
  providerSessionId: 'thread-1'
}

describe('RunItemEventCompatMapper', () => {
  it('projects assistant content into item start/delta/completed events with stable identity', () => {
    const mapper = new RunItemEventCompatMapper()

    const first = mapper.createEvents(identity, {
      type: 'content',
      text: 'Hel',
      itemId: 'item-a',
      provider: 'codex'
    }, '2026-06-29T00:00:00.000Z')
    const second = mapper.createEvents(identity, {
      type: 'content',
      text: 'lo',
      itemId: 'item-a',
      complete: true,
      provider: 'codex'
    }, '2026-06-29T00:00:01.000Z')

    expect(first.map((event) => event.kind)).toEqual(['item/started', 'item/delta'])
    expect(second.map((event) => event.kind)).toEqual(['item/delta', 'item/completed'])
    expect([...first, ...second].map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(first[0]).toMatchObject({
      protocolVersion: 1,
      chatId: 'chat-1',
      runId: 'run-1',
      provider: 'codex',
      providerSessionId: 'thread-1',
      itemId: 'item-a'
    })
  })

  it('preserves provider snapshot semantics as cumulative item deltas', () => {
    const mapper = new RunItemEventCompatMapper()
    const events = mapper.createEvents(identity, {
      type: 'content',
      text: 'whole snapshot',
      provider: 'cursor',
      runItemCumulative: true
    })

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      kind: 'item/delta',
      channel: 'assistant',
      cumulative: true,
      delta: 'whole snapshot',
      itemId: 'run-1:assistant'
    })
  })

  it('projects tool use/result pairs onto tool progress/output events', () => {
    const mapper = new RunItemEventCompatMapper()
    const use = mapper.createEvents(identity, {
      type: 'tool_use',
      tool_id: 'tool-1',
      tool_name: 'read_file',
      parameters: { path: 'README.md' }
    })
    const result = mapper.createEvents(identity, {
      type: 'tool_result',
      tool_id: 'tool-1',
      tool_name: 'read_file',
      status: 'success',
      output: 'contents'
    })

    expect(use.map((event) => event.kind)).toEqual(['item/started', 'tool/progress'])
    expect(result.map((event) => event.kind)).toEqual(['tool/outputDelta'])
    expect(result[0]).toMatchObject({
      itemId: 'tool-1',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      delta: 'contents'
    })
  })

  it('pairs id-less tool results with the most recent matching id-less tool use', () => {
    const mapper = new RunItemEventCompatMapper()
    const use = mapper.createEvents(identity, {
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: { path: 'README.md' }
    })
    const result = mapper.createEvents(identity, {
      type: 'tool_result',
      tool_name: 'read_file',
      output: 'contents'
    })

    const useProgress = use.find((event) => event.kind === 'tool/progress')
    expect(useProgress?.itemId).toBe('run-1:tool-1')
    expect(result[0]).toMatchObject({
      kind: 'tool/outputDelta',
      itemId: useProgress?.itemId,
      toolCallId: useProgress?.itemId
    })
  })

  it('clears per-run sequence and item-start state on completion', () => {
    const mapper = new RunItemEventCompatMapper()
    mapper.createEvents(identity, { type: 'content', text: 'A', itemId: 'item-a' })
    mapper.completeRun('run-1')

    const events = mapper.createEvents(identity, { type: 'content', text: 'B', itemId: 'item-a' })

    expect(events.map((event) => event.kind)).toEqual(['item/started', 'item/delta'])
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
  })

  it('emits only one run/completed event for result plus exit-style drafts', () => {
    const mapper = new RunItemEventCompatMapper()
    const result = mapper.createEvents(identity, {
      type: 'result',
      status: 'success',
      stats: { duration_ms: 100 }
    })
    const exit = mapper.createDraftEvents(identity, [
      {
        kind: 'run/completed',
        itemKind: 'run',
        status: 'success',
        exitCode: 0
      }
    ])

    expect(result.map((event) => event.kind)).toEqual(['run/completed'])
    expect(exit).toEqual([])
  })
})
