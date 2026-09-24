import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../store/types'
import {
  appendTimelineContent,
  appendTimelineTool,
  isRunTimelineMessage,
  laneTranscriptMetadata,
  runTimelineInsertionIndex,
  timelineMessageId
} from './EnsembleTimelineOrdering'
import type { TimelineOrderingRun } from './EnsembleTimelineOrdering'

function testRun(overrides: Partial<TimelineOrderingRun> = {}): TimelineOrderingRun {
  return {
    runId: 'run-1',
    roundId: 'round-1',
    assistantMessageId: 'assistant-1',
    participant: { id: 'p1', order: 1 },
    ...overrides
  }
}

function testMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'hello',
    timestamp: '2026-09-05T00:00:00.000Z',
    ...overrides
  }
}

function laneMessage(runId: string, laneId: string, order: number): ChatMessage {
  return testMessage({
    id: `lane-msg-${laneId}`,
    runId,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: 'round-1',
      ensembleFanoutWaveId: 'wave-1',
      ensembleLaneId: laneId,
      ensembleOrder: order,
      ensembleParticipantId: `participant-${laneId}`
    }
  })
}

describe('timelineMessageId', () => {
  it('builds stable content and tool ids', () => {
    expect(timelineMessageId('run-1', 0, 'content')).toBe('ensemble-content-run-1-0')
    expect(timelineMessageId('run-1', 2, 'tool')).toBe('ensemble-tool-run-1-2')
  })

  it('resolves the same entry to the same id across flush passes', () => {
    expect(timelineMessageId('run-9', 4, 'content')).toBe(timelineMessageId('run-9', 4, 'content'))
  })
})

describe('appendTimelineContent', () => {
  it('initializes the timeline on first append', () => {
    const run = testRun()
    appendTimelineContent(run, 'hello')
    expect(run.timeline).toEqual([{ kind: 'content', text: 'hello' }])
  })

  it('merges consecutive content into one entry', () => {
    const run = testRun()
    appendTimelineContent(run, 'hello ')
    appendTimelineContent(run, 'world')
    expect(run.timeline).toEqual([{ kind: 'content', text: 'hello world' }])
  })

  it('starts a fresh entry when forced and resets the flag', () => {
    const run = testRun()
    appendTimelineContent(run, 'first')
    run.forceNextTimelineContentEntry = true
    appendTimelineContent(run, 'second')
    expect(run.timeline).toEqual([
      { kind: 'content', text: 'first' },
      { kind: 'content', text: 'second' }
    ])
    expect(run.forceNextTimelineContentEntry).toBe(false)
  })
})

describe('appendTimelineTool', () => {
  it('initializes the timeline when absent', () => {
    const run = testRun()
    appendTimelineTool(run, 'tool-1')
    expect(run.timeline).toEqual([{ kind: 'tool', toolId: 'tool-1' }])
  })

  it('interleaves speak, tool, speak entries in chronology', () => {
    const run = testRun()
    appendTimelineContent(run, 'before ')
    appendTimelineContent(run, 'tool')
    appendTimelineTool(run, 'tool-1')
    appendTimelineContent(run, 'after')
    expect(run.timeline).toEqual([
      { kind: 'content', text: 'before tool' },
      { kind: 'tool', toolId: 'tool-1' },
      { kind: 'content', text: 'after' }
    ])
  })
})

describe('laneTranscriptMetadata', () => {
  it('returns empty metadata for runs without a lane', () => {
    expect(laneTranscriptMetadata(testRun())).toEqual({})
  })

  it('stamps lane identity and defaults intent to read', () => {
    const run = testRun({
      laneId: 'lane-1',
      fanoutWaveId: 'wave-1',
      fanoutLabel: 'recon',
      fanoutCategory: 'orchestrated'
    })
    expect(laneTranscriptMetadata(run)).toEqual({
      ensembleLaneId: 'lane-1',
      ensembleLaneIntent: 'read',
      ensembleFanoutWaveId: 'wave-1',
      ensembleFanoutLabel: 'recon',
      ensembleFanoutCategory: 'orchestrated'
    })
  })

  it('omits absent optional fanout fields and keeps an explicit intent', () => {
    const run = testRun({ laneId: 'lane-1', laneIntent: 'write' })
    expect(laneTranscriptMetadata(run)).toEqual({
      ensembleLaneId: 'lane-1',
      ensembleLaneIntent: 'write'
    })
  })
})

describe('isRunTimelineMessage', () => {
  it('matches stable content and tool ids', () => {
    const run = testRun()
    expect(
      isRunTimelineMessage(testMessage({ id: 'ensemble-content-run-1-0', runId: 'run-1' }), run)
    ).toBe(true)
    expect(
      isRunTimelineMessage(testMessage({ id: 'ensemble-tool-run-1-0', runId: 'run-1' }), run)
    ).toBe(true)
  })

  it('matches the legacy assistant message id', () => {
    const run = testRun()
    expect(isRunTimelineMessage(testMessage({ id: 'assistant-1', runId: 'run-1' }), run)).toBe(true)
  })

  it('rejects other runs, roles, and unrelated ids', () => {
    const run = testRun()
    expect(
      isRunTimelineMessage(testMessage({ id: 'ensemble-content-run-1-0', runId: 'run-2' }), run)
    ).toBe(false)
    expect(
      isRunTimelineMessage(
        testMessage({ id: 'ensemble-content-run-1-0', runId: 'run-1', role: 'user' }),
        run
      )
    ).toBe(false)
    expect(isRunTimelineMessage(testMessage({ id: 'unrelated', runId: 'run-1' }), run)).toBe(false)
  })
})

describe('runTimelineInsertionIndex', () => {
  it('appends at the tail when no messages are desired', () => {
    const messages = [testMessage({ id: 'a' }), testMessage({ id: 'b' })]
    expect(runTimelineInsertionIndex(messages, [], testRun(), 0)).toBe(2)
  })

  it('honors and clamps the preferred insertion index', () => {
    const messages = [testMessage({ id: 'a' }), testMessage({ id: 'b' })]
    const desired = [testMessage({ id: 'c' })]
    expect(runTimelineInsertionIndex(messages, desired, testRun(), 1)).toBe(1)
    expect(runTimelineInsertionIndex(messages, desired, testRun(), 99)).toBe(2)
    expect(runTimelineInsertionIndex(messages, desired, testRun(), -5)).toBe(0)
  })

  it('appends a serial run at the tail without dispatch order', () => {
    const messages = [testMessage({ id: 'a' })]
    const desired = [testMessage({ id: 'b' })]
    expect(runTimelineInsertionIndex(messages, desired, testRun())).toBe(1)
  })

  it('slots a serial run above later-dispatched lanes but below earlier ones', () => {
    const messages = [
      laneMessage('lane-old', 'lane-old', 0),
      laneMessage('lane-new', 'lane-new', 2)
    ]
    const desired = [testMessage({ id: 'boss' })]
    const dispatchOrder = new Map([
      ['lane-old', 0],
      ['run-1', 1],
      ['lane-new', 2]
    ])
    expect(runTimelineInsertionIndex(messages, desired, testRun(), null, dispatchOrder)).toBe(1)
  })

  it('inserts a lane in roster order within the tail cluster', () => {
    const messages = [laneMessage('lane-sibling', 'lane-sib', 5)]
    const desired = [testMessage({ id: 'first' })]
    const run = testRun({ laneId: 'lane-b', fanoutWaveId: 'wave-1' })
    expect(runTimelineInsertionIndex(messages, desired, run)).toBe(0)
  })

  it('never leapfrogs a serial row to reach a stale lane row', () => {
    const messages = [
      laneMessage('stale-run', 'lane-stale', 9),
      testMessage({ id: 'serial-live', runId: 'serial-1' })
    ]
    const desired = [testMessage({ id: 'first' })]
    const run = testRun({ laneId: 'lane-b', fanoutWaveId: 'wave-1' })
    expect(runTimelineInsertionIndex(messages, desired, run)).toBe(2)
  })
})
