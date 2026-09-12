import { describe, expect, it } from 'vitest'
import type {
  ActiveGoal,
  ChatMessage,
  ChatRecord,
  ChatRun,
  EnsembleParticipant
} from '../../../main/store/types'
import {
  CHAT_RECORD_LIVE_GRACE_MS,
  chatRecordHasLiveRun,
  coalescePendingChatUpdateRender,
  mergeChatUpdatedForRender
} from './chatUpdateRenderMerge'
import { groupEnsembleMessagesByRound } from './ensembleRoundGrouping'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '1' }
}

function run(runId: string): ChatRun {
  return { runId, startedAt: '1' }
}

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'chat-merge',
    title: 'Merge test',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: 1
  } as ChatRecord
}

describe('mergeChatUpdatedForRender', () => {
  it('reuses the live transcript for metadata-only updates', () => {
    const incomingMessages = [message('a', 'incoming')]
    const liveMessages = [message('a', 'live'), message('b', 'synthetic')]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toBe(liveMessages)
  })

  it('never takes a paged shell’s window as the live transcript', () => {
    // Stage 1b: a paged shell's messages are a bounded presentation page;
    // folding them into a metadata-only delivery would blank the full arrays.
    const incomingMessages = [message('a', 'incoming'), message('b', 'two')]
    const pagedShell = {
      ...chat([message('b', 'two')]),
      summaryOnly: true,
      messageCount: 2,
      runCount: 0,
      transcriptPaged: true
    } as unknown as ChatRecord
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: pagedShell,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toBe(incomingMessages)
  })

  it('does not graft the live transcript onto a paged shell’s truncated runs', () => {
    // A snapshot of an oversized chat arrives as a shell whose messages AND
    // runs are both bounded to one tail page. Adopting the live transcript
    // without the live runs leaves the two arrays describing different
    // windows, which is what empties every older round's fan-out run index.
    const liveMessages = [message('old', 'older row'), message('tail', 'tail row')]
    const liveRuns = [run('run-old'), run('run-tail')]
    const live = { ...chat(liveMessages), runs: liveRuns } as ChatRecord
    const shell = {
      ...chat([message('tail', 'tail row')]),
      runs: [run('run-tail')],
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 2,
      runCount: 2
    } as unknown as ChatRecord

    const merged = mergeChatUpdatedForRender(shell, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toBe(liveMessages)
    expect(merged.runs).toBe(liveRuns)
  })

  it('does not re-inflate a paged snapshot from a live full transcript', () => {
    const page = [message('z', 'tail')]
    const incoming = {
      ...chat(page),
      summaryOnly: true,
      messageCount: 80,
      runCount: 0,
      transcriptPaged: true
    } as unknown as ChatRecord
    const liveMessages = Array.from({ length: 80 }, (_, index) => message(`m-${index}`, `${index}`))
    const merged = mergeChatUpdatedForRender(incoming, {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toEqual(page)
    expect(merged.messages).toHaveLength(1)
  })

  it('does not resurrect paged-out user prompts onto a snapshot shell', () => {
    // An oversized chat snapshots as a tail page. Every historical user prompt
    // is "missing" from that window, so the unconditional live-user-message
    // preservation re-appended all of history below the tail — each orphaned
    // prompt splitting off from its round as a lone "0 messages" card while the
    // real transcript sat way above the groupings.
    const roundPrompt = (id: string, roundId: string, timestamp: string): ChatMessage => ({
      id,
      role: 'user',
      content: `prompt ${id}`,
      timestamp,
      metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: roundId }
    })
    const roundTurn = (id: string, roundId: string, timestamp: string): ChatMessage => ({
      id,
      role: 'assistant',
      content: `turn ${id}`,
      timestamp,
      metadata: { kind: 'ensembleParticipant', ensembleRoundId: roundId }
    })
    const liveMessages = [
      roundPrompt('u1', 'round-1', '2026-09-07T20:00:00.000Z'),
      roundTurn('a1', 'round-1', '2026-09-07T20:01:00.000Z'),
      roundPrompt('u2', 'round-2', '2026-09-07T21:00:00.000Z'),
      roundTurn('a2', 'round-2', '2026-09-07T21:01:00.000Z')
    ]
    const tail = liveMessages.slice(2)
    const shell = {
      ...chat(tail),
      chatKind: 'ensemble',
      runs: [],
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 4,
      runCount: 0
    } as unknown as ChatRecord
    const live = { ...chat(liveMessages), chatKind: 'ensemble' } as ChatRecord

    const merged = mergeChatUpdatedForRender(shell, {
      liveChat: live,
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['u2', 'a2'])
    // The user-visible half: the merged tail groups as one intact round, not
    // a lone prompt card plus a body-less round.
    const items = groupEnsembleMessagesByRound(merged)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: 'round-group', roundId: 'round-2' })
    if (items[0].type !== 'round-group') throw new Error('expected a round group')
    expect(items[0].messages.map((entry) => entry.id)).toEqual(['u2', 'a2'])
  })

  it('does not resurrect paged-out closeouts onto a snapshot shell', () => {
    const closeout = (id: string): ChatMessage => ({
      id,
      role: 'system',
      content: '',
      timestamp: '2026-09-07T20:00:00.000Z',
      metadata: { kind: 'taskWraithCloseout' }
    })
    const answer = (id: string, timestamp: string): ChatMessage => ({
      id,
      role: 'assistant',
      content: `answer ${id}`,
      timestamp
    })
    const liveMessages = [
      answer('a1', '2026-09-07T19:00:00.000Z'),
      closeout('closeout-old'),
      answer('a2', '2026-09-07T21:00:00.000Z')
    ]
    const shell = {
      ...chat([answer('a2', '2026-09-07T21:00:00.000Z')]),
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 3,
      runCount: 0
    } as unknown as ChatRecord

    const merged = mergeChatUpdatedForRender(shell, {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a2'])
  })

  it('still preserves a new local user row appended past a snapshot shell’s total', () => {
    // The live transcript runs one row past the snapshot's canonical total:
    // that row was authored after the snapshot and must survive the merge.
    const tail: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'tail answer',
      timestamp: '2026-09-07T21:00:00.000Z'
    }
    const fresh: ChatMessage = {
      id: 'u-new',
      role: 'user',
      content: 'just sent',
      timestamp: '2026-09-07T21:00:01.000Z'
    }
    const shell = {
      ...chat([tail]),
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 1,
      runCount: 0
    } as unknown as ChatRecord

    const merged = mergeChatUpdatedForRender(shell, {
      liveChat: chat([tail, fresh]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a1', 'u-new'])
  })

  it('preserves a new local row on a stale live base by recency, not history', () => {
    // The live base missed the snapshot's tail row, so the fresh row sits
    // below the shell's total and only its newer timestamp proves it is new.
    const historical: ChatMessage = {
      id: 'u-old',
      role: 'user',
      content: 'old prompt',
      timestamp: '2026-09-07T20:00:00.000Z'
    }
    const fresh: ChatMessage = {
      id: 'u-new',
      role: 'user',
      content: 'just sent',
      timestamp: '2026-09-07T21:00:01.000Z'
    }
    const shellRow: ChatMessage = {
      id: 'a2',
      role: 'assistant',
      content: 'tail answer',
      timestamp: '2026-09-07T21:00:00.000Z'
    }
    const shell = {
      ...chat([shellRow]),
      summaryOnly: true,
      transcriptPaged: true,
      messageCount: 2,
      runCount: 0
    } as unknown as ChatRecord

    const merged = mergeChatUpdatedForRender(shell, {
      liveChat: chat([historical, fresh]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a2', 'u-new'])
  })

  it('keeps longer live assistant content when the incoming transcript changed', () => {
    const incomingMessages = [message('a', 'short')]
    const liveMessages = [message('a', 'longer live answer')]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toHaveLength(1)
    expect(merged.messages[0].content).toBe('longer live answer')
  })

  it('preserves a renderer-authored user follow-up message when the incoming transcript changed', () => {
    const incomingMessages = [message('a', 'assistant answer')]
    const liveMessages = [
      message('a', 'assistant answer'),
      { id: 'u1', role: 'user', content: 'follow-up', timestamp: '2' } as ChatMessage
    ]
    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages).toHaveLength(2)
    expect(merged.messages[1].role).toBe('user')
    expect(merged.messages[1].content).toBe('follow-up')
  })

  // Reported 2026-09-10 as "tools keep appearing ABOVE the user prompt — the
  // transcript should only ever move forward". The renderer authors the prompt
  // optimistically; main has not persisted it yet, but the run's first tool row
  // is already in the delivery. Re-appending the prompt at the TAIL puts this
  // turn's activity above the prompt that caused it, and because the renderer
  // saves the whole record on the next stream delta, the inversion is durable.
  it('restores a preserved user row to its live position, not the tail', () => {
    const toolRow: ChatMessage = {
      id: 't1',
      role: 'tool',
      content: '',
      timestamp: '3',
      toolActivities: [{ id: 'act-1', tool: 'delegate_wave', status: 'completed' }]
    } as unknown as ChatMessage
    const prompt: ChatMessage = { id: 'u-new', role: 'user', content: 'the prompt', timestamp: '2' }
    const incomingMessages = [message('a', 'previous answer'), toolRow]
    const liveMessages = [message('a', 'previous answer'), prompt]

    const merged = mergeChatUpdatedForRender(chat(incomingMessages), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'u-new', 't1'])
  })

  // The same inversion at live index 0: a brand-new chat whose first prompt is
  // still un-persisted when the run's first tool row arrives. Nothing has been
  // paged out here and no base is stale — the row IS the transcript's head — so
  // the tail fallback that exists to serve a vanished prefix misfires and puts
  // this turn's activity above the prompt that caused it.
  it('restores a preserved first prompt to the head, not the tail', () => {
    const toolRow: ChatMessage = {
      id: 't1',
      role: 'tool',
      content: '',
      timestamp: '3',
      toolActivities: [{ id: 'act-1', tool: 'delegate_wave', status: 'completed' }]
    } as unknown as ChatMessage
    const prompt: ChatMessage = { id: 'u-new', role: 'user', content: 'the prompt', timestamp: '2' }

    const merged = mergeChatUpdatedForRender(chat([toolRow]), {
      liveChat: chat([prompt]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['u-new', 't1'])
  })

  // The head restore stays evidence-based: it applies only where the row has no
  // live predecessor AT ALL. A prefix the delivery dropped still proves nothing
  // about position, so such a row keeps the historical tail placement instead of
  // jumping to the transcript's head.
  it('keeps a preserved row at the tail when its live prefix is missing from the delivery', () => {
    const toolRow: ChatMessage = {
      id: 't1',
      role: 'tool',
      content: '',
      timestamp: '3',
      toolActivities: [{ id: 'act-1', tool: 'delegate_wave', status: 'completed' }]
    } as unknown as ChatMessage
    // A tool row is in none of the orphan-preservation categories, so a live
    // one the delivery does not carry is genuinely dropped rather than restored.
    const droppedPrefix: ChatMessage = {
      id: 't0',
      role: 'tool',
      content: '',
      timestamp: '1'
    } as unknown as ChatMessage
    const prompt: ChatMessage = { id: 'u-new', role: 'user', content: 'the prompt', timestamp: '2' }

    const merged = mergeChatUpdatedForRender(chat([toolRow]), {
      liveChat: chat([droppedPrefix, prompt]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['t1', 'u-new'])
  })

  // The other direction, so the restore is evidence-based rather than a blanket
  // "everything the delivery carries goes below the prompt". A row stamped
  // BEFORE the prompt genuinely preceded it — the renderer's live base merely
  // never saw it — and must keep its place above.
  it('leaves a delivered row stamped before the preserved prompt above it', () => {
    const earlier: ChatMessage = {
      id: 'earlier',
      role: 'tool',
      content: '',
      timestamp: '2026-09-10T15:00:00.000Z'
    }
    const later: ChatMessage = {
      id: 'later',
      role: 'tool',
      content: '',
      timestamp: '2026-09-10T15:00:02.000Z'
    }
    const prompt: ChatMessage = {
      id: 'u-new',
      role: 'user',
      content: 'the prompt',
      timestamp: '2026-09-10T15:00:01.000Z'
    }
    const head = message('a', 'previous answer')

    const merged = mergeChatUpdatedForRender(chat([head, earlier, later]), {
      liveChat: chat([head, prompt]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'earlier', 'u-new', 'later'])
  })

  // Timestamps only arbitrate where live has no opinion. Live already orders
  // this delivered row AFTER the preserved one, so a skewed or start-of-run
  // stamp on it must not drag it back above.
  it('keeps live order over a stamp for a delivered row live already places later', () => {
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2026-09-10T15:00:05.000Z',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const nextTurn: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: 'next turn',
      timestamp: '2026-09-10T15:00:01.000Z'
    }
    const head = message('a', 'answer')

    const merged = mergeChatUpdatedForRender(chat([head, nextTurn]), {
      liveChat: chat([head, closeout, nextTurn]),
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout', 'u2'])
  })

  // Same inversion on the path that skips the active-run merge entirely, which
  // is where a delivery for a finished-and-forgotten run lands.
  it('restores a preserved user row to its live position with no active run', () => {
    const toolRow: ChatMessage = { id: 't1', role: 'tool', content: '', timestamp: '3' }
    const prompt: ChatMessage = { id: 'u-new', role: 'user', content: 'the prompt', timestamp: '2' }

    const merged = mergeChatUpdatedForRender(chat([message('a', 'previous answer'), toolRow]), {
      liveChat: chat([message('a', 'previous answer'), prompt]),
      messagesChanged: true,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'u-new', 't1'])
  })

  // The closeout preservation shares the tail-append, so it inverts the same
  // way against any row the delivery carries past the closeout's position.
  it('restores a preserved closeout row to its live position, not the tail', () => {
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const nextPrompt: ChatMessage = { id: 'u2', role: 'user', content: 'next turn', timestamp: '3' }

    const merged = mergeChatUpdatedForRender(chat([message('a', 'answer'), nextPrompt]), {
      liveChat: chat([message('a', 'answer'), closeout, nextPrompt]),
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout', 'u2'])
  })

  it('preserves a renderer-authored closeout outside the recent-run window', () => {
    const incoming = chat([message('a', 'answer')])
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const live = chat([...incoming.messages, closeout])
    const merged = mergeChatUpdatedForRender(incoming, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout'])
  })

  // 2026-09-11 - nine Muse runs failed inside one second and the renderer
  // appended a providerRunFailure row for each. They rendered, then vanished
  // on the next main delivery, then came back, then vanished again: the rows
  // are renderer-authored and the 200ms debounced saveChat races every
  // `chat-updated` frame. The close-out written in the SAME millisecond stayed
  // on screen throughout, because it was on this preserve list and the failure
  // rows were not. A dropped failure row leaves the close-out saying "The run
  // failed" with nothing above it saying why.
  it('preserves a renderer-authored provider failure row the delivery has not got yet', () => {
    const failure: ChatMessage = {
      id: 'failure-1',
      role: 'error',
      content: 'Muse failed - exit 1',
      timestamp: '2',
      metadata: { kind: 'providerRunFailure', provider: 'muse', exitCode: 1 }
    }
    const incoming = chat([message('a', 'answer')])

    const merged = mergeChatUpdatedForRender(incoming, {
      liveChat: chat([...incoming.messages, failure]),
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'failure-1'])
  })

  // Same position rule the close-out and prompt preservations follow: the
  // failure row belongs where the run put it, not after the next turn.
  it('restores a preserved provider failure row to its live position, not the tail', () => {
    const failure: ChatMessage = {
      id: 'failure-1',
      role: 'error',
      content: 'Muse failed - exit 1',
      timestamp: '2',
      metadata: { kind: 'providerRunFailure', provider: 'muse', exitCode: 1 }
    }
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const nextPrompt: ChatMessage = { id: 'u2', role: 'user', content: 'next turn', timestamp: '3' }

    const merged = mergeChatUpdatedForRender(chat([message('a', 'answer'), nextPrompt]), {
      liveChat: chat([message('a', 'answer'), failure, closeout, nextPrompt]),
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'failure-1', 'closeout', 'u2'])
  })

  // The preserve must key on the failure METADATA, not on `role === 'error'`:
  // every other error row (a Discord context read, a provider stream error) is
  // main-authored or transient and has never been on this list.
  it('does not resurrect an error row that carries no provider-failure metadata', () => {
    const plainError: ChatMessage = {
      id: 'err-plain',
      role: 'error',
      content: 'Failed to read Discord context',
      timestamp: '2'
    }
    const incoming = chat([message('a', 'answer')])

    const merged = mergeChatUpdatedForRender(incoming, {
      liveChat: chat([...incoming.messages, plainError]),
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a'])
  })

  // 1.0.5-UI2 — renderer-authored goal/roster edits must survive a stale
  // main refresh (the "Set Goal sets then unsets" / "Add Participant adds
  // then removes" reports).
  function makeGoal(updatedAt: string, objective = 'Ship the fix'): ActiveGoal {
    return {
      id: 'goal-1',
      objective,
      status: 'active',
      mode: 'taskwraith_steered',
      provider: 'codex',
      createdAt: updatedAt,
      updatedAt
    } as ActiveGoal
  }

  function makeEnsemble(
    participants: Array<Pick<EnsembleParticipant, 'id' | 'role'> & Partial<EnsembleParticipant>>,
    ensembleUpdatedAt: string
  ): ChatRecord['ensemble'] {
    return {
      enabled: true,
      maxParticipants: Math.max(6, participants.length),
      participants: participants.map((participant, index) => ({
        provider: 'codex',
        enabled: true,
        instructions: '',
        order: index + 1,
        model: 'gpt-5.4',
        ...participant
      })) as EnsembleParticipant[],
      updatedAt: ensembleUpdatedAt
    } as ChatRecord['ensemble']
  }

  it('preserves a just-set live goal against a staler delivery that lacks it', () => {
    const deliveredAt = chat([message('a', 'stream frame')])
    deliveredAt.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    const live = { ...chat([message('a', 'stream frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.activeGoal = makeGoal('2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(deliveredAt, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false,
      localGoalIntent: { goalId: 'goal-1' }
    })
    expect(merged.activeGoal?.id).toBe('goal-1')
  })

  it('keeps a deliberate live goal clear instead of resurrecting a stale delivery goal', () => {
    const delivered = { ...chat([message('a', 'stale frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.activeGoal = makeGoal('2026-09-01T00:00:00.400Z')
    const live = chat([message('a', 'stale frame')])
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localGoalIntent: { goalId: null, clearedGoalId: 'goal-1' }
    })
    expect(merged.activeGoal).toBeUndefined()
  })

  // The "goal keeps unsetting itself" report: an agent `update_goal` (or any
  // other main-authored goal write) broadcasts the pre-save object, so it
  // arrives stamped OLDER than a renderer copy that never held a goal at all.
  // With no renderer edit in flight there is nothing local to defend, so the
  // delivery must win — the ambient-stamp comparison deleted it here instead,
  // and the renderer's next whole-record save made the loss durable.
  it('adopts a main-authored goal when the renderer holds no pending goal edit', () => {
    const delivered = { ...chat([message('a', 'agent set the goal')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.activeGoal = makeGoal('2026-09-01T00:00:00.500Z', 'Agent-authored objective')
    const live = chat([message('a', 'agent set the goal')])
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    expect(merged.activeGoal?.objective).toBe('Agent-authored objective')
  })

  it('lets a main-authored goal through a local clear of a different goal', () => {
    const delivered = { ...chat([message('a', 'new objective')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.activeGoal = { ...makeGoal('2026-09-01T00:00:00.500Z'), id: 'goal-2' }
    const live = chat([message('a', 'new objective')])
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localGoalIntent: { goalId: null, clearedGoalId: 'goal-1' }
    })
    expect(merged.activeGoal?.id).toBe('goal-2')
  })

  it('adopts a main-side status advance on the goal the renderer just set', () => {
    const delivered = { ...chat([message('a', 'completed upstream')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.activeGoal = {
      ...makeGoal('2026-09-01T00:00:03.000Z'),
      status: 'completed'
    } as ActiveGoal
    const live = { ...chat([message('a', 'completed upstream')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.activeGoal = makeGoal('2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localGoalIntent: { goalId: 'goal-1' }
    })
    expect(merged.activeGoal?.status).toBe('completed')
  })

  it('lets a newer main-side goal win over the older live copy', () => {
    const delivered = { ...chat([message('a', 'sync')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:03.000Z')
    delivered.activeGoal = makeGoal('2026-09-01T00:00:03.000Z', 'Main-synced objective')
    const live = { ...chat([message('a', 'sync')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.activeGoal = makeGoal('2026-09-01T00:00:01.000Z', 'Locally set objective')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.activeGoal?.objective).toBe('Main-synced objective')
  })

  it('keeps an identical delivered goal without rewriting the record', () => {
    const goal = makeGoal('2026-09-01T00:00:01.000Z')
    const delivered = { ...chat([message('a', 'echo')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    delivered.activeGoal = JSON.parse(JSON.stringify(goal))
    const live = { ...chat([message('a', 'echo')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.activeGoal = goal
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })

  it('preserves a just-added live participant against a staler delivery roster', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker' }],
      '2026-09-01T00:00:00.500Z'
    )
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    live.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Worker' },
        { id: 'seat-2', role: 'Reviewer' }
      ],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-2'
    ])
  })

  it('lets a newer delivered roster change replace the stale live roster', () => {
    const delivered = { ...chat([message('a', 'remote edit')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Worker' },
        { id: 'seat-3', role: 'Remote seat' }
      ],
      '2026-09-01T00:00:04.000Z'
    )
    const live = { ...chat([message('a', 'remote edit')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Worker' }], '2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-3'
    ])
  })

  // 2026-09-11, fourth report in the 1.0.5-UI2 class: "I click remove, the seat
  // disappears and immediately reappears", and the same denial on ADD. The chip
  // strip's optimistic commit stamps only `ensemble.updatedAt`; main re-stamps
  // the top-level `chat.updatedAt` on EVERY unrelated save, so one landing
  // inside the `saveChat` window out-stamps the edit while still carrying the
  // pre-edit roster. The claim says main has not been told yet, so the stamp
  // does not get to decide.
  it('keeps a just-removed seat out while the roster write is unconfirmed', () => {
    const delivered = { ...chat([message('a', 'unrelated save')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Boss' },
        { id: 'seat-2', role: 'Flash' },
        { id: 'seat-3', role: 'Reviewer' }
      ],
      '2026-09-01T00:00:01.000Z'
    )
    const live = { ...chat([message('a', 'unrelated save')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Boss' },
        { id: 'seat-3', role: 'Reviewer' }
      ],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: true
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-3'
    ])
  })

  it('keeps a just-added seat while the roster write is unconfirmed', () => {
    const delivered = { ...chat([message('a', 'unrelated save')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:01.000Z')
    const live = { ...chat([message('a', 'unrelated save')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Boss' },
        { id: 'seat-2', role: 'Flash' }
      ],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: true
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-2'
    ])
  })

  it('keeps a just-renamed seat role while the roster write is unconfirmed', () => {
    const delivered = { ...chat([message('a', 'unrelated save')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker' }],
      '2026-09-01T00:00:01.000Z'
    )
    const live = { ...chat([message('a', 'unrelated save')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Reviewer', model: 'gpt-5.4-codex' }],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: true
    })
    expect(merged.ensemble?.participants[0].role).toBe('Reviewer')
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.4-codex')
  })

  // Second defect in the same report: the rescue rebuilt the block as
  // `{ ...deliveredEnsemble, participants: liveParticipants }`, so defending a
  // seat edit silently reverted the round budget sitting beside it.
  it('keeps the live panel configuration when it restores the live roster', () => {
    const delivered = { ...chat([message('a', 'unrelated save')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = {
      ...makeEnsemble(
        [
          { id: 'seat-1', role: 'Boss' },
          { id: 'seat-2', role: 'Flash' }
        ],
        '2026-09-01T00:00:01.000Z'
      )!,
      maxContinuationHops: 6,
      roundMode: 'roundtable',
      ensembleContextChars: 5_000
    }
    const live = { ...chat([message('a', 'unrelated save')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = {
      ...makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:02.000Z')!,
      maxContinuationHops: 40,
      roundMode: 'rebuttal',
      ensembleContextChars: 120_000
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: true
    })
    expect(merged.ensemble?.maxContinuationHops).toBe(40)
    expect(merged.ensemble?.roundMode).toBe('rebuttal')
    expect(merged.ensemble?.ensembleContextChars).toBe(120_000)
  })

  // The panel config is defended on its own, without a membership change: a
  // hop-limit edit persists through its own IPC and leaves the seats alone.
  it('keeps a just-set hop limit against a staler delivery with the same seats', () => {
    const delivered = { ...chat([message('a', 'unrelated save')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = {
      ...makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:01.000Z')!,
      maxContinuationHops: 6
    }
    const live = { ...chat([message('a', 'unrelated save')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = {
      ...makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:02.000Z')!,
      maxContinuationHops: 200
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: true
    })
    expect(merged.ensemble?.maxContinuationHops).toBe(200)
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual(['seat-1'])
  })

  // 2026-09-11 — "Not allowing me to enable Ensemble". `setChatKind` is
  // main-authoritative, but main can have BUILT a delivery before the switch and
  // flushed it after; that frame carries the previous mode on a newer clock, so
  // the stamp comparison stood down and the toggle snapped back to Off.
  describe('an Ensemble mode switch still in flight', () => {
    const soloDelivery = (): ChatRecord => {
      const delivered = { ...chat([message('a', 'unrelated save')]) }
      delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
      delivered.chatKind = 'single'
      delete delivered.ensemble
      return delivered
    }
    const ensembleLive = (): ChatRecord => {
      const live = { ...chat([message('a', 'unrelated save')]) }
      live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
      live.chatKind = 'ensemble'
      live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:01.000Z')
      return live
    }

    it('keeps the switched-on mode against an older-built, newer-stamped delivery', () => {
      const merged = mergeChatUpdatedForRender(soloDelivery(), {
        liveChat: ensembleLive(),
        messagesChanged: false,
        hasActiveRun: false,
        hadRecentRun: false,
        localEnsembleChatKindPending: true
      })

      expect(merged.chatKind).toBe('ensemble')
      expect(merged.ensemble?.participants.map((seat) => seat.id)).toEqual(['seat-1'])
    })

    // Without the claim this is the reported revert, and it is the reason the
    // roster claim alone could not rescue it: the mode helper runs first, so a
    // delivered record with no `ensemble` block survives into the merge and the
    // roster helper then returns on its own `!deliveredEnsemble` guard.
    it('loses the mode to the same delivery when no claim is held', () => {
      const merged = mergeChatUpdatedForRender(soloDelivery(), {
        liveChat: ensembleLive(),
        messagesChanged: false,
        hasActiveRun: false,
        hadRecentRun: false,
        localEnsembleChatKindPending: false,
        localEnsembleRosterPending: true
      })

      expect(merged.chatKind).toBe('single')
    })

    // The claim is not a veto on main either: a confirmed switch-off broadcast
    // must still land while nothing is in flight.
    it('lets a newer main-authored switch-off win when no claim is held', () => {
      const live = ensembleLive()
      const delivered = soloDelivery()
      const merged = mergeChatUpdatedForRender(delivered, {
        liveChat: live,
        messagesChanged: false,
        hasActiveRun: false,
        hadRecentRun: false
      })

      expect(merged.chatKind).toBe('single')
      expect(merged.ensemble).toBeUndefined()
    })
  })

  // The claim is not a veto on main. With none held the wall clock still
  // decides, so a genuinely newer main-authored roster change applies.
  it('still lets a newer delivered roster win when no claim is held', () => {
    const delivered = { ...chat([message('a', 'remote edit')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = makeEnsemble(
      [
        { id: 'seat-1', role: 'Boss' },
        { id: 'seat-9', role: 'Remote seat' }
      ],
      '2026-09-01T00:00:09.000Z'
    )
    const live = { ...chat([message('a', 'remote edit')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: false
    })
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual([
      'seat-1',
      'seat-9'
    ])
  })

  // Main-authored seat bookkeeping must survive the rescue, or a restored
  // roster breaks a resumed provider session.
  it('keeps delivered main-authored round state while restoring the live roster', () => {
    const delivered = { ...chat([message('a', 'unrelated save')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:09.000Z')
    delivered.ensemble = {
      ...makeEnsemble(
        [
          { id: 'seat-1', role: 'Boss' },
          { id: 'seat-2', role: 'Flash' }
        ],
        '2026-09-01T00:00:01.000Z'
      )!,
      activeRound: { roundId: 'round-7', status: 'running' }
    } as ChatRecord['ensemble']
    const live = { ...chat([message('a', 'unrelated save')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localEnsembleRosterPending: true
    })
    expect(merged.ensemble?.activeRound?.roundId).toBe('round-7')
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual(['seat-1'])
  })

  it('leaves the record untouched when live and delivered rosters agree', () => {
    const delivered = { ...chat([message('a', 'frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Worker' }], '2026-09-01T00:00:01.000Z')
    const live = { ...chat([message('a', 'frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Worker' }], '2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })

  // Same 1.0.5-UI2 class, mode-state report (2026-08-30): an Ensemble on/off
  // toggle commits optimistically and persists asynchronously. A delivery built
  // BEFORE that save lands reverts chatKind wholesale — the roster helper
  // cannot defend it because a collapsed live record has no ensemble block to
  // compare, and the selection helper never covered mode state.
  it('keeps a just-collapsed single-provider mode against a staler ensemble delivery', () => {
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'ensemble' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-08-31T00:00:00.500Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = {
      stashedEnsemble: {
        config: makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-08-31T00:00:00.500Z'),
        provider: 'kimi'
      }
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.chatKind).toBe('single')
    expect(merged.ensemble).toBeUndefined()
    // The stashed roster rides across too, or a later Ensemble-on toggle loses it.
    expect(merged.providerMetadata?.stashedEnsemble).toEqual(
      live.providerMetadata.stashedEnsemble
    )
  })

  it('keeps a just-enabled ensemble mode against a staler single-provider delivery', () => {
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'ensemble' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:02.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.chatKind).toBe('ensemble')
    expect(merged.ensemble?.participants.map((participant) => participant.id)).toEqual(['seat-1'])
  })

  it('lets a newer delivered mode change replace the stale live mode', () => {
    // The toggle's own confirmed broadcast — or a remote companion's switch —
    // is newer than the optimistic live copy and must still win.
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'ensemble' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.ensemble = makeEnsemble([{ id: 'seat-1', role: 'Boss' }], '2026-09-01T00:00:04.000Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.chatKind).toBe('ensemble')
    expect(merged.ensemble?.participants).toHaveLength(1)
  })

  it('leaves the record untouched when live and delivered modes agree', () => {
    const delivered = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    const live = { ...chat([message('a', 'frame')]), chatKind: 'single' as const }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })

  // Same 1.0.5-UI2 class, third report: a seat's model/reasoning edit (the
  // Provider/Model/Reasoning picker bound to a participant chip, or the Add
  // Participant picker's seat rows) keeps the id sequence identical, so the
  // membership-only roster preservation let a staler delivery revert the
  // fields — "the selection bounces back".
  it('preserves a just-edited seat configuration against a staler delivery with the same seats', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.4', reasoningEffort: 'medium' }],
      '2026-09-01T00:00:00.500Z'
    )
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.ensemble = makeEnsemble(
      [
        {
          id: 'seat-1',
          role: 'Worker',
          model: 'gpt-5.6-codex',
          reasoningEffort: 'xhigh',
          fastModeEnabled: true
        }
      ],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.6-codex')
    expect(merged.ensemble?.participants[0].reasoningEffort).toBe('xhigh')
    expect(merged.ensemble?.participants[0].fastModeEnabled).toBe(true)
  })

  it('keeps delivered seat bookkeeping while restoring the live seat configuration', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.ensemble = makeEnsemble(
      [
        {
          id: 'seat-1',
          role: 'Worker',
          model: 'gpt-5.4',
          linkedProviderSessionId: 'session-9',
          promptShellVersion: 'shell-3'
        }
      ],
      '2026-09-01T00:00:00.500Z'
    )
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.6-codex' }],
      '2026-09-01T00:00:02.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.6-codex')
    expect(merged.ensemble?.participants[0].linkedProviderSessionId).toBe('session-9')
    expect(merged.ensemble?.participants[0].promptShellVersion).toBe('shell-3')
  })

  it('lets a newer delivered seat configuration replace the stale live copy', () => {
    const delivered = { ...chat([message('a', 'remote edit')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.7' }],
      '2026-09-01T00:00:04.000Z'
    )
    const live = { ...chat([message('a', 'remote edit')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.ensemble = makeEnsemble(
      [{ id: 'seat-1', role: 'Worker', model: 'gpt-5.4' }],
      '2026-09-01T00:00:01.000Z'
    )
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.ensemble?.participants[0].model).toBe('gpt-5.7')
  })

  // Same class again for the solo composer: the Provider/Model/Reasoning
  // picker's chat-level selection (providerMetadata + the queued provider
  // change + workflowMode) had no preservation at all, and main's overlay
  // persistence never broadcasts, so a staler delivery reverted the pick and
  // nothing ever bounced it forward again.
  it('preserves a just-picked composer model selection against a staler delivery', () => {
    const delivered = { ...chat([message('a', 'save echo')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.provider = 'kimi' as ChatRecord['provider']
    delivered.providerMetadata = {
      selectedModelType: 'kimi-k2.7',
      kimiReasoningEffort: 'on',
      agentIdentities: { keep: true }
    }
    const live = { ...chat([message('a', 'save echo')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.provider = 'ollama' as ChatRecord['provider']
    live.providerMetadata = {
      selectedModelType: 'ornith-1.0:9b',
      ollamaReasoningEffort: 'on'
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.provider).toBe('ollama')
    expect(merged.providerMetadata?.selectedModelType).toBe('ornith-1.0:9b')
    expect(merged.providerMetadata?.ollamaReasoningEffort).toBe('on')
    // Selection keys the fresher live record dropped are dropped too…
    expect(merged.providerMetadata?.kimiReasoningEffort).toBeUndefined()
    // …but non-selection metadata stays delivered-authoritative.
    expect(merged.providerMetadata?.agentIdentities).toEqual({ keep: true })
  })

  it('preserves a just-queued pending provider change against a staler delivery', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = {
      selectedModelType: 'kimi-k2.7',
      pendingProviderChange: {
        provider: 'ollama',
        providerMetadata: { selectedModelType: 'ornith-1.0:9b' },
        queuedAt: '2026-09-01T00:00:02.000Z'
      }
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.providerMetadata?.pendingProviderChange).toEqual({
      provider: 'ollama',
      providerMetadata: { selectedModelType: 'ornith-1.0:9b' },
      queuedAt: '2026-09-01T00:00:02.000Z'
    })
  })

  it('does not resurrect a pending provider change the fresher live record cleared', () => {
    const delivered = { ...chat([message('a', 'run frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:00.500Z')
    delivered.providerMetadata = {
      pendingProviderChange: {
        provider: 'ollama',
        providerMetadata: { selectedModelType: 'ornith-1.0:9b' },
        queuedAt: '2026-09-01T00:00:00.000Z'
      }
    }
    const live = { ...chat([message('a', 'run frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = { selectedModelType: 'ornith-1.0:9b' }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.providerMetadata?.pendingProviderChange).toBeUndefined()
    expect(merged.providerMetadata?.selectedModelType).toBe('ornith-1.0:9b')
  })

  it('lets a newer delivered composer selection win over the older live copy', () => {
    const delivered = { ...chat([message('a', 'turn-end apply')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:04.000Z')
    delivered.provider = 'ollama' as ChatRecord['provider']
    delivered.providerMetadata = { selectedModelType: 'ornith-1.0:9b' }
    const live = { ...chat([message('a', 'turn-end apply')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    live.provider = 'kimi' as ChatRecord['provider']
    live.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged.provider).toBe('ollama')
    expect(merged.providerMetadata?.selectedModelType).toBe('ornith-1.0:9b')
  })

  it('leaves the record untouched when the composer selections agree', () => {
    const delivered = { ...chat([message('a', 'frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:01.000Z')
    delivered.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const live = { ...chat([message('a', 'frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false
    })
    expect(merged).toBe(delivered)
  })

  // The reported "I pick a model or drag the reasoning ladder and it resets
  // itself". The delivery is newer BY STAMP — main re-stamps `updatedAt` on
  // every unrelated save, and a run produces one every few hundred ms — while
  // still carrying the selection from before the pick, because the debounced
  // patch has not landed yet. Only the claim can tell those apart.
  it('keeps a claimed selection against a delivery that out-stamps the pick', () => {
    const delivered = { ...chat([message('a', 'stream frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:03.000Z')
    delivered.providerMetadata = {
      selectedModelType: 'muse-spark-1.3',
      museReasoningEffort: 'high'
    }
    const live = { ...chat([message('a', 'stream frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = {
      selectedModelType: 'muse-spark-1.3',
      museReasoningEffort: 'max'
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: true,
      localComposerSelectionPending: true
    })
    expect(merged.providerMetadata?.museReasoningEffort).toBe('max')
  })

  it('keeps a claimed clear of a pending provider change from resurrecting', () => {
    const delivered = { ...chat([message('a', 'stream frame')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:03.000Z')
    delivered.providerMetadata = {
      selectedModelType: 'kimi-k2.7',
      pendingProviderChange: { provider: 'ollama', providerMetadata: {} }
    }
    const live = { ...chat([message('a', 'stream frame')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = { selectedModelType: 'kimi-k2.7' }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localComposerSelectionPending: true
    })
    expect(merged.providerMetadata?.pendingProviderChange).toBeUndefined()
  })

  // The claim is the whole licence to ignore the stamp. With no write
  // outstanding the delivery is main's own newer answer and still wins, so a
  // turn-end apply or a remote companion is never refused.
  it('lets a newer delivered selection win once no local write is outstanding', () => {
    const delivered = { ...chat([message('a', 'turn end')]) }
    delivered.updatedAt = Date.parse('2026-09-01T00:00:03.000Z')
    delivered.providerMetadata = {
      selectedModelType: 'muse-spark-1.3',
      museReasoningEffort: 'high'
    }
    const live = { ...chat([message('a', 'turn end')]) }
    live.updatedAt = Date.parse('2026-09-01T00:00:02.000Z')
    live.providerMetadata = {
      selectedModelType: 'muse-spark-1.3',
      museReasoningEffort: 'max'
    }
    const merged = mergeChatUpdatedForRender(delivered, {
      liveChat: live,
      messagesChanged: false,
      hasActiveRun: false,
      hadRecentRun: false,
      localComposerSelectionPending: false
    })
    expect(merged.providerMetadata?.museReasoningEffort).toBe('high')
  })
})

describe('coalescePendingChatUpdateRender', () => {
  it('keeps transcript dirt sticky when metadata arrives before the frame flush', () => {
    const live = chat([message('a', 'old')])
    const closeout: ChatMessage = {
      id: 'closeout',
      role: 'system',
      content: '',
      timestamp: '2',
      metadata: { kind: 'taskWraithCloseout' }
    }
    const transcriptMessages = [message('a', 'old'), closeout]
    const transcriptDelivery = chat(transcriptMessages)
    const metadataDelivery = {
      ...chat(transcriptMessages),
      title: 'Newest metadata'
    }

    const first = coalescePendingChatUpdateRender(undefined, {
      chat: transcriptDelivery,
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })
    const pending = coalescePendingChatUpdateRender(first, {
      chat: metadataDelivery,
      messagesChanged: false,
      hasActiveRun: true,
      hadRecentRun: false
    })
    const merged = mergeChatUpdatedForRender(pending.chat, {
      liveChat: live,
      messagesChanged: pending.messagesChanged,
      hasActiveRun: pending.hasActiveRun,
      hadRecentRun: pending.hadRecentRun
    })

    expect(pending.chat).toBe(metadataDelivery)
    expect(pending.messagesChanged).toBe(true)
    expect(merged.title).toBe('Newest metadata')
    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'closeout'])
  })

  it('retains only the newest non-gating render receipt for a coalesced chat', () => {
    const first = coalescePendingChatUpdateRender(undefined, {
      chat: chat([message('a', 'one')]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false,
      renderReceipt: {
        chatId: 'chat-merge',
        deliveryId: 'delivery-1',
        revision: 1,
        rendererEpoch: 'renderer-a'
      }
    })
    const pending = coalescePendingChatUpdateRender(first, {
      chat: chat([message('a', 'two')]),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false,
      renderReceipt: {
        chatId: 'chat-merge',
        deliveryId: 'delivery-2',
        revision: 2,
        rendererEpoch: 'renderer-a'
      }
    })

    expect(pending.renderReceipt?.deliveryId).toBe('delivery-2')
  })
})

describe('chatRecordHasLiveRun', () => {
  const NOW = Date.parse('2026-09-12T04:00:00.000Z')
  const iso = (ms: number): string => new Date(ms).toISOString()

  function ensembleChatWithRound(round: Record<string, unknown>): ChatRecord {
    return {
      ...chat([]),
      chatKind: 'ensemble',
      ensemble: { participants: [], activeRound: round }
    } as unknown as ChatRecord
  }

  it('treats a running round with no endedAt as live, with no renderer run context', () => {
    // The Host-independent-threads shape: the round executes in the Host, so
    // activeRunsRef never carries it — the record is the only liveness evidence.
    const record = ensembleChatWithRound({
      roundId: 'round-1',
      status: 'running',
      prompt: 'hi',
      startedAt: iso(NOW - 60_000),
      synthesisStatus: 'pending',
      participants: []
    })

    expect(chatRecordHasLiveRun(record, NOW)).toBe(true)
  })

  it('keeps a just-ended round live through the settling grace', () => {
    // The incident shape: the round was stamped 'cancelled' with synthesis
    // still 'pending' while its lane rows were still settling.
    const record = ensembleChatWithRound({
      roundId: 'round-1',
      status: 'cancelled',
      prompt: 'hi',
      startedAt: iso(NOW - 60_000),
      endedAt: iso(NOW - 1_000),
      synthesisStatus: 'pending',
      participants: []
    })

    expect(chatRecordHasLiveRun(record, NOW)).toBe(true)
  })

  it('treats a round ended past the grace as settled', () => {
    const record = ensembleChatWithRound({
      roundId: 'round-1',
      status: 'cancelled',
      prompt: 'hi',
      startedAt: iso(NOW - 600_000),
      endedAt: iso(NOW - CHAT_RECORD_LIVE_GRACE_MS - 1),
      participants: []
    })

    expect(chatRecordHasLiveRun(record, NOW)).toBe(false)
  })

  it('treats a terminal-stamped round that never got an endedAt as settled', () => {
    const record = ensembleChatWithRound({
      roundId: 'round-1',
      status: 'completed',
      prompt: 'hi',
      startedAt: iso(NOW - 600_000),
      participants: []
    })

    expect(chatRecordHasLiveRun(record, NOW)).toBe(false)
  })

  it('treats a running-status run with no endedAt as live', () => {
    const record = {
      ...chat([]),
      runs: [{ runId: 'run-host', startedAt: iso(NOW - 5_000), status: 'running' }]
    }

    expect(chatRecordHasLiveRun(record, NOW)).toBe(true)
  })

  it('keeps a run that just ended live through the grace', () => {
    const record = {
      ...chat([]),
      runs: [
        {
          runId: 'run-host',
          startedAt: iso(NOW - 5_000),
          status: 'success',
          endedAt: iso(NOW - 500)
        }
      ]
    }

    expect(chatRecordHasLiveRun(record, NOW)).toBe(true)
  })

  it('treats a run ended past the grace as settled', () => {
    const record = {
      ...chat([]),
      runs: [
        {
          runId: 'run-host',
          startedAt: iso(NOW - 500_000),
          status: 'success',
          endedAt: iso(NOW - CHAT_RECORD_LIVE_GRACE_MS - 1)
        }
      ]
    }

    expect(chatRecordHasLiveRun(record, NOW)).toBe(false)
  })

  it('treats a run with no status and no endedAt as live (no end evidence)', () => {
    const record = { ...chat([]), runs: [run('run-host')] }

    expect(chatRecordHasLiveRun(record, NOW)).toBe(true)
  })

  it('treats a terminal-status run with no endedAt as settled', () => {
    const record = {
      ...chat([]),
      runs: [{ runId: 'run-host', startedAt: iso(NOW - 5_000), status: 'failed' }]
    }

    expect(chatRecordHasLiveRun(record, NOW)).toBe(false)
  })

  it('treats a quiet record, and no record, as settled', () => {
    expect(chatRecordHasLiveRun(chat([message('a', 'done')]), NOW)).toBe(false)
    expect(chatRecordHasLiveRun(null, NOW)).toBe(false)
    expect(chatRecordHasLiveRun(undefined, NOW)).toBe(false)
  })
})

describe('mergeChatUpdatedForRender fan-out lane tool rows', () => {
  const LANE_BASE_METADATA = {
    ensembleRoundId: 'round-1',
    ensembleParticipantId: 'participant-1',
    ensembleLaneId: 'lane-1'
  }

  function laneContentRow(id: string, content: string, timestamp: string): ChatMessage {
    return {
      id,
      role: 'assistant',
      content,
      timestamp,
      runId: 'run-1',
      metadata: { ...LANE_BASE_METADATA, kind: 'ensembleParticipant' }
    } as ChatMessage
  }

  function laneToolRow(id: string, timestamp: string): ChatMessage {
    return {
      id,
      role: 'tool',
      content: '',
      timestamp,
      runId: 'run-1',
      toolActivities: [{ id: `${id}-act`, tool: 'read_file', status: 'completed' }],
      metadata: { ...LANE_BASE_METADATA, kind: 'ensembleParticipantTools' }
    } as unknown as ChatMessage
  }

  it('preserves an orphaned lane tool row onto a delivery from a different baseline', () => {
    // Mid-round the Host streams deliveries built from baselines that have not
    // seen this lane's rows yet. Before, the tool row vanished from view and
    // the next delivery restored it — the visible lane-card flash.
    const liveMessages = [laneContentRow('lane-c1', 'working…', '2'), laneToolRow('lane-t1', '3')]

    const merged = mergeChatUpdatedForRender(chat([message('a', 'older round row')]), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'lane-c1', 'lane-t1'])
  })

  it('re-anchors the preserved tool row after its lane content, not the tail', () => {
    const liveMessages = [
      message('a', 'older round row'),
      laneContentRow('lane-c1', 'working…', '2'),
      laneToolRow('lane-t1', '3')
    ]
    const newerDelivered: ChatMessage = {
      id: 'b',
      role: 'assistant',
      content: 'newer delivered row',
      timestamp: '4'
    }

    const merged = mergeChatUpdatedForRender(chat([message('a', 'older round row'), newerDelivered]), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'lane-c1', 'lane-t1', 'b'])
  })

  it('does not duplicate a lane tool row the delivery already carries', () => {
    const liveMessages = [laneContentRow('lane-c1', 'working…', '2'), laneToolRow('lane-t1', '3')]
    const delivery = chat([laneContentRow('lane-c1', 'delivered content', '2'), laneToolRow('lane-t1', '3')])

    const merged = mergeChatUpdatedForRender(delivery, {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: true,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['lane-c1', 'lane-t1'])
  })

  it('does not preserve lane tool rows outside the live gate', () => {
    // Outside an active/recent run the delivery is authoritative: rows the
    // canonical record no longer carries stay gone (the wipe-respecting
    // boundary — preservation only ever runs inside the gate).
    const liveMessages = [laneContentRow('lane-c1', 'working…', '2'), laneToolRow('lane-t1', '3')]

    const merged = mergeChatUpdatedForRender(chat([message('a', 'canonical')]), {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun: false,
      hadRecentRun: false
    })

    expect(merged.messages.map((entry) => entry.id)).toEqual(['a'])
  })

  it('preserves the lane rows when record-derived liveness opens the gate', () => {
    // The (a)+(b) wiring contract: no renderer-registered run exists for a
    // Host-owned round, so the delivery's own running round is what App.tsx
    // feeds into hasActiveRun.
    const NOW = Date.parse('2026-09-12T04:00:00.000Z')
    const delivery = {
      ...chat([message('a', 'older round row')]),
      chatKind: 'ensemble',
      ensemble: {
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'hi',
          startedAt: new Date(NOW - 60_000).toISOString(),
          participants: []
        }
      }
    } as unknown as ChatRecord
    const liveMessages = [laneContentRow('lane-c1', 'working…', '2'), laneToolRow('lane-t1', '3')]
    const hasActiveRun = chatRecordHasLiveRun(delivery, NOW)

    const merged = mergeChatUpdatedForRender(delivery, {
      liveChat: chat(liveMessages),
      messagesChanged: true,
      hasActiveRun,
      hadRecentRun: false
    })

    expect(hasActiveRun).toBe(true)
    expect(merged.messages.map((entry) => entry.id)).toEqual(['a', 'lane-c1', 'lane-t1'])
  })
})
