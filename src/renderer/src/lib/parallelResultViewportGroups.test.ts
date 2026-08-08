import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  buildParallelResultViewportRanges,
  collectParallelResultViewportGroups,
  isParallelResultViewportHeaderMessage,
  parallelResultViewportCategoryLabel,
  readParallelResultViewportHeader
} from './parallelResultViewportGroups'

function returnCard(
  id: string,
  patch: Partial<NonNullable<ChatMessage['metadata']>> = {}
): ChatMessage {
  return {
    id,
    role: 'tool',
    content: `↩ Result from Codex sub-thread (${id}):\n\nbody-${id}`,
    timestamp: `2026-08-08T00:00:0${Math.min(id.length, 9)}.000Z`,
    metadata: {
      kind: 'subThreadReturn',
      subThreadId: `child-${id}`,
      subThreadProvider: 'codex',
      subThreadTitle: id,
      mailboxEventId: `mailbox-${id}`,
      providerContextVisibility: 'projection-only',
      resultTrust: 'untrusted-child-output',
      ...patch
    }
  }
}

function userTurn(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: `user-${id}`,
    timestamp: '2026-08-08T00:01:00.000Z'
  }
}

function assistantTurn(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `assistant-${id}`,
    timestamp: '2026-08-08T00:01:30.000Z'
  }
}

describe('parallel-result viewport groups', () => {
  it('groups adjacent same-wave subThread returns and keeps sideChat without wave id as a singleton', () => {
    const messages = [
      returnCard('wave-a1', { parallelResultWaveId: 'wave-a' }),
      returnCard('wave-a2', { parallelResultWaveId: 'wave-a' }),
      returnCard('side-alone', { linkedChildRelation: 'sideChat' }),
      returnCard('wave-b1', { parallelResultWaveId: 'wave-b' })
    ]

    const groups = collectParallelResultViewportGroups('chat-1', messages)

    expect(
      groups.map((group) => [group.waveId, group.category, group.members.map((m) => m.message.id)])
    ).toEqual([
      ['wave-a', 'subThread', ['wave-a1', 'wave-a2']],
      ['wave-b', 'subThread', ['wave-b1']]
    ])
    expect(groups.every((group) => group.category !== 'sideChat')).toBe(true)
    expect(parallelResultViewportCategoryLabel('subThread')).toBe('Sub-thread')
    expect(parallelResultViewportCategoryLabel('sideChat')).toBe('Side-chat')
  })

  it('never merges a sideChat return into a subThread wave even when adjacent', () => {
    const messages = [
      returnCard('sub-1', { parallelResultWaveId: 'join-1' }),
      returnCard('side-1', {
        linkedChildRelation: 'sideChat',
        parallelResultWaveId: 'join-1'
      }),
      returnCard('sub-2', { parallelResultWaveId: 'join-1' })
    ]

    const groups = collectParallelResultViewportGroups('chat-side-omit', messages)

    expect(groups.map((group) => [group.category, group.members.map((m) => m.message.id)])).toEqual(
      [
        ['subThread', ['sub-1']],
        ['sideChat', ['side-1']],
        ['subThread', ['sub-2']]
      ]
    )
  })

  it('keeps an incomplete wave open as ordinary cards even after later transcript focus', () => {
    const messages = [
      returnCard('incomplete-a', {
        parallelResultWaveId: 'wave-incomplete',
        parallelResultExpectedCount: 3
      }),
      returnCard('incomplete-b', {
        parallelResultWaveId: 'wave-incomplete',
        parallelResultExpectedCount: 3
      }),
      userTurn('parent-moved-on'),
      assistantTurn('parent-answered')
    ]

    const ranges = buildParallelResultViewportRanges({
      chatId: 'chat-incomplete',
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })

    expect(ranges.map((entry) => entry.message.id)).toEqual([
      'incomplete-a',
      'incomplete-b',
      'parent-moved-on',
      'parent-answered'
    ])
    expect(ranges.some((entry) => isParallelResultViewportHeaderMessage(entry.message))).toBe(false)
  })

  it('collapses a complete wave after later focus and preserves member order on expand', () => {
    const messages = [
      returnCard('complete-a', { parallelResultWaveId: 'wave-complete' }),
      returnCard('complete-b', { parallelResultWaveId: 'wave-complete' }),
      userTurn('after-wave'),
      assistantTurn('serial-after')
    ]

    const groups = collectParallelResultViewportGroups('chat-complete', messages)
    expect(groups).toHaveLength(1)
    // Unknown expected count → present adjacent same-wave run is membership.
    expect(groups[0].expectedMemberCount).toBe(2)

    const collapsed = buildParallelResultViewportRanges({
      chatId: 'chat-complete',
      messages,
      sourceOffset: 5,
      expandedViewportIds: new Set()
    })
    expect(collapsed).toHaveLength(3)
    const header = collapsed[0].message
    expect(isParallelResultViewportHeaderMessage(header)).toBe(true)
    expect(readParallelResultViewportHeader(header)).toMatchObject({
      waveId: 'wave-complete',
      chatId: 'chat-complete',
      category: 'subThread',
      expanded: false,
      memberCount: 2,
      memberMessageIds: ['complete-a', 'complete-b']
    })
    expect(collapsed.map((entry) => entry.message.id)).toEqual([
      header.id,
      'after-wave',
      'serial-after'
    ])

    const expanded = buildParallelResultViewportRanges({
      chatId: 'chat-complete',
      messages,
      sourceOffset: 5,
      expandedViewportIds: new Set([header.id])
    })
    // Re-home under the header without reordering members relative to each other.
    expect(expanded.map((entry) => entry.message.id)).toEqual([
      header.id,
      'complete-a',
      'complete-b',
      'after-wave',
      'serial-after'
    ])
    expect(readParallelResultViewportHeader(expanded[0].message)?.expanded).toBe(true)
    expect(expanded.map((entry) => [entry.startIndex, entry.endIndex])).toEqual([
      [5, 7],
      [5, 6],
      [6, 7],
      [7, 8],
      [8, 9]
    ])
  })

  it('does not reorder intervening serial rows when a late same-wave adjacent run is separate', () => {
    // Adjacent-only grouping: intervening focus breaks the wave into two runs.
    // Neither run is rewritten ahead of the serial turn for pairing.
    const messages = [
      returnCard('early', { parallelResultWaveId: 'wave-split' }),
      assistantTurn('intervening-serial'),
      returnCard('late', { parallelResultWaveId: 'wave-split' }),
      userTurn('tail')
    ]

    const groups = collectParallelResultViewportGroups('chat-split', messages)
    expect(groups.map((group) => group.members.map((m) => m.message.id))).toEqual([
      ['early'],
      ['late']
    ])

    const ranges = buildParallelResultViewportRanges({
      chatId: 'chat-split',
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    // Singleton complete runs collapse after later focus; order of non-members stays put.
    expect(ranges.map((entry) => entry.message.id)).toEqual([
      ranges[0].message.id,
      'intervening-serial',
      ranges[2].message.id,
      'tail'
    ])
    expect(isParallelResultViewportHeaderMessage(ranges[0].message)).toBe(true)
    expect(isParallelResultViewportHeaderMessage(ranges[2].message)).toBe(true)
    expect(readParallelResultViewportHeader(ranges[0].message)?.memberMessageIds).toEqual(['early'])
    expect(readParallelResultViewportHeader(ranges[2].message)?.memberMessageIds).toEqual(['late'])
  })

  it('omits sideChat returns without a wave id from join-wave collapse', () => {
    const messages = [
      returnCard('joined-a', { parallelResultWaveId: 'wave-join' }),
      returnCard('joined-b', { parallelResultWaveId: 'wave-join' }),
      returnCard('side-no-wave', { linkedChildRelation: 'sideChat' }),
      userTurn('later')
    ]

    const groups = collectParallelResultViewportGroups('chat-omit-side', messages)
    expect(groups).toHaveLength(1)
    expect(groups[0].members.map((m) => m.message.id)).toEqual(['joined-a', 'joined-b'])

    const ranges = buildParallelResultViewportRanges({
      chatId: 'chat-omit-side',
      messages,
      sourceOffset: 0,
      expandedViewportIds: new Set()
    })
    expect(ranges.map((entry) => entry.message.id)).toEqual([
      ranges[0].message.id,
      'side-no-wave',
      'later'
    ])
    expect(isParallelResultViewportHeaderMessage(ranges[0].message)).toBe(true)
    expect(ranges[1].message.id).toBe('side-no-wave')
  })
})
