import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type {
  HostProviderRunPort,
  HostProviderRunEvent,
  HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import type { HostNodeProviderCreateInput } from './HostNodeProvider'
import { createHostNodeKimiProvider } from './HostNodeKimiProvider'

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
    providerId: 'kimi',
    modelId: 'kimi-k2.7-code',
    reasoningId: 'on',
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
  const events: HostProviderRunEvent[] = []
  const cancels = new Map<string, () => void>()
  const child = new FakeChild()
  const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => child as never)
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
  const factory = createHostNodeKimiProvider({
    resources: {
      resolveBinary: async () =>
        input.missingBinary
          ? { binaryPath: null, source: 'missing' }
          : { binaryPath: '/usr/local/bin/kimi', source: 'path' },
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
  return { factory, instance, child, appends, finishes, events, cancels, spawn }
}

function frames(child: FakeChild): string[] {
  const received: string[] = []
  child.stdin.on('data', (chunk) => received.push(String(chunk)))
  return received
}

function completePrompt(child: FakeChild): void {
  child.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }) + '\n'
  )
}

describe('HostNodeKimiProvider', () => {
  it.each([
    ['kimi-k2.7-code', 'kimi-code/kimi-for-coding'],
    ['kimi-k3', 'kimi-code/k3'],
    ['kimi-k3-256k', 'kimi-code/k3-256k']
  ])('maps the offered %s row to Kimi CLI alias %s', async (modelId, cliAlias) => {
    const reasoningId = modelId === 'kimi-k2.7-code' ? 'on' : 'high'
    const { instance, child, spawn } = open({
      configuredThread: thread({ modelId, reasoningId })
    })
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    expect(spawn.mock.calls[0]?.[1]).toEqual(['--model', cliAlias, 'acp'])
    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('uses the managed model alias in the ACP session configuration', async () => {
    const { instance, child } = open({
      configuredThread: thread({ modelId: 'kimi-k3', reasoningId: 'high' })
    })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-model-config',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/new"'))
    const sessionNew = JSON.parse(
      sent.find((frame) => frame.includes('"method":"session/new"'))!
    ) as {
      params: { configOptions: Array<{ configId: string; value: string }> }
    }
    expect(sessionNew.params.configOptions).toEqual([
      { configId: 'model', value: 'kimi-code/k3' },
      { configId: 'reasoning', value: 'high' }
    ])

    expect(instance.cancel('run-model-config')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('resumes an existing ACP session and falls back with bounded transcript context', async () => {
    const { instance, child } = open({
      configuredThread: thread({
        modelId: 'kimi-k3',
        reasoningId: 'high',
        providerSessionId: 'session-existing'
      })
    })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-resume',
      threadId: 'thread-1',
      prompt: 'follow up',
      resumeFallbackPrompt: 'Earlier context\n\nNew user message:\nfollow up',
      target: { id: 'client' }
    })

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/resume"'))
    const resume = JSON.parse(
      sent.find((frame) => frame.includes('"method":"session/resume"'))!
    ) as {
      params: { sessionId: string; cwd: string; mcpServers: unknown[] }
    }
    expect(resume.params).toMatchObject({
      sessionId: 'session-existing',
      cwd: '/tmp/host-node-provider-test',
      mcpServers: []
    })

    child.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/prompt"'))
    const resumedPrompt = JSON.parse(
      sent.find((frame) => frame.includes('"method":"session/prompt"'))!
    ) as { params: { sessionId: string; prompt: Array<{ text: string }> } }
    expect(resumedPrompt.params).toMatchObject({
      sessionId: 'session-existing',
      prompt: [{ text: 'follow up' }]
    })

    child.stdout.write(JSON.stringify({ id: 3, result: { stopReason: 'end_turn' } }) + '\n')
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true))
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({
      status: 'completed',
      sessionId: 'session-existing'
    })
  })

  it('uses the Host transcript prompt when native Kimi resume is rejected', async () => {
    const { instance, child } = open({
      configuredThread: thread({
        providerSessionId: 'session-expired',
        modelId: 'kimi-k3',
        reasoningId: 'high'
      })
    })
    const sent = frames(child)
    const running = instance.run({
      runId: 'run-resume-fallback',
      threadId: 'thread-1',
      prompt: 'short follow up',
      resumeFallbackPrompt: 'Prior turn: hello\n\nNew user message:\nshort follow up',
      target: { id: 'client' }
    })

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/resume"'))
    child.stdout.write(
      JSON.stringify({ id: 2, error: { code: -32000, message: 'session not found' } }) + '\n'
    )
    await vi.waitFor(() => expect(sent.join('')).toContain('"id":4,"method":"session/new"'))
    const fallbackSession = JSON.parse(
      sent.find((frame) => frame.includes('"id":4,"method":"session/new"'))!
    ) as { params: { configOptions: Array<{ configId: string; value: string }> } }
    expect(fallbackSession.params.configOptions[0]).toEqual({
      configId: 'model',
      value: 'kimi-code/k3'
    })

    child.stdout.write(JSON.stringify({ id: 4, result: { sessionId: 'session-fresh' } }) + '\n')
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/prompt"'))
    const fallbackPrompt = JSON.parse(
      sent.find((frame) => frame.includes('"method":"session/prompt"'))!
    ) as { params: { sessionId: string; prompt: Array<{ text: string }> } }
    expect(fallbackPrompt.params).toMatchObject({
      sessionId: 'session-fresh',
      prompt: [{ text: 'Prior turn: hello\n\nNew user message:\nshort follow up' }]
    })

    child.stdout.write(JSON.stringify({ id: 3, result: { stopReason: 'end_turn' } }) + '\n')
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true))
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({
      status: 'completed',
      sessionId: 'session-fresh'
    })
  })

  it('publishes bounded file-edit activity with line counts', async () => {
    const { instance, child, events } = open({
      configuredThread: thread({ modelId: 'kimi-k3', reasoningId: 'high' })
    })
    const running = instance.run({
      runId: 'run-edit-activity',
      threadId: 'thread-1',
      prompt: 'edit the example',
      target: { id: 'client' }
    })

    await vi.waitFor(() => events.some((event) => event.type === 'run.started'))
    child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
    await vi.waitFor(() => events.some((event) => event.type === 'run.status'))
    child.stdout.write(JSON.stringify({ id: 2, result: { sessionId: 'session-edit' } }) + '\n')
    child.stdout.write(
      JSON.stringify({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-edit',
            title: 'Edit',
            input: {
              file_path: 'src/example.ts',
              old_string: 'one\ntwo',
              new_string: 'one\nthree\nfour'
            }
          }
        }
      }) + '\n'
    )
    child.stdout.write(
      JSON.stringify({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-edit',
            title: 'Edit',
            status: 'completed'
          }
        }
      }) + '\n'
    )

    await vi.waitFor(() => events.filter((event) => event.type === 'run.tool').length === 2)
    const toolEvents = events.filter((event) => event.type === 'run.tool')
    expect(toolEvents).toEqual([
      expect.objectContaining({
        toolId: 'tool-edit',
        toolName: 'Edit',
        phase: 'started',
        file: 'src/example.ts',
        additions: 3,
        deletions: 2
      }),
      expect.objectContaining({
        toolId: 'tool-edit',
        phase: 'finished',
        status: 'success'
      })
    ])

    child.stdout.write(JSON.stringify({ id: 3, result: { stopReason: 'end_turn' } }) + '\n')
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true))
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'completed' })
  })

  it('keeps a missing binary visible as unavailable and terminalizes setup failure', async () => {
    const { instance, finishes } = open({ missingBinary: true })
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'kimi',
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
    // Live 2026-08-27 probe: kimi-cli 1.47.0 ACP schema v0.10.8 CLIENT_METHODS has no
    // elicitation/create (permission+fs+terminal only). kimi_cli/wire `_request_question` is
    // the TUI wire protocol, not ACP. Do not flip supportsQuestions without a proven ACP
    // agent→client question method on this Host path.
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
    let settled = false
    void running.finally(() => {
      settled = true
    })
    completePrompt(child)
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true))
    expect(settled).toBe(false)
    expect(finishes).toEqual([])
    child.emit('error', new Error('teardown race'))
    expect(settled).toBe(false)
    expect(finishes).toEqual([])
    child.emit('close', null, 'SIGTERM')

    await expect(running).resolves.toMatchObject({
      runId: 'run-1',
      status: 'completed',
      sessionId: 'session-1'
    })
    expect(appends.filter((entry) => (entry as { role?: unknown }).role === 'assistant')).toEqual([
      expect.objectContaining({ text: 'ready' })
    ])
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.content' })])
    )
    expect(finishes).toEqual([expect.objectContaining({ status: 'completed' })])
    expect(
      events.filter(
        (entry) =>
          (entry as { type?: unknown }).type === 'run.status' &&
          (entry as { status?: unknown }).status === 'completed'
      )
    ).toHaveLength(1)
  })

  it('does not treat a clean ACP process exit without terminal prompt evidence as completion', async () => {
    const { instance, child, finishes } = open()
    const running = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hello',
      target: { id: 'client' }
    })
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0))
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
    expect(finishes).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'provider_failed' })
    ])
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
        providerId: 'kimi',
        runId: 'run-1',
        threadId: 'thread-1',
        toolId: 'tool-1',
        options: ['allow-once', 'reject-once']
      })
    )

    settle({
      id: 'kimi:run-1:approval:1',
      kind: 'approval',
      decision: 'accept',
      actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
    })
    await vi.waitFor(() =>
      expect(sent.filter((frame) => frame.includes('"id":"permission-1"'))).toHaveLength(1)
    )
    expect(sent.join('')).toContain('"outcome":"selected"')
    expect(sent.join('')).toContain('"optionId":"allow-once"')
    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('does not register elicitation/create as a question: no proven ACP question source', async () => {
    const interactions = {
      register: vi.fn(async () => {
        throw new Error('ACP questions have no event source on the Kimi Host adapter')
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
    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('resolves unknown resource auth into configured or auth-required status', async () => {
    const unconfigured = open({ authState: 'unknown', isConfigured: () => false })
    await expect(unconfigured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'kimi',
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
      expect.objectContaining({ flowId: 'kimi:login' })
    ])
    await expect(login.instance.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledWith(
      'kimi',
      expect.objectContaining({ argv: ['/usr/local/bin/kimi', 'login'] })
    )
    await expect(login.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const configured = open({ authState: 'unknown', isConfigured: () => true })
    await expect(configured.instance.getStatus()).resolves.toMatchObject({
      providerId: 'kimi',
      status: 'ready'
    })
    await expect(configured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'authenticated'
    })
  })
})
