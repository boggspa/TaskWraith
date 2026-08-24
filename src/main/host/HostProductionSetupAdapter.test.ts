import { describe, expect, it, vi } from 'vitest'

import { HOST_PROTOCOL_VERSION, type HostCommand } from '../../shared/hostProtocol'
import { createHostProductionSetupAdapter } from './HostProductionSetupAdapter'

const actor = { actorId: 'tui-1', clientId: 'tui-1', clientClass: 'tui' as const }
const context = {
  actor,
  client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
}

function command(
  name: HostCommand['name'],
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'command-1',
    idempotencyKey: 'key-1',
    actor,
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-08-24T00:00:00.000Z'
  }
}

function open(status: 'ready' | 'auth_required' | 'unavailable' | 'degraded' = 'ready') {
  const configureThread = vi.fn(() => ({ appChatId: 'thread-1' }))
  const begin = vi.fn(({ provider, operationId }) => ({ provider, operationId }))
  const adapter = createHostProductionSetupAdapter({
    workspace: {
      getWorkspaces: () => [{ id: 'workspace-1', path: '/lexical', realPath: '/real' }],
      registerWorkspace: vi.fn(() => ({ id: 'workspace-1' }))
    },
    chat: {
      createSingleThread: vi.fn(() => ({ appChatId: 'thread-1' })),
      configureThread,
      archiveThread: vi.fn(() => ({ appChatId: 'thread-1' }))
    },
    terminal: {
      begin,
      cancel: vi.fn(() => ({ outcome: 'not_cancellable' as const }))
    },
    providers: () => [
      {
        providerId: 'codex' as const,
        label: 'Codex',
        status,
        models: [
          {
            modelId: 'gpt-5.6',
            label: 'GPT 5.6',
            default: true,
            reasoning: [{ reasoningId: 'high', label: 'High' }]
          }
        ]
      }
    ]
  })
  return { adapter, configureThread, begin }
}

describe('HostProductionSetupAdapter', () => {
  it('normalizes lazy async provider-adapter rows inside the adapter', async () => {
    const adapter = createHostProductionSetupAdapter({
      workspace: { getWorkspaces: () => [], registerWorkspace: () => ({ id: 'workspace-1' }) },
      chat: {
        createSingleThread: () => ({ appChatId: 'thread-1' }),
        configureThread: () => ({ appChatId: 'thread-1' }),
        archiveThread: () => ({ appChatId: 'thread-1' })
      },
      terminal: {
        begin: ({ provider, operationId }) => ({ provider, operationId }),
        cancel: () => ({ outcome: 'not_cancellable' })
      },
      providerSource: {
        listProviderIds: async () => ['codex'],
        getLabel: async () => 'Codex',
        getStatus: async () => ({
          available: true,
          setupRequired: true,
          authState: 'unauthenticated'
        }),
        getModels: async () => [
          {
            id: 'gpt-5.6',
            label: 'GPT 5.6',
            isDefault: true,
            supportedReasoningEfforts: [
              'low',
              { reasoningEffort: 'high', label: 'High' },
              { reasoningEffort: 'max', disabled: true, disabledReason: 'not offered' }
            ],
            defaultReasoningEffort: 'high'
          }
        ]
      }
    })
    await expect(adapter.providerStatuses()).resolves.toEqual([
      {
        providerId: 'codex',
        status: 'auth_required',
        label: 'Codex',
        detail: 'Provider sign-in is required.'
      }
    ])
    const offers = await adapter.providerOffers('codex')
    expect(offers).toMatchObject({
      providerId: 'codex',
      models: [
        {
          modelId: 'gpt-5.6',
          default: true,
          reasoning: [
            { reasoningId: 'low' },
            { reasoningId: 'high', label: 'High' },
            { reasoningId: 'max', available: false }
          ]
        }
      ]
    })
  })

  it('does not treat an available provider with absent auth evidence as ready', async () => {
    const adapter = createHostProductionSetupAdapter({
      workspace: { getWorkspaces: () => [], registerWorkspace: () => ({ id: 'workspace-1' }) },
      chat: {
        createSingleThread: () => ({ appChatId: 'thread-1' }),
        configureThread: () => ({ appChatId: 'thread-1' }),
        archiveThread: () => ({ appChatId: 'thread-1' })
      },
      terminal: {
        begin: ({ provider, operationId }) => ({ provider, operationId }),
        cancel: () => ({ outcome: 'not_cancellable' })
      },
      providerSource: {
        listProviderIds: () => ['codex'],
        getLabel: () => 'Codex',
        getStatus: () => ({ available: true }),
        getModels: () => []
      }
    })
    await expect(adapter.providerStatuses()).resolves.toEqual([
      {
        providerId: 'codex',
        status: 'degraded',
        label: 'Codex',
        detail: 'Provider status is degraded.'
      }
    ])
  })

  it('projects only admitted provider offers and keeps auth-required selections unavailable', async () => {
    const { adapter } = open('auth_required')
    await expect(adapter.providerStatuses()).resolves.toEqual([
      { providerId: 'codex', status: 'auth_required', label: 'Codex' }
    ])
    const offers = await adapter.providerOffers('codex')
    expect(offers.models[0]).toMatchObject({ modelId: 'gpt-5.6', available: false })
    expect(offers.postures.every((posture) => posture.ceiling !== 'full_access')).toBe(true)
    await expect(adapter.providerAuthFlows('codex')).resolves.toEqual([
      { flowId: 'codex:login', kind: 'manual', label: 'Sign in', available: true }
    ])
  })

  it('revalidates the exact revision and persists a bounded selected posture through ChatService', async () => {
    const { adapter, configureThread } = open()
    const offers = await adapter.providerOffers('codex')
    await expect(
      adapter.setupExecutor.execute(
        command(
          'thread.configure',
          { threadId: 'thread-1' },
          {
            providerId: 'codex',
            modelId: 'gpt-5.6',
            reasoningId: 'high',
            postureId: 'workspace_write',
            postureConsent: true,
            offerRevision: offers.offerRevision,
            title: 'Configured'
          }
        ),
        context
      )
    ).resolves.toMatchObject({
      status: 'succeeded',
      resultRef: { kind: 'thread', threadId: 'thread-1' }
    })
    expect(configureThread).toHaveBeenCalledWith({
      chatId: 'thread-1',
      provider: 'codex',
      selectedModelType: 'gpt-5.6',
      reasoningId: 'high',
      postureId: 'workspace_write',
      title: 'Configured'
    })
  })

  it('binds provider login to the Host command id and reports terminal cancellation honestly', async () => {
    const { adapter, begin } = open()
    await expect(
      adapter.setupExecutor.execute(
        command('provider.auth.begin', { providerId: 'codex' }, { flowId: 'codex:login' }),
        context
      )
    ).resolves.toMatchObject({
      status: 'succeeded',
      resultRef: { kind: 'provider-auth', operationId: 'command-1' }
    })
    expect(begin).toHaveBeenCalledWith({
      provider: 'codex',
      flowId: 'codex:login',
      operationId: 'command-1'
    })
    await expect(
      adapter.setupExecutor.execute(
        command('provider.auth.cancel', { providerId: 'codex', operationId: 'command-1' }, {}),
        context
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_auth_not_cancellable' })
  })
})
