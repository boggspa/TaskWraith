import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  museMeterSnapshotToProviderStats,
  unavailableMuseMeterSnapshot
} from '../main/muse/MuseUsage'
import type { MuseRunInput, MuseRunOutcome, MuseRunSpawnHandle } from '../main/muse/MuseRun'
import type {
  HostProviderRunBegin,
  HostProviderRunBeginResult,
  HostProviderRunCancelRegistrationResult,
  HostProviderRunEvent,
  HostProviderRunFinish,
  HostProviderRunPort,
  HostProviderRunThread,
  HostProviderRunTranscriptAppend,
  HostProviderRunUpdate
} from '../host-runtime/HostProviderRunPort'
import {
  HostNodeMuseProvider,
  HostNodeMuseProviderDuplicateRunError,
  HostNodeMuseProviderPersistenceError,
  HostNodeMuseProviderValidationError,
  type HostNodeMuseProviderOptions
} from './HostNodeMuseProvider'

const NOW = Date.UTC(2026, 7, 24, 5, 0, 0)
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const ENV_SECRET = 'env-secret-should-not-leak'
const AUTH_JSON = JSON.stringify({
  providers: { meta: { api_key: 'auth-secret-should-not-leak' } }
})

function configuredThread(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    workspace: {
      workspaceId: 'workspace-1',
      canonicalPath: '/tmp/muse-workspace',
      canonical: true
    },
    providerId: 'muse',
    modelId: 'muse-spark-1.2',
    reasoningId: 'high',
    posture: {
      postureId: 'workspace-write',
      approvalMode: 'default',
      requiresExplicitConsent: true,
      explicitConsentAcknowledged: true
    },
    ...overrides
  }
}

function outcome(overrides: Partial<MuseRunOutcome> = {}): MuseRunOutcome {
  const meter = unavailableMuseMeterSnapshot(SESSION_ID)
  return {
    status: 'success',
    sessionId: SESSION_ID,
    exitCode: 0,
    assistantText: 'Muse assistant result',
    events: [],
    meter,
    providerStats: {
      ...museMeterSnapshotToProviderStats(meter),
      input_tokens: 13,
      output_tokens: 21,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
      total_cost_usd: 0.001
    },
    warnings: [],
    argv: ['exec', '--json'],
    effort: 'high',
    writeCapable: true,
    skillPinHash: 'a'.repeat(64),
    leasePath: '/tmp/muse-lease',
    ...overrides
  }
}

function spawnHandle(): MuseRunSpawnHandle & { readonly killCalls: string[] } {
  const killCalls: string[] = []
  return {
    pid: 99,
    kill(signal) {
      killCalls.push(signal ?? 'SIGTERM')
    },
    onStdout(listener) {
      void listener
    },
    onStderr(listener) {
      void listener
    },
    async wait() {
      return { code: 0, signal: null }
    },
    killCalls
  }
}

class FakeRunPort implements HostProviderRunPort {
  readonly transcripts: HostProviderRunTranscriptAppend[] = []
  readonly begins: HostProviderRunBegin[] = []
  readonly updates: HostProviderRunUpdate[] = []
  readonly finishes: HostProviderRunFinish[] = []
  readonly events: Array<{ target: unknown; event: HostProviderRunEvent }> = []
  readonly cancels = new Map<string, () => void>()
  beginResult: HostProviderRunBeginResult = { kind: 'started' }
  cancelRegistration: HostProviderRunCancelRegistrationResult = { kind: 'registered' }
  throwOnAppend = false
  throwOnClearCancel = false

  constructor(readonly thread: HostProviderRunThread | null = configuredThread()) {}

  getThread(threadId: string): HostProviderRunThread | null {
    return this.thread?.threadId === threadId ? this.thread : null
  }

  appendTranscript(input: HostProviderRunTranscriptAppend): void {
    if (this.throwOnAppend) throw new Error('store unavailable')
    this.transcripts.push(input)
  }

  beginRun(input: HostProviderRunBegin) {
    this.begins.push(input)
    return this.beginResult
  }

  updateRun(input: HostProviderRunUpdate): void {
    this.updates.push(input)
  }

  finishRun(input: HostProviderRunFinish): void {
    this.finishes.push(input)
  }

  registerCancel(runId: string, cancel: () => void): HostProviderRunCancelRegistrationResult {
    if (this.cancels.has(runId)) return { kind: 'duplicate' }
    if (this.cancelRegistration.kind === 'duplicate') return this.cancelRegistration
    this.cancels.set(runId, cancel)
    return { kind: 'registered' }
  }

  clearCancel(runId: string): void {
    this.cancels.delete(runId)
    if (this.throwOnClearCancel) throw new Error('cancel registry unavailable')
  }

  publishRunEvent(target: unknown, event: HostProviderRunEvent): void {
    this.events.push({ target, event })
  }
}

function baseOptions(
  runPort: HostProviderRunPort,
  overrides: Partial<HostNodeMuseProviderOptions> = {}
): HostNodeMuseProviderOptions {
  return {
    runPort,
    resources: {
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/muse', source: 'path' }),
      getTemporaryRoot: () => '/tmp/muse-root',
      readAuthJsonText: async () => AUTH_JSON,
      readMetaApiKeyEnv: () => ENV_SECRET,
      spawn: () => spawnHandle()
    },
    now: () => NOW,
    createSessionId: () => SESSION_ID,
    runMuseProvider: async () => outcome(),
    ...overrides
  }
}

function request(overrides: Partial<Parameters<HostNodeMuseProvider['run']>[0]> = {}) {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    prompt: 'Use api_key=user-intent-value only as a literal example.\nKeep the formatting.',
    target: { id: 'host-client-1', disconnected: true },
    ...overrides
  }
}

describe('HostNodeMuseProvider', () => {
  it('persists an exact configured run and publishes bounded body-free events', async () => {
    const port = new FakeRunPort()
    const runMuseProvider = vi.fn(async (input: MuseRunInput) => {
      input.onEvent?.({
        type: 'content',
        payloadType: 'run.output.delta',
        text: `${ENV_SECRET} ` + `x`.repeat(5_000),
        raw: { token: ENV_SECRET }
      })
      input.onEvent?.({
        type: 'tool_use',
        payloadType: 'runtime.session',
        toolId: 'tool-1',
        toolName: 'write_file',
        toolInput: { secret: ENV_SECRET },
        raw: { secret: ENV_SECRET }
      })
      input.onEvent?.({
        type: 'tool_result',
        payloadType: 'runtime.session',
        toolId: 'tool-1',
        toolOutput: `authorization=${ENV_SECRET}`,
        toolStatus: 'success',
        raw: { authorization: ENV_SECRET }
      })
      return outcome({
        assistantText: `Answer ${ENV_SECRET}`,
        warnings: [`muse stderr: token=${ENV_SECRET}`]
      })
    })
    const provider = new HostNodeMuseProvider(
      baseOptions(port, {
        runMuseProvider,
        resources: { ...baseOptions(port).resources, spawn: () => spawnHandle() }
      })
    )

    const result = await provider.run(request())

    expect(result).toEqual({
      runId: 'run-1',
      status: 'completed',
      sessionId: SESSION_ID,
      exitCode: 0
    })
    expect(port.begins).toHaveLength(1)
    expect(port.transcripts[0].text).toBe(request().prompt)
    expect(port.transcripts.some((entry) => entry.role === 'assistant')).toBe(true)
    expect(port.finishes).toEqual([
      expect.objectContaining({
        status: 'completed',
        providerSessionId: SESSION_ID,
        usage: expect.objectContaining({ inputTokens: 13, outputTokens: 21 }),
        warningSummaries: ['Muse reported stderr during the run.']
      })
    ])
    const eventJson = JSON.stringify(port.events)
    expect(eventJson).not.toContain(ENV_SECRET)
    expect(eventJson).not.toContain('toolInput')
    expect(eventJson).not.toContain('toolOutput')
    const content = port.events.find(({ event }) => event.type === 'run.content')?.event
    expect(content).toMatchObject({
      type: 'run.content',
      text: expect.stringContaining('[redacted]')
    })
    expect(
      (content as Extract<HostProviderRunEvent, { type: 'run.content' }>).text.length
    ).toBeLessThanOrEqual(4_000)
    expect(runMuseProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: ENV_SECRET,
        authJsonText: null,
        prompt: request().prompt
      })
    )
    expect(JSON.stringify([...port.transcripts, ...port.finishes, ...port.events])).not.toContain(
      ENV_SECRET
    )
  })

  it('rejects unsafe prompt/configuration before starting a provider run', async () => {
    const port = new FakeRunPort(configuredThread({ providerId: 'not-muse' }))
    const provider = new HostNodeMuseProvider(baseOptions(port))

    await expect(provider.run(request())).rejects.toBeInstanceOf(
      HostNodeMuseProviderValidationError
    )
    await expect(
      provider.run(request({ prompt: 'line one\u0000line two' }))
    ).rejects.toBeInstanceOf(HostNodeMuseProviderValidationError)
    expect(port.begins).toEqual([])
    expect(port.transcripts).toEqual([])
  })

  it('finishes a prelaunch setup failure after recording the user turn', async () => {
    const port = new FakeRunPort()
    const runMuseProvider = vi.fn()
    const provider = new HostNodeMuseProvider(
      baseOptions(port, {
        resources: {
          ...baseOptions(port).resources,
          resolveBinary: async () => ({ binaryPath: null, error: 'missing' })
        },
        runMuseProvider
      })
    )

    const result = await provider.run(request())

    expect(result.status).toBe('failed')
    expect(runMuseProvider).not.toHaveBeenCalled()
    expect(port.transcripts.map((entry) => entry.role)).toEqual(['user', 'system', 'system'])
    expect(port.finishes).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'provider_setup_unavailable' })
    ])
  })

  it('uses the landed Node Muse runner with credentials only on stdin', async () => {
    const port = new FakeRunPort()
    const options = baseOptions(port)
    let capturedSpawn: MuseRunInput['spawn'] extends (input: infer Input) => unknown ? Input : never
    const provider = new HostNodeMuseProvider({
      ...options,
      runMuseProvider: undefined,
      resources: {
        ...options.resources,
        getTemporaryRoot: () => '/tmp',
        spawn: (input) => {
          capturedSpawn = input
          return spawnHandle()
        }
      }
    })

    await expect(provider.run(request())).resolves.toMatchObject({ status: 'completed' })

    expect(capturedSpawn!.argv).toContain('--api-key-stdin')
    expect(capturedSpawn!.argv.join(' ')).not.toContain(ENV_SECRET)
    expect(capturedSpawn!.env.META_API_KEY).toBeUndefined()
    expect(capturedSpawn!.stdin).toBe(ENV_SECRET)
    expect(JSON.stringify([...port.transcripts, ...port.events, ...port.finishes])).not.toContain(
      ENV_SECRET
    )
  })

  it('fails closed on a duplicate durable run id without overwriting cancellation', async () => {
    const port = new FakeRunPort()
    port.beginResult = { kind: 'duplicate' }
    const provider = new HostNodeMuseProvider(baseOptions(port))

    await expect(provider.run(request())).rejects.toBeInstanceOf(
      HostNodeMuseProviderDuplicateRunError
    )
    expect(port.transcripts).toEqual([])
    expect(port.cancels.size).toBe(0)
  })

  it('terminalizes and surfaces a duplicate cancellation registration', async () => {
    const port = new FakeRunPort()
    port.cancelRegistration = { kind: 'duplicate' }
    const provider = new HostNodeMuseProvider(baseOptions(port))

    await expect(provider.run(request())).rejects.toBeInstanceOf(
      HostNodeMuseProviderPersistenceError
    )
    expect(port.cancels.size).toBe(0)
    expect(port.finishes).toEqual([expect.objectContaining({ status: 'failed' })])
  })

  it('cancels the exact spawned run once and ignores target disconnect state', async () => {
    const port = new FakeRunPort()
    let releaseRun: (() => void) | undefined
    const waitForCancellation = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const handle = spawnHandle()
    const provider = new HostNodeMuseProvider(
      baseOptions(port, {
        resources: { ...baseOptions(port).resources, spawn: () => handle },
        runMuseProvider: async (input) => {
          input.spawn({
            binaryPath: '/usr/local/bin/muse',
            argv: [],
            cwd: '/tmp/muse-workspace',
            env: {}
          })
          await waitForCancellation
          return outcome({
            status: input.shouldCancel?.() ? 'cancelled' : 'success',
            exitCode: null
          })
        }
      })
    )

    const pending = provider.run(request())
    await vi.waitFor(() => expect(port.cancels.has('run-1')).toBe(true))
    expect(provider.cancel('run-1')).toBe(true)
    expect(provider.cancel('run-1')).toBe(false)
    releaseRun?.()

    await expect(pending).resolves.toMatchObject({ status: 'cancelled' })
    expect(handle.killCalls).toEqual(['SIGTERM'])
    expect(port.finishes).toEqual([expect.objectContaining({ status: 'cancelled' })])
    expect(port.cancels.size).toBe(0)
  })

  it('terminalizes then surfaces a persistence fault instead of masking it as provider failure', async () => {
    const port = new FakeRunPort()
    port.throwOnAppend = true
    const provider = new HostNodeMuseProvider(baseOptions(port))

    await expect(provider.run(request())).rejects.toBeInstanceOf(
      HostNodeMuseProviderPersistenceError
    )
    expect(port.finishes).toEqual([expect.objectContaining({ status: 'failed' })])
  })

  it('releases the local active-run guard even when cancellation cleanup faults', async () => {
    const port = new FakeRunPort()
    port.throwOnClearCancel = true
    const provider = new HostNodeMuseProvider(baseOptions(port))

    await expect(provider.run(request())).rejects.toBeInstanceOf(
      HostNodeMuseProviderPersistenceError
    )

    port.throwOnClearCancel = false
    await expect(provider.run(request())).resolves.toMatchObject({ status: 'completed' })
  })

  it('reports credential presence only and has no Electron imports', async () => {
    const port = new FakeRunPort()
    const provider = new HostNodeMuseProvider(baseOptions(port))

    await expect(provider.getStatus()).resolves.toEqual({
      providerId: 'muse',
      status: 'ready',
      label: 'Muse'
    })
    const source = await readFile(
      resolve(process.cwd(), 'src/host-node/HostNodeMuseProvider.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
    expect(source).not.toMatch(/webcontents|ipcmain|ipcrenderer/i)
  })
})
