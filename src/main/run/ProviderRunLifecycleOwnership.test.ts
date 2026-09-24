import { describe, expect, it, vi } from 'vitest'
import { RunManager } from '../RunManager'
import { availableProviderIds } from '../settings/MainSanitizers'
import type { AgentRunPayload } from './AgentRunTypes'
import {
  acquireProviderRunLifecycleOwnership,
  createProviderRunLifecycleOwnershipDependencies,
  runWithProviderRunLifecycleOwnership,
  settleProviderRunWithoutTransport,
  SIGNED_POSTURE_RETENTION_PROVIDER_IDS,
  type ProviderRunLifecycleRegistrationInput
} from './ProviderRunLifecycleOwnership'

const PROVIDERS = availableProviderIds()

function payload(provider: AgentRunPayload['provider']): AgentRunPayload {
  return {
    provider,
    prompt: `Run ${provider}`,
    scope: 'workspace',
    workspace: '/workspace',
    appRunId: `run-${provider}`,
    appChatId: `chat-${provider}`,
    model: `${provider}-model`,
    approvalMode: 'plan',
    workflowMode: 'plan',
    sessionTrust: false,
    effectivePermissionsSignature: `signed-${provider}`
  }
}

function harness(provider: AgentRunPayload['provider']) {
  const manager = new RunManager<unknown>()
  const registerStartingSession = vi.fn((input: ProviderRunLifecycleRegistrationInput) =>
    manager.create({
      runId: input.route.appRunId!,
      provider: input.provider,
      appChatId: input.route.appChatId,
      workspacePath: input.workspacePath,
      providerSessionId: input.providerSessionId || undefined,
      sender: input.sender,
      abortController: input.setupAbortController,
      state: input.state,
      status: 'starting'
    })
  )
  const settleUnclaimedSession = vi.fn((runId: string, status: 'failed' | 'cancelled') => {
    manager.finish(runId, status)
  })
  const input = payload(provider)
  const ownership = acquireProviderRunLifecycleOwnership(
    { id: `sender-${provider}` },
    input,
    { appRunId: input.appRunId, appChatId: input.appChatId },
    {
      registerStartingSession,
      getSession: (runId) => manager.get(runId),
      settleUnclaimedSession,
      now: () => 42
    }
  )
  return { input, manager, ownership, registerStartingSession, settleUnclaimedSession }
}

describe('provider run lifecycle ownership', () => {
  it('covers the exact twelve stable provider identities', () => {
    expect(PROVIDERS).toHaveLength(12)
    expect(new Set(PROVIDERS).size).toBe(12)
    expect(SIGNED_POSTURE_RETENTION_PROVIDER_IDS).toEqual(PROVIDERS)
  })

  it.each(PROVIDERS)('registers %s as starting before provider setup', (provider) => {
    const { input, manager, ownership, registerStartingSession } = harness(provider)
    const session = manager.get(input.appRunId)

    expect(registerStartingSession).toHaveBeenCalledOnce()
    expect(session).toMatchObject({
      runId: input.appRunId,
      provider,
      appChatId: input.appChatId,
      workspacePath: input.workspace,
      status: 'starting'
    })
    expect(session?.state).toBe(ownership.state)
    expect(ownership.state).toMatchObject({
      lifecycleOwner: 'run-coordinator',
      provider,
      startedAt: 42,
      prompt: input.prompt,
      effectivePermissionsSignature: `signed-${provider}`
    })
  })

  it.each(PROVIDERS)('lets exact cancellation find %s during setup', (provider) => {
    const { input, manager, ownership, settleUnclaimedSession } = harness(provider)

    expect(manager.cancel(input.appRunId!)).toBe(true)

    expect(manager.get(input.appRunId)?.status).toBe('cancelled')
    expect(ownership.setupAbortSignal.aborted).toBe(true)
    expect(ownership.settleIfUnclaimed()).toBe(false)
    expect(settleUnclaimedSession).not.toHaveBeenCalled()
  })

  it.each(PROVIDERS)('does not settle %s after its adapter takes ownership', (provider) => {
    const { input, manager, ownership, settleUnclaimedSession } = harness(provider)
    const providerState = { provider, exactTransport: true }
    manager.update(input.appRunId!, { state: providerState, status: 'running' })

    expect(ownership.settleIfUnclaimed()).toBe(false)
    expect(manager.get(input.appRunId)?.state).toBe(providerState)
    expect(manager.get(input.appRunId)?.status).toBe('running')
    expect(settleUnclaimedSession).not.toHaveBeenCalled()
  })

  it.each(PROVIDERS)('fails an unclaimed %s placeholder when setup returns', (provider) => {
    const { input, manager, ownership, settleUnclaimedSession } = harness(provider)

    expect(ownership.settleIfUnclaimed()).toBe(true)
    expect(settleUnclaimedSession).toHaveBeenCalledWith(input.appRunId, 'failed')
    expect(manager.get(input.appRunId)?.status).toBe('failed')
  })

  it('refuses provider setup when starting-session registration is denied', () => {
    const input = payload('cursor')
    const adapterSetup = vi.fn()

    expect(() => {
      acquireProviderRunLifecycleOwnership(
        {},
        input,
        { appRunId: input.appRunId, appChatId: input.appChatId },
        {
          registerStartingSession: () => undefined,
          getSession: () => undefined,
          settleUnclaimedSession: vi.fn()
        }
      )
      adapterSetup()
    }).toThrow('lifecycle ownership could not be acquired')
    expect(adapterSetup).not.toHaveBeenCalled()
  })

  it.each(PROVIDERS)(
    'wraps the entire %s adapter invocation in starting ownership',
    async (provider) => {
      const manager = new RunManager<unknown>()
      const input = payload(provider)
      const adapter = vi.fn(async () => {
        expect(manager.get(input.appRunId)).toMatchObject({
          provider,
          status: 'starting'
        })
        manager.update(input.appRunId!, {
          state: { provider, exactTransport: true },
          status: 'running'
        })
      })

      await runWithProviderRunLifecycleOwnership(
        {
          sender: {},
          payload: input,
          route: { appRunId: input.appRunId, appChatId: input.appChatId },
          runProvider: adapter
        },
        {
          registerStartingSession: (registration) =>
            manager.create({
              runId: registration.route.appRunId!,
              provider: registration.provider,
              appChatId: registration.route.appChatId,
              workspacePath: registration.workspacePath,
              abortController: registration.setupAbortController,
              state: registration.state,
              status: 'starting'
            }),
          getSession: (runId) => manager.get(runId),
          settleUnclaimedSession: (runId, status) => {
            manager.finish(runId, status)
          }
        }
      )

      expect(adapter).toHaveBeenCalledOnce()
      expect(manager.get(input.appRunId)?.status).toBe('running')
    }
  )

  it('settles a claimed graph cancellation when no provider transport was admitted', async () => {
    const manager = new RunManager<unknown>()
    const input = payload('pi')
    const deps = createProviderRunLifecycleOwnershipDependencies({
      registerStartingSession: (registration) => {
        const session = manager.create({
          runId: registration.route.appRunId!,
          provider: registration.provider,
          appChatId: registration.route.appChatId,
          workspacePath: registration.workspacePath,
          abortController: registration.setupAbortController,
          state: registration.state,
          status: 'starting'
        })
        manager.requireTerminalConfirmation(session.runId)
        return session
      },
      runManager: manager
    })

    await runWithProviderRunLifecycleOwnership(
      {
        sender: {},
        payload: input,
        route: { appRunId: input.appRunId, appChatId: input.appChatId },
        runProvider: async () => {
          manager.claimTerminalStatus(input.appRunId!, 'cancelled', {
            requireConfirmation: true
          })
        }
      },
      deps
    )

    expect(manager.get(input.appRunId)?.status).toBe('cancelled')
    expect(manager.getTerminalJoinState(input.appRunId)).toEqual({
      required: false,
      conflict: false
    })
  })

  it('settles a claimed graph run after provider-specific setup adopted it without transport', () => {
    const manager = new RunManager<unknown>()
    manager.create({
      runId: 'grok-adopted-before-spawn',
      provider: 'grok',
      state: { provider: 'grok', setupOnly: true },
      status: 'running'
    })
    manager.requireTerminalConfirmation('grok-adopted-before-spawn')
    manager.claimTerminalStatus('grok-adopted-before-spawn', 'cancelled', {
      requireConfirmation: true
    })

    settleProviderRunWithoutTransport(manager, 'grok-adopted-before-spawn', 'failed')

    expect(manager.get('grok-adopted-before-spawn')?.status).toBe('cancelled')
    expect(manager.getTerminalJoinState('grok-adopted-before-spawn')).toEqual({
      required: false,
      conflict: false
    })
  })
})
