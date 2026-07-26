import { describe, expect, it } from 'vitest'
import {
  evaluateThreadMessageGate,
  threadMessageApprovalLedgerMetadata,
  threadMessageDenialMessage,
  type ThreadMessageGateInput
} from './ThreadMessagePermission'

const FULL_ELEVATION = {
  fullAccess: true,
  trustedSession: true,
  bossAutoApproval: true
} as const

function gate(overrides: Partial<ThreadMessageGateInput> = {}) {
  return evaluateThreadMessageGate({
    origin: 'agent',
    requestedDelivery: 'queue',
    crossWorkspace: false,
    servicePolicy: 'allow',
    readOnly: false,
    remoteOrigin: false,
    elevation: { fullAccess: false, trustedSession: false, bossAutoApproval: false },
    ...overrides
  })
}

describe('evaluateThreadMessageGate — the ordinary case', () => {
  it('auto-allows a queued same-workspace send once the service is granted', () => {
    expect(gate()).toEqual({
      verdict: 'allow',
      reason: 'service-granted',
      ledgerRequired: true
    })
  })

  it.each(['ask', 'workspace'] as const)('prompts when the service is at %s', (servicePolicy) => {
    expect(gate({ servicePolicy })).toMatchObject({ verdict: 'prompt', reason: 'service-ask' })
  })
})

describe('evaluateThreadMessageGate — hard denies win first', () => {
  // The global setting is the user's own kill switch, so it outranks even a
  // message the user composed themselves.
  it.each([
    ['an agent send', 'agent'],
    ['a user send', 'user']
  ] as const)('denies %s when the service policy is deny', (_label, origin) => {
    expect(gate({ origin, servicePolicy: 'deny' })).toMatchObject({
      verdict: 'deny',
      reason: 'service-denied'
    })
  })

  it('denies a deny-policy send even with the full elevation stack', () => {
    expect(gate({ servicePolicy: 'deny', elevation: { ...FULL_ELEVATION } })).toMatchObject({
      verdict: 'deny'
    })
  })
})

describe('evaluateThreadMessageGate — waking another thread', () => {
  // A wake runs a turn in ANOTHER thread, under that thread's permissions, with
  // nobody watching. A service grant must never be enough on its own.
  it('prompts for a wake even when the service is granted', () => {
    expect(gate({ requestedDelivery: 'wake' })).toMatchObject({
      verdict: 'prompt',
      reason: 'wake-requested',
      ledgerRequired: false
    })
  })

  it('allows an elevated same-workspace wake but demands a ledger row', () => {
    expect(gate({ requestedDelivery: 'wake', elevation: { ...FULL_ELEVATION } })).toEqual({
      verdict: 'allow',
      reason: 'elevated',
      ledgerRequired: true,
      elevationGrounds: ['fullAccess', 'trustedSession', 'bossAutoApproval']
    })
  })

  // Any ONE signal is enough — they are three independent ways the user has said
  // yes to automation here, not three conditions to satisfy at once.
  it.each([
    ['fullAccess', { fullAccess: true, trustedSession: false, bossAutoApproval: false }],
    ['trustedSession', { fullAccess: false, trustedSession: true, bossAutoApproval: false }],
    ['bossAutoApproval', { fullAccess: false, trustedSession: false, bossAutoApproval: true }]
  ])('allows a same-workspace wake on %s alone', (ground, elevation) => {
    expect(gate({ requestedDelivery: 'wake', elevation })).toEqual({
      verdict: 'allow',
      reason: 'elevated',
      ledgerRequired: true,
      // Only the signal that actually held: the ledger row is read to find out
      // what happened, so recording all three would make it wrong.
      elevationGrounds: [ground]
    })
  })

  // These two are refusals rather than prompts: there is no posture under which
  // the answer becomes yes, so offering the user a button would be misleading.
  it('denies a wake from a read-only seat', () => {
    expect(
      gate({ requestedDelivery: 'wake', readOnly: true, servicePolicy: 'allow' })
    ).toMatchObject({ verdict: 'deny', reason: 'read-only-wake' })
  })

  it('denies a wake from a phone-issued run', () => {
    expect(gate({ requestedDelivery: 'wake', remoteOrigin: true })).toMatchObject({
      verdict: 'deny',
      reason: 'remote-wake'
    })
  })

  it.each([
    ['a read-only seat', { readOnly: true }],
    ['a phone-issued run', { remoteOrigin: true }]
  ])('denies a wake from %s even with full elevation', (_label, overrides) => {
    expect(
      gate({ requestedDelivery: 'wake', elevation: { ...FULL_ELEVATION }, ...overrides })
    ).toMatchObject({ verdict: 'deny' })
  })

  // A remote or read-only sender may still QUEUE — only the run-now request is
  // refused, so the feature degrades rather than disappearing.
  it('still lets a phone-issued run queue a message', () => {
    expect(gate({ remoteOrigin: true })).toMatchObject({ verdict: 'allow' })
  })
})

describe('evaluateThreadMessageGate — crossing a workspace boundary', () => {
  it('prompts for a cross-workspace send that the service would otherwise allow', () => {
    expect(gate({ crossWorkspace: true })).toMatchObject({
      verdict: 'prompt',
      reason: 'cross-workspace',
      ledgerRequired: false
    })
  })

  // The elevation stack is not a passport. The workspace boundary is the user's
  // own line and no grant combination redraws it.
  it('prompts for a cross-workspace send even with the full elevation stack', () => {
    expect(gate({ crossWorkspace: true, elevation: { ...FULL_ELEVATION } })).toMatchObject({
      verdict: 'prompt',
      reason: 'cross-workspace'
    })
  })

  it('prompts for a cross-workspace wake with full elevation', () => {
    expect(
      gate({ crossWorkspace: true, requestedDelivery: 'wake', elevation: { ...FULL_ELEVATION } })
    ).toMatchObject({ verdict: 'prompt' })
  })
})

describe('evaluateThreadMessageGate — elevation needs at least one signal', () => {
  it('prompts for a wake with no signal at all', () => {
    expect(gate({ requestedDelivery: 'wake' })).toMatchObject({
      verdict: 'prompt',
      reason: 'wake-requested'
    })
  })

  it.each([
    ['two of three', { fullAccess: true, trustedSession: true, bossAutoApproval: false }],
    ['a different two', { fullAccess: false, trustedSession: true, bossAutoApproval: true }]
  ])('records exactly the signals that held with %s', (_label, elevation) => {
    const decision = gate({ requestedDelivery: 'wake', elevation })
    expect(decision.verdict).toBe('allow')
    expect(decision.elevationGrounds).toEqual(
      (['fullAccess', 'trustedSession', 'bossAutoApproval'] as const).filter(
        (ground) => elevation[ground]
      )
    )
  })

  // Guards against a truthy-but-not-boolean value crossing a boundary and counting
  // as consent — now more load-bearing, since one signal is enough.
  it('counts only exactly-true as a signal', () => {
    expect(
      gate({
        requestedDelivery: 'wake',
        // @ts-expect-error exercising an untrusted boundary value
        elevation: { fullAccess: 1, trustedSession: 'yes', bossAutoApproval: 0 }
      })
    ).toMatchObject({ verdict: 'prompt', reason: 'wake-requested' })
  })
})

describe('evaluateThreadMessageGate — user-composed sends', () => {
  it('allows a user send with no ledger row, because the human decision is the record', () => {
    expect(gate({ origin: 'user' })).toEqual({
      verdict: 'allow',
      reason: 'user-origin',
      ledgerRequired: false
    })
  })

  it.each([
    ['cross-workspace', { crossWorkspace: true }],
    ['a wake request', { requestedDelivery: 'wake' as const }],
    ['an ask-policy service', { servicePolicy: 'ask' as const }]
  ])('allows a user send with %s', (_label, overrides) => {
    expect(gate({ origin: 'user', ...overrides })).toMatchObject({ verdict: 'allow' })
  })

  it('still refuses a user wake from a read-only seat', () => {
    expect(gate({ origin: 'user', requestedDelivery: 'wake', readOnly: true })).toMatchObject({
      verdict: 'deny',
      reason: 'read-only-wake'
    })
  })
})

describe('evaluateThreadMessageGate — read-only seats', () => {
  // Under the shipped presets read_only/plan already set threadMessage:'deny'.
  // This is the defence for a custom preset that leaves it at 'ask'/'allow'.
  it('never auto-allows a read-only seat even when the policy would', () => {
    expect(gate({ readOnly: true, servicePolicy: 'allow' })).toMatchObject({
      verdict: 'prompt',
      reason: 'read-only-seat'
    })
  })

  it('does not let elevation lift a read-only seat', () => {
    expect(gate({ readOnly: true, elevation: { ...FULL_ELEVATION } })).toMatchObject({
      verdict: 'prompt'
    })
  })
})

describe('evaluateThreadMessageGate — audit completeness', () => {
  // The invariant the user asked for: automation may skip the prompt, never the
  // ledger. Any allow a human did not see must be recorded.
  it('flags every non-human allow for the ledger', () => {
    const autoAllows = [
      gate(),
      gate({ requestedDelivery: 'wake', elevation: { ...FULL_ELEVATION } }),
      gate({ elevation: { ...FULL_ELEVATION } })
    ]
    for (const decision of autoAllows) {
      expect(decision.verdict).toBe('allow')
      expect(decision.ledgerRequired).toBe(true)
    }
  })

  it('never flags a prompt or a deny for the ledger', () => {
    const notAllowed = [
      gate({ servicePolicy: 'ask' }),
      gate({ crossWorkspace: true }),
      gate({ requestedDelivery: 'wake' }),
      gate({ servicePolicy: 'deny' }),
      gate({ requestedDelivery: 'wake', readOnly: true })
    ]
    for (const decision of notAllowed) {
      expect(decision.verdict).not.toBe('allow')
      expect(decision.ledgerRequired).toBe(false)
    }
  })
})

describe('threadMessageApprovalLedgerMetadata', () => {
  const context = {
    fromChatId: 'chat-a',
    toChatId: 'chat-b',
    requestedDelivery: 'queue' as const,
    crossWorkspace: false,
    servicePolicy: 'allow' as const
  }

  it('records the grant-based allow', () => {
    expect(threadMessageApprovalLedgerMetadata(gate(), context)).toMatchObject({
      actionClass: 'threadMessage',
      decisionReason: 'service-granted',
      fromChatId: 'chat-a',
      toChatId: 'chat-b'
    })
  })

  it('records which grounds carried an elevated allow', () => {
    const decision = gate({ requestedDelivery: 'wake', elevation: { ...FULL_ELEVATION } })
    expect(
      threadMessageApprovalLedgerMetadata(decision, { ...context, requestedDelivery: 'wake' })
    ).toMatchObject({
      decisionReason: 'elevated',
      elevationGrounds: ['fullAccess', 'trustedSession', 'bossAutoApproval'],
      requestedDelivery: 'wake'
    })
  })

  // The human path writes its own row; this must not add a second one.
  it.each([
    ['a prompt', { servicePolicy: 'ask' as const }],
    ['a deny', { servicePolicy: 'deny' as const }],
    ['a user send', { origin: 'user' as const }]
  ])('returns null for %s', (_label, overrides) => {
    expect(threadMessageApprovalLedgerMetadata(gate(overrides), context)).toBeNull()
  })
})

describe('threadMessageDenialMessage', () => {
  it.each(['service-denied', 'read-only-wake', 'remote-wake'] as const)(
    'explains %s in terms of what to do instead',
    (reason) => {
      expect(threadMessageDenialMessage(reason).length).toBeGreaterThan(20)
    }
  )

  it('falls back to a neutral refusal for a declined prompt', () => {
    expect(threadMessageDenialMessage('cross-workspace')).toBe(
      'The thread message was not approved.'
    )
  })
})
