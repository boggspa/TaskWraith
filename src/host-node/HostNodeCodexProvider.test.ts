import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type {
  HostProviderRunPort,
  HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import type { HostNodeProviderCreateInput } from './HostNodeProvider'
import { createHostNodeCodexProvider, resolveHostNodeCodexPosture } from './HostNodeCodexProvider'

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
      canonicalPath: '/tmp/host-node-codex-test',
      canonical: true
    },
    providerId: 'codex',
    modelId: 'gpt-5.5',
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
  const child = new FakeChild()
  const port: HostProviderRunPort = {
    getThread: () => input.configuredThread ?? thread(),
    appendTranscript: (value) => appends.push(value),
    beginRun: () => ({ kind: 'started' }),
    updateRun: () => undefined,
    finishRun: (value) => finishes.push(value),
    registerCancel: () => ({ kind: 'registered' }),
    clearCancel: () => undefined,
    publishRunEvent: (_target, event) => events.push(event)
  }
  const factory = createHostNodeCodexProvider({
    resources: {
      resolveBinary: async () =>
        input.missingBinary
          ? { binaryPath: null, source: 'missing' }
          : { binaryPath: '/usr/local/bin/codex', source: 'path' },
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
  return { factory, instance, child, appends, finishes, events }
}

function frames(child: FakeChild): string[] {
  const received: string[] = []
  child.stdin.on('data', (chunk) => received.push(String(chunk)))
  return received
}

describe('HostNodeCodexProvider', () => {
  it.each([
    ['read_only', 'plan', 'read-only', 'readOnly'],
    ['plan', 'plan', 'read-only', 'readOnly'],
    ['default', 'default', 'workspace-write', 'workspaceWrite'],
    ['workspace_write', 'default', 'workspace-write', 'workspaceWrite']
  ] as const)(
    'maps %s posture to the exact Codex sandbox and interactive approval policy',
    (postureId, approvalMode, sandbox, sandboxPolicyType) => {
      const base = thread()
      const controls = resolveHostNodeCodexPosture({
        workspace: base.workspace,
        posture: {
          ...base.posture,
          postureId,
          approvalMode,
          ...(postureId === 'workspace_write'
            ? { requiresExplicitConsent: true, explicitConsentAcknowledged: true }
            : {})
        }
      })
      expect(controls).toMatchObject({
        approvalPolicy: 'on-request',
        sandbox,
        sandboxPolicy: { type: sandboxPolicyType, networkAccess: false }
      })
      if (sandbox === 'read-only') {
        expect(controls.sandboxPolicy).toMatchObject({
          readableRoots: [base.workspace.canonicalPath]
        })
      } else {
        expect(controls.sandboxPolicy).toMatchObject({
          readableRoots: [base.workspace.canonicalPath],
          writableRoots: [base.workspace.canonicalPath]
        })
      }
    }
  )

  it('keeps a missing binary visible as unavailable and reports a setup failure', async () => {
    const { instance, finishes } = open({ missingBinary: true })
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'codex',
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

  it('drives the Node-only app-server handshake and settles on its terminal turn notification', async () => {
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
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"thread/start"'))
    const threadStart = JSON.parse(
      sent.find((frame) => frame.includes('"method":"thread/start"')) ?? '{}'
    ) as { params?: Record<string, unknown> }
    expect(threadStart.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: { model_reasoning_effort: 'high' }
    })
    child.stdout.write(
      JSON.stringify({ id: 2, result: { thread: { id: 'native-thread-1' } } }) + '\n'
    )
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"turn/start"'))
    child.stdout.write(JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } }) + '\n')
    child.stdout.write(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { delta: 'ready' }
      }) + '\n'
    )
    child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {} }) + '\n')

    await expect(running).resolves.toMatchObject({
      runId: 'run-1',
      status: 'completed',
      sessionId: 'native-thread-1'
    })
    expect(appends).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: 'ready' })])
    )
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.content' })])
    )
    expect(finishes).toEqual([expect.objectContaining({ status: 'completed' })])
  })

  it('cancels only the exact active Codex run', async () => {
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
  it('registers a Codex approval and delivers its settled decision exactly once', async () => {
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
        id: 'approval-1',
        method: 'approval/request',
        params: { itemId: 'tool-1', toolName: 'Shell command' }
      }) + '\n'
    )
    await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
    expect(interactions.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval',
        providerId: 'codex',
        runId: 'run-1',
        threadId: 'thread-1',
        toolId: 'tool-1'
      })
    )

    settle({
      id: 'codex:run-1:approval:1',
      kind: 'approval',
      decision: 'accept',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"approval-1"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"decision":"accept"')
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
  })
  it('resolves unknown resource auth into configured or auth-required status', async () => {
    const unconfigured = open({ authState: 'unknown', isConfigured: () => false })
    await expect(unconfigured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'codex',
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
      expect.objectContaining({ flowId: 'codex:login' })
    ])
    await expect(login.instance.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ argv: ['/usr/local/bin/codex', 'login'] })
    )
    await expect(login.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const configured = open({ authState: 'unknown', isConfigured: () => true })
    await expect(configured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'codex',
      status: 'ready'
    })
    await expect(configured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'authenticated'
    })
  })
})
