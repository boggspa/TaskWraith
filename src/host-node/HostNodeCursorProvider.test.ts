import { describe, expect, it, vi } from 'vitest'

import {
  createHostNodeCursorProviderFactory,
  HostNodeCursorProvider,
  HostNodeCursorRunNotImplementedError,
  HostNodeCursorValidationError,
  type HostNodeCursorAuthProbe
} from './HostNodeCursorProvider'
import type { HostNodeProviderTerminalLauncher } from './HostNodeTerminalLauncher'
import { hostProviderOffers } from '../host-shared/HostProviderCatalog'
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
import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'

const CURSOR_OFFERS = hostProviderOffers('cursor', true)!
const TARGET: HostRunEventTarget = { id: 'client-1' }

function threadFixture(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    providerId: 'cursor',
    modelId: 'composer-2.5-fast',
    reasoningId: 'high',
    workspace: { workspaceId: 'ws-1', canonicalPath: '/tmp/ws', canonical: true },
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
  readonly begins: HostProviderRunBegin[] = []
  readonly events: HostProviderRunEvent[] = []
  finish: HostProviderRunFinish | null = null
  readonly registered: string[] = []

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
  updateRun(_input: HostProviderRunUpdate): void {}
  finishRun(input: HostProviderRunFinish): void {
    this.finish = input
  }
  registerCancel(runId: string) {
    this.registered.push(runId)
    return { kind: 'registered' as const }
  }
  clearCancel(): void {}
  publishRunEvent(_target: HostRunEventTarget, event: HostProviderRunEvent): void {
    this.events.push(event)
  }
}

function resourcePort(
  overrides: Partial<HostNodeProviderResourcePort> = {}
): HostNodeProviderResourcePort {
  return {
    resolveBinary: async () => ({ binaryPath: '/usr/local/bin/cursor-agent', source: 'path' }),
    getAuthState: async () => 'authenticated' as const,
    getVersion: async () => null,
    ...overrides
  }
}

function provider(
  resources: HostNodeProviderResourcePort = resourcePort(),
  extra: {
    readonly terminalLauncher?: HostNodeProviderTerminalLauncher
    readonly probeAuth?: HostNodeCursorAuthProbe
  } = {}
): HostNodeCursorProvider {
  return new HostNodeCursorProvider({
    runPort: new FakeRunPort(),
    offers: CURSOR_OFFERS,
    resources,
    ...extra
  })
}

function recordedAuthProbe(exitCode: number | null): {
  readonly probeAuth: HostNodeCursorAuthProbe
  readonly calls: { readonly binaryPath: string; readonly args: readonly string[] }[]
} {
  const calls: { binaryPath: string; args: readonly string[] }[] = []
  return {
    calls,
    probeAuth: async (input) => {
      calls.push({ binaryPath: input.binaryPath, args: input.args })
      return { exitCode }
    }
  }
}

describe('HostNodeCursorProvider status and auth', () => {
  it('reports a missing binary as a present unavailable row, never an omission', async () => {
    const status = await provider(
      resourcePort({ resolveBinary: async () => ({ binaryPath: null, source: 'missing' }) })
    ).getStatus()
    expect(status.providerId).toBe('cursor')
    expect(status.status).toBe('unavailable')
    expect(status.label).toBe('Cursor')
  })

  it('reports auth_required when unauthenticated and degraded once signed in', async () => {
    const unauthenticated = provider(
      resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    )
    expect((await unauthenticated.getStatus()).status).toBe('auth_required')
    expect((await unauthenticated.getAuthStatus()).state).toBe('unauthenticated')
    const signedIn = await provider().getStatus()
    expect(signedIn.status).toBe('degraded')
    expect(signedIn.detail).toMatch(/containment attestation/i)
    expect((await provider().getAuthStatus()).state).toBe('authenticated')
  })

  it('withholds sign-in flows once authenticated', async () => {
    expect(await provider().getAuthFlows()).toEqual([])
  })

  it('withholds dead sign-in flows when unauthenticated and no launcher is injected', async () => {
    const unauthenticated = provider(
      resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    )
    expect(await unauthenticated.getAuthFlows()).toEqual([])
    await expect(unauthenticated.beginAuth('auth-1')).rejects.toThrow(
      /interactive terminal login is unavailable/i
    )
  })

  it('rejects a non-canonical auth operation id', async () => {
    await expect(provider().beginAuth(' bad ')).rejects.toBeInstanceOf(
      HostNodeCursorValidationError
    )
    expect(await provider().cancelAuth()).toBe(false)
  })

  it('lets an explicit resource authState win over an injected probe', async () => {
    const failing = recordedAuthProbe(1)
    const authenticated = provider(
      resourcePort({ getAuthState: async () => 'authenticated' as const }),
      {
        probeAuth: failing.probeAuth
      }
    )
    expect((await authenticated.getStatus()).status).toBe('degraded')
    expect((await authenticated.getAuthStatus()).state).toBe('authenticated')
    expect(failing.calls).toEqual([])

    const succeeding = recordedAuthProbe(0)
    const unauthenticated = provider(
      resourcePort({ getAuthState: async () => 'unauthenticated' as const }),
      { probeAuth: succeeding.probeAuth }
    )
    expect((await unauthenticated.getStatus()).status).toBe('auth_required')
    expect((await unauthenticated.getAuthStatus()).state).toBe('unauthenticated')
    expect(succeeding.calls).toEqual([])
  })

  it('probes `status` by exit code when resource auth is unknown', async () => {
    const readyProbe = recordedAuthProbe(0)
    const ready = provider(resourcePort({ getAuthState: async () => 'unknown' as const }), {
      probeAuth: readyProbe.probeAuth
    })
    expect((await ready.getStatus()).status).toBe('degraded')
    expect((await ready.getAuthStatus()).state).toBe('authenticated')
    expect(readyProbe.calls.length).toBeGreaterThan(0)
    expect(readyProbe.calls).toEqual(
      readyProbe.calls.map(() => ({
        binaryPath: '/usr/local/bin/cursor-agent',
        args: ['status']
      }))
    )

    const requiredProbe = recordedAuthProbe(1)
    const required = provider(resourcePort({ getAuthState: async () => 'unknown' as const }), {
      probeAuth: requiredProbe.probeAuth
    })
    expect((await required.getStatus()).status).toBe('auth_required')
    expect((await required.getAuthStatus()).state).toBe('unauthenticated')
    expect(requiredProbe.calls.length).toBeGreaterThan(0)
    expect(requiredProbe.calls).toEqual(
      requiredProbe.calls.map(() => ({
        binaryPath: '/usr/local/bin/cursor-agent',
        args: ['status']
      }))
    )
  })

  it('never projects probe stdout or stderr into Host status surfaces', async () => {
    const leaked = 'cursor-account secret-token-xyz'
    const probeAuth: HostNodeCursorAuthProbe = async (input) => {
      void input
      return { exitCode: 0, stdout: leaked, stderr: leaked } as never
    }
    const instance = provider(resourcePort({ getAuthState: async () => 'unknown' as const }), {
      probeAuth
    })
    const status = await instance.getStatus()
    const auth = await instance.getAuthStatus()
    expect(JSON.stringify(status)).not.toContain('cursor-account')
    expect(JSON.stringify(status)).not.toContain('secret-token-xyz')
    expect(JSON.stringify(auth)).not.toContain('cursor-account')
    expect(JSON.stringify(auth)).not.toContain('secret-token-xyz')
    expect(status.status).toBe('degraded')
  })

  it('advertises login and launches exact argv only when a launcher is injected', async () => {
    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const withLauncher = provider(
      resourcePort({ getAuthState: async () => 'unauthenticated' as const }),
      { terminalLauncher: launcher }
    )
    expect(await withLauncher.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'cursor:login' })
    ])
    await expect(withLauncher.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledWith('cursor', {
      argv: ['/usr/local/bin/cursor-agent', 'login']
    })
    await expect(withLauncher.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const withoutLauncher = provider(
      resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    )
    expect(await withoutLauncher.getAuthFlows()).toEqual([])
    await expect(withoutLauncher.beginAuth('auth-1')).rejects.toThrow(
      /interactive terminal login is unavailable/i
    )
    expect(launcher.launchForProvider).toHaveBeenCalledTimes(1)
  })
})

describe('HostNodeCursorProvider selection validation', () => {
  it('accepts a catalogued model and reasoning pair', () => {
    expect(provider().validateThread(threadFixture()).modelId).toBe('composer-2.5-fast')
  })

  it('rejects an uncatalogued model, reasoning, or provider', () => {
    const instance = provider()
    expect(() => instance.validateThread(threadFixture({ modelId: 'gpt-9' }))).toThrow(
      HostNodeCursorValidationError
    )
    expect(() => instance.validateThread(threadFixture({ reasoningId: 'ludicrous' }))).toThrow(
      HostNodeCursorValidationError
    )
    expect(() => instance.validateThread(threadFixture({ providerId: 'claude' }))).toThrow(
      HostNodeCursorValidationError
    )
  })
})

describe('HostNodeCursorProvider run refusal', () => {
  it('refuses to run with a typed error rather than a pretend-completed result', async () => {
    const runPort = new FakeRunPort()
    const instance = new HostNodeCursorProvider({
      runPort,
      offers: CURSOR_OFFERS,
      resources: resourcePort()
    })

    const run = instance.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'edit the file',
      target: TARGET
    })
    await expect(run).rejects.toBeInstanceOf(HostNodeCursorRunNotImplementedError)
    await expect(run).rejects.toThrow(/containment attestation/i)

    // The decisive property: a refusal must leave no phantom run behind.
    expect(runPort.begins).toEqual([])
    expect(runPort.transcripts).toEqual([])
    expect(runPort.events).toEqual([])
    expect(runPort.finish).toBeNull()
    expect(runPort.registered).toEqual([])
  })

  it('cancels and shuts down cleanly because no process is ever started', async () => {
    const instance = provider()
    expect(instance.cancel()).toBe(false)
    await expect(instance.shutdown()).resolves.toBeUndefined()
  })
})

describe('HostNodeCursorProvider factory', () => {
  it('exposes catalog offers and advertises no unresumable interactions', () => {
    const factory = createHostNodeCursorProviderFactory()
    expect(factory.providerId).toBe('cursor')
    expect(factory.offers.providerId).toBe('cursor')
    expect(factory.offers.models.length).toBeGreaterThan(0)
    expect(factory.supportsApprovals).toBe(false)
    // run() throws HostNodeCursorRunNotImplementedError: the Node Host has no
    // MCP deny-list containment attestation, so there is no run path and no
    // question event source. Do not flip supportsQuestions.
    expect(factory.supportsQuestions).toBe(false)
  })

  it('refuses offers belonging to another provider', () => {
    expect(() =>
      createHostNodeCursorProviderFactory({ offers: hostProviderOffers('claude', true)! })
    ).toThrow()
  })

  it('passes an injected launcher through so detached Hosts stay flow-silent by default', async () => {
    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const withLauncher = createHostNodeCursorProviderFactory({
      resources: resourcePort({ getAuthState: async () => 'unauthenticated' as const }),
      terminalLauncher: launcher
    }).create({
      runPort: new FakeRunPort(),
      interactions: { register: () => new Promise<never>(() => {}) }
    })
    expect(await withLauncher.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'cursor:login' })
    ])

    const detached = createHostNodeCursorProviderFactory({
      resources: resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    }).create({
      runPort: new FakeRunPort(),
      interactions: { register: () => new Promise<never>(() => {}) }
    })
    expect(await detached.getAuthFlows()).toEqual([])
  })
})
