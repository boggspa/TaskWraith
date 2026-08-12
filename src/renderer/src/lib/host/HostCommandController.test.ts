import { describe, expect, it, vi } from 'vitest'

import type { HostCommandReceipt } from '../../../../shared/hostProtocol'
import { HOST_PROTOCOL_VERSION } from '../../../../shared/hostProtocol'
import type { HostCommandRunOutcome } from './HostCommandClient'
import { HostCommandController, type HostCommandControllerClient } from './HostCommandController'

function receipt(): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'command-1',
    idempotencyKey: 'key-1',
    name: 'run.cancel',
    actor: { actorId: 'desktop', clientId: 'desktop', clientClass: 'desktop' },
    authority: { decision: 'ask' },
    status: 'pending',
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-12T20:00:00.000Z',
    updatedAt: '2026-08-12T20:00:00.000Z'
  }
}

function terminal(status: 'succeeded' | 'denied' = 'succeeded'): HostCommandRunOutcome {
  return {
    kind: 'terminal',
    receipt: { ...receipt(), status },
    description: {
      text: status === 'succeeded' ? 'Host accepted run.cancel' : 'Host denied run.cancel',
      tone: status === 'succeeded' ? 'good' : 'error'
    }
  }
}

describe('HostCommandController', () => {
  it('keeps a pending command visible and answers its exact correlated approval', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submitAndResolve: HostCommandControllerClient['submitAndResolve'] = vi.fn(
      async (_input, hooks) => {
        hooks?.onPending?.(receipt(), 'approval-1')
        await gate
        return terminal()
      }
    )
    const decideApproval = vi.fn(async () => terminal())
    const controller = new HostCommandController({
      client: { submitAndResolve, decideApproval } as HostCommandControllerClient
    })

    const running = controller.submit({ name: 'run.cancel', target: { threadId: 'thread-1' } })
    await Promise.resolve()
    expect(controller.getState()).toMatchObject({
      busy: true,
      approvalBusy: false,
      pending: {
        commandId: 'command-1',
        name: 'run.cancel',
        approvalId: 'approval-1'
      }
    })

    await controller.decidePendingApproval('accept')
    expect(decideApproval).toHaveBeenCalledWith({ approvalId: 'approval-1', decision: 'accept' })

    release()
    await running
    expect(controller.getState()).toMatchObject({
      busy: false,
      notice: { text: 'Host accepted run.cancel', tone: 'good' }
    })
    expect(controller.getState().pending).toBeUndefined()
  })

  it('never rewrites a pending timeout into success', async () => {
    const pendingReceipt = receipt()
    const client: HostCommandControllerClient = {
      submitAndResolve: vi.fn(
        async (): Promise<HostCommandRunOutcome> => ({
          kind: 'pending-timeout',
          receipt: pendingReceipt,
          description: { text: 'Awaiting Host approval · run.cancel', tone: 'warning' }
        })
      ),
      decideApproval: vi.fn(async () => terminal())
    }
    const controller = new HostCommandController({ client })

    const outcome = await controller.submit({
      name: 'run.cancel',
      target: { threadId: 'thread-1' }
    })

    expect(outcome.kind).toBe('pending-timeout')
    expect(controller.getState().notice).toEqual({
      text: 'Awaiting Host approval · run.cancel · timed out',
      tone: 'warning'
    })
  })

  it('fails honestly when no approval card correlated by commandId is available', async () => {
    const client: HostCommandControllerClient = {
      submitAndResolve: vi.fn(async () => terminal()),
      decideApproval: vi.fn(async () => terminal())
    }
    const controller = new HostCommandController({ client })

    await expect(controller.decidePendingApproval('accept')).resolves.toEqual({
      kind: 'error',
      error: 'No correlated Host approval is available.'
    })
    expect(client.decideApproval).not.toHaveBeenCalled()
  })

  it('serializes approval responses while leaving the original mutation pending', async () => {
    let releaseMutation!: () => void
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve
    })
    let releaseApproval!: () => void
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve
    })
    const client: HostCommandControllerClient = {
      submitAndResolve: vi.fn(async (_input, hooks) => {
        hooks?.onPending?.(receipt(), 'approval-1')
        await mutationGate
        return terminal()
      }),
      decideApproval: vi.fn(async () => {
        await approvalGate
        return terminal()
      })
    }
    const controller = new HostCommandController({ client })
    const mutation = controller.submit({ name: 'run.cancel', target: { threadId: 'thread-1' } })
    await Promise.resolve()

    const first = controller.decidePendingApproval('accept')
    await Promise.resolve()
    expect(controller.getState()).toMatchObject({ busy: true, approvalBusy: true })
    await expect(controller.decidePendingApproval('decline')).resolves.toEqual({
      kind: 'error',
      error: 'A Host approval response is already in flight.'
    })

    releaseApproval()
    await first
    expect(controller.getState()).toMatchObject({ busy: true, approvalBusy: false })
    releaseMutation()
    await mutation
  })
})
