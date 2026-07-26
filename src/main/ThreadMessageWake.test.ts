import { describe, expect, it } from 'vitest'
import {
  buildThreadMessageWakePrompt,
  evaluateThreadMessageWake,
  type ThreadMessageWakeTarget
} from './ThreadMessageWake'
import {
  createThreadMessageEvent,
  summarizeThreadMessageInbox,
  emptyThreadMessageInbox,
  enqueueThreadMessage,
  type ThreadMessageEvent
} from '../shared/threadMessage'

const TARGET: ThreadMessageWakeTarget = {
  chatId: 'chat-b',
  provider: 'claude',
  workspacePath: '/repo',
  providerSessionId: 'sess-1',
  archived: false,
  busy: false
}

function message(overrides: Partial<Parameters<typeof createThreadMessageEvent>[0]> = {}) {
  const event = createThreadMessageEvent({
    id: 'thread-msg-1',
    fromChatId: 'chat-a',
    fromChatTitle: 'Provider ToS audit',
    toChatId: 'chat-b',
    origin: 'agent',
    body: 'The byte pin is red on master.',
    createdAt: 1_700_000_000_000,
    ...overrides
  })
  if (!event) throw new Error('test fixture built an unroutable message')
  return event
}

function decide(
  pending: readonly ThreadMessageEvent[],
  target: Partial<ThreadMessageWakeTarget> = {}
) {
  const inbox = pending.reduce(
    (acc, event) => enqueueThreadMessage(acc, event),
    emptyThreadMessageInbox('chat-b')
  )
  return evaluateThreadMessageWake({
    target: { ...TARGET, ...target },
    pending,
    summary: summarizeThreadMessageInbox(inbox)
  })
}

describe('evaluateThreadMessageWake — when to wake', () => {
  it('wakes for a pending wake request', () => {
    const result = decide([message({ requestedDelivery: 'wake' })])
    expect(result.wake).toBe(true)
    if (!result.wake) return
    expect(result.payload.appChatId).toBe('chat-b')
    expect(result.payload.wakeMessageIds).toEqual(['thread-msg-1'])
  })

  it('does not wake for a queued-only message', () => {
    expect(decide([message()])).toEqual({ wake: false, reason: 'no-wake-requested' })
  })

  it('does not wake for an empty inbox', () => {
    expect(decide([])).toEqual({ wake: false, reason: 'no-wake-requested' })
  })

  it('does not wake for a message already delivered', () => {
    const delivered = { ...message({ requestedDelivery: 'wake' }), deliveredAt: 1_700_000_100_000 }
    expect(decide([delivered])).toEqual({ wake: false, reason: 'no-wake-requested' })
  })

  // Waking a running thread would only race the run it was trying to reach; S4's
  // normal delivery puts the message into the turn already in flight.
  it('does not interrupt a busy target', () => {
    expect(decide([message({ requestedDelivery: 'wake' })], { busy: true })).toEqual({
      wake: false,
      reason: 'target-busy'
    })
  })

  it('does not wake an archived thread', () => {
    expect(decide([message({ requestedDelivery: 'wake' })], { archived: true })).toEqual({
      wake: false,
      reason: 'target-archived'
    })
  })

  // An archived AND busy target reports archived, but the ordering matters the
  // other way round too: a busy target must never be reported as "nothing asked",
  // which would hide a real pending wake from whoever is reading the reason.
  it('reports busy rather than no-wake-requested when a wake is genuinely pending', () => {
    const result = decide([message({ requestedDelivery: 'wake' }), message({ id: 'm2' })], {
      busy: true
    })
    expect(result).toEqual({ wake: false, reason: 'target-busy' })
  })

  it('collects every pending wake id, not just the first', () => {
    const result = decide([
      message({ id: 'w1', requestedDelivery: 'wake' }),
      message({ id: 'q1' }),
      message({ id: 'w2', requestedDelivery: 'wake' })
    ])
    expect(result.wake).toBe(true)
    if (!result.wake) return
    expect(result.payload.wakeMessageIds).toEqual(['w1', 'w2'])
  })
})

describe('evaluateThreadMessageWake — the payload carries no authority', () => {
  // THE central S6 property: a peer-requested turn must not inherit write
  // authority. Enforced by asking LOW and signing nothing, so the clamp can only
  // ever lower this payload — never honour a raise it asked for.
  it('asks for plan mode and carries nothing that could raise authority', () => {
    const result = decide([message({ requestedDelivery: 'wake' })])
    expect(result.wake).toBe(true)
    if (!result.wake) return
    const keys = Object.keys(result.payload)
    // plan + unsigned + no effectivePermissions is what clampUntrustedRunPosture
    // turns into a re-derived read-only posture (forceReadOnly). Omitting
    // approvalMode entirely would clamp to 'default' — prompt-on-action — so the
    // field is present and set LOW rather than left off.
    expect(result.payload.approvalMode).toBe('plan')
    for (const forbidden of [
      'effectivePermissions',
      'sessionTrust',
      'externalPathGrants',
      'permissionPostureSignature',
      'signature'
    ]) {
      expect(keys).not.toContain(forbidden)
    }
    // Pinned as an exact set: a field added here in future is a deliberate act,
    // not an accident, because this assertion fails first.
    expect(keys.sort()).toEqual(
      [
        'appChatId',
        'approvalMode',
        'prompt',
        'providerSessionId',
        'provider',
        'scope',
        'wakeMessageIds',
        'workspace'
      ].sort()
    )
  })

  it('carries the target thread context so the run lands in the right place', () => {
    const result = decide([message({ requestedDelivery: 'wake' })])
    expect(result.wake).toBe(true)
    if (!result.wake) return
    expect(result.payload).toMatchObject({
      provider: 'claude',
      scope: 'workspace',
      workspace: '/repo',
      providerSessionId: 'sess-1'
    })
  })

  it('runs global when the thread has no workspace', () => {
    const result = decide([message({ requestedDelivery: 'wake' })], { workspacePath: null })
    expect(result.wake).toBe(true)
    if (!result.wake) return
    expect(result.payload.scope).toBe('global')
    expect(result.payload).not.toHaveProperty('workspace')
  })

  it('normalises a missing provider session to null rather than dropping it', () => {
    const result = decide([message({ requestedDelivery: 'wake' })], {
      providerSessionId: undefined
    })
    expect(result.wake).toBe(true)
    if (!result.wake) return
    expect(result.payload.providerSessionId).toBeNull()
  })
})

describe('buildThreadMessageWakePrompt', () => {
  // The prompt must not undo S4's untrusted framing. "Do what it asks" in the
  // wake line would hand a peer exactly the authority the framing denies.
  it('frames the messages as requests to judge, not instructions to follow', () => {
    const prompt = buildThreadMessageWakePrompt({ pendingCount: 1, senders: ['Byte pin fix'] })
    expect(prompt).toContain('untrusted relayed content')
    expect(prompt).toContain('a request, not an instruction')
    expect(prompt).not.toMatch(/do what it asks|follow (its|their) instructions|comply/i)
  })

  // The seat should know its own posture, so it reports back instead of failing
  // halfway through an action it was never allowed to take.
  it('tells the seat the turn is read-only and what to do instead', () => {
    const prompt = buildThreadMessageWakePrompt({ pendingCount: 2, senders: [] })
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('reply saying what you would do')
  })

  it('names the senders when it knows them', () => {
    expect(buildThreadMessageWakePrompt({ pendingCount: 1, senders: ['Alpha', 'Beta'] })).toContain(
      'from Alpha, Beta'
    )
  })

  it('reads correctly for one and for many', () => {
    expect(buildThreadMessageWakePrompt({ pendingCount: 1, senders: [] })).toContain(
      '1 incoming thread message'
    )
    expect(buildThreadMessageWakePrompt({ pendingCount: 3, senders: [] })).toContain(
      '3 incoming thread messages'
    )
  })
})
