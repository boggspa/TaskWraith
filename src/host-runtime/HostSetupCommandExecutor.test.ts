import { describe, expect, it, vi } from 'vitest'

import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import {
  HostSetupCommandExecutor,
  type HostSetupCommandExecutorPorts
} from './HostSetupCommandExecutor'

const actor = { actorId: 'actor-1', clientId: 'tui-1', clientClass: 'tui' as const }

const context = {
  actor,
  client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
}

function command(
  name: HostCommand['name'],
  target: Record<string, string>,
  args: Record<string, unknown>,
  overrides: Partial<HostCommand> = {}
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'command-1',
    idempotencyKey: 'idempotency-1',
    actor,
    name,
    target,
    arguments: args,
    issuedAt: '2026-08-24T03:00:00.000Z',
    ...overrides
  }
}

function ports(): HostSetupCommandExecutorPorts {
  return {
    workspace: { register: vi.fn(() => ({ workspaceId: 'workspace-1' })) },
    thread: {
      create: vi.fn(() => ({ threadId: 'thread-1' })),
      configure: vi.fn(() => ({ threadId: 'thread-1' })),
      archive: vi.fn(() => ({ threadId: 'thread-1' }))
    },
    providerAuth: {
      begin: vi.fn(({ providerId, operationId }) => ({ providerId, operationId })),
      cancel: vi.fn(({ providerId, operationId }) => ({
        providerId,
        operationId,
        outcome: 'cancelled' as const
      }))
    },
    currentOffers: {
      read: vi.fn(() => ({
        providerId: 'provider-1',
        offerRevision: 'revision-1',
        models: [
          {
            modelId: 'model-1',
            label: 'Model',
            available: true,
            reasoning: [{ reasoningId: 'reasoning-1', label: 'Reasoning', available: true }]
          }
        ],
        postures: [
          {
            postureId: 'posture-1',
            label: 'Posture',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'workspace_write' as const
          }
        ]
      }))
    },
    currentAuthFlows: {
      read: vi.fn(() => [
        { flowId: 'flow-1', kind: 'browser' as const, label: 'Browser', available: true }
      ])
    }
  }
}

describe('HostSetupCommandExecutor', () => {
  it('requires every injected port structurally', () => {
    expect(() => new HostSetupCommandExecutor({} as HostSetupCommandExecutorPorts)).toThrow(
      'complete injected ports'
    )
  })

  it('executes workspace setup and returns only the opaque workspace locator', async () => {
    const injected = ports()
    const executor = new HostSetupCommandExecutor(injected)

    await expect(
      executor.execute(
        command('workspace.register', {}, { path: '/workspace', pinned: true }),
        context
      )
    ).resolves.toEqual({
      status: 'succeeded',
      resultRef: { kind: 'workspace', workspaceId: 'workspace-1' }
    })
    expect(injected.workspace.register).toHaveBeenCalledWith({ path: '/workspace', pinned: true })
  })

  it('requires exact current revision, available selections, and consent before configuring', async () => {
    const injected = ports()
    const executor = new HostSetupCommandExecutor(injected)
    const selected = command(
      'thread.configure',
      { threadId: 'thread-1' },
      {
        providerId: 'provider-1',
        modelId: 'model-1',
        reasoningId: 'reasoning-1',
        postureId: 'posture-1',
        offerRevision: 'revision-1',
        postureConsent: true
      }
    )

    await expect(executor.execute(selected, context)).resolves.toMatchObject({
      status: 'succeeded',
      resultRef: { kind: 'thread', threadId: 'thread-1' }
    })
    expect(injected.thread.configure).toHaveBeenCalledWith({
      threadId: 'thread-1',
      providerId: 'provider-1',
      modelId: 'model-1',
      reasoningId: 'reasoning-1',
      postureId: 'posture-1',
      offerRevision: 'revision-1',
      postureConsent: true
    })

    await expect(
      executor.execute(
        command(
          'thread.configure',
          { threadId: 'thread-1' },
          {
            providerId: 'provider-1',
            modelId: 'model-1',
            postureId: 'posture-1',
            offerRevision: 'stale'
          }
        ),
        context
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_stale_offer' })
  })

  it('fails closed when a selected posture requires explicit consent', async () => {
    const injected = ports()
    vi.mocked(injected.currentOffers.read).mockReturnValue({
      providerId: 'provider-1',
      offerRevision: 'revision-1',
      models: [{ modelId: 'model-1', label: 'Model', available: true, reasoning: [] }],
      postures: [
        {
          postureId: 'posture-1',
          label: 'Full access',
          available: true,
          requiresExplicitConsent: true,
          ceiling: 'full_access'
        }
      ]
    })
    const executor = new HostSetupCommandExecutor(injected)

    await expect(
      executor.execute(
        command(
          'thread.configure',
          { threadId: 'thread-1' },
          {
            providerId: 'provider-1',
            modelId: 'model-1',
            postureId: 'posture-1',
            offerRevision: 'revision-1'
          }
        ),
        context
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_consent_required' })
    expect(injected.thread.configure).not.toHaveBeenCalled()
  })

  it('uses commandId as the deterministic auth operation identity', async () => {
    const injected = ports()
    const executor = new HostSetupCommandExecutor(injected)
    const begin = command('provider.auth.begin', { providerId: 'provider-1' }, { flowId: 'flow-1' })

    await expect(executor.execute(begin, context)).resolves.toEqual({
      status: 'succeeded',
      resultRef: { kind: 'provider-auth', providerId: 'provider-1', operationId: 'command-1' }
    })
    expect(injected.providerAuth.begin).toHaveBeenCalledWith({
      providerId: 'provider-1',
      flowId: 'flow-1',
      operationId: 'command-1'
    })
  })

  it('does not claim an auth cancellation unless the port confirms cancelled', async () => {
    const injected = ports()
    vi.mocked(injected.providerAuth.cancel).mockReturnValue({
      providerId: 'provider-1',
      operationId: 'operation-1',
      outcome: 'not_cancellable'
    })
    const executor = new HostSetupCommandExecutor(injected)

    await expect(
      executor.execute(
        command(
          'provider.auth.cancel',
          { providerId: 'provider-1', operationId: 'operation-1' },
          {}
        ),
        context
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_auth_not_cancellable' })

    vi.mocked(injected.providerAuth.cancel).mockReturnValue({
      providerId: 'provider-1',
      operationId: 'operation-1',
      outcome: 'not_found'
    })
    await expect(
      executor.execute(
        command(
          'provider.auth.cancel',
          { providerId: 'provider-1', operationId: 'operation-1' },
          {}
        ),
        context
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_auth_not_found' })
  })

  it('denies a remote actor before invoking any setup port', async () => {
    const injected = ports()
    const executor = new HostSetupCommandExecutor(injected)
    const iosContext = {
      actor: { actorId: 'ios-actor', clientId: 'ios-client', clientClass: 'ios' as const },
      client: { clientId: 'ios-client', clientClass: 'ios' as const, clientVersion: '1.0.0' }
    }
    const remote = command(
      'workspace.register',
      {},
      { path: '/workspace' },
      { actor: iosContext.actor }
    )

    await expect(executor.execute(remote, iosContext)).resolves.toEqual({
      status: 'failed',
      errorCode: 'setup_forbidden'
    })
    expect(injected.workspace.register).not.toHaveBeenCalled()
  })
})
