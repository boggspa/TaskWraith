import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type {
  HostProviderRunPort,
  HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import type { HostNodeProviderCreateInput } from './HostNodeProvider'
import { createHostNodeGrokProvider } from './HostNodeGrokProvider'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  kill = vi.fn(() => {
    this.killed = true
    return true
  })
}

function thread(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    workspace: {
      workspaceId: 'workspace-1',
      canonicalPath: '/tmp/host-node-provider-test',
      canonical: true
    },
    providerId: 'grok',
    modelId: 'grok-4.6',
    reasoningId: 'high',
    posture: {
      postureId: 'default',
      approvalMode: 'workspace_write',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    },
    ...overrides
  }
}

function open(
  input: {
    readonly missingBinary?: boolean
    readonly authState?: 'authenticated' | 'unauthenticated' | 'unknown'
    readonly isConfigured?: () => boolean | Promise<boolean>
    readonly terminalLauncher?: {
      launchForProvider: (
        providerId: string,
        input: { readonly argv: readonly string[] }
      ) => Promise<void | {
        readonly spawned: true
        readonly providerId: string
      }>
    }
    readonly configuredThread?: HostProviderRunThread
    readonly interactions?: HostNodeInteractionResolver
  } = {}
) {
  const appends: unknown[] = []
  const finishes: unknown[] = []
  const events: unknown[] = []
  const cancels = new Map<string, () => void>()
  const child = new FakeChild()
  const port: HostProviderRunPort = {
    getThread: () => input.configuredThread ?? thread(),
    appendTranscript: (value) => appends.push(value),
    beginRun: () => ({ kind: 'started' }),
    updateRun: () => undefined,
    finishRun: (value) => finishes.push(value),
    registerCancel: (runId, cancel) => {
      cancels.set(runId, cancel)
      return { kind: 'registered' }
    },
    clearCancel: (runId) => cancels.delete(runId),
    publishRunEvent: (_target, event) => events.push(event)
  }
  const factory = createHostNodeGrokProvider({
    resources: {
      resolveBinary: async () =>
        input.missingBinary
          ? { binaryPath: null, source: 'missing' }
          : { binaryPath: '/usr/local/bin/grok', source: 'path' },
      getAuthState: async () =>
        input.authState ?? (input.missingBinary ? 'unauthenticated' : 'authenticated'),
      getVersion: async () => 'test'
    },
    ...(input.isConfigured ? { isConfigured: input.isConfigured } : {}),
    ...(input.terminalLauncher ? { terminalLauncher: input.terminalLauncher } : {}),
    spawn: () => child as never
  })
  const instance = factory.create({
    runPort: port,
    interactions:
      input.interactions ??
      ({
        register: () => new Promise<never>(() => {})
      } satisfies HostNodeInteractionResolver)
  } satisfies HostNodeProviderCreateInput)
  return { factory, instance, child, appends, finishes, events, cancels }
}

function frames(child: FakeChild): string[] {
  const received: string[] = []
  child.stdin.on('data', (chunk) => received.push(String(chunk)))
  return received
}

describe('HostNodeGrokProvider', () => {
  it('keeps a missing binary visible as unavailable and terminalizes setup failure', async () => {
    const { instance, finishes } = open({ missingBinary: true })
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'grok',
      status: 'unavailable'
    })

    await expect(
      instance.run({
        runId: 'run-1',
        threadId: 'thread-1',
        prompt: 'hello',
        target: { id: 'client' }
      })
    ).resolves.toMatchObject({ status: 'failed' })
    expect(finishes).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'provider_setup_unavailable' })
    ])
  })

  it('runs a real ACP handshake, streams bounded output, and records an exact terminal receipt', async () => {
    const { factory, instance, child, appends, finishes, events } = open()
    const sent = frames(child)
    expect(factory).toMatchObject({ supportsApprovals: true, supportsQuestions: false })
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/new"'))
    child.stdout.write(JSON.stringify({ id: 2, result: { sessionId: 'session-1' } }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/prompt"'))
    child.stdout.write(
      JSON.stringify({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { text: 'ready' }
          }
        }
      }) + '\n'
    )
    child.emit('close', 0)

    await expect(running).resolves.toMatchObject({
      runId: 'run-1',
      status: 'completed',
      sessionId: 'session-1'
    })
    expect(appends).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'ready' })])
    )
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.content' })])
    )
    expect(finishes).toEqual([expect.objectContaining({ status: 'completed' })])
  })

  it('cancels only the exact active run', async () => {
    const { instance, child } = open()
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })
    await vi.waitFor(() => expect(instance.cancel('run-1')).toBe(true))
    expect(instance.cancel('other-run')).toBe(false)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('rejects a thread whose catalog model is not selectable', async () => {
    const { instance } = open({ configuredThread: thread({ modelId: 'not-offered' }) })
    await expect(
      instance.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hello', target: {} })
    ).rejects.toThrow(/configuration is not selectable/)
  })
  it('registers an ACP permission and resumes its exact request once after approval', async () => {
    let settle!: (value: {
      id: string
      kind: 'approval'
      decision: 'accept'
      actor: { clientId: string; clientClass: string; actorId: string }
    }) => void
    const settlement = new Promise<{
      id: string
      kind: 'approval'
      decision: 'accept'
      actor: { clientId: string; clientClass: string; actorId: string }
    }>((resolve) => {
      settle = resolve
    })
    const interactions = {
      register: vi.fn(() => settlement)
    } satisfies HostNodeInteractionResolver
    const { instance, child } = open({ interactions })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })

    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'session-1',
          toolCall: { id: 'tool-1', title: 'Write file', kind: 'edit' },
          options: [
            { optionId: 'allow-once', kind: 'allow_once' },
            { optionId: 'reject-once', kind: 'reject_once' }
          ]
        }
      }) + '\n'
    )
    await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
    expect(interactions.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval',
        providerId: 'grok',
        runId: 'run-1',
        threadId: 'thread-1',
        toolId: 'tool-1',
        options: ['allow-once', 'reject-once']
      })
    )

    settle({
      id: 'grok:run-1:approval:1',
      kind: 'approval',
      decision: 'accept',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"permission-1"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"outcome":"selected"')
    expect(sent.join('')).toContain('"optionId":"allow-once"')
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'completed' })
  })
  it('resolves unknown resource auth into configured or auth-required status', async () => {
    const unconfigured = open({ authState: 'unknown', isConfigured: () => false })
    await expect(unconfigured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'grok',
      status: 'auth_required'
    })
    await expect(unconfigured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })
    expect(await unconfigured.instance.getAuthFlows()).toEqual([])
    await expect(unconfigured.instance.beginAuth('auth-1')).rejects.toThrow(
      /interactive terminal login is unavailable/
    )

    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const login = open({
      authState: 'unknown',
      isConfigured: () => false,
      terminalLauncher: launcher
    })
    expect(await login.instance.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'grok:login' })
    ])
    await expect(login.instance.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledWith(
      'grok',
      expect.objectContaining({ argv: ['/usr/local/bin/grok', 'login'] })
    )
    await expect(login.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const configured = open({ authState: 'unknown', isConfigured: () => true })
    await expect(configured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'grok',
      status: 'ready'
    })
    await expect(configured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'authenticated'
    })
  })
})
