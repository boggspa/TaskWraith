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

const MODELS = [
  { id: 'gemini-3.7-flash-high', label: 'gemini-3.7-flash-high' },
  { id: 'gemini-3.7-flash-medium', label: 'gemini-3.7-flash-medium' },
  { id: 'gemini-3.7-flash-low', label: 'gemini-3.7-flash-low' }
]

function resources(): HostNodeProviderResourcePort {
  return {
    resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' }),
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
    workspace: { workspaceId: 'ws', canonicalPath: '/tmp/work', canonical: true },
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
      argv: ['/usr/local/bin/agy'],
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
    const provider = instance({ profilePath, spawn })
    await provider.getOffers()
    writeFileSync(
      join(profilePath, 'settings.json'),
      JSON.stringify({ antigravityEnabled: false, antigravityOptInAcceptedAt: null }),
      { mode: 0o600 }
    )
    await expect(
      provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'inspect', target: TARGET })
    ).resolves.toMatchObject({ status: 'failed' })
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
      binaryPath: '/usr/local/bin/agy',
      cwd: '/tmp/work'
    })
    expect((spawnInput as HostNodeAntigravitySpawnInput | null)?.args).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      '30m',
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
