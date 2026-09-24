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
  const spawn = vi.fn(
    (
      _command: string,
      _args: string[],
      _options: {
        cwd: string
        env: NodeJS.ProcessEnv
        shell: false
        stdio: 'pipe'
      }
    ) => child as never
  )
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
    spawn
  })
  const instance = factory.create({
    runPort: port,
    interactions:
      input.interactions ??
      ({
        register: () => new Promise<never>(() => {})
      } satisfies HostNodeInteractionResolver)
  } satisfies HostNodeProviderCreateInput)
  return { factory, instance, child, spawn, appends, finishes, events }
}

function frames(child: FakeChild): string[] {
  const received: string[] = []
  child.stdin.on('data', (chunk) => received.push(String(chunk)))
  return received
}

describe('HostNodeCodexProvider', () => {
  it.each([
    ['read_only', 'plan', 'on-request', 'read-only', 'readOnly'],
    ['plan', 'plan', 'never', 'read-only', 'readOnly'],
    ['default', 'default', 'on-request', 'workspace-write', 'workspaceWrite'],
    ['workspace_write', 'default', 'never', 'workspace-write', 'workspaceWrite']
  ] as const)(
    'maps %s posture to the exact Codex sandbox and approval policy',
    (postureId, approvalMode, approvalPolicy, sandbox, sandboxPolicyType) => {
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
        approvalPolicy,
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

  it('maps only verified Full Access onto Codex danger-full-access with no approvals', () => {
    const base = thread()
    const verified = resolveHostNodeCodexPosture({
      workspace: base.workspace,
      posture: {
        postureId: 'full_access',
        approvalMode: 'auto_edit',
        requiresExplicitConsent: true,
        explicitConsentAcknowledged: true,
        verifiedConsent: {
          authority: 'host-signed',
          commandId: 'command-1',
          commandFingerprint: 'a'.repeat(64),
          actorClientClass: 'tui',
          offerRevision: 'revision-1',
          acknowledgedAt: '2026-08-29T23:30:00.000Z'
        }
      }
    })
    expect(verified).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    expect(
      resolveHostNodeCodexPosture({
        workspace: base.workspace,
        posture: {
          postureId: 'full_access',
          approvalMode: 'auto_edit',
          requiresExplicitConsent: true,
          explicitConsentAcknowledged: true
        }
      })
    ).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'read-only' })
  })

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

  it('never inherits Host elevation material into the Codex child environment', async () => {
    process.env.TASKWRAITH_FULL_ACCESS_BOOTSTRAP_SECRET = 'host-secret-sentinel'
    try {
      const { instance, child, spawn } = open()
      const running = instance.run({
        runId: 'run-env',
        threadId: 'thread-1',
        prompt: 'hello',
        target: { id: 'client' }
      })
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
      const options = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }
      expect(options.env?.TASKWRAITH_FULL_ACCESS_BOOTSTRAP_SECRET).toBeUndefined()
      expect(JSON.stringify(options.env)).not.toContain('host-secret-sentinel')
      child.emit('close', 1)
      await expect(running).resolves.toMatchObject({ status: 'failed' })
    } finally {
      delete process.env.TASKWRAITH_FULL_ACCESS_BOOTSTRAP_SECRET
    }
  })

  it('drives the Node-only app-server handshake and settles on its terminal turn notification', async () => {
    const { factory, instance, child, appends, finishes, events } = open()
    const sent = frames(child)
    expect(factory).toMatchObject({ supportsApprovals: true, supportsQuestions: true })
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

  it('keeps verified Full Access atomic across thread/start and turn/start wire controls', async () => {
    const configuredThread = thread({
      posture: {
        postureId: 'full_access',
        approvalMode: 'auto_edit',
        requiresExplicitConsent: true,
        explicitConsentAcknowledged: true,
        verifiedConsent: {
          authority: 'host-signed',
          commandId: 'command-1',
          commandFingerprint: 'a'.repeat(64),
          actorClientClass: 'tui',
          offerRevision: 'revision-1',
          acknowledgedAt: '2026-08-29T23:30:00.000Z'
        }
      }
    })
    const { instance, child } = open({ configuredThread })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-full',
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
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })

    child.stdout.write(
      JSON.stringify({ id: 2, result: { thread: { id: 'native-thread-full' } } }) + '\n'
    )
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"turn/start"'))
    const turnStart = JSON.parse(
      sent.find((frame) => frame.includes('"method":"turn/start"')) ?? '{}'
    ) as { params?: Record<string, unknown> }
    expect(turnStart.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    child.stdout.write(JSON.stringify({ id: 3, result: { turn: { id: 'turn-full' } } }) + '\n')
    child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {} }) + '\n')
    await expect(running).resolves.toMatchObject({ status: 'completed' })
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

  it('registers a Codex elicitation as a question and delivers the answer on stdin', async () => {
    let settle!: (value: {
      id: string
      kind: 'question'
      decision: 'answer'
      answer: string
      actor: { clientId: string; clientClass: string; actorId: string }
    }) => void
    const settlement = new Promise<{
      id: string
      kind: 'question'
      decision: 'answer'
      answer: string
      actor: { clientId: string; clientClass: string; actorId: string }
    }>((resolve) => {
      settle = resolve
    })
    const interactions = {
      register: vi.fn(() => settlement)
    } satisfies HostNodeInteractionResolver
    const { factory, instance, child } = open({ interactions })
    expect(factory).toMatchObject({ supportsQuestions: true })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })

    child.stdout.write(
      JSON.stringify({
        id: 'elicit-1',
        method: 'mcpServer/elicitation/request',
        params: {
          message: 'Which branch?',
          requestedSchema: {
            type: 'object',
            properties: { default: { type: 'string', enum: ['main', 'dev'] } }
          }
        }
      }) + '\n'
    )
    await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
    expect(interactions.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'question',
        providerId: 'codex',
        runId: 'run-1',
        threadId: 'thread-1',
        title: 'Which branch?',
        summary: 'Which branch?',
        options: ['main', 'dev']
      })
    )

    settle({
      id: 'codex:run-1:question:1',
      kind: 'question',
      decision: 'answer',
      answer: 'main',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"elicit-1"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"action":"accept"')
    expect(sent.join('')).toContain('"content":"main"')
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
  })

  it('delivers requestUserInput answers as {answers:{default}} on the same rpcId', async () => {
    let settle!: (value: {
      id: string
      kind: 'question'
      decision: 'answer' | 'dismiss'
      answer?: string
      actor: { clientId: string; clientClass: string; actorId: string }
    }) => void
    const settlement = new Promise<{
      id: string
      kind: 'question'
      decision: 'answer' | 'dismiss'
      answer?: string
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
        id: 'input-1',
        method: 'tool/requestUserInput',
        params: {
          questions: [{ id: 'default', question: 'Commit message?', options: ['ship', 'wait'] }]
        }
      }) + '\n'
    )
    await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
    expect(interactions.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'question',
        title: 'Commit message?',
        summary: 'Commit message?',
        options: ['ship', 'wait']
      })
    )

    settle({
      id: 'codex:run-1:question:1',
      kind: 'question',
      decision: 'answer',
      answer: 'ship',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"input-1"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"answers"')
    expect(sent.join('')).toContain('"default":"ship"')
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
  })

  it('declines a dismissed elicitation on the same rpcId stdin channel', async () => {
    let settle!: (value: {
      id: string
      kind: 'question'
      decision: 'dismiss'
      actor: { clientId: string; clientClass: string; actorId: string }
    }) => void
    const settlement = new Promise<{
      id: string
      kind: 'question'
      decision: 'dismiss'
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
        id: 'elicit-2',
        method: 'mcp/elicitation/request',
        params: { message: 'Continue?' }
      }) + '\n'
    )
    await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
    expect(interactions.register).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'question', title: 'Continue?' })
    )

    settle({
      id: 'codex:run-1:question:1',
      kind: 'question',
      decision: 'dismiss',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"elicit-2"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"action":"decline"')
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
  })

  it('rejects a dismissed requestUserInput on the same rpcId stdin channel', async () => {
    let settle!: (value: {
      id: string
      kind: 'question'
      decision: 'dismiss'
      actor: { clientId: string; clientClass: string; actorId: string }
    }) => void
    const settlement = new Promise<{
      id: string
      kind: 'question'
      decision: 'dismiss'
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
        id: 'input-2',
        method: 'tool/requestUserInput',
        params: { questions: [{ id: 'default', question: 'Name?' }] }
      }) + '\n'
    )
    await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())

    settle({
      id: 'codex:run-1:question:1',
      kind: 'question',
      decision: 'dismiss',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"input-2"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"error"')
    expect(sent.join('')).toContain('User dismissed Codex input request.')
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
