import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun } from '../../../main/store/types'
import {
  buildEnsembleFanoutViewportRanges,
  coLocateUserFanoutLaneMessages,
  collectEnsembleFanoutViewportGroups,
  ensembleFanoutViewportStageLabel,
  isEnsembleFanoutViewportHeaderMessage,
  readEnsembleFanoutViewportHeader
} from './ensembleFanoutViewportGroups'
import { classifyFanoutLaneSlots } from './fanoutLanePairing'

function status(
  id: string,
  roundId: string,
  content: string,
  patch: Partial<NonNullable<ChatMessage['metadata']>> = {}
): ChatMessage {
  return {
    id,
    role: 'system',
    content,
    timestamp: `2026-08-02T12:00:0${id.length}.000Z`,
    metadata: { kind: 'ensembleRoundStatus', ensembleRoundId: roundId, ...patch }
  }
}

function lane(
  id: string,
  roundId: string,
  patch: Partial<NonNullable<ChatMessage['metadata']>> = {}
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `result-${id}`,
    timestamp: `2026-08-02T12:01:0${id.length}.000Z`,
    runId: `run-${id}`,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: roundId,
      ensembleParticipantId: id,
      ensembleLaneId: `lane-${id}`,
      ensembleLaneIntent: 'read',
      ensembleProvider: 'codex',
      ensembleRole: id,
      ensembleModel: 'gpt-5.6-sol',
      ensembleStatus: 'answered',
      ...patch
    }
  }
}

function serialTurn(id: string, roundId: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `serial-${id}`,
    timestamp: '2026-08-02T12:02:00.000Z',
    runId: `run-${id}`,
    metadata: {
      kind: 'ensembleParticipant',
      ensembleRoundId: roundId,
      ensembleParticipantId: id,
      ensembleProvider: 'claude',
      ensembleRole: 'Worker',
      ensembleStatus: 'running'
    }
  }
}

function failedLane(id: string, roundId: string, laneId = id): ChatMessage {
  return {
    id,
    role: 'system',
    content: `${id} failed.`,
    timestamp: '2026-08-02T12:01:30.000Z',
    runId: `run-${laneId}`,
    metadata: {
      kind: 'ensembleParticipantStatus',
      ensembleRoundId: roundId,
      ensembleParticipantId: laneId,
      ensembleLaneId: `lane-${laneId}`,
      ensembleLaneIntent: 'read',
      ensembleProvider: 'claude',
      ensembleRole: laneId,
      ensembleStageRole: 'scout',
      ensembleStatus: 'failed'
    }
  }
}

describe('fan-out disclosure groups', () => {
  it('recovers separate Scout and Review waves from durable dispatch receipts', () => {
    const roundId = 'round-1'
    const messages = [
      status(
        'legacy-shared-dispatch',
        roundId,
        'Scout fan-out · 2 read-only participants dispatched concurrently.'
      ),
      lane('scout-a', roundId, { ensembleStageRole: 'scout' }),
      lane('scout-b', roundId, {
        ensembleProvider: 'pi',
        ensembleModel: 'mistral/devstral-2512',
        ensembleStageRole: 'scout'
      }),
      status(
        'legacy-shared-dispatch',
        roundId,
        'Review wave · 1 read-only participants dispatched concurrently.'
      ),
      lane('review-a', roundId, { ensembleProvider: 'claude', ensembleStageRole: 'reviewer' })
    ]

    const groups = collectEnsembleFanoutViewportGroups('chat-1', roundId, messages)

    expect(groups.map((group) => group.stage)).toEqual(['scout', 'review'])
    expect(groups.map((group) => group.lanes.map((entry) => entry.message.id))).toEqual([
      ['scout-a', 'scout-b'],
      ['review-a']
    ])
    expect(groups[0].dispatchLabel).toBe('Scout fan-out')
    expect(new Set(groups.map((group) => group.viewportId)).size).toBe(2)
  })

  it('distinguishes All dispatches from explicitly specified parallel passes', () => {
    const roundId = 'round-2'
    const groups = collectEnsembleFanoutViewportGroups('chat-2', roundId, [
      status(
        'all-dispatch',
        roundId,
        'Ensemble fan-out · 1 participant(s) dispatched concurrently.'
      ),
      lane('all-a', roundId),
      status(
        'specified-dispatch',
        roundId,
        'Parallel fan-out · 1 participant(s) dispatched concurrently.'
      ),
      lane('specified-a', roundId)
    ])

    expect(groups.map((group) => group.stage)).toEqual(['all', 'specified'])
    expect(groups.map((group) => ensembleFanoutViewportStageLabel(group.stage))).toEqual([
      'All',
      'Specified'
    ])
  })

  it('retains the durable User Fan-Out identity and folds it after the next turn', () => {
    const roundId = 'round-user-fanout'
    const messages = [
      status(
        'user-fanout-dispatch',
        roundId,
        'User Fan-Out · 2 participant(s) dispatched concurrently (1 read / 1 write-intent).',
        {
          ensembleFanoutWaveId: 'user-wave-1',
          ensembleFanoutCategory: 'user',
          ensembleFanoutLabel: 'User Fan-Out'
        }
      ),
      lane('user-fanout-review', roundId, {
        ensembleStageRole: 'reviewer',
        ensembleFanoutWaveId: 'user-wave-1'
      }),
      lane('user-fanout-work', roundId, {
        ensembleStageRole: 'worker',
        ensembleFanoutWaveId: 'user-wave-1'
      }),
      serialTurn('ordinary-next-turn', roundId)
    ]

    const groups = collectEnsembleFanoutViewportGroups('chat-user-fanout', roundId, messages)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      dispatchLabel: 'User Fan-Out',
      category: 'user',
      waveId: 'user-wave-1',
      stage: 'specified',
      expectedLaneCount: 2
    })

    const ranges = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-user-fanout',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    expect(ranges).toHaveLength(2)
    expect(readEnsembleFanoutViewportHeader(ranges[0].message)).toMatchObject({
      dispatchLabel: 'User Fan-Out',
      category: 'user',
      waveId: 'user-wave-1',
      stage: 'specified',
      expanded: false,
      laneCount: 2
    })
    expect(ranges[1].message.id).toBe('ordinary-next-turn')
  })

  it('co-locates live User Fan-Out lanes split by serial output for paired layout', () => {
    const roundId = 'round-live-user-fanout'
    const messages = [
      status(
        'live-user-fanout-dispatch',
        roundId,
        'User Fan-Out · 2 participant(s) dispatched concurrently (0 read / 2 write-intent).',
        {
          ensembleFanoutWaveId: 'live-user-wave',
          ensembleFanoutCategory: 'user',
          ensembleFanoutLabel: 'User Fan-Out'
        }
      ),
      serialTurn('speaker-before-first-lane', roundId),
      lane('work-7', roundId, {
        ensembleOrder: 7,
        ensembleStatus: 'running',
        ensembleFanoutWaveId: 'live-user-wave',
        ensembleFanoutCategory: 'user'
      }),
      serialTurn('speaker-between-lanes', roundId),
      lane('orchestrator-1', roundId, {
        ensembleOrder: 1,
        ensembleStatus: 'running',
        ensembleFanoutWaveId: 'live-user-wave',
        ensembleFanoutCategory: 'user'
      }),
      serialTurn('speaker-after-lanes', roundId)
    ]

    const displayMessages = coLocateUserFanoutLaneMessages(messages)

    expect(displayMessages.map((message) => message.id)).toEqual([
      'live-user-fanout-dispatch',
      'speaker-before-first-lane',
      'orchestrator-1',
      'work-7',
      'speaker-between-lanes',
      'speaker-after-lanes'
    ])
    expect([...classifyFanoutLaneSlots(displayMessages, true).entries()]).toEqual([
      ['orchestrator-1#2', 'lead'],
      ['work-7#3', 'trail']
    ])
  })

  it('keeps live orchestrated wave chronology unchanged', () => {
    const roundId = 'round-live-orchestrated-fanout'
    const messages = [
      status(
        'live-orchestrated-dispatch',
        roundId,
        'Writer fan-out · 2 participant(s) dispatched concurrently (0 read / 2 write-intent).',
        {
          ensembleFanoutWaveId: 'live-orchestrated-wave',
          ensembleFanoutCategory: 'orchestrated'
        }
      ),
      lane('worker-2', roundId, {
        ensembleOrder: 2,
        ensembleStatus: 'running',
        ensembleFanoutWaveId: 'live-orchestrated-wave'
      }),
      serialTurn('serial-boundary', roundId),
      lane('worker-1', roundId, {
        ensembleOrder: 1,
        ensembleStatus: 'running',
        ensembleFanoutWaveId: 'live-orchestrated-wave'
      })
    ]

    const displayMessages = coLocateUserFanoutLaneMessages(messages)

    expect(displayMessages).toBe(messages)
    expect(displayMessages.map((message) => message.id)).toEqual([
      'live-orchestrated-dispatch',
      'worker-2',
      'serial-boundary',
      'worker-1'
    ])
  })

  it('uses durable wave ids when two dispatch receipts overlap before lane rows flush', () => {
    const roundId = 'round-overlapping-user-fanout'
    const messages = [
      status('wave-a', roundId, 'User Fan-Out · 1 participant(s) dispatched concurrently.', {
        ensembleFanoutWaveId: 'wave-a',
        ensembleFanoutCategory: 'user'
      }),
      status('wave-b', roundId, 'User Fan-Out · 1 participant(s) dispatched concurrently.', {
        ensembleFanoutWaveId: 'wave-b',
        ensembleFanoutCategory: 'user'
      }),
      lane('lane-b-first', roundId, { ensembleFanoutWaveId: 'wave-b' }),
      lane('lane-a-later', roundId, { ensembleFanoutWaveId: 'wave-a' })
    ]

    const groups = collectEnsembleFanoutViewportGroups('chat-overlap', roundId, messages)

    expect(groups.map((group) => [group.waveId, group.lanes[0].message.id])).toEqual([
      ['wave-a', 'lane-a-later'],
      ['wave-b', 'lane-b-first']
    ])
    expect(groups.every((group) => group.category === 'user')).toBe(true)
  })

  it('recovers an explicitly tagged lane that was persisted before its dispatch receipt', () => {
    const roundId = 'round-misordered-overlap'
    const messages = [
      status('older-wave', roundId, 'User Fan-Out · 1 participant(s) dispatched concurrently.', {
        ensembleFanoutWaveId: 'older-wave',
        ensembleFanoutCategory: 'user'
      }),
      lane('new-low-order-lane', roundId, {
        ensembleOrder: 1,
        ensembleFanoutWaveId: 'newer-wave'
      }),
      lane('older-high-order-lane', roundId, {
        ensembleOrder: 6,
        ensembleFanoutWaveId: 'older-wave'
      }),
      status('newer-wave', roundId, 'User Fan-Out · 1 participant(s) dispatched concurrently.', {
        ensembleFanoutWaveId: 'newer-wave',
        ensembleFanoutCategory: 'user'
      })
    ]

    const groups = collectEnsembleFanoutViewportGroups('chat-misordered-overlap', roundId, messages)

    expect(
      groups.map((group) => [
        group.waveId,
        group.anchorIndex,
        group.lanes.map((entry) => entry.message.id)
      ])
    ).toEqual([
      ['older-wave', 0, ['older-high-order-lane']],
      ['newer-wave', 3, ['new-low-order-lane']]
    ])
  })

  it('expands a late-flushed User Fan-Out lane under the one-liner, not at its raw transcript index', () => {
    // Background User Fan-Out: serial rotation continues, then the tagged lane
    // flushes after intervening turns — the durable wave still owns it.
    const roundId = 'round-user-fanout-late-lane'
    const messages = [
      status(
        'user-fanout-dispatch-late',
        roundId,
        'User Fan-Out · 1 participant(s) dispatched concurrently (1 read / 0 write-intent).',
        {
          ensembleFanoutWaveId: 'user-wave-late',
          ensembleFanoutCategory: 'user',
          ensembleFanoutLabel: 'User Fan-Out'
        }
      ),
      serialTurn('boss-keeps-talking', roundId),
      lane('sol-boss-late-lane', roundId, {
        ensembleProvider: 'claude',
        ensembleRole: 'SolBoss',
        ensembleFanoutWaveId: 'user-wave-late'
      }),
      serialTurn('next-serial-after-lane', roundId)
    ]

    const collapsed = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-user-fanout-late',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    const header = readEnsembleFanoutViewportHeader(collapsed[0].message)
    expect(header).toMatchObject({
      category: 'user',
      dispatchLabel: 'User Fan-Out',
      laneCount: 1,
      expanded: false
    })
    expect(collapsed.map((entry) => entry.message.id)).toEqual([
      header?.viewportId,
      'boss-keeps-talking',
      'next-serial-after-lane'
    ])

    const expanded = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-user-fanout-late',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set([header?.viewportId || ''])
    })
    // Lane parks under the disclosure — not after boss-keeps-talking where it
    // was flushed chronologically.
    expect(expanded.map((entry) => entry.message.id)).toEqual([
      header?.viewportId,
      'sol-boss-late-lane',
      'boss-keeps-talking',
      'next-serial-after-lane'
    ])
    expect(readEnsembleFanoutViewportHeader(expanded[0].message)?.expanded).toBe(true)
  })

  it('recovers legacy lanes without dispatch receipts from their frozen stage role', () => {
    const groups = collectEnsembleFanoutViewportGroups('chat-legacy', 'round-legacy', [
      lane('legacy-a', 'round-legacy', { ensembleStageRole: 'background' }),
      lane('legacy-b', 'round-legacy', { ensembleStageRole: 'background' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].stage).toBe('background')
    expect(groups[0].dispatchLabel).toBeNull()
  })

  it('folds a terminal wave after the next turn and restores only its lane rows when expanded', () => {
    const roundId = 'round-3'
    const messages = [
      status('dispatch', roundId, 'Worker fan-out · 2 participant(s) dispatched concurrently.'),
      lane('worker-a', roundId, {
        ensembleStageRole: 'worker',
        groupedFanoutMessageIds: ['worker-a-fragment']
      }),
      lane('worker-b', roundId, { ensembleStageRole: 'worker' }),
      serialTurn('serial-a', roundId)
    ]
    const collapsed = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-3',
      roundId,
      messages,
      sourceOffset: 10,
      expandedViewportIds: new Set()
    })
    expect(collapsed).toHaveLength(2)
    const header = collapsed[0].message
    expect(isEnsembleFanoutViewportHeaderMessage(header)).toBe(true)
    expect(readEnsembleFanoutViewportHeader(header)).toMatchObject({
      stage: 'work',
      expanded: false,
      laneCount: 2,
      laneMessageIds: ['worker-a', 'worker-b']
    })
    expect(header.metadata?.groupedFanoutMessageIds).toEqual([
      'worker-a',
      'worker-a-fragment',
      'worker-b'
    ])

    expect(collapsed[1].message.id).toBe('serial-a')

    const expanded = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-3',
      roundId,
      messages,
      sourceOffset: 10,
      expandedViewportIds: new Set([header.id])
    })
    expect(expanded.map((entry) => entry.message.id)).toEqual([
      header.id,
      'worker-a',
      'worker-b',
      'serial-a'
    ])
    expect(readEnsembleFanoutViewportHeader(expanded[0].message)?.expanded).toBe(true)
    expect(expanded.map((entry) => [entry.startIndex, entry.endIndex])).toEqual([
      [10, 13],
      [11, 12],
      [12, 13],
      [13, 14]
    ])
  })

  /* A fan-out lane participant can call ask_user_question mid-wave. BOTH rows
   * of the exchange carry the settled Q&A card — the marker holds the question
   * and options, the reply holds the chosen answer, and a tombstone missing
   * the reply reports an answered question as "Skipped — no answer sent". The
   * exchange is a round-level decision record, so both must ride ABOVE the
   * wave fold as their own rows, never nested inside the fan-out viewport,
   * whether the wave is collapsed or expanded. */
  it('passes an ask_user_question exchange through a folded wave as its own rows', () => {
    const roundId = 'round-question'
    const marker: ChatMessage = {
      id: 'agent-question-q-lane',
      role: 'system',
      content: 'Pi asked you to pick an option:',
      timestamp: '2026-05-27T12:00:30.000Z',
      metadata: {
        kind: 'agentQuestion',
        questionId: 'q-lane',
        agentQuestion: 'Which branch should the lane target?',
        ensembleRoundId: roundId
      }
    } as ChatMessage
    const reply: ChatMessage = {
      id: 'agent-question-reply-q-lane',
      role: 'user',
      content: 'master',
      timestamp: '2026-05-27T12:00:45.000Z',
      metadata: {
        kind: 'agentQuestionReply',
        questionId: 'q-lane',
        respondedToMessageId: 'agent-question-q-lane',
        isCustomAnswer: false,
        ensembleRoundId: roundId
      }
    } as ChatMessage
    const messages = [
      status('dispatch', roundId, 'Worker fan-out · 2 participant(s) dispatched concurrently.'),
      lane('worker-a', roundId, { ensembleStageRole: 'worker' }),
      marker,
      reply,
      lane('worker-b', roundId, { ensembleStageRole: 'worker' }),
      serialTurn('serial-a', roundId)
    ]
    const collapsed = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-q',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    const collapsedIds = collapsed.map((entry) => entry.message.id)
    expect(collapsedIds).toContain('agent-question-q-lane')
    expect(collapsedIds).toContain('agent-question-reply-q-lane')
    expect(isEnsembleFanoutViewportHeaderMessage(collapsed[0].message)).toBe(true)
    // Neither row is swept into the header's constituents.
    expect(collapsed[0].message.metadata?.groupedFanoutMessageIds).not.toContain(
      'agent-question-q-lane'
    )
    expect(collapsed[0].message.metadata?.groupedFanoutMessageIds).not.toContain(
      'agent-question-reply-q-lane'
    )
  })

  it('folds only the completed wave when the next fan-out stage begins', () => {
    const roundId = 'round-stage-boundary'
    const result = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-stage-boundary',
      roundId,
      messages: [
        status(
          'scout-dispatch',
          roundId,
          'Scout fan-out · 2 read-only participants dispatched concurrently.'
        ),
        lane('scout-one', roundId, { ensembleStageRole: 'scout' }),
        lane('scout-two', roundId, { ensembleStageRole: 'scout' }),
        status(
          'review-dispatch',
          roundId,
          'Review wave · 1 read-only participants dispatched concurrently.'
        ),
        lane('review-live', roundId, {
          ensembleStageRole: 'reviewer',
          ensembleStatus: 'running'
        })
      ],
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })

    expect(result).toHaveLength(3)
    expect(readEnsembleFanoutViewportHeader(result[0].message)).toMatchObject({
      stage: 'scout',
      laneCount: 2,
      expanded: false
    })
    expect(result.slice(1).map((entry) => entry.message.id)).toEqual([
      'review-dispatch',
      'review-live'
    ])
  })

  it('keeps a late lane attached to its earlier stage after a newer dispatch receipt', () => {
    const roundId = 'round-overlapping-receipts'
    const messages = [
      status(
        'scout-overlap-dispatch',
        roundId,
        'Scout fan-out · 2 read-only participants dispatched concurrently.'
      ),
      lane('scout-overlap-one', roundId, { ensembleStageRole: 'scout' }),
      status(
        'review-overlap-dispatch',
        roundId,
        'Review wave · 1 read-only participants dispatched concurrently.'
      ),
      lane('review-overlap', roundId, { ensembleStageRole: 'reviewer' }),
      lane('scout-overlap-late', roundId, { ensembleStageRole: 'scout' }),
      serialTurn('serial-after-overlap', roundId)
    ]

    const groups = collectEnsembleFanoutViewportGroups(
      'chat-overlapping-receipts',
      roundId,
      messages
    )
    expect(groups.map((group) => group.lanes.map((entry) => entry.message.id))).toEqual([
      ['scout-overlap-one', 'scout-overlap-late'],
      ['review-overlap']
    ])

    const result = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-overlapping-receipts',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    expect(result).toHaveLength(3)
    expect(
      result.slice(0, 2).map((entry) => readEnsembleFanoutViewportHeader(entry.message)?.stage)
    ).toEqual(['scout', 'review'])
    expect(result[2].message.id).toBe('serial-after-overlap')
  })

  it('treats All as a wildcard when routing a late lane across dispatch receipts', () => {
    const roundId = 'round-overlapping-all'
    const messages = [
      status(
        'all-overlap-dispatch',
        roundId,
        'Ensemble fan-out · 2 participant(s) dispatched concurrently.'
      ),
      lane('all-overlap-scout', roundId, { ensembleStageRole: 'scout' }),
      status(
        'review-after-all-dispatch',
        roundId,
        'Review wave · 1 read-only participants dispatched concurrently.'
      ),
      lane('all-overlap-work-late', roundId, { ensembleStageRole: 'worker' }),
      lane('review-after-all', roundId, { ensembleStageRole: 'reviewer' })
    ]

    const groups = collectEnsembleFanoutViewportGroups('chat-overlapping-all', roundId, messages)
    expect(groups.map((group) => group.lanes.map((entry) => entry.message.id))).toEqual([
      ['all-overlap-scout', 'all-overlap-work-late'],
      ['review-after-all']
    ])
  })

  it('keeps a wave fully visible until every lane is terminal and later activity begins', () => {
    const roundId = 'round-live'
    const base = [
      status(
        'dispatch-live',
        roundId,
        'Scout fan-out · 2 read-only participants dispatched concurrently.'
      ),
      lane('scout-a', roundId, { ensembleStageRole: 'scout' }),
      lane('scout-b', roundId, { ensembleStageRole: 'scout' })
    ]

    const beforeNextTurn = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-live',
      roundId,
      messages: base,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    expect(beforeNextTurn.map((entry) => entry.message.id)).toEqual([
      'dispatch-live',
      'scout-a',
      'scout-b'
    ])

    const oneLaneStillRunning = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-live',
      roundId,
      messages: [
        base[0],
        base[1],
        lane('scout-b', roundId, {
          ensembleStageRole: 'scout',
          ensembleStatus: 'running'
        }),
        serialTurn('worker-a', roundId)
      ],
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    expect(oneLaneStillRunning.map((entry) => entry.message.id)).toEqual([
      'dispatch-live',
      'scout-a',
      'scout-b',
      'worker-a'
    ])
  })

  it('counts a failed lane status as a terminal member of its dispatch wave', () => {
    const roundId = 'round-failed-lane'
    const result = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-failed-lane',
      roundId,
      messages: [
        status(
          'dispatch-failed-lane',
          roundId,
          'Scout fan-out · 2 read-only participants dispatched concurrently.'
        ),
        lane('successful-lane', roundId, { ensembleStageRole: 'scout' }),
        failedLane('failed-lane', roundId),
        serialTurn('worker-after-failure', roundId)
      ],
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })

    const header = readEnsembleFanoutViewportHeader(result[0].message)
    expect(header).toMatchObject({
      laneCount: 2,
      laneMessageIds: ['successful-lane', 'failed-lane'],
      expanded: false
    })
    expect(result.map((entry) => entry.message.id)).toEqual([
      header?.viewportId,
      'worker-after-failure'
    ])
  })

  it('owns a terminal status coda without counting the same lane twice', () => {
    const roundId = 'round-failed-coda'
    const messages = [
      status(
        'dispatch-failed-coda',
        roundId,
        'Scout fan-out · 1 read-only participants dispatched concurrently.'
      ),
      lane('degraded-lane', roundId, {
        ensembleStageRole: 'scout',
        ensembleStatus: 'running'
      }),
      failedLane('degraded-lane-status', roundId, 'degraded-lane'),
      serialTurn('worker-after-coda', roundId)
    ]
    const collapsed = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-failed-coda',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })

    expect(collapsed).toHaveLength(2)
    const header = readEnsembleFanoutViewportHeader(collapsed[0].message)
    expect(header).toMatchObject({ laneCount: 1, laneMessageIds: ['degraded-lane'] })
    expect(collapsed[0].message.metadata?.groupedFanoutMessageIds).toEqual([
      'degraded-lane',
      'degraded-lane-status'
    ])

    const expanded = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-failed-coda',
      roundId,
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set([header?.viewportId || ''])
    })
    expect(expanded.map((entry) => entry.message.id)).toEqual([
      header?.viewportId,
      'degraded-lane',
      'degraded-lane-status',
      'worker-after-coda'
    ])
  })

  it('keeps a sleeping lane visible because it can wake within the round', () => {
    const roundId = 'round-sleeping-lane'
    const sleepingLane = lane('sleeping-lane', roundId, {
      ensembleStageRole: 'scout',
      ensembleStatus: 'sleeping'
    })
    const result = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-sleeping-lane',
      roundId,
      messages: [
        status(
          'dispatch-sleeping-lane',
          roundId,
          'Scout fan-out · 1 read-only participants dispatched concurrently.'
        ),
        sleepingLane,
        serialTurn('worker-after-sleep', roundId)
      ],
      runs: [
        {
          runId: sleepingLane.runId || '',
          startedAt: '2026-08-02T12:00:00.000Z',
          endedAt: '2026-08-02T12:01:00.000Z',
          status: 'sleeping',
          ensembleRoundId: roundId,
          ensembleLaneId: 'lane-sleeping-lane'
        }
      ],
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })

    expect(result.map((entry) => entry.message.id)).toEqual([
      'dispatch-sleeping-lane',
      'sleeping-lane',
      'worker-after-sleep'
    ])
  })

  it('uses canonical ChatRun terminal semantics for warning and stale running states', () => {
    const roundId = 'round-run-terminal-semantics'
    const messages = [
      status(
        'dispatch-run-terminal-semantics',
        roundId,
        'Scout fan-out · 1 read-only participants dispatched concurrently.'
      ),
      lane('run-terminal-lane', roundId, {
        ensembleStageRole: 'scout',
        ensembleStatus: 'running'
      }),
      serialTurn('worker-after-run-terminal', roundId)
    ]
    const build = (laneRun: ChatRun) =>
      buildEnsembleFanoutViewportRanges({
        chatId: 'chat-run-terminal-semantics',
        roundId,
        messages,
        runs: [laneRun],
        sourceOffset: 0,
        expandedViewportIds: new Set()
      })

    const warningComplete = build({
      runId: 'run-run-terminal-lane',
      startedAt: '2026-08-02T12:00:00.000Z',
      status: 'success_with_warnings',
      ensembleRoundId: roundId,
      ensembleLaneId: 'lane-run-terminal-lane'
    })
    expect(isEnsembleFanoutViewportHeaderMessage(warningComplete[0].message)).toBe(true)

    const staleRunning = build({
      runId: 'run-run-terminal-lane',
      startedAt: '2026-08-02T12:00:00.000Z',
      endedAt: '2026-08-02T12:01:00.000Z',
      status: 'running',
      ensembleRoundId: roundId,
      ensembleLaneId: 'lane-run-terminal-lane'
    })
    expect(staleRunning.map((entry) => entry.message.id)).toEqual([
      'dispatch-run-terminal-semantics',
      'run-terminal-lane',
      'worker-after-run-terminal'
    ])
  })

  it('uses a later same-round run start as the turn boundary before transcript prose arrives', () => {
    const roundId = 'round-run-boundary'
    const messages = [
      status(
        'dispatch-runs',
        roundId,
        'Scout fan-out · 2 read-only participants dispatched concurrently.'
      ),
      lane('lane-a', roundId, { ensembleStageRole: 'scout', ensembleStatus: 'running' }),
      lane('lane-b', roundId, { ensembleStageRole: 'scout', ensembleStatus: 'running' })
    ]
    const runs: ChatRun[] = [
      {
        runId: 'run-lane-a',
        startedAt: '2026-08-02T12:00:00.000Z',
        endedAt: '2026-08-02T12:01:00.000Z',
        status: 'completed',
        ensembleRoundId: roundId,
        ensembleLaneId: 'lane-lane-a'
      },
      {
        runId: 'run-lane-b',
        startedAt: '2026-08-02T12:00:00.000Z',
        endedAt: '2026-08-02T12:01:00.000Z',
        status: 'completed',
        ensembleRoundId: roundId,
        ensembleLaneId: 'lane-lane-b'
      },
      {
        runId: 'run-worker',
        startedAt: '2026-08-02T12:01:01.000Z',
        status: 'running',
        ensembleRoundId: roundId,
        ensembleParticipantId: 'worker'
      }
    ]

    const result = buildEnsembleFanoutViewportRanges({
      chatId: 'chat-runs',
      roundId,
      messages,
      runs,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })

    expect(result).toHaveLength(1)
    expect(isEnsembleFanoutViewportHeaderMessage(result[0].message)).toBe(true)
  })
})
