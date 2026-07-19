import { describe, expect, it } from 'vitest'
import {
  codexProviderOperationId,
  codexTerminalMethodMatchesAdmission,
  CodexThreadAdmissionRegistry
} from './CodexThreadAdmission'

describe('CodexThreadAdmissionRegistry', () => {
  const scope = { appChatId: 'chat-a', workspaceId: 'workspace-a' }

  it('serializes a compaction attempted while a user turn is paused in setup', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const userTurn = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    const compaction = registry.reserve({
      threadId: 'thread-a',
      kind: 'manual_compaction',
      scope
    })

    expect(await userTurn.waitUntilAcquired()).toBe(true)
    let compactionAcquired = false
    void compaction.waitUntilAcquired().then((value) => {
      compactionAcquired = value
    })
    await Promise.resolve()
    expect(compactionAcquired).toBe(false)

    // The compaction is still only an attempt: it cannot have an admitted id
    // while the user's setup reservation owns the lane.
    expect(compaction.bindExactOperationId('compact-turn')).toBe(false)
    expect(userTurn.bindExactOperationId('user-turn')).toBe(true)
    await Promise.resolve()
    expect(compactionAcquired).toBe(false)
    expect(userTurn.releaseAfterExactTerminal('compact-turn')).toBe(false)
    expect(userTurn.releaseAfterExactTerminal('user-turn')).toBe(true)
    expect(await compaction.waitUntilAcquired()).toBe(true)

    expect(compaction.bindExactOperationId('compact-turn')).toBe(true)
    expect(compaction.matchesExactOperationId('user-turn')).toBe(false)
    expect(compaction.releaseAfterExactTerminal('compact-turn')).toBe(true)
  })

  it('keeps an accepted user turn correlated through only its own terminal id', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const userTurn = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    expect(await userTurn.waitUntilAcquired()).toBe(true)
    expect(userTurn.bindExactOperationId('user-turn')).toBe(true)

    expect(userTurn.matchesExactOperationId('compact-turn')).toBe(false)
    expect(userTurn.matchesExactOperationId('user-turn')).toBe(true)
    expect(userTurn.bindExactOperationId('compact-turn')).toBe(false)
    expect(userTurn.exactOperationId).toBe('user-turn')
    expect(userTurn.releaseAfterExactTerminal('user-turn')).toBe(true)
  })

  it('gives native review the same exact-id admission boundary', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const review = registry.reserve({ threadId: 'thread-a', kind: 'review', scope })
    const compaction = registry.reserve({
      threadId: 'thread-a',
      kind: 'manual_compaction',
      scope
    })

    expect(await review.waitUntilAcquired()).toBe(true)
    expect(review.bindExactOperationId('review-1')).toBe(true)
    expect(review.releaseAfterExactTerminal('review-1')).toBe(true)
    expect(await compaction.waitUntilAcquired()).toBe(true)
    expect(compaction.bindExactOperationId('compact-1')).toBe(true)

    expect(review.matchesExactOperationId('compact-1')).toBe(false)
    expect(review.matchesExactOperationId('review-1')).toBe(true)
    expect(compaction.releaseAfterExactTerminal('compact-1')).toBe(true)
  })

  it('extracts exact ids and rejects cross-kind or uncorrelated terminal settlement', () => {
    expect(
      codexProviderOperationId({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } })
    ).toBe('turn-1')
    expect(
      codexProviderOperationId({ method: 'item/started', params: { turnId: 'turn-2' } })
    ).toBe('turn-2')
    expect(codexProviderOperationId({ method: 'error', params: { threadId: 'thread-a' } })).toBe(
      undefined
    )
    expect(
      codexProviderOperationId({
        method: 'turn/completed',
        params: { turn: { id: 'turn-a' }, turnId: 'turn-b' }
      })
    ).toBe(undefined)
    expect(codexTerminalMethodMatchesAdmission('turn', 'review/completed')).toBe(false)
    expect(codexTerminalMethodMatchesAdmission('review', 'turn/completed')).toBe(true)
    expect(codexTerminalMethodMatchesAdmission('review', 'review/completed')).toBe(true)
  })

  it('can cancel a queued admission without blocking the lane', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const first = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    const cancelled = registry.reserve({
      threadId: 'thread-a',
      kind: 'manual_compaction',
      scope
    })
    const next = registry.reserve({ threadId: 'thread-a', kind: 'review', scope })

    cancelled.cancelBeforeAcquired()
    expect(await cancelled.waitUntilAcquired()).toBe(false)
    expect(first.bindExactOperationId('turn-1')).toBe(true)
    expect(first.releaseAfterExactTerminal('turn-1')).toBe(true)
    expect(await next.waitUntilAcquired()).toBe(true)
    expect(next.bindExactOperationId('review-1')).toBe(true)
    expect(next.releaseAfterExactTerminal('review-1')).toBe(true)
  })

  it('does not let a terminal frame become the first binder or release a successor', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const first = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    const successor = registry.reserve({ threadId: 'thread-a', kind: 'review', scope })
    expect(await first.waitUntilAcquired()).toBe(true)

    expect(first.matchesExactOperationId('stale-terminal')).toBe(false)
    expect(first.releaseAfterExactTerminal('stale-terminal')).toBe(false)
    let successorAcquired = false
    void successor.waitUntilAcquired().then((value) => {
      successorAcquired = value
    })
    await Promise.resolve()
    expect(successorAcquired).toBe(false)

    expect(first.bindExactOperationId('turn-1')).toBe(true)
    expect(first.releaseAfterExactTerminal('turn-1')).toBe(true)
    expect(await successor.waitUntilAcquired()).toBe(true)
    // A duplicate release from the predecessor cannot release the new owner.
    expect(first.releaseAfterExactTerminal('turn-1')).toBe(true)
    expect(successor.bindExactOperationId('review-1')).toBe(true)
    expect(successor.isAdmissionOwner()).toBe(true)
    expect(successor.releaseAfterExactTerminal('review-1')).toBe(true)
  })

  it('keeps different provider threads concurrent', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const first = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    const second = registry.reserve({
      threadId: 'thread-b',
      kind: 'manual_compaction',
      scope: { appChatId: 'chat-b', workspaceId: 'workspace-b' }
    })

    expect(await first.waitUntilAcquired()).toBe(true)
    expect(await second.waitUntilAcquired()).toBe(true)
    expect(first.bindExactOperationId('turn-a')).toBe(true)
    expect(second.bindExactOperationId('turn-b')).toBe(true)
    expect(first.releaseAfterExactTerminal('turn-a')).toBe(true)
    expect(second.releaseAfterExactTerminal('turn-b')).toBe(true)
  })

  it('retains an accepted review with no response id until delayed start and terminal', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const review = registry.reserve({ threadId: 'thread-a', kind: 'review', scope })
    const nextTurn = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    expect(await review.waitUntilAcquired()).toBe(true)

    // Successful review/start acknowledgement carried no turn id. No explicit
    // pre-admission release occurs, so the later turn remains queued.
    let nextAcquired = false
    void nextTurn.waitUntilAcquired().then((value) => {
      nextAcquired = value
    })
    await Promise.resolve()
    expect(nextAcquired).toBe(false)

    expect(review.bindExactOperationId('delayed-review-turn')).toBe(true)
    await Promise.resolve()
    expect(nextAcquired).toBe(false)
    expect(review.releaseAfterExactTerminal('delayed-review-turn')).toBe(true)
    expect(await nextTurn.waitUntilAcquired()).toBe(true)
    nextTurn.releaseBeforeAdmission()
  })

  it('cancels and joins queued admission during exact chat history deletion', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const setupOwner = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    const queuedReview = registry.reserve({ threadId: 'thread-a', kind: 'review', scope })
    expect(await setupOwner.waitUntilAcquired()).toBe(true)

    const hold = registry.beginHistoryClear({ kind: 'chat', chatIds: ['chat-a'] })
    expect(setupOwner.isHistoryRevoked()).toBe(true)
    expect(await queuedReview.waitUntilAcquired()).toBe(false)
    let joined = false
    void hold.completion.then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)

    setupOwner.releaseBeforeAdmission()
    await hold.completion
    expect(joined).toBe(true)

    const blocked = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    expect(await blocked.waitUntilAcquired()).toBe(false)
    expect(registry.endHistoryClear(hold)).toBe(true)
    const reopened = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    expect(await reopened.waitUntilAcquired()).toBe(true)
    reopened.releaseBeforeAdmission()
  })

  it('holds deletion through an admitted exact operation until its terminal release', async () => {
    const registry = new CodexThreadAdmissionRegistry()
    const turn = registry.reserve({ threadId: 'thread-a', kind: 'turn', scope })
    expect(await turn.waitUntilAcquired()).toBe(true)
    expect(turn.bindExactOperationId('turn-1')).toBe(true)

    const hold = registry.beginHistoryClear({
      kind: 'workspace',
      workspaceId: 'workspace-a',
      chatIds: ['chat-a']
    })
    let joined = false
    void hold.completion.then(() => {
      joined = true
    })
    await Promise.resolve()
    expect(joined).toBe(false)
    expect(turn.releaseAfterExactTerminal('wrong-turn')).toBe(false)
    await Promise.resolve()
    expect(joined).toBe(false)
    expect(turn.releaseAfterExactTerminal('turn-1')).toBe(true)
    await hold.completion
    expect(joined).toBe(true)
    expect(registry.endHistoryClear(hold)).toBe(true)
  })
})
