import { describe, expect, it, vi } from 'vitest'
import {
  createThreadMessageAccessResolver,
  type ThreadMessageAccessResolverDeps
} from './ThreadMessageAccessResolver'

const NO_ELEVATION = {
  fullAccess: false,
  trustedSession: false,
  bossAutoApproval: false
} as const

const FULL_ELEVATION = {
  fullAccess: true,
  trustedSession: true,
  bossAutoApproval: true
} as const

function harness(overrides: Partial<ThreadMessageAccessResolverDeps> = {}) {
  const ledgerRows: Record<string, unknown>[] = []
  const requestApproval = vi.fn(async () => true)
  const deps: ThreadMessageAccessResolverDeps = {
    resolveServicePolicy: () => 'allow',
    isReadOnlyRun: () => false,
    isRemoteOriginRun: () => false,
    resolveElevation: () => ({ ...NO_ELEVATION }),
    requestApproval,
    recordAutoAllowLedgerRow: (_request, metadata) => ledgerRows.push(metadata),
    ...overrides
  }
  return { resolve: createThreadMessageAccessResolver(deps), ledgerRows, requestApproval }
}

const REQUEST = {
  context: { appChatId: 'chat-a', appRunId: 'run-1', workspacePath: '/repo' },
  parentProvider: 'claude',
  crossWorkspace: false,
  requestedDelivery: 'queue' as const,
  fromChatId: 'chat-a',
  toChatId: 'chat-b'
}

describe('createThreadMessageAccessResolver — audit trail', () => {
  // The requirement, restated: automation may skip the prompt, never the ledger.
  it('records a ledger row for a grant-based auto-allow', async () => {
    const { resolve, ledgerRows, requestApproval } = harness()
    const decision = await resolve(REQUEST)
    expect(decision.verdict).toBe('allow')
    expect(requestApproval).not.toHaveBeenCalled()
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      actionClass: 'threadMessage',
      decisionReason: 'service-granted',
      fromChatId: 'chat-a',
      toChatId: 'chat-b'
    })
  })

  it('records the grounds behind an elevated wake', async () => {
    const { resolve, ledgerRows } = harness({
      resolveElevation: () => ({ ...FULL_ELEVATION })
    })
    const decision = await resolve({ ...REQUEST, requestedDelivery: 'wake' })
    expect(decision.reason).toBe('elevated')
    expect(ledgerRows[0]).toMatchObject({
      decisionReason: 'elevated',
      elevationGrounds: ['fullAccess', 'trustedSession', 'bossAutoApproval'],
      requestedDelivery: 'wake'
    })
  })

  // One signal is enough, and the row must name that one rather than the full set.
  it('records the single signal that carried an elevated wake', async () => {
    const { resolve, ledgerRows, requestApproval } = harness({
      resolveElevation: () => ({
        fullAccess: false,
        trustedSession: true,
        bossAutoApproval: false
      })
    })
    const decision = await resolve({ ...REQUEST, requestedDelivery: 'wake' })
    expect(decision.reason).toBe('elevated')
    expect(requestApproval).not.toHaveBeenCalled()
    expect(ledgerRows[0]).toMatchObject({ elevationGrounds: ['trustedSession'] })
    expect(String(ledgerRows[0].rationale)).toContain('trustedSession')
  })

  // The human approval flow writes its own row; a second one here would
  // double-record the same decision.
  it('does not add a row for a human-approved send', async () => {
    const { resolve, ledgerRows, requestApproval } = harness({
      resolveServicePolicy: () => 'ask'
    })
    const decision = await resolve(REQUEST)
    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(decision).toEqual({ verdict: 'allow', reason: 'service-ask', ledgerRequired: false })
    expect(ledgerRows).toHaveLength(0)
  })

  it.each([
    ['a declined prompt', { resolveServicePolicy: () => 'ask' as const }, false],
    ['a policy deny', { resolveServicePolicy: () => 'deny' as const }, true]
  ])('adds no row for %s', async (_label, overrides, denyByPolicy) => {
    const { resolve, ledgerRows } = harness({
      ...overrides,
      requestApproval: vi.fn(async () => false)
    })
    const decision = await resolve(REQUEST)
    expect(decision.verdict).toBe('deny')
    if (denyByPolicy) expect(decision.reason).toBe('service-denied')
    expect(ledgerRows).toHaveLength(0)
  })
})

describe('createThreadMessageAccessResolver — decisions', () => {
  it('never prompts for a hard deny', async () => {
    const { resolve, requestApproval } = harness({ resolveServicePolicy: () => 'deny' })
    expect((await resolve(REQUEST)).verdict).toBe('deny')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it.each([
    ['a read-only seat', { isReadOnlyRun: () => true }],
    ['a phone-issued run', { isRemoteOriginRun: () => true }]
  ])('refuses a wake from %s without prompting', async (_label, overrides) => {
    const { resolve, requestApproval } = harness(overrides)
    const decision = await resolve({ ...REQUEST, requestedDelivery: 'wake' })
    expect(decision.verdict).toBe('deny')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('prompts for a cross-workspace send and honours the answer', async () => {
    const approved = harness()
    expect((await approved.resolve({ ...REQUEST, crossWorkspace: true })).verdict).toBe('allow')
    expect(approved.requestApproval).toHaveBeenCalledTimes(1)

    const declined = harness({ requestApproval: vi.fn(async () => false) })
    expect((await declined.resolve({ ...REQUEST, crossWorkspace: true })).verdict).toBe('deny')
  })

  // The resolver hardcodes origin:'agent'. A tool call is never a user-composed
  // message, so it must not be able to take the ungated user path.
  it('always evaluates as an agent send, so the ask policy still prompts', async () => {
    const { resolve, requestApproval } = harness({ resolveServicePolicy: () => 'ask' })
    await resolve(REQUEST)
    expect(requestApproval).toHaveBeenCalledTimes(1)
  })

  it('passes the resolved policy to the approval prompt', async () => {
    const { resolve, requestApproval } = harness({ resolveServicePolicy: () => 'workspace' })
    await resolve(REQUEST)
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining(REQUEST), 'workspace')
  })
})
