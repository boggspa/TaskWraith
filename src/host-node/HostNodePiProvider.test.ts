import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createHostNodePiProviderFactory,
  HostNodePiProvider,
  HostNodePiValidationError,
  type HostNodePiSpawn,
  type HostNodePiSpawnInput
} from './HostNodePiProvider'
import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
import { PI_UPSTREAM_KEY_ENV } from '../host-shared/pi/PiModelPolicy'
import type { HostNodeProviderResourcePort } from './HostNodeProviderResources'
import type {
  HostProviderRunBegin,
  HostProviderRunEvent,
  HostProviderRunFinish,
  HostProviderRunPort,
  HostProviderRunThread,
  HostProviderRunTranscriptAppend,
  HostProviderRunUpdate
} from '../host-runtime/HostProviderRunPort'
import type { HostProviderOffersProjection } from '../shared/hostSetupProtocol'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'

const NOW = Date.UTC(2026, 7, 26, 4, 0, 0)
const TARGET: HostRunEventTarget = { id: 'client-1' }
const WIRE_MODEL_ID = 'deepseek/deepseek-v4-pro'
const UPSTREAM_ENV = PI_UPSTREAM_KEY_ENV.deepseek

/**
 * Tests drive a real upstream-qualified wire id. The shipped catalog no longer
 * includes the bare `pi-model` placeholder; that id now fails as not offered.
 * A separate test still injects a catalogued bare id so the adapter's
 * upstream-qualified refusal stays pinned.
 */
const PI_OFFERS: HostProviderOffersProjection = {
  ...hostProviderOffers('pi', true)!,
  models: [
    {
      modelId: WIRE_MODEL_ID,
      label: 'DeepSeek V4 Pro',
      available: true,
      reasoning: [
        { reasoningId: 'low', label: 'Low', available: true },
        { reasoningId: 'high', label: 'High', available: true }
      ]
    }
  ]
}

const temporaryRoots: string[] = []
function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'host-pi-test-'))
  temporaryRoots.push(root)
  return root
}
afterEach(() => {
  while (temporaryRoots.length) {
    const root = temporaryRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function threadFixture(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    providerId: 'pi',
    modelId: WIRE_MODEL_ID,
    reasoningId: 'high',
    workspace: { workspaceId: 'ws-1', canonicalPath: '/tmp', canonical: true },
    posture: {
      postureId: 'posture-plan',
      approvalMode: 'plan',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    },
    ...overrides
  }
}

class FakeRunPort implements HostProviderRunPort {
  thread: HostProviderRunThread | null = threadFixture()
  readonly transcripts: HostProviderRunTranscriptAppend[] = []
  readonly updates: HostProviderRunUpdate[] = []
  readonly events: HostProviderRunEvent[] = []
  readonly begins: HostProviderRunBegin[] = []
  finish: HostProviderRunFinish | null = null
  readonly cleared: string[] = []

  getThread(): HostProviderRunThread | null {
    return this.thread
  }
  appendTranscript(input: HostProviderRunTranscriptAppend): void {
    this.transcripts.push(input)
  }
  beginRun(input: HostProviderRunBegin) {
    this.begins.push(input)
    return { kind: 'started' as const }
  }
  updateRun(input: HostProviderRunUpdate): void {
    this.updates.push(input)
  }
  finishRun(input: HostProviderRunFinish): void {
    this.finish = input
  }
  registerCancel() {
    return { kind: 'registered' as const }
  }
  clearCancel(runId: string): void {
    this.cleared.push(runId)
  }
  publishRunEvent(_target: HostRunEventTarget, event: HostProviderRunEvent): void {
    this.events.push(event)
  }
}

function resourcePort(
  overrides: Partial<HostNodeProviderResourcePort> = {}
): HostNodeProviderResourcePort {
  return {
    resolveBinary: async () => ({ binaryPath: '/opt/homebrew/bin/pi', source: 'path' }),
    getAuthState: async () => 'unknown' as const,
    getVersion: async () => null,
    ...overrides
  }
}

const ENV_WITH_KEY: Record<string, string | undefined> = {
  [UPSTREAM_ENV]: 'deepseek-secret-key',
  PATH: '/usr/bin'
}

/** Fake pi process: records argv/env/stdin, replays scripted stdout. */
function scriptedSpawn(script: {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exitCode?: number | null
  /** Emit stdout only after the prompt command arrives, like the real RPC. */
  readonly replyToPrompt?: boolean
}): {
  spawn: HostNodePiSpawn
  captured: HostNodePiSpawnInput[]
  commands: string[]
  killed: string[]
} {
  const captured: HostNodePiSpawnInput[] = []
  const commands: string[] = []
  const killed: string[] = []
  const spawn: HostNodePiSpawn = (input) => {
    captured.push(input)
    const emit = (): void => {
      for (const chunk of script.stdout ?? []) input.onStdout(chunk)
      for (const chunk of script.stderr ?? []) input.onStderr(chunk)
    }
    if (!script.replyToPrompt) emit()
    return {
      writeCommand(line) {
        commands.push(line)
        if (script.replyToPrompt) emit()
      },
      kill(signal) {
        killed.push(String(signal))
      },
      exit: Promise.resolve({
        code: script.exitCode === undefined ? 0 : script.exitCode,
        signal: null
      })
    }
  }
  return { spawn, captured, commands, killed }
}

function providerWith(
  runPort: FakeRunPort,
  spawn: HostNodePiSpawn,
  overrides: {
    resources?: HostNodeProviderResourcePort
    baseEnv?: Record<string, string | undefined>
  } = {}
): HostNodePiProvider {
  return new HostNodePiProvider({
    runPort,
    offers: PI_OFFERS,
    resources: overrides.resources ?? resourcePort(),
    spawn,
    baseEnv: overrides.baseEnv ?? ENV_WITH_KEY,
    temporaryRoot: makeTemporaryRoot(),
    now: () => NOW
  })
}

const SUCCESS_STREAM = [
  `${JSON.stringify({ type: 'init', session_id: 'pi-session-1' })}\n`,
  `${JSON.stringify({ type: 'assistant_message_delta', delta: { text: 'Hello ' } })}\n`,
  `${JSON.stringify({ type: 'agent_settled' })}\n`
]

describe('HostNodePiProvider status and auth', () => {
  it('reports a missing binary as a present unavailable row, never an omission', async () => {
    const status = await providerWith(new FakeRunPort(), scriptedSpawn({}).spawn, {
      resources: resourcePort({
        resolveBinary: async () => ({ binaryPath: null, source: 'missing' })
      })
    }).getStatus()
    expect(status.providerId).toBe('pi')
    expect(status.status).toBe('unavailable')
    expect(status.label).toBe('Pi')
  })

  it('reports auth_required until an upstream key is present in the Host environment', async () => {
    const withoutKey = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn, {
      baseEnv: { PATH: '/usr/bin' }
    })
    const withoutStatus = await withoutKey.getStatus()
    expect(withoutStatus.status).toBe('auth_required')
    expect(withoutStatus.detail).toMatch(/not a terminal login/i)
    expect((await withoutKey.getAuthStatus()).state).toBe('unauthenticated')

    const withKey = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn)
    expect((await withKey.getStatus()).status).toBe('ready')
    expect((await withKey.getAuthStatus()).state).toBe('authenticated')
  })

  it('offers no terminal sign-in flow and refuses a fabricated one', async () => {
    const provider = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn)
    expect(await provider.getAuthFlows()).toEqual([])
    await expect(provider.beginAuth('op-1')).rejects.toBeInstanceOf(HostNodePiValidationError)
    await expect(provider.beginAuth('op-1')).rejects.toThrow(/upstream API key/i)
    expect(await provider.cancelAuth()).toBe(false)
  })
})

describe('HostNodePiProvider selection validation', () => {
  it('accepts a catalogued upstream-qualified wire id', () => {
    const resolved = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn).validateThread(
      threadFixture()
    )
    expect(resolved.upstream).toBe('deepseek')
    expect(resolved.modelId).toBe('deepseek-v4-pro')
  })

  it('rejects uncatalogued model, reasoning, or provider', () => {
    const provider = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn)
    expect(() => provider.validateThread(threadFixture({ modelId: 'zai/other' }))).toThrow(
      HostNodePiValidationError
    )
    expect(() => provider.validateThread(threadFixture({ reasoningId: 'ludicrous' }))).toThrow(
      HostNodePiValidationError
    )
    expect(() => provider.validateThread(threadFixture({ providerId: 'claude' }))).toThrow(
      HostNodePiValidationError
    )
  })

  // 696b2dc74 gave each Pi route its own ladder in place of one shared
  // seven-stop list, so stops seats had already persisted went off-ladder.
  // Throwing here reaches the caller as failed('run_not_started'), stranding
  // the chat; `medium` is DeepSeek's own documented alias for `high` anyway.
  it('folds a stop the per-route ladder retired onto that route default', () => {
    const provider = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn)
    const resolved = provider.validateThread(threadFixture({ reasoningId: 'medium' }))
    expect(resolved.thread.reasoningId).toBe('high')
    expect(resolved.modelId).toBe('deepseek-v4-pro')
  })

  it('rejects a shipped-catalog-absent bare model id as not offered', () => {
    const shipped = hostProviderOffers('pi', true)!
    expect(shipped.models.length).toBeGreaterThan(0)
    for (const model of shipped.models) {
      expect(model.modelId).toMatch(/^[a-z0-9-]+\/.+/)
    }
    expect(shipped.models.map((model) => model.modelId)).not.toContain('pi-model')
    const provider = new HostNodePiProvider({
      runPort: new FakeRunPort(),
      offers: shipped,
      resources: resourcePort(),
      spawn: scriptedSpawn({}).spawn,
      baseEnv: ENV_WITH_KEY,
      temporaryRoot: makeTemporaryRoot()
    })
    expect(() => provider.validateThread(threadFixture({ modelId: 'pi-model' }))).toThrow(
      /not offered/i
    )
  })

  it('rejects a catalogued but bare model id as not upstream-qualified', () => {
    const offers: HostProviderOffersProjection = {
      ...hostProviderOffers('pi', true)!,
      models: [
        {
          modelId: 'pi-model',
          label: 'Bare placeholder',
          available: true,
          reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
        }
      ]
    }
    const provider = new HostNodePiProvider({
      runPort: new FakeRunPort(),
      offers,
      resources: resourcePort(),
      spawn: scriptedSpawn({}).spawn,
      baseEnv: ENV_WITH_KEY,
      temporaryRoot: makeTemporaryRoot()
    })
    expect(() => provider.validateThread(threadFixture({ modelId: 'pi-model' }))).toThrow(
      /upstream-qualified/i
    )
  })
})

describe('HostNodePiProvider containment', () => {
  it('spawns with the full containment flag surface and read-only native tools', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM, replyToPrompt: true })
    await providerWith(runPort, spawn).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })

    const args = captured[0].args
    // Containment is built ENTIRELY from these flags — pi has no permission
    // system of its own, so losing any one of them opens a real hole.
    for (const flag of [
      '--mode',
      'rpc',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '--offline'
    ]) {
      expect(args).toContain(flag)
    }
    // Read-only by construction: the Host has no coordination extension, so no
    // write tool can ever be registered regardless of thread posture.
    const toolsIndex = args.indexOf('--tools')
    expect(toolsIndex).toBeGreaterThanOrEqual(0)
    expect(args[toolsIndex + 1]).toBe('read,grep,find,ls')
    expect(args).not.toContain('--extension')
    expect(args).toContain('--provider')
    expect(args[args.indexOf('--provider') + 1]).toBe('deepseek')
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek-v4-pro')
  })

  it('firewalls the credential environment down to the selected upstream only', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM, replyToPrompt: true })
    await providerWith(runPort, spawn, {
      baseEnv: {
        ...ENV_WITH_KEY,
        // A parent shell must never be able to widen the credential set.
        [PI_UPSTREAM_KEY_ENV.openrouter]: 'foreign-openrouter-key',
        ANTHROPIC_API_KEY: 'foreign-anthropic-key',
        OPENAI_API_KEY: 'foreign-openai-key'
      }
    }).run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET })

    const env = captured[0].env
    expect(env[UPSTREAM_ENV]).toBe('deepseek-secret-key')
    expect(env[PI_UPSTREAM_KEY_ENV.openrouter]).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    // Isolated per-run config home + telemetry/version/offline clamps.
    expect(env.PI_CODING_AGENT_DIR).toBeTruthy()
    expect(env.PI_TELEMETRY).toBe('0')
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1')
    expect(env.PI_OFFLINE).toBe('1')
  })
})

describe('HostNodePiProvider run', () => {
  it('sends the prompt over RPC, streams content, and completes', async () => {
    const runPort = new FakeRunPort()
    const { spawn, commands } = scriptedSpawn({ stdout: SUCCESS_STREAM, replyToPrompt: true })
    const result = await providerWith(runPort, spawn).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'Say hello',
      target: TARGET
    })

    expect(result.status).toBe('completed')
    const prompt = JSON.parse(commands[0]) as Record<string, unknown>
    expect(prompt.type).toBe('prompt')
    expect(prompt.message).toBe('Say hello')

    expect(runPort.events.map((event) => event.type)).toContain('run.started')
    expect(runPort.transcripts[0].role).toBe('user')
    expect(runPort.finish?.status).toBe('completed')
  })

  it('reports setup failure without launching when the binary is missing', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM })
    const result = await providerWith(runPort, spawn, {
      resources: resourcePort({
        resolveBinary: async () => ({ binaryPath: null, source: 'missing' })
      })
    }).run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET })

    expect(result.status).toBe('failed')
    expect(captured).toHaveLength(0)
    expect(runPort.finish?.errorCode).toBe('provider_setup_unavailable')
  })

  it('reports setup failure without launching when the upstream key is missing', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM })
    const result = await providerWith(runPort, spawn, { baseEnv: { PATH: '/usr/bin' } }).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })

    expect(result.status).toBe('failed')
    expect(captured).toHaveLength(0)
    expect(runPort.finish?.errorCode).toBe('provider_setup_unavailable')
    // The message names the variable to set, never a key value.
    expect(runPort.transcripts.some((entry) => entry.text.includes(UPSTREAM_ENV))).toBe(true)
  })

  it('cancels the exact run id with an RPC abort before signalling', async () => {
    const runPort = new FakeRunPort()
    const killed: string[] = []
    const commands: string[] = []
    let provider: HostNodePiProvider | undefined
    const spawn: HostNodePiSpawn = () => ({
      writeCommand(line) {
        commands.push(line)
        // Cancel arrives out-of-band, exactly as run.cancel would.
        if (commands.length === 1) {
          expect(provider?.cancel('a-different-run')).toBe(false)
          expect(provider?.cancel('run-1')).toBe(true)
        }
      },
      kill: (signal) => killed.push(String(signal)),
      exit: Promise.resolve({ code: 0, signal: null })
    })
    provider = providerWith(runPort, spawn)

    const result = await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })

    expect(result.status).toBe('cancelled')
    expect(runPort.finish?.status).toBe('cancelled')
    expect(JSON.parse(commands[1]).type).toBe('abort')
    expect(killed).toContain('SIGTERM')
  })

  it('cleans up the isolated home and cancel registration so the run id is reusable', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM, replyToPrompt: true })
    const provider = providerWith(runPort, spawn)
    const request = { runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET }

    await provider.run(request)
    const isolatedHome = String(captured[0].env.PI_CODING_AGENT_DIR)
    expect(isolatedHome).toBeTruthy()
    // The per-run config home must not outlive the run.
    const { existsSync } = await import('node:fs')
    expect(existsSync(isolatedHome)).toBe(false)

    expect(runPort.cleared).toEqual(['run-1'])
    await expect(provider.run(request)).resolves.toMatchObject({ status: 'completed' })
    expect(provider.cancel('run-1')).toBe(false)
  })

  it('records stderr as a bounded warning rather than transcript text', async () => {
    const runPort = new FakeRunPort()
    const { spawn } = scriptedSpawn({
      stdout: SUCCESS_STREAM,
      stderr: ['noisy pi output'],
      replyToPrompt: true
    })
    await providerWith(runPort, spawn).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })
    expect(runPort.finish?.warningSummaries).toContain('Pi reported stderr during the run.')
    expect(runPort.transcripts.some((entry) => entry.text.includes('noisy pi output'))).toBe(false)
  })
})

describe('HostNodePiProvider factory', () => {
  it('exposes catalog offers and advertises no interactions', () => {
    const factory = createHostNodePiProviderFactory()
    expect(factory.providerId).toBe('pi')
    expect(factory.offers.providerId).toBe('pi')
    // Pi ships no permission system, so there is nothing to resume.
    expect(factory.supportsApprovals).toBe(false)
    // PiRpc has no elicitation event type. There is no question event source;
    // do not flip supportsQuestions without one.
    expect(factory.supportsQuestions).toBe(false)
  })

  it('refuses offers belonging to another provider', () => {
    expect(() =>
      createHostNodePiProviderFactory({ offers: hostProviderOffers('claude', true)! })
    ).toThrow()
  })
})
