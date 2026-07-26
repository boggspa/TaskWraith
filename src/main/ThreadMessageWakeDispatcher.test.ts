import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REMEMBERED_DISPATCHED_WAKE_IDS,
  createThreadMessageWakeDispatcher,
  type ThreadMessageWakeDispatcherDeps
} from './ThreadMessageWakeDispatcher'
import type { ThreadMessageWakeTarget } from './ThreadMessageWake'
import {
  createThreadMessageEvent,
  emptyThreadMessageInbox,
  enqueueThreadMessage,
  type ThreadMessageInbox
} from '../shared/threadMessage'

const TARGET: ThreadMessageWakeTarget = {
  chatId: 'chat-b',
  provider: 'claude',
  workspacePath: '/repo',
  providerSessionId: 'sess-1',
  archived: false,
  busy: false
}

function inbox(
  toChatId: string,
  specs: { id: string; wake?: boolean }[] = [{ id: 'w1', wake: true }]
): ThreadMessageInbox {
  return specs.reduce((acc, spec) => {
    const event = createThreadMessageEvent({
      id: spec.id,
      fromChatId: 'chat-a',
      fromChatTitle: 'Sender',
      toChatId,
      origin: 'agent',
      body: 'Byte pin is red.',
      requestedDelivery: spec.wake ? 'wake' : 'queue',
      createdAt: 1_700_000_000_000
    })
    if (!event) throw new Error('bad fixture')
    return enqueueThreadMessage(acc, event)
  }, emptyThreadMessageInbox(toChatId))
}

function harness(overrides: Partial<ThreadMessageWakeDispatcherDeps> = {}) {
  const dispatched: Record<string, unknown>[] = []
  const deps: ThreadMessageWakeDispatcherDeps = {
    getPendingInboxes: () => [inbox('chat-b')],
    resolveTarget: () => TARGET,
    dispatchRun: async (payload) => {
      dispatched.push(payload)
      return { dispatched: true }
    },
    createRunId: (provider) => `run-${provider}-${dispatched.length + 1}`,
    ...overrides
  }
  return { dispatcher: createThreadMessageWakeDispatcher(deps), dispatched }
}

describe('createThreadMessageWakeDispatcher', () => {
  it('dispatches a run for a pending wake request', async () => {
    const h = harness()
    const out = await h.dispatcher.dispatchPendingWakes()
    expect(out.woken).toEqual([
      { chatId: 'chat-b', appRunId: 'run-claude-1', wakeMessageIds: ['w1'] }
    ])
    expect(h.dispatched).toHaveLength(1)
    expect(h.dispatched[0]).toMatchObject({ appChatId: 'chat-b', appRunId: 'run-claude-1' })
  })

  // THE property this module exists to keep. A peer-requested turn must not be
  // able to carry write authority, and the enforcement is that nothing here can
  // add it — there is no signer in the deps.
  it('dispatches a payload with no permission fields and no signature', async () => {
    const h = harness()
    await h.dispatcher.dispatchPendingWakes()
    const keys = Object.keys(h.dispatched[0])
    for (const forbidden of [
      'effectivePermissions',
      'sessionTrust',
      'externalPathGrants',
      'permissionPostureSignature',
      'signature'
    ]) {
      expect(keys).not.toContain(forbidden)
    }
    // plan + unsigned + no permissions is what clampUntrustedRunPosture turns into
    // a re-derived read-only posture.
    expect(h.dispatched[0].approvalMode).toBe('plan')
  })

  it('does not dispatch for a queued-only inbox', async () => {
    const h = harness({ getPendingInboxes: () => [inbox('chat-b', [{ id: 'q1' }])] })
    const out = await h.dispatcher.dispatchPendingWakes()
    expect(out.woken).toEqual([])
    expect(out.skipped).toEqual([{ chatId: 'chat-b', reason: 'no-wake-requested' }])
  })

  it.each([
    ['busy', { ...TARGET, busy: true }, 'target-busy'],
    ['archived', { ...TARGET, archived: true }, 'target-archived']
  ])('skips a %s target with its reason', async (_label, target, reason) => {
    const h = harness({ resolveTarget: () => target })
    const out = await h.dispatcher.dispatchPendingWakes()
    expect(out.woken).toEqual([])
    expect(out.skipped[0].reason).toBe(reason)
  })

  it('skips an unresolvable target rather than throwing', async () => {
    const h = harness({ resolveTarget: () => null })
    const out = await h.dispatcher.dispatchPendingWakes()
    expect(out.skipped).toEqual([{ chatId: 'chat-b', reason: 'target-archived' }])
  })
})

describe('createThreadMessageWakeDispatcher — double dispatch', () => {
  // A started run makes the target busy, which the decision already refuses on,
  // but two ticks can race that window. Waking twice for one message would put a
  // peer's request in front of the user twice and burn a turn doing it.
  it('does not wake twice for the same message', async () => {
    const h = harness()
    await h.dispatcher.dispatchPendingWakes()
    const second = await h.dispatcher.dispatchPendingWakes()
    expect(h.dispatched).toHaveLength(1)
    expect(second.skipped).toEqual([{ chatId: 'chat-b', reason: 'already-dispatched' }])
  })

  // A genuinely new request alongside an old one still deserves a turn.
  it('wakes again when a NEW wake id joins an already-dispatched one', async () => {
    let box = inbox('chat-b')
    const h = harness({ getPendingInboxes: () => [box] })
    await h.dispatcher.dispatchPendingWakes()
    box = inbox('chat-b', [
      { id: 'w1', wake: true },
      { id: 'w2', wake: true }
    ])
    const second = await h.dispatcher.dispatchPendingWakes()
    expect(second.woken[0].wakeMessageIds).toEqual(['w1', 'w2'])
    expect(h.dispatched).toHaveLength(2)
  })

  // A transient dispatch failure must retry, not be swallowed as done.
  it('retries after a failed dispatch', async () => {
    let attempt = 0
    const h = harness({
      dispatchRun: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('run queue unavailable')
        return { dispatched: true }
      }
    })
    const first = await h.dispatcher.dispatchPendingWakes()
    expect(first.skipped).toEqual([{ chatId: 'chat-b', reason: 'failed' }])
    const second = await h.dispatcher.dispatchPendingWakes()
    expect(second.woken).toHaveLength(1)
  })

  it('treats a refused dispatch as failed and retryable', async () => {
    let attempt = 0
    const h = harness({
      dispatchRun: async () => {
        attempt += 1
        return { dispatched: attempt > 1 }
      }
    })
    expect((await h.dispatcher.dispatchPendingWakes()).skipped[0].reason).toBe('failed')
    expect((await h.dispatcher.dispatchPendingWakes()).woken).toHaveLength(1)
  })

  // Eviction needs many CHATS, not one big inbox: enqueueThreadMessage caps pending
  // at MAX_PENDING_THREAD_MESSAGES (64), so a single inbox can never reach the
  // guard's size. That makes the 512 budget generous and eviction genuinely rare.
  it('bounds the remembered id set across many chats', async () => {
    const chats = MAX_REMEMBERED_DISPATCHED_WAKE_IDS + 40
    let served = 0
    const h = harness({
      getPendingInboxes: () => {
        served += 1
        if (served === 1) {
          return Array.from({ length: chats }, (_x, i) =>
            inbox(`chat-${i}`, [{ id: `w${i}`, wake: true }])
          )
        }
        return [inbox('chat-0', [{ id: 'w0', wake: true }])]
      },
      resolveTarget: (chatId) => ({ ...TARGET, chatId })
    })
    const first = await h.dispatcher.dispatchPendingWakes()
    expect(first.woken).toHaveLength(chats)
    // w0 was evicted as the oldest, so it is eligible again — bounded memory trades
    // a rare duplicate wake for a guard that cannot grow without limit.
    const second = await h.dispatcher.dispatchPendingWakes()
    expect(second.woken).toHaveLength(1)
  })
})

describe('createThreadMessageWakeDispatcher — sweep isolation', () => {
  it('keeps going after one chat fails', async () => {
    const log = vi.fn()
    const h = harness({
      getPendingInboxes: () => [inbox('chat-bad'), inbox('chat-b')],
      resolveTarget: (chatId) => ({ ...TARGET, chatId }),
      dispatchRun: async (payload) => {
        if (payload.appChatId === 'chat-bad') throw new Error('boom')
        return { dispatched: true }
      },
      log
    })
    const out = await h.dispatcher.dispatchPendingWakes()
    expect(out.skipped).toEqual([{ chatId: 'chat-bad', reason: 'failed' }])
    expect(out.woken.map((w) => w.chatId)).toEqual(['chat-b'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('chat-bad'))
  })
})
