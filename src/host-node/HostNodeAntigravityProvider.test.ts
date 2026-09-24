import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  HostProviderRunBegin,
  HostProviderRunEvent,
  HostProviderRunFinish,
  HostProviderRunPort,
  HostProviderRunThread,
  HostProviderRunTranscriptAppend,
  HostProviderRunUpdate
} from '../host-runtime/HostProviderRunPort'
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'
import { hostStandaloneAntigravityOffers } from '../host-shared/antigravity/HostStandaloneAntigravityAdmission'
import {
  createHostNodeAntigravityProviderFactory,
  HostNodeAntigravityProvider,
  type HostNodeAntigravitySpawnHandle,
  type HostNodeAntigravitySpawnInput
} from './HostNodeAntigravityProvider'
import { captureHostStandaloneAgyModels } from './HostNodeAgyPtyCapture'
import type { HostNodeProviderResourcePort } from './HostNodeProviderResources'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'

const TARGET: HostRunEventTarget = { id: 'client' }
const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

function profile(consented = true): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'host-antigravity-provider-')))
  paths.push(path)
  writeFileSync(
    join(path, 'settings.json'),
    JSON.stringify({
      antigravityEnabled: consented,
      antigravityOptInAcceptedAt: consented ? 1_700_000_000_000 : null
    }),
    { mode: 0o600 }
  )
  return path
}

const CONSENT_DETAIL = 'Accept the AntiGravity account/ToS ban-risk disclosure in TaskWraith first.'

function withdrawConsent(profilePath: string): void {
  writeFileSync(
    join(profilePath, 'settings.json'),
    JSON.stringify({ antigravityEnabled: false, antigravityOptInAcceptedAt: null }),
    { mode: 0o600 }
  )
}

const MODELS = [
  { id: 'gemini-3.7-flash-high', label: 'gemini-3.7-flash-high' },
  { id: 'gemini-3.7-flash-medium', label: 'gemini-3.7-flash-medium' },
  { id: 'gemini-3.7-flash-low', label: 'gemini-3.7-flash-low' }
]

/**
 * The admission/status paths validate the resolved binary with the ambient
 * platform's absolute-path rules, so the fixture must be canonical on the
 * runner's OS. Nothing executes it.
 */
const AGY_BINARY =
  process.platform === 'win32' ? 'C:\\taskwraith-test-bin\\agy.exe' : '/usr/local/bin/agy'

function resources(): HostNodeProviderResourcePort {
  return {
    resolveBinary: async () => ({ binaryPath: AGY_BINARY, source: 'path' }),
    getAuthState: async () => 'unknown',
    getVersion: async () => null
  }
}

function capture(models = MODELS) {
  return vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options: { readonly env: Record<string, string>; readonly timeoutMs: number }
    ) => ({ stdout: JSON.stringify({ models }), stderr: '', code: 0 })
  )
}

function thread(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    providerId: 'antigravity',
    modelId: 'gemini-3.7-flash-high',
    reasoningId: 'low',
    workspace: {
      workspaceId: 'ws',
      canonicalPath: process.platform === 'win32' ? 'C:\\work' : '/tmp/work',
      canonical: true
    },
    posture: {
      postureId: 'plan',
      approvalMode: 'plan',
      requiresExplicitConsent: false,
      explicitConsentAcknowledged: false
    },
    ...overrides
  }
}

class RunPort implements HostProviderRunPort {
  thread: HostProviderRunThread | null = thread()
  transcripts: HostProviderRunTranscriptAppend[] = []
  begins: HostProviderRunBegin[] = []
  events: HostProviderRunEvent[] = []
  finish: HostProviderRunFinish | null = null
  cancelCallback: (() => void) | null = null

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
    void input
  }
  finishRun(input: HostProviderRunFinish): void {
    this.finish = input
  }
  registerCancel(_runId: string, callback: () => void) {
    this.cancelCallback = callback
    return { kind: 'registered' as const }
  }
  clearCancel(): void {
    this.cancelCallback = null
  }
  publishRunEvent(_target: HostRunEventTarget, event: HostProviderRunEvent): void {
    this.events.push(event)
  }
}

function instance(
  options: {
    profilePath?: string
    runPort?: RunPort
    captureModels?: ReturnType<typeof capture>
    terminalLauncher?: HostNodeProviderTerminalLauncher
    spawn?: (input: HostNodeAntigravitySpawnInput) => HostNodeAntigravitySpawnHandle
    readConversationReceipt?: () => Promise<string | null>
  } = {}
) {
  return new HostNodeAntigravityProvider({
    profilePath: options.profilePath ?? profile(),
    runPort: options.runPort ?? new RunPort(),
    offers: hostStandaloneAntigravityOffers([]),
    resources: resources(),
    captureModels: options.captureModels ?? capture(),
    environment: {
      PATH: '/usr/local/bin',
      GEMINI_API_KEY: 'must-not-forward',
      TASKWRAITH_LOCK_OWNER_ID: 'must-not-forward-either'
    },
    ...(options.terminalLauncher ? { terminalLauncher: options.terminalLauncher } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.readConversationReceipt
      ? { readConversationReceipt: options.readConversationReceipt }
      : {})
  })
}

describe('HostNodeAntigravityProvider admission and auth', () => {
  it('stays unavailable and performs no probe before consent', async () => {
    const captureModels = capture()
    const provider = instance({ profilePath: profile(false), captureModels })
    await expect(provider.getOffers()).resolves.toMatchObject({ models: [] })
    await expect(provider.getStatus()).resolves.toMatchObject({ status: 'auth_required' })
    await expect(provider.getAuthStatus()).resolves.toMatchObject({ state: 'unauthenticated' })
    expect(captureModels).not.toHaveBeenCalled()
  })

  it('projects live authenticated offers and auth only after a nonempty probe', async () => {
    const provider = instance()
    const offers = await provider.getOffers()
    expect(offers.models).toEqual([
      expect.objectContaining({
        label: 'Gemini 3.7 Flash',
        default: true,
        reasoning: expect.arrayContaining([expect.objectContaining({ reasoningId: 'low' })])
      })
    ])
    await expect(provider.getStatus()).resolves.toMatchObject({ status: 'ready' })
    await expect(provider.getAuthStatus()).resolves.toMatchObject({ state: 'authenticated' })
  })

  it('uses bare agy login with no Google credentials and never treats spawn as auth', async () => {
    const launchForProvider = vi.fn(
      async (
        _providerId: string,
        _input: { readonly argv: readonly string[]; readonly env?: Record<string, string> }
      ) => ({ providerId: 'antigravity', spawned: true as const })
    )
    const provider = instance({
      captureModels: capture([]),
      terminalLauncher: { launchForProvider }
    })
    await expect(provider.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({ flowId: 'antigravity:login', available: true })
    ])
    await provider.beginAuth('auth-1')
    expect(launchForProvider).toHaveBeenCalledWith('antigravity', {
      argv: [AGY_BINARY],
      env: expect.objectContaining({ PATH: '/usr/local/bin', FORCE_COLOR: '0' })
    })
    const launch = launchForProvider.mock.calls[0]?.[1]
    expect(launch?.env).not.toHaveProperty('GEMINI_API_KEY')
    expect(launch?.env).not.toHaveProperty('TASKWRAITH_LOCK_OWNER_ID')
  })
})

describe('HostNodeAntigravityProvider run path', () => {
  beforeEach(() => vi.clearAllMocks())

  it('revalidates consent immediately before spawn', async () => {
    const profilePath = profile()
    const spawn = vi.fn()
    const runPort = new RunPort()
    const captureModels = capture()
    const provider = instance({ profilePath, runPort, captureModels, spawn })
    await provider.getOffers()
    // The run's forced re-probe reads consent before it calls `agy models`.
    // Consent is withdrawn during that call, and agy then answers.
    captureModels.mockImplementationOnce(async () => {
      withdrawConsent(profilePath)
      return { stdout: JSON.stringify({ models: MODELS }), stderr: '', code: 0 }
    })
    await expect(
      provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'inspect', target: TARGET })
    ).resolves.toMatchObject({ status: 'failed' })
    expect(runPort.finish?.warningSummaries).toEqual([CONSENT_DETAIL])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses Ask because the standalone agy transport cannot resume permission prompts', async () => {
    const spawn = vi.fn()
    const runPort = new RunPort()
    runPort.thread = thread({
      posture: {
        postureId: 'read_only',
        approvalMode: 'plan',
        requiresExplicitConsent: false,
        explicitConsentAcknowledged: false
      }
    })
    const provider = instance({ runPort, spawn })
    await provider.getOffers()
    await expect(
      provider.run({ runId: 'run-ask', threadId: 'thread-1', prompt: 'inspect', target: TARGET })
    ).rejects.toThrow(/only Plan/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs sandboxed plan mode, maps the effort variant, and persists a resumable receipt', async () => {
    let spawnInput: HostNodeAntigravitySpawnInput | null = null
    const spawn = (input: HostNodeAntigravitySpawnInput): HostNodeAntigravitySpawnHandle => {
      spawnInput = input
      input.onStdout('Plan complete. token=private-value')
      return { kill: vi.fn(), exit: Promise.resolve({ code: 0, signal: null }) }
    }
    const runPort = new RunPort()
    const provider = instance({
      runPort,
      spawn,
      readConversationReceipt: async () => 'agy-project-v1:0e81528b-aa70-4678-b9ce-d3005b829583'
    })
    await provider.getOffers()

    await expect(
      provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'inspect', target: TARGET })
    ).resolves.toMatchObject({
      status: 'completed',
      sessionId: 'agy-project-v1:0e81528b-aa70-4678-b9ce-d3005b829583'
    })
    expect(spawnInput).toMatchObject({
      binaryPath: AGY_BINARY,
      cwd: process.platform === 'win32' ? 'C:\\work' : '/tmp/work'
    })
    expect((spawnInput as HostNodeAntigravitySpawnInput | null)?.args).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      '24h',
      '--new-project',
      '--model',
      'gemini-3.7-flash-low',
      '--effort',
      'low',
      '-p',
      'inspect'
    ])
    expect((spawnInput as HostNodeAntigravitySpawnInput | null)?.env).not.toHaveProperty(
      'GEMINI_API_KEY'
    )
    expect(runPort.finish).toMatchObject({ status: 'completed' })
    expect(runPort.transcripts[1]?.text).toContain('token=[redacted]')
  })

  it('records stderr as a bounded warning rather than transcript text on a completed run', async () => {
    const runPort = new RunPort()
    const spawn = (input: HostNodeAntigravitySpawnInput): HostNodeAntigravitySpawnHandle => {
      input.onStdout('Plan complete.')
      input.onStderr('some noise')
      return { kill: vi.fn(), exit: Promise.resolve({ code: 0, signal: null }) }
    }
    const provider = instance({ runPort, spawn })
    await provider.getOffers()
    await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'inspect',
      target: TARGET
    })
    expect(runPort.finish?.status).toBe('completed')
    expect(runPort.finish?.warningSummaries).toEqual(['agy reported stderr during the run.'])
    expect(runPort.transcripts.some((entry) => entry.text.includes('some noise'))).toBe(false)
  })

  it('records a meaningful stderr line as the failed-run reason instead of a generic wrapper', async () => {
    const runPort = new RunPort()
    const quota = "You've hit your usage limit for this AntiGravity model."
    const spawn = (input: HostNodeAntigravitySpawnInput): HostNodeAntigravitySpawnHandle => {
      input.onStderr(`DEBUG: warming up\n${quota}\nSentry is attempting to send 2 pending events\n`)
      return { kill: vi.fn(), exit: Promise.resolve({ code: 1, signal: null }) }
    }
    const provider = instance({ runPort, spawn })
    await provider.getOffers()
    await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'inspect',
      target: TARGET
    })
    expect(runPort.finish?.status).toBe('failed')
    expect(runPort.finish?.warningSummaries).toEqual([quota])
    expect(runPort.finish?.warningSummaries).not.toContain('agy reported stderr during the run.')
    expect(runPort.transcripts.some((entry) => entry.text.includes(quota))).toBe(false)
    expect(runPort.transcripts.some((entry) => entry.text.includes('DEBUG:'))).toBe(false)
    expect(runPort.transcripts.some((entry) => entry.text.includes('Sentry'))).toBe(false)
  })

  it('keeps the generic stderr wrapper when a failed run only emitted telemetry', async () => {
    const runPort = new RunPort()
    const spawn = (input: HostNodeAntigravitySpawnInput): HostNodeAntigravitySpawnHandle => {
      input.onStderr(
        'INFO: warming up\nDEBUG:vibe:x\nSentry is attempting to send 2 pending events\n'
      )
      return { kill: vi.fn(), exit: Promise.resolve({ code: 1, signal: null }) }
    }
    const provider = instance({ runPort, spawn })
    await provider.getOffers()
    await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'inspect',
      target: TARGET
    })
    expect(runPort.finish?.status).toBe('failed')
    expect(runPort.finish?.warningSummaries).toEqual(['agy reported stderr during the run.'])
    expect(runPort.transcripts.some((entry) => entry.text.includes('DEBUG:'))).toBe(false)
  })

  it('cancels a live agy child exactly once', async () => {
    let settle: ((value: { code: number | null; signal: string | null }) => void) | undefined
    const kill = vi.fn(() => settle?.({ code: null, signal: 'SIGTERM' }))
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      settle = resolve
    })
    const provider = instance({ spawn: () => ({ kill, exit }) })
    await provider.getOffers()
    const run = provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'inspect',
      target: TARGET
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.cancel('run-1')).toBe(true)
    expect(provider.cancel('run-1')).toBe(false)
    await expect(run).resolves.toMatchObject({ status: 'cancelled' })
    expect(kill).toHaveBeenCalledTimes(1)
  })
})

describe('createHostNodeAntigravityProviderFactory', () => {
  it('marks only the guarded conditional provider path', () => {
    const factory = createHostNodeAntigravityProviderFactory({
      profilePath: profile(),
      offers: hostStandaloneAntigravityOffers([]),
      resources: resources(),
      captureModels: capture()
    })
    expect(factory).toMatchObject({
      providerId: 'antigravity',
      conditionalAdmission: 'antigravity-live-guarded'
    })
  })
})

type Harness = ReturnType<typeof harness>

/**
 * A provider whose `agy models` answers, binary lookups and spawns the test
 * steers. While `hold` is set, `agy models` waits until `answerProbe()` and
 * then answers as `probe` says at that moment; `holdBinary` and
 * `releaseBinary()` do the same for the binary lookup. `captures` counts the
 * `agy models` calls.
 */
function harness() {
  const profilePath = profile()
  const state: {
    probe: 'answers' | 'times-out' | 'no-models'
    models: typeof MODELS
    binary: string | null
    hold: boolean
    release?: () => void
    holdBinary: boolean
    releaseBinary?: () => void
    captures: number
  } = {
    probe: 'answers',
    models: MODELS,
    binary: AGY_BINARY,
    hold: false,
    holdBinary: false,
    captures: 0
  }
  const runPort = new RunPort()
  const kill = vi.fn()
  const spawn = vi.fn((input: HostNodeAntigravitySpawnInput): HostNodeAntigravitySpawnHandle => {
    input.onStdout('Plan complete.')
    return { kill, exit: Promise.resolve({ code: 0, signal: null }) }
  })
  const launchForProvider = vi.fn(
    async (
      _providerId: string,
      _input: { readonly argv: readonly string[]; readonly env?: Record<string, string> }
    ) => ({ providerId: 'antigravity', spawned: true as const })
  )
  const timedOut = { stdout: '', stderr: '', code: null, timedOut: true }
  const provider = new HostNodeAntigravityProvider({
    profilePath,
    runPort,
    offers: hostStandaloneAntigravityOffers([]),
    resources: {
      ...resources(),
      resolveBinary: async () => {
        if (state.holdBinary) {
          await new Promise<void>((resolve) => {
            state.releaseBinary = resolve
          })
        }
        return state.binary
          ? { binaryPath: state.binary, source: 'path' }
          : { binaryPath: null, source: 'missing' }
      }
    },
    captureModels: async () => {
      state.captures += 1
      if (state.hold) {
        await new Promise<void>((resolve) => {
          state.release = resolve
        })
      }
      if (state.probe === 'times-out') return timedOut
      if (state.probe === 'no-models') {
        return { stdout: 'Not logged in. Please sign in.', stderr: '', code: 0 }
      }
      return { stdout: JSON.stringify({ models: state.models }), stderr: '', code: 0 }
    },
    spawn,
    terminalLauncher: { launchForProvider },
    readConversationReceipt: async () => null
  })
  // Each refresh is a fresh probe, as the next one a second later would be.
  const refresh = async () => {
    provider['probeCache'] = null
    return provider.getOffers()
  }
  const send = (runId = 'run-1') =>
    provider.run({ runId, threadId: 'thread-1', prompt: 'inspect', target: TARGET })
  const probeHeld = () => vi.waitFor(() => expect(state.release).toBeTypeOf('function'))
  const answerProbe = () => {
    state.hold = false
    state.release?.()
  }
  return {
    profilePath,
    state,
    runPort,
    spawn,
    kill,
    launchForProvider,
    provider,
    refresh,
    send,
    probeHeld,
    answerProbe
  }
}

// An `agy models` call that timed out, crashed, exited non-zero or overflowed
// says nothing about the account. A send is then validated against the offers
// of the last probe that got an answer, as the Ollama adapter does after a
// failed catalog read, while the published offers and status stay honest. An
// answer that says no still refuses up front. Consent is read from its own
// source before a send is admitted against kept offers, and again immediately
// before agy is spawned (see 'at the moment agy launches' below).
describe('HostNodeAntigravityProvider after a probe that could not read agy', () => {
  const UNVERIFIED_DETAIL = 'A live agy account could not be verified; sign in and retry.'

  it('runs a send after one agy models call timed out, as the last ready probe offered it', async () => {
    const { state, runPort, spawn, refresh, send } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()
    state.probe = 'answers'

    await expect(send()).resolves.toMatchObject({ status: 'completed' })
    expect(runPort.begins).toHaveLength(1)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('publishes the unknown probe honestly: no offers, and the account unverified', async () => {
    const { state, provider, refresh } = harness()
    await refresh()
    state.probe = 'times-out'
    const offers = await refresh()
    provider['probeCache'] = null

    expect(offers).toEqual(hostStandaloneAntigravityOffers([]))
    await expect(provider.getStatus()).resolves.toMatchObject({
      status: 'auth_required',
      detail: UNVERIFIED_DETAIL
    })
    await expect(provider.getAuthStatus()).resolves.toMatchObject({ state: 'unauthenticated' })
  })

  it('fails the run with the probe reason when agy still cannot be read, and never spawns', async () => {
    const { state, runPort, spawn, refresh, send } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()

    await expect(send()).resolves.toMatchObject({ status: 'failed' })
    expect(runPort.finish).toMatchObject({
      status: 'failed',
      errorCode: 'provider_launch_failed',
      warningSummaries: [UNVERIFIED_DETAIL]
    })
    expect(runPort.events.at(-1)).toMatchObject({ status: 'failed', warningCount: 1 })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fails the run with the consent reason when consent is withdrawn with no refresh in between', async () => {
    const { profilePath, runPort, spawn, refresh, send } = harness()
    await refresh()
    withdrawConsent(profilePath)

    await expect(send()).resolves.toMatchObject({ status: 'failed' })
    expect(runPort.finish?.warningSummaries).toEqual([CONSENT_DETAIL])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads consent from its own source before admitting against offers an unknown probe kept', async () => {
    const { profilePath, state, runPort, spawn, refresh, send } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()
    withdrawConsent(profilePath)
    state.probe = 'answers'

    await expect(send()).rejects.toThrow(CONSENT_DETAIL)
    expect(runPort.begins).toEqual([])
    expect(runPort.transcripts).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('stays fail-closed when no probe has ever got an answer', async () => {
    const { state, runPort, spawn, refresh, send } = harness()
    state.probe = 'times-out'
    await refresh()
    state.probe = 'answers'

    await expect(send()).rejects.toThrow('AntiGravity model selection is not currently offered.')
    expect(runPort.begins).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['consent is withdrawn', (h: ReturnType<typeof harness>) => withdrawConsent(h.profilePath)],
    [
      'the agy CLI is missing',
      (h: ReturnType<typeof harness>) => {
        h.state.binary = null
      }
    ],
    [
      'agy answers with no models',
      (h: ReturnType<typeof harness>) => {
        h.state.probe = 'no-models'
      }
    ]
  ])('refuses up front when a refresh saw that %s', async (_label, answerNo) => {
    const h = harness()
    await h.refresh()
    answerNo(h)
    await h.refresh()

    await expect(h.send()).rejects.toThrow('AntiGravity model selection is not currently offered.')
    expect(h.runPort.begins).toEqual([])
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('validates against the next probe that gets an answer after an unknown one', async () => {
    const { state, refresh, send } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()
    state.probe = 'answers'
    state.models = [{ id: 'claude-opus-4-6', label: 'claude-opus-4-6' }]
    await refresh()

    await expect(send()).rejects.toThrow('AntiGravity model selection is not currently offered.')
  })

  it('launches only a model the forced re-probe still offers, not one the kept offers had', async () => {
    const { state, runPort, spawn, refresh, send } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()
    state.probe = 'answers'
    state.models = [{ id: 'claude-opus-4-6', label: 'claude-opus-4-6' }]

    await expect(send()).resolves.toMatchObject({ status: 'failed' })
    expect(runPort.finish?.warningSummaries).toEqual([
      'AntiGravity model selection is not currently offered.'
    ])
    expect(spawn).not.toHaveBeenCalled()
  })

  // A run's forced re-probe that answers puts sends back on the ordinary path:
  // a later withdrawal is reported on the next run by its own forced re-probe,
  // as after a ready refresh, rather than refused against kept offers.
  it('treats the offers as current again once a forced re-probe answers', async () => {
    const { profilePath, state, runPort, spawn, refresh, send } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()
    state.probe = 'answers'
    await expect(send('run-1')).resolves.toMatchObject({ status: 'completed' })
    withdrawConsent(profilePath)

    await expect(send('run-2')).resolves.toMatchObject({ status: 'failed' })
    expect(runPort.begins).toHaveLength(2)
    expect(runPort.finish?.warningSummaries).toEqual([CONSENT_DETAIL])
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('offers the agy sign-in flow while agy cannot be read', async () => {
    const { state, provider, refresh } = harness()
    await refresh()
    state.probe = 'times-out'
    await refresh()

    await expect(provider.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({ flowId: 'antigravity:login', available: true })
    ])
  })
})

/** A node-pty terminal whose agy answers `models` with MODELS and exits 0. */
function answeringTerminal() {
  const data: Array<(chunk: string) => void> = []
  const exits: Array<(event: { exitCode: number }) => void> = []
  setImmediate(() => {
    data.forEach((listener) => listener(JSON.stringify({ models: MODELS })))
    exits.forEach((listener) => listener({ exitCode: 0 }))
  })
  return {
    onData: (listener: (chunk: string) => void) => {
      data.push(listener)
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exits.push(listener)
    },
    kill: () => undefined
  }
}

/**
 * A provider on the production `agy models` capture, with node-pty replaced by
 * `ptySpawn`. `withdrawWhileLoading` withdraws consent while node-pty loads.
 */
function realCaptureProvider() {
  const profilePath = profile()
  const runPort = new RunPort()
  const ptySpawn = vi.fn(() => answeringTerminal())
  const spawn = vi.fn()
  const state = { withdrawWhileLoading: false }
  const provider = new HostNodeAntigravityProvider({
    profilePath,
    runPort,
    offers: hostStandaloneAntigravityOffers([]),
    resources: resources(),
    captureModels: (command, args, options) =>
      captureHostStandaloneAgyModels(command, args, options, {
        loadPty: async () => {
          if (state.withdrawWhileLoading) withdrawConsent(profilePath)
          return { spawn: ptySpawn }
        }
      }),
    spawn,
    readConversationReceipt: async () => null
  })
  return { runPort, ptySpawn, spawn, state, provider }
}

// Every wait before agy starts is followed by a consent read. The account
// probe reads it after resolving the binary, after node-pty loads (immediately
// before `agy models` is spawned) and after the capture. A run reads consent
// and Stop once more immediately before agy is spawned, and the sign-in
// terminal reads consent after resolving the binary. Nothing that lands during
// those waits launches agy, the `agy models` account check included.
describe('HostNodeAntigravityProvider at the moment agy launches', () => {
  it.each([
    [
      'a send after a ready refresh',
      async (h: Harness) => {
        await h.refresh()
      }
    ],
    [
      'a send admitted against kept offers',
      async (h: Harness) => {
        await h.refresh()
        h.state.probe = 'times-out'
        await h.refresh()
        h.state.probe = 'answers'
      }
    ]
  ])(
    'never launches agy for %s when consent is withdrawn while its forced re-probe waits on agy',
    async (_label, setUp) => {
      const h = harness()
      await setUp(h)
      h.state.hold = true
      const run = h.send()
      await h.probeHeld()
      withdrawConsent(h.profilePath)
      h.answerProbe()

      await expect(run).resolves.toMatchObject({ status: 'failed' })
      expect(h.runPort.finish).toMatchObject({
        status: 'failed',
        errorCode: 'provider_launch_failed',
        warningSummaries: [CONSENT_DETAIL]
      })
      expect(h.spawn).not.toHaveBeenCalled()
    }
  )

  it.each([
    [
      'a Stop',
      (h: Harness) => {
        expect(h.provider.cancel('run-1')).toBe(true)
      }
    ],
    ['a Host shutdown', (h: Harness) => h.provider.shutdown()]
  ])(
    'never launches agy for a run ended by %s during its forced re-probe, and gives it no failure reason',
    async (_label, end) => {
      const h = harness()
      await h.refresh()
      h.state.hold = true
      const run = h.send()
      await h.probeHeld()
      await end(h)
      h.answerProbe()

      await expect(run).resolves.toMatchObject({ status: 'cancelled' })
      expect(h.runPort.finish).toMatchObject({ status: 'cancelled', warningSummaries: [] })
      expect(h.spawn).not.toHaveBeenCalled()
    }
  )

  it('stops agy when a Stop lands while agy is being launched', async () => {
    const h = harness()
    await h.refresh()
    let stopped = false
    h.spawn.mockImplementationOnce(() => {
      // The Stop arrives before the launch has handed back agy's handle.
      stopped = h.provider.cancel('run-1')
      return { kill: h.kill, exit: Promise.resolve({ code: null, signal: 'SIGTERM' }) }
    })

    await expect(h.send()).resolves.toMatchObject({ status: 'cancelled' })
    expect(stopped).toBe(true)
    expect(h.kill).toHaveBeenCalledTimes(1)
    expect(h.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reads the thread again after the forced re-probe, and launches nothing for one switched to Ask', async () => {
    const h = harness()
    await h.refresh()
    h.state.hold = true
    const run = h.send()
    await h.probeHeld()
    h.runPort.thread = thread({
      posture: {
        postureId: 'read_only',
        approvalMode: 'plan',
        requiresExplicitConsent: false,
        explicitConsentAcknowledged: false
      }
    })
    h.answerProbe()

    await expect(run).resolves.toMatchObject({ status: 'failed' })
    expect(h.runPort.finish?.warningSummaries).toEqual([
      'Standalone AntiGravity currently permits only Plan.'
    ])
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('reads consent again before the sign-in terminal launches agy', async () => {
    const h = harness()
    h.state.holdBinary = true
    const begin = h.provider.beginAuth('auth-1')
    await vi.waitFor(() => expect(h.state.releaseBinary).toBeTypeOf('function'))
    withdrawConsent(h.profilePath)
    h.state.releaseBinary?.()

    await expect(begin).rejects.toThrow('AntiGravity consent is required before sign-in.')
    expect(h.launchForProvider).not.toHaveBeenCalled()
  })

  // The run reads its thread again once the forced re-probe returns, after the
  // probe's own last consent read. A withdrawal landing there is still seen.
  it('reads consent once more after the forced re-probe returns, immediately before the spawn', async () => {
    const h = harness()
    await h.refresh()
    const getThread = h.runPort.getThread.bind(h.runPort)
    let reads = 0
    h.runPort.getThread = () => {
      reads += 1
      if (reads === 2) withdrawConsent(h.profilePath)
      return getThread()
    }

    await expect(h.send()).resolves.toMatchObject({ status: 'failed' })
    expect(h.runPort.finish?.warningSummaries).toEqual([CONSENT_DETAIL])
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('calls no agy models when consent is withdrawn while a refresh resolves the binary', async () => {
    const h = harness()
    await h.refresh()
    const captures = h.state.captures
    h.state.holdBinary = true
    const refreshed = h.refresh()
    await vi.waitFor(() => expect(h.state.releaseBinary).toBeTypeOf('function'))
    withdrawConsent(h.profilePath)
    h.state.releaseBinary?.()

    await expect(refreshed).resolves.toEqual(hostStandaloneAntigravityOffers([]))
    expect(h.state.captures).toBe(captures)
    await expect(h.provider.getStatus()).resolves.toMatchObject({
      status: 'auth_required',
      detail: CONSENT_DETAIL
    })
  })

  it('calls no agy models when consent is withdrawn while node-pty loads for a refresh', async () => {
    const { state, ptySpawn, provider } = realCaptureProvider()
    state.withdrawWhileLoading = true

    await expect(provider.getOffers()).resolves.toEqual(hostStandaloneAntigravityOffers([]))
    expect(ptySpawn).not.toHaveBeenCalled()
    await expect(provider.getStatus()).resolves.toMatchObject({
      status: 'auth_required',
      detail: CONSENT_DETAIL
    })
  })

  it('starts no agy process for a send when consent is withdrawn while its forced re-probe loads node-pty', async () => {
    const { state, runPort, ptySpawn, spawn, provider } = realCaptureProvider()
    await provider.getOffers()
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    state.withdrawWhileLoading = true

    await expect(
      provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'inspect', target: TARGET })
    ).resolves.toMatchObject({ status: 'failed' })
    expect(runPort.finish?.warningSummaries).toEqual([CONSENT_DETAIL])
    expect(ptySpawn).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
  })
})
