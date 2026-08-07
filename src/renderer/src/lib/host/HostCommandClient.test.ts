import { describe, expect, it, vi } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  type HostCommand,
  type HostCommandReceipt,
  type HostSnapshot
} from '../../../../shared/hostProtocol'
import {
  findPendingApprovalId,
  HostCommandClient,
  HOST_COMMAND_BRIDGE_UNAVAILABLE,
  type HostCommandBridge
} from './HostCommandClient'

function receipt(overrides: Partial<HostCommandReceipt> = {}): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'key-1',
    name: 'composer.send',
    actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
    authority: { decision: 'ask' },
    status: 'pending',
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides
  }
}

function snapshotWithApproval(commandId: string): HostSnapshot {
  return {
    approvals: [
      {
        approvalId: 'apr-1',
        commandId,
        status: 'pending',
        actionKind: 'composer.send',
        createdAt: 1,
        summary: 'send'
      }
    ]
  } as HostSnapshot
}

function bridgeOf(handlers: {
  submit?: (command: HostCommand) => Promise<HostCommandReceipt>
  lookup?: (commandId: string) => Promise<HostCommandReceipt>
}): HostCommandBridge {
  return {
    hostProjectionCommandSubmit: async (command) => {
      const next = (await handlers.submit?.(command)) ?? receipt()
      return { ok: true, receipt: next }
    },
    hostProjectionReceiptLookup: async ({ commandId }) => {
      const next =
        (await handlers.lookup?.(commandId)) ??
        receipt({ status: 'succeeded', authority: { decision: 'allow' } })
      return { ok: true, receipt: next }
    }
  }
}

const actor = { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' as const }

describe('findPendingApprovalId · Wave 4.2c join', () => {
  it('binds approval by exact commandId — never by actionKind alone', () => {
    const snap = snapshotWithApproval('cmd-1')
    expect(findPendingApprovalId(snap, 'cmd-1')).toBe('apr-1')
    expect(findPendingApprovalId(snap, 'cmd-other')).toBeUndefined()
    expect(findPendingApprovalId(null, 'cmd-1')).toBeUndefined()
  })
})

describe('HostCommandClient · Wave 4.3b receipt honesty', () => {
  it('requires options + actor', () => {
    expect(() => new HostCommandClient(undefined as never)).toThrow(/options/)
    expect(() => new HostCommandClient({} as never)).toThrow(/actor/)
  })

  it('returns bridge-unavailable when the conduit is absent', async () => {
    const client = new HostCommandClient({ actor, bridge: null })
    const outcome = await client.submitAndResolve({
      name: 'composer.send',
      target: { threadId: 't1' },
      arguments: { text: 'hi' }
    })
    expect(outcome).toEqual({ kind: 'error', error: HOST_COMMAND_BRIDGE_UNAVAILABLE })
  })

  it('never treats a pending initial receipt as success — polls until terminal', async () => {
    let lookups = 0
    const client = new HostCommandClient({
      actor,
      timeoutMs: 1_000,
      sleep: async () => undefined,
      bridge: bridgeOf({
        submit: async () => receipt({ status: 'pending', authority: { decision: 'ask' } }),
        lookup: async () => {
          lookups += 1
          if (lookups < 2) return receipt({ status: 'pending' })
          return receipt({ status: 'succeeded', authority: { decision: 'allow' } })
        }
      })
    })

    const pendingSeen: string[] = []
    const outcome = await client.submitAndResolve(
      { name: 'composer.send', target: { threadId: 't1' }, arguments: { text: 'hi' } },
      {
        onPending: (r) => {
          pendingSeen.push(r.status)
          expect(r.status).not.toBe('succeeded')
        }
      }
    )

    expect(pendingSeen).toEqual(['pending'])
    expect(outcome.kind).toBe('terminal')
    if (outcome.kind === 'terminal') {
      expect(outcome.receipt.status).toBe('succeeded')
      expect(outcome.description.tone).toBe('good')
    }
    expect(lookups).toBeGreaterThanOrEqual(2)
  })

  it('refreshes snapshot once on pending and binds approvalId by commandId', async () => {
    const refreshSnapshot = vi.fn(async () => snapshotWithApproval('cmd-fixed'))
    let pendingApproval: string | undefined
    const client = new HostCommandClient({
      actor,
      refreshSnapshot,
      timeoutMs: 50,
      sleep: async () => undefined,
      bridge: bridgeOf({
        submit: async () =>
          receipt({
            commandId: 'cmd-fixed',
            status: 'pending',
            authority: { decision: 'ask' }
          }),
        lookup: async () =>
          receipt({
            commandId: 'cmd-fixed',
            status: 'succeeded',
            authority: { decision: 'allow' }
          })
      })
    })

    await client.submitAndResolve(
      {
        name: 'composer.send',
        target: { threadId: 't1' },
        commandId: 'cmd-fixed',
        idempotencyKey: 'key-fixed',
        arguments: { text: 'hi' }
      },
      {
        onPending: (_r, approvalId) => {
          pendingApproval = approvalId
        }
      }
    )

    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
    expect(pendingApproval).toBe('apr-1')
  })

  it('returns pending-timeout without rewriting status to succeeded', async () => {
    const client = new HostCommandClient({
      actor,
      timeoutMs: 20,
      sleep: async () => undefined,
      bridge: bridgeOf({
        submit: async () => receipt({ status: 'pending' }),
        lookup: async () => receipt({ status: 'pending' })
      })
    })

    const outcome = await client.submitAndResolve({
      name: 'composer.send',
      target: { threadId: 't1' },
      arguments: { text: 'hi' }
    })
    expect(outcome.kind).toBe('pending-timeout')
    if (outcome.kind === 'pending-timeout') {
      expect(outcome.receipt.status).toBe('pending')
      expect(outcome.description.tone).toBe('warning')
      expect(outcome.description.text).not.toMatch(/accepted|succeeded/i)
    }
  })

  it('submits approval.decide through the same command path', async () => {
    const submitted: HostCommand[] = []
    const client = new HostCommandClient({
      actor,
      bridge: bridgeOf({
        submit: async (command) => {
          submitted.push(command)
          return receipt({
            name: 'approval.decide',
            status: 'succeeded',
            authority: { decision: 'allow' }
          })
        }
      })
    })

    const outcome = await client.decideApproval({
      approvalId: 'apr-1',
      decision: 'accept'
    })
    expect(outcome.kind).toBe('terminal')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.name).toBe('approval.decide')
    expect(submitted[0]?.target.approvalId).toBe('apr-1')
    expect(submitted[0]?.arguments.decision).toBe('accept')
  })

  it('rejects a second concurrent mutation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const client = new HostCommandClient({
      actor,
      bridge: bridgeOf({
        submit: async () => {
          await gate
          return receipt({ status: 'succeeded', authority: { decision: 'allow' } })
        }
      })
    })

    const first = client.submitAndResolve({
      name: 'composer.send',
      target: { threadId: 't1' },
      arguments: { text: 'a' }
    })
    // Allow the first call to mark inFlight before the second starts.
    await Promise.resolve()
    const second = await client.submitAndResolve({
      name: 'composer.send',
      target: { threadId: 't1' },
      arguments: { text: 'b' }
    })
    expect(second).toEqual({ kind: 'error', error: 'A Host command is already in flight.' })
    release()
    const done = await first
    expect(done.kind).toBe('terminal')
  })
})
