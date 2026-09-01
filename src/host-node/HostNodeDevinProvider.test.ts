import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostProviderRunPort,
  HostProviderRunThread
} from '../host-runtime/HostProviderRunPort'
import {
  DEVIN_READ_ONLY_PROMPT_PREAMBLE,
  DEVIN_WRITE_MODE_PROMPT_PREAMBLE
} from '../main/devin/DevinCliArgs'
import type {
  HostNodeInteractionResolver,
  HostNodeInteractionSettlement
} from './HostNodeInteractionRegistry'
import type { HostNodeProviderCreateInput } from './HostNodeProvider'
import { createHostNodeDevinProvider, hostNodeDevinAcpArgs } from './HostNodeDevinProvider'

const BINARY = '/usr/local/bin/devin'
const RAW_PROMPT = 'summarise the README'
const WORKSPACE_PATH = '/tmp/host-node-devin-test'

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

const scratch: string[] = []
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true })
})

/**
 * A credentials.toml path inside a fresh scratch directory. The file exists
 * only when `contents` is given, so the default is an honest "no stored
 * credential" without ever reading the real home directory.
 */
function credentialsFixture(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-node-devin-'))
  scratch.push(dir)
  const path = join(dir, 'credentials.toml')
  if (contents !== undefined) writeFileSync(path, contents)
  return path
}

function thread(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    workspace: {
      workspaceId: 'workspace-1',
      canonicalPath: WORKSPACE_PATH,
      canonical: true
    },
    providerId: 'devin',
    modelId: 'cli-default',
    posture: {
      postureId: 'default',
      approvalMode: 'workspace_write',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    },
    ...overrides
  }
}

function planThread(): HostProviderRunThread {
  return thread({
    posture: {
      postureId: 'plan',
      approvalMode: 'plan',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    }
  })
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
    readonly credentialsPath?: string
  } = {}
) {
  const appends: unknown[] = []
  const finishes: unknown[] = []
  const events: unknown[] = []
  const cancels = new Map<string, () => void>()
  const spawns: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
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
  const factory = createHostNodeDevinProvider({
    resources: {
      resolveBinary: async () =>
        input.missingBinary
          ? { binaryPath: null, source: 'missing' }
          : { binaryPath: BINARY, source: 'path' },
      getAuthState: async () =>
        input.authState ?? (input.missingBinary ? 'unauthenticated' : 'authenticated'),
      getVersion: async () => 'test'
    },
    ...(input.isConfigured ? { isConfigured: input.isConfigured } : {}),
    ...(input.terminalLauncher ? { terminalLauncher: input.terminalLauncher } : {}),
    environment: input.environment ?? { PATH: '/usr/bin', WINDSURF_API_KEY: 'env-key' },
    credentialsPath: input.credentialsPath ?? credentialsFixture(),
    spawn: (command, args, options) => {
      spawns.push({ command, args, env: options.env })
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
  return { factory, instance, child, appends, finishes, events, cancels, spawns }
}

function frames(child: FakeChild): string[] {
  const received: string[] = []
  child.stdin.on('data', (chunk) => received.push(String(chunk)))
  return received
}

function wireFrames(sent: readonly string[]): Record<string, unknown>[] {
  return sent
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function responsesTo(sent: readonly string[], rpcId: string): Record<string, unknown>[] {
  return wireFrames(sent).filter((frame) => frame.id === rpcId)
}

function permissionFrame(rpcId: string, kind: string, title: string): string {
  return (
    JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'session/request_permission',
      params: {
        sessionId: 's-1',
        toolCall: { id: 'tool-1', title, kind },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' }
        ]
      }
    }) + '\n'
  )
}

function completePrompt(child: FakeChild): void {
  child.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }) + '\n'
  )
}

/** Drive initialize -> session/new -> session/prompt and stop once the prompt is on the wire. */
async function handshake(child: FakeChild, sent: readonly string[]): Promise<void> {
  await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
  child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
  await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/new"'))
  child.stdout.write(JSON.stringify({ id: 2, result: { sessionId: 's-1' } }) + '\n')
  await vi.waitFor(() => expect(sent.join('')).toContain('"method":"session/prompt"'))
}

function promptText(sent: readonly string[]): string {
  const prompt = wireFrames(sent).find((frame) => frame.method === 'session/prompt') as
    | { params: { sessionId: string; prompt: { type: string; text: string }[] } }
    | undefined
  expect(prompt?.params.sessionId).toBe('s-1')
  expect(prompt?.params.prompt).toHaveLength(1)
  return prompt!.params.prompt[0]!.text
}

const runRequest = {
  runId: 'run-1',
  threadId: 'thread-1',
  prompt: RAW_PROMPT,
  target: { id: 'client' }
}

describe('HostNodeDevinProvider', () => {
  it('keeps a missing binary visible as unavailable and terminalizes setup failure', async () => {
    const { instance, finishes, events, spawns } = open({ missingBinary: true })
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'devin',
      status: 'unavailable'
    })

    await expect(instance.run(runRequest)).resolves.toEqual({ runId: 'run-1', status: 'failed' })
    expect(finishes).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        status: 'failed',
        errorCode: 'provider_setup_unavailable'
      })
    ])
    expect(events).toEqual([
      expect.objectContaining({ type: 'run.status', runId: 'run-1', status: 'failed' })
    ])
    expect(spawns).toEqual([])
  })

  it('refuses to launch without a Devin credential and reports the seat unauthenticated', async () => {
    const { instance, spawns } = open({
      authState: 'unknown',
      environment: { PATH: '/usr/bin' },
      credentialsPath: credentialsFixture()
    })

    await expect(instance.run(runRequest)).rejects.toThrow(
      /WINDSURF_API_KEY or DEVIN_API_KEY[\s\S]*devin auth login/
    )
    expect(spawns).toEqual([])
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'devin',
      status: 'auth_required'
    })
    await expect(instance.getAuthStatus()).resolves.toEqual({
      providerId: 'devin',
      state: 'unauthenticated'
    })
  })

  it('launches a bare `devin acp` with the canonical key injected and alias keys scrubbed', async () => {
    const { instance, child, spawns } = open({
      environment: {
        PATH: '/usr/bin',
        TERM: 'xterm',
        WINDSURF_API_KEY: 'primary-key',
        DEVIN_API_KEY: 'alias-key',
        windsurf_api_key: 'lower-key'
      }
    })
    const sent = frames(child)
    const running = instance.run(runRequest)

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ command: BINARY, args: ['acp'] })
    expect(spawns[0]?.env).toEqual({
      PATH: '/usr/bin',
      TERM: 'xterm',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      WINDSURF_API_KEY: 'primary-key'
    })
    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('rejects a model the catalog does not offer before anything is launched', async () => {
    // The catalog offers only `cli-default`, so a concrete Devin model id is
    // stopped at the selectable gate today; the argv mapping below is what a
    // future catalogued id would ride on.
    const { instance, spawns } = open({ configuredThread: thread({ modelId: 'devin-custom-x' }) })
    await expect(instance.run(runRequest)).rejects.toThrow(/configuration is not selectable/)
    expect(spawns).toEqual([])
  })

  it('maps the catalog default to a bare `devin acp` and passes a concrete model id through verbatim', () => {
    expect(hostNodeDevinAcpArgs('cli-default')).toEqual(['acp'])
    expect(hostNodeDevinAcpArgs('devin-custom-x')).toEqual(['acp', '--model', 'devin-custom-x'])
  })

  it('prompts straight after session/new with the write preamble and records an exact completed receipt', async () => {
    const { factory, instance, child, appends, finishes, events } = open()
    const sent = frames(child)
    expect(factory).toMatchObject({
      providerId: 'devin',
      supportsApprovals: true,
      supportsQuestions: false
    })
    const running = instance.run(runRequest)

    await handshake(child, sent)
    const wire = wireFrames(sent)
    // No session/set_config_option drain: Devin has no config surface, so the
    // prompt is the very next frame after session/new.
    expect(wire.map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'session/new',
      'session/prompt'
    ])
    expect(wire[0]).toMatchObject({
      id: 1,
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'taskwraith-host', version: 'node-host-v1' }
      }
    })
    expect(wire[2]).toMatchObject({ id: 2, params: { cwd: WORKSPACE_PATH } })
    expect((wire[2] as { params: { mcpServers: unknown } }).params.mcpServers).toEqual([])
    const text = promptText(sent)
    expect(text.startsWith(DEVIN_WRITE_MODE_PROMPT_PREAMBLE)).toBe(true)
    expect(text.endsWith(RAW_PROMPT)).toBe(true)

    child.stdout.write(
      JSON.stringify({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Devin says hi' }
          }
        }
      }) + '\n'
    )
    await vi.waitFor(() =>
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'run.content', runId: 'run-1', text: 'Devin says hi' })
        ])
      )
    )
    completePrompt(child)
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true))
    expect(finishes).toEqual([])
    child.emit('close', null, 'SIGTERM')

    await expect(running).resolves.toEqual({
      runId: 'run-1',
      status: 'completed',
      sessionId: 's-1'
    })
    expect(finishes).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        status: 'completed',
        providerSessionId: 's-1',
        warningSummaries: []
      })
    ])
    // The transcript keeps the raw prompt; the preamble lives on the wire only.
    expect(appends).toEqual([
      expect.objectContaining({ role: 'user', runId: 'run-1', text: RAW_PROMPT }),
      expect.objectContaining({ role: 'assistant', runId: 'run-1', text: 'Devin says hi' })
    ])
    expect(
      events.filter(
        (entry) =>
          (entry as { type?: unknown }).type === 'run.status' &&
          (entry as { status?: unknown }).status === 'completed'
      )
    ).toHaveLength(1)
  })

  it('prompts with the read-only preamble on a plan seat', async () => {
    const { instance, child } = open({ configuredThread: planThread() })
    const sent = frames(child)
    const running = instance.run(runRequest)

    await handshake(child, sent)
    const text = promptText(sent)
    expect(text.startsWith(DEVIN_READ_ONLY_PROMPT_PREAMBLE)).toBe(true)
    expect(text.endsWith(RAW_PROMPT)).toBe(true)
    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('does not treat a clean ACP process exit without terminal prompt evidence as completion', async () => {
    const { instance, child, finishes } = open()
    const running = instance.run(runRequest)
    await vi.waitFor(() => expect(child.stdin.readableLength).toBeGreaterThan(0))
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
    expect(finishes).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'provider_failed' })
    ])
  })

  it('surfaces a rejected prompt as a failed turn with the ACP error as its warning', async () => {
    const { instance, child, finishes } = open()
    const sent = frames(child)
    const running = instance.run(runRequest)
    await handshake(child, sent)
    child.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        error: { code: -32000, message: 'quota exhausted' }
      }) + '\n'
    )
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true))
    child.emit('close', 1)
    await expect(running).resolves.toMatchObject({ status: 'failed' })
    expect(finishes).toEqual([
      expect.objectContaining({
        status: 'failed',
        errorCode: 'provider_failed',
        warningSummaries: ['quota exhausted']
      })
    ])
  })

  it.each([
    ['accept', 'allow-once'],
    ['decline', 'reject-once']
  ] as const)(
    'registers an ACP permission on a write seat and answers %s with the %s option exactly once',
    async (decision, optionId) => {
      let settle!: (value: HostNodeInteractionSettlement) => void
      const settlement = new Promise<HostNodeInteractionSettlement>((resolve) => {
        settle = resolve
      })
      const interactions = {
        register: vi.fn(() => settlement)
      } satisfies HostNodeInteractionResolver
      const { instance, child } = open({ interactions })
      const sent = frames(child)
      const running = instance.run(runRequest)

      child.stdout.write(permissionFrame('permission-1', 'edit', 'Write file'))
      await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
      expect(interactions.register).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'devin:run-1:approval:1',
          kind: 'approval',
          providerId: 'devin',
          runId: 'run-1',
          threadId: 'thread-1',
          toolId: 'tool-1',
          title: 'Write file',
          options: ['allow-once', 'reject-once']
        })
      )
      expect(responsesTo(sent, 'permission-1')).toEqual([])

      settle({
        id: 'devin:run-1:approval:1',
        kind: 'approval',
        decision,
        actor: { clientId: 'client', clientClass: 'tui', actorId: 'client' }
      })
      await vi.waitFor(() => expect(responsesTo(sent, 'permission-1')).toHaveLength(1))
      expect(responsesTo(sent, 'permission-1')).toEqual([
        { jsonrpc: '2.0', id: 'permission-1', result: { outcome: 'selected', optionId } }
      ])
      expect(instance.cancel('run-1')).toBe(true)
      child.emit('close', 0)
      await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    }
  )

  it.each(['edit', 'delete', 'move', 'execute'])(
    'refuses the %s tool kind on a plan seat without asking, while a read kind still asks',
    async (kind) => {
      const interactions = {
        register: vi.fn(() => new Promise<never>(() => {}))
      } satisfies HostNodeInteractionResolver
      const { instance, child } = open({ interactions, configuredThread: planThread() })
      const sent = frames(child)
      const running = instance.run(runRequest)

      child.stdout.write(permissionFrame('permission-mutate', kind, 'Mutate workspace'))
      await vi.waitFor(() => expect(responsesTo(sent, 'permission-mutate')).toHaveLength(1))
      expect(responsesTo(sent, 'permission-mutate')).toEqual([
        {
          jsonrpc: '2.0',
          id: 'permission-mutate',
          result: { outcome: 'selected', optionId: 'reject-once' }
        }
      ])
      expect(interactions.register).not.toHaveBeenCalled()

      child.stdout.write(permissionFrame('permission-read', 'read', 'Read file'))
      await vi.waitFor(() => expect(interactions.register).toHaveBeenCalledOnce())
      expect(interactions.register).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'devin:run-1:approval:1',
          kind: 'approval',
          providerId: 'devin',
          toolId: 'tool-1',
          title: 'Read file'
        })
      )
      expect(responsesTo(sent, 'permission-read')).toEqual([])
      expect(instance.cancel('run-1')).toBe(true)
      child.emit('close', 0)
      await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    }
  )

  it('cancels only the exact active run and drives the ACP stop', async () => {
    const { instance, child, finishes, cancels } = open()
    const sent = frames(child)
    const running = instance.run(runRequest)
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(cancels.has('run-1')).toBe(true)
    expect(child.stdin.writableEnded).toBe(false)

    expect(instance.cancel('other-run')).toBe(false)
    expect(instance.cancel('run-1')).toBe(true)
    // requestStop closes stdin as the graceful EOF boundary for the one-shot child.
    expect(child.stdin.writableEnded).toBe(true)
    child.emit('close', null, 'SIGTERM')
    await expect(running).resolves.toEqual({
      runId: 'run-1',
      status: 'cancelled',
      sessionId: 'run-1'
    })
    expect(finishes).toEqual([expect.objectContaining({ runId: 'run-1', status: 'cancelled' })])
    expect(instance.cancel('run-1')).toBe(false)
  })

  it('uses the CLI credentials.toml lane when the Host environment carries no key', async () => {
    const credentialsPath = credentialsFixture(
      'windsurf_api_key = "toml-key"\napi_server_url = "https://devin.example.test"\n'
    )
    const { instance, child, spawns } = open({
      authState: 'unknown',
      environment: { PATH: '/usr/bin' },
      credentialsPath
    })
    await expect(instance.getStatus()).resolves.toMatchObject({
      providerId: 'devin',
      status: 'ready'
    })
    await expect(instance.getAuthStatus()).resolves.toEqual({
      providerId: 'devin',
      state: 'authenticated'
    })

    const sent = frames(child)
    const running = instance.run(runRequest)
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(spawns[0]?.env).toMatchObject({
      WINDSURF_API_KEY: 'toml-key',
      WINDSURF_API_SERVER_URL: 'https://devin.example.test'
    })
    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('lets an explicit configured-state probe override the credential probe when auth is unknown', async () => {
    const configured = open({
      authState: 'unknown',
      environment: { PATH: '/usr/bin' },
      isConfigured: () => true
    })
    await expect(configured.instance.getStatus()).resolves.toMatchObject({ status: 'ready' })
    await expect(configured.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'authenticated'
    })

    const unconfigured = open({ authState: 'unknown', isConfigured: () => false })
    await expect(unconfigured.instance.getStatus()).resolves.toMatchObject({
      status: 'auth_required'
    })
  })

  it('offers the terminal login flow and launches `devin auth login`; without a launcher it throws', async () => {
    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const login = open({
      authState: 'unknown',
      environment: { PATH: '/usr/bin' },
      terminalLauncher: launcher
    })
    expect(await login.instance.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'devin:login', kind: 'manual', available: true })
    ])
    await expect(login.instance.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledTimes(1)
    expect(launcher.launchForProvider).toHaveBeenCalledWith('devin', {
      argv: [BINARY, 'auth', 'login']
    })
    // A terminal handoff is not authentication; the probe still says signed out.
    await expect(login.instance.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const detached = open({ authState: 'unknown', environment: { PATH: '/usr/bin' } })
    expect(await detached.instance.getAuthFlows()).toEqual([])
    await expect(detached.instance.beginAuth('auth-2')).rejects.toThrow(
      /interactive terminal login is unavailable/
    )
  })
})
