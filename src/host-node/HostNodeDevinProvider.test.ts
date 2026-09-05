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
    modelId: 'swe-1-7',
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
    /**
     * Devin subscription plan the stubbed resolver reports. Left undefined the
     * plan is unknown, which is the fail-open (ungated) case. A resolver is
     * ALWAYS injected so a test never opens the real Devin state DB.
     */
    readonly freePlan?: boolean
  } = {}
) {
  const appends: unknown[] = []
  const finishes: unknown[] = []
  const events: unknown[] = []
  const cancels = new Map<string, () => void>()
  const spawns: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const planStateReads: number[] = []
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
    planState: {
      resolve: async () => {
        planStateReads.push(planStateReads.length + 1)
        return input.freePlan
      },
      invalidate: () => undefined
    },
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
  return { factory, instance, child, appends, finishes, events, cancels, spawns, planStateReads }
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
    expect(spawns[0]).toMatchObject({ command: BINARY, args: ['acp', '--model', 'swe-1-7'] })
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
    // The catalog offers the CLI-enumerated rows (shared devinModelCatalog.ts);
    // an id outside it is stopped at the selectable gate before any spawn.
    const { instance, spawns } = open({ configuredThread: thread({ modelId: 'devin-custom-x' }) })
    await expect(instance.run(runRequest)).rejects.toThrow(/configuration is not selectable/)
    expect(spawns).toEqual([])
  })

  it('always names an exact variant on argv: family + reasoning fold into the CLI uid', () => {
    // Family default when no reasoning id is carried (SWE-1.7 → Max is the
    // bare `swe-1-7` uid); an offered level picks that variant.
    expect(hostNodeDevinAcpArgs('swe-1-7')).toEqual(['acp', '--model', 'swe-1-7'])
    expect(hostNodeDevinAcpArgs('swe-1-7', 'medium')).toEqual(['acp', '--model', 'swe-1-7-medium'])
    expect(hostNodeDevinAcpArgs('claude-opus-5', 'high')).toEqual([
      'acp',
      '--model',
      'claude-opus-5-high'
    ])
    // A level the family does not offer falls back to the family default.
    expect(hostNodeDevinAcpArgs('gemini-3-7-flash', 'max')).toEqual([
      'acp',
      '--model',
      'gemini-3-7-flash-medium'
    ])
    // A thread recorded with the exact variant keeps it.
    expect(hostNodeDevinAcpArgs('claude-opus-5-high')).toEqual([
      'acp',
      '--model',
      'claude-opus-5-high'
    ])
    // A thread recorded before the catalogue existed still carries the old
    // sentinel; it must never reach the CLI as `--model cli-default`.
    expect(hostNodeDevinAcpArgs('cli-default')).toEqual(['acp', '--model', 'swe-1-6-slow'])
    expect(hostNodeDevinAcpArgs('devin-custom-x')).toEqual(['acp', '--model', 'devin-custom-x'])
  })

  it('clamps argv to SWE-1.6 Slow on an observed free plan and stays open otherwise', () => {
    // A free plan may run exactly one family, so a paid selection that survived
    // in a thread record never reaches the CLI as `--model <paid family>`.
    expect(hostNodeDevinAcpArgs('claude-opus-5', 'high', true)).toEqual([
      'acp',
      '--model',
      'swe-1-6-slow'
    ])
    expect(hostNodeDevinAcpArgs('claude-opus-5-high', null, true)).toEqual([
      'acp',
      '--model',
      'swe-1-6-slow'
    ])
    // The one allowed family is untouched, and its reasoning id cannot invent a
    // variant the single-variant family does not have.
    expect(hostNodeDevinAcpArgs('swe-1-6-slow', 'high', true)).toEqual([
      'acp',
      '--model',
      'swe-1-6-slow'
    ])
    // Fail-open: only a positively observed free plan narrows anything. An
    // unknown plan (unreadable state DB, a non-macOS Host, a signed-out CLI)
    // and a paid plan both dispatch the selection as made.
    expect(hostNodeDevinAcpArgs('claude-opus-5', 'high', undefined)).toEqual([
      'acp',
      '--model',
      'claude-opus-5-high'
    ])
    expect(hostNodeDevinAcpArgs('claude-opus-5', 'high', false)).toEqual([
      'acp',
      '--model',
      'claude-opus-5-high'
    ])
  })

  it('clamps a stale paid selection to the free-plan family at launch', async () => {
    // The Host's offers projection is not plan-filtered, so the selectable gate
    // passes a paid family; the clamp is what keeps the launch honest.
    const { instance, child, spawns, planStateReads } = open({
      freePlan: true,
      configuredThread: thread({ modelId: 'claude-opus-5', reasoningId: 'high' })
    })
    const sent = frames(child)
    const running = instance.run(runRequest)

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ command: BINARY, args: ['acp', '--model', 'swe-1-6-slow'] })
    expect(planStateReads).toHaveLength(1)

    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('offers a free plan the one family it can run, without narrowing the run gate', async () => {
    const { instance, child, spawns } = open({
      freePlan: true,
      configuredThread: thread({ modelId: 'claude-opus-5', reasoningId: 'high' })
    })

    const gated = await instance.getOffers!()
    expect(gated.models.map((model) => model.modelId)).toEqual(['swe-1-6-slow'])

    // The same seat still runs. A thread that carries a family it could select
    // before the plan lapsed is clamped at dispatch, exactly as the desktop
    // lane does — validating the run against the narrowed rows instead would
    // turn it into a hard 'not selectable' failure.
    const sent = frames(child)
    const running = instance.run(runRequest)
    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(spawns[0]).toMatchObject({ args: ['acp', '--model', 'swe-1-6-slow'] })

    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('offers the whole catalogue while the plan is unknown', async () => {
    const { factory, instance } = open()
    const offers = await instance.getOffers!()
    expect(offers.models.length).toBeGreaterThan(1)
    expect(offers.models.map((model) => model.modelId)).toContain('claude-opus-5')
    expect(offers.offerRevision).toBe(factory.offers.offerRevision)
  })

  it('leaves a paid selection alone when the plan state is unknown', async () => {
    const { instance, child, spawns } = open({
      configuredThread: thread({ modelId: 'claude-opus-5', reasoningId: 'high' })
    })
    const sent = frames(child)
    const running = instance.run(runRequest)

    await vi.waitFor(() => expect(sent.join('')).toContain('"method":"initialize"'))
    expect(spawns[0]).toMatchObject({ args: ['acp', '--model', 'claude-opus-5-high'] })

    expect(instance.cancel('run-1')).toBe(true)
    child.emit('close', 0)
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
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
    ['decline', 'reject-once'],
    ['cancel', undefined]
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
        {
          jsonrpc: '2.0',
          id: 'permission-1',
          result: {
            outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
          }
        }
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
          result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
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
