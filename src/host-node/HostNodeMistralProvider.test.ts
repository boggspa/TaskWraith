import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type {
  HostProviderRunPort,
  HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import type { HostNodeProviderCreateInput } from './HostNodeProvider'
import { createHostNodeMistralProvider } from './HostNodeMistralProvider'

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
    providerId: 'mistral',
    modelId: 'devstral-small',
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
    readonly environment?: NodeJS.ProcessEnv
  } = {}
) {
  const appends: unknown[] = []
  const finishes: unknown[] = []
  const events: unknown[] = []
  const cancels = new Map<string, () => void>()
  const spawnEnvs: NodeJS.ProcessEnv[] = []
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
  const factory = createHostNodeMistralProvider({
    resources: {
      resolveBinary: async () =>
        input.missingBinary
          ? { binaryPath: null, source: 'missing' }
          : { binaryPath: '/usr/local/bin/mistral', source: 'path' },
      getAuthState: async () =>
        input.authState ?? (input.missingBinary ? 'unauthenticated' : 'authenticated'),
      getVersion: async () => 'test'
    },
    ...(input.isConfigured ? { isConfigured: input.isConfigured } : {}),
    ...(input.terminalLauncher ? { terminalLauncher: input.terminalLauncher } : {}),
    environment: input.environment ?? { PATH: '/usr/bin' },
    spawn: (_command, _args, options) => {
      spawnEnvs.push(options.env)
      return child as never
    }
  })
  const instance = factory.create({
    runPort: port,
    interactions:
      input.interactions ??
      ({
        register: () => new Promise<never>(() => {})
      } satisfies HostNodeInteractionResolver)
  } satisfies HostNodeProviderCreateInput)
  return { factory, instance, child, appends, finishes, events, cancels, spawnEnvs }
}

function frames(child: FakeChild): string[] {
  const received: string[] = []
  child.stdin.on('data', (chunk) => received.push(String(chunk)))
  return received
}

describe('HostNodeMistralProvider', () => {
  it('keeps a missing binary visible as unavailable and terminalizes setup failure', async () => {
    const { instance, finishes } = open({ missingBinary: true })
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'mistral',
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
    // Live 2026-08-27 probe: vibe 2.24.3 ACP SDK lists elicitation/create, but vibe/acp/agent.py
    // never emits it (only session/request_permission). Host initialize does not advertise
    // clientCapabilities.elicitation, which ACP requires before any elicitation/create. Do not
    // flip supportsQuestions without a proven ACP agent→client question method on this Host path.
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

  it.each(['devstral-small', 'mistral-medium-3.5'])(
    'scrubs an ambient API key from the Vibe model %s',
    async (modelId) => {
      const { instance, child, spawnEnvs } = open({
        configuredThread: thread({ modelId }),
        environment: { PATH: '/usr/bin', MISTRAL_API_KEY: 'studio-key' }
      })
      const sent = frames(child)
      const running = instance.run({
        runId: 'run-1',
        threadId: 'thread-1',
        prompt: 'hello',
        target: {}
      })

      await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
      expect(spawnEnvs).toHaveLength(1)
      expect(spawnEnvs[0]?.MISTRAL_API_KEY).toBeUndefined()
      child.emit('close', 0)
      await expect(running).resolves.toMatchObject({ status: 'completed' })
    }
  )

  it('passes the API key only to a key-marked Mistral model', async () => {
    const { instance, child, spawnEnvs } = open({
      configuredThread: thread({ modelId: 'mistral-large-2512' }),
      environment: { PATH: '/usr/bin', MISTRAL_API_KEY: 'studio-key' }
    })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: {}
    })

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(spawnEnvs[0]?.MISTRAL_API_KEY).toBe('studio-key')
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'completed' })
  })

  it('rejects a key-marked model before launch when the host has no API key', async () => {
    const { instance, spawnEnvs } = open({
      configuredThread: thread({ modelId: 'mistral-large-2512' }),
      environment: { PATH: '/usr/bin' }
    })

    await expect(
      instance.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hello', target: {} })
    ).rejects.toThrow(/requires MISTRAL_API_KEY/)
    expect(spawnEnvs).toHaveLength(0)
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
        providerId: 'mistral',
        runId: 'run-1',
        threadId: 'thread-1',
        toolId: 'tool-1',
        options: ['allow-once', 'reject-once']
      })
    )

    settle({
      id: 'mistral:run-1:approval:1',
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

  it('does not register elicitation/create as a question: vibe ACP agent never emits it', async () => {
    const interactions = {
      register: vi.fn(async () => {
        throw new Error('ACP questions have no event source on the Mistral Host adapter')
      })
    } satisfies HostNodeInteractionResolver
    const { factory, instance, child } = open({ interactions })
    const sent = frames(child)
    expect(factory.supportsQuestions).toBe(false)
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })
    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'elicit-1',
        method: 'elicitation/create',
        params: { sessionId: 'session-1', mode: 'form', message: 'Pick a strategy?' }
      }) + '\n'
    )
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(interactions.register).not.toHaveBeenCalled()
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'completed' })
  })

  it('resolves unknown resource auth into configured or auth-required status', async () => {
    const unconfigured = open({ authState: 'unknown', isConfigured: () => false })
    await expect(unconfigured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'mistral',
      status: 'auth_required'
    })
    await expect(unconfigured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })
    expect(await unconfigured.instance.getAuthFlows()).toEqual([])

    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const login = open({
      authState: 'unknown',
      isConfigured: () => false,
      terminalLauncher: launcher
    })
    expect(await login.instance.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'mistral:login' })
    ])
    await expect(login.instance.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledWith(
      'mistral',
      expect.objectContaining({ argv: ['/usr/local/bin/mistral', 'login'] })
    )
    await expect(login.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const configured = open({ authState: 'unknown', isConfigured: () => true })
    await expect(configured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'mistral',
      status: 'ready'
    })
    await expect(configured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'authenticated'
    })
  })
})
