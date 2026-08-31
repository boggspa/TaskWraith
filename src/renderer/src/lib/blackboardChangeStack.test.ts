import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  BLACKBOARD_UPDATE_STACK_MAX_ITEMS,
  BLACKBOARD_UPDATE_STACK_WINDOW_MS,
  projectBlackboardUpdateStacks
} from './blackboardChangeStack'

const T0 = Date.parse('2026-08-31T15:28:00.000Z')

function update(
  id: string,
  offsetMs: number,
  options: {
    roundId?: string
    category?: 'decision' | 'fact' | 'risk' | 'do-not-repeat' | 'note'
    provider?: string
    pinned?: boolean
  } = {}
): ChatMessage {
  const timestamp = new Date(T0 + offsetMs).toISOString()
  const provider = options.provider || 'codex'
  return {
    id,
    role: 'system',
    content: `Blackboard updated: ${options.category || 'note'} / ${id}.`,
    timestamp,
    metadata: {
      kind: 'ensembleBlackboardChange',
      ensembleRoundId: options.roundId || 'round-1',
      ensembleParticipantId: `${provider}-seat`,
      ...(options.pinned ? { pinnedAt: T0 + offsetMs } : {}),
      blackboardChange: {
        action: 'updated',
        key: id,
        category: options.category || 'note',
        scope: 'session',
        provider,
        displayProviderLabel: provider,
        displayHueClass: provider,
        changedAt: timestamp
      }
    }
  }
}

function status(id: string, offsetMs: number, roundId = 'round-1'): ChatMessage {
  return {
    id,
    role: 'system',
    content: `System status ${id}.`,
    timestamp: new Date(T0 + offsetMs).toISOString(),
    metadata: { kind: 'ensembleRoundStatus', ensembleRoundId: roundId }
  }
}

function scoutBrief(id: string, offsetMs: number): ChatMessage {
  const timestamp = new Date(T0 + offsetMs).toISOString()
  return {
    id,
    role: 'system',
    content: 'Scout brief shared.',
    timestamp,
    metadata: {
      kind: 'ensembleBlackboardChange',
      ensembleRoundId: 'round-1',
      blackboardChange: {
        action: 'scoutBriefShared',
        role: 'Scout',
        provider: 'claude',
        displayProviderLabel: 'Claude',
        displayHueClass: 'claude',
        changedAt: timestamp
      }
    }
  }
}

describe('projectBlackboardUpdateStacks', () => {
  it('anchors an interleaved cross-provider burst at its newest update without losing leaves', () => {
    const first = update('fact-1', 0, { category: 'fact', provider: 'codex' })
    const notice = status('notice', 20_000)
    const second = update('note-2', 40_000, { category: 'note', provider: 'claude' })
    const brief = scoutBrief('brief', 50_000)
    const latest = update('risk-3', 80_000, { category: 'risk', provider: 'grok' })

    const projection = projectBlackboardUpdateStacks([first, notice, second, brief, latest])

    expect(projection.messages).toEqual([first, notice, second, brief, latest])
    const stack = projection.stacks[0]
    expect(stack?.messages).toEqual([first, second, latest])
    expect(stack?.memberIndexes).toEqual([0, 2, 4])
    expect(stack?.leadIndex).toBe(4)
    expect(stack?.latestMessage).toBe(latest)
    expect(stack?.firstMessageId).toBe('fact-1')
    expect(projection.stackByMessageIndex.get(0)).toBe(stack)
    expect(projection.stackByMessageIndex.get(2)).toBe(stack)
    expect(projection.stackByMessageIndex.get(4)).toBe(stack)
    expect(projection.stackByMessageIndex.has(1)).toBe(false)
  })

  it('uses transcript order for the summary and a sliding 120-second window', () => {
    const first = update('first', 0)
    const second = update('second', BLACKBOARD_UPDATE_STACK_WINDOW_MS)
    const outside = update('outside', BLACKBOARD_UPDATE_STACK_WINDOW_MS * 2 + 1)

    const projection = projectBlackboardUpdateStacks([first, second, outside])

    expect(projection.messages).toEqual([first, second, outside])
    expect(projection.stacks).toHaveLength(1)
    expect(projection.stacks[0].latestMessage).toBe(second)
    expect(projection.stackByMessageIndex.has(2)).toBe(false)
  })

  it('does not bridge explicit round boundaries, pinned updates, or non-update actions', () => {
    const pinned = update('pinned', 20_000, { pinned: true })
    const otherRound = status('round-2-start', 30_000, 'round-2')
    const laterOriginalRound = update('later-round-1', 40_000)
    const brief = scoutBrief('brief', 50_000)
    const messages = [update('first', 0), pinned, otherRound, laterOriginalRound, brief]

    const projection = projectBlackboardUpdateStacks(messages)

    expect(projection.messages).toBe(messages)
    expect(projection.stacks).toHaveLength(0)
  })

  it('promotes exact legacy updates while leaving malformed carriers visible', () => {
    const legacy: ChatMessage = {
      id: 'legacy',
      role: 'system',
      content: 'Blackboard updated: fact / legacy-key.',
      timestamp: new Date(T0 + 10_000).toISOString(),
      metadata: { kind: 'ensembleRoundStatus', ensembleRoundId: 'round-1' }
    }
    const malformed: ChatMessage = {
      ...update('malformed', 20_000),
      metadata: {
        ...update('malformed', 20_000).metadata,
        blackboardChange: {
          ...update('malformed', 20_000).metadata?.blackboardChange,
          displayHueClass: 'bad);color:red'
        } as never
      }
    }
    const latest = update('latest', 30_000)

    const projection = projectBlackboardUpdateStacks([legacy, malformed, latest])

    expect(projection.messages).toEqual([legacy, malformed, latest])
    expect(projection.stacks[0]?.messages).toEqual([legacy, latest])
    expect(projection.stacks[0]?.memberIndexes).toEqual([0, 2])
  })

  it('seals a full stack and starts another without dropping source history', () => {
    const messages = Array.from({ length: BLACKBOARD_UPDATE_STACK_MAX_ITEMS + 1 }, (_, index) =>
      update(`update-${index + 1}`, index * 1_000)
    )

    const projection = projectBlackboardUpdateStacks(messages)

    expect(projection.messages).toBe(messages)
    expect(projection.stacks).toHaveLength(1)
    const sealed = projection.stacks[0]
    expect(sealed?.messages).toHaveLength(BLACKBOARD_UPDATE_STACK_MAX_ITEMS)
    expect((sealed?.messages.length || 0) + 1).toBe(messages.length)
  })
})
