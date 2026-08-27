import { describe, expect, it, vi } from 'vitest'

import {
  buildHostNodeClaudeArgs,
  CLAUDE_CLI_PERMISSION_MODES,
  claudePermissionModeFor,
  createHostNodeClaudeProviderFactory,
  HostNodeClaudeProvider,
  HostNodeClaudeValidationError,
  parseHostNodeClaudeChunk,
  type HostNodeClaudeAuthProbe,
  type HostNodeClaudeSpawn,
  type HostNodeClaudeSpawnHandle,
  type HostNodeClaudeSpawnInput
} from './HostNodeClaudeProvider'
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

const NOW = Date.UTC(2026, 7, 26, 3, 0, 0)
const CLAUDE_OFFERS = hostProviderOffers('claude', true)!
const TARGET: HostRunEventTarget = { id: 'client-1' }

function threadFixture(overrides: Partial<HostProviderRunThread> = {}): HostProviderRunThread {
  return {
    threadId: 'thread-1',
    providerId: 'claude',
    modelId: 'claude-opus-5',
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
  readonly updates: HostProviderRunUpdate[] = []
  readonly events: HostProviderRunEvent[] = []
  readonly begins: HostProviderRunBegin[] = []
  finish: HostProviderRunFinish | null = null
  readonly registered = new Set<string>()
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
  registerCancel(runId: string) {
    this.registered.add(runId)
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
    resolveBinary: async () => ({ binaryPath: '/usr/local/bin/claude', source: 'path' as const }),
    getAuthState: async () => 'authenticated' as const,
    getVersion: async () => null,
    ...overrides
  }
}

/** Fake process: the test drives stdout, then settles the exit promise. */
function scriptedSpawn(script: {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exitCode?: number | null
}): { spawn: HostNodeClaudeSpawn; killed: string[]; captured: HostNodeClaudeSpawnInput[] } {
  const killed: string[] = []
  const captured: HostNodeClaudeSpawnInput[] = []
  const spawn: HostNodeClaudeSpawn = (input) => {
    captured.push(input)
    for (const chunk of script.stdout ?? []) input.onStdout(chunk)
    for (const chunk of script.stderr ?? []) input.onStderr(chunk)
    const handle: HostNodeClaudeSpawnHandle = {
      kill(signal) {
        killed.push(String(signal))
      },
      exit: Promise.resolve({
        code: script.exitCode === undefined ? 0 : script.exitCode,
        signal: null
      })
    }
    return handle
  }
  return { spawn, killed, captured }
}

function providerWith(
  runPort: FakeRunPort,
  spawn: HostNodeClaudeSpawn,
  resources: HostNodeProviderResourcePort = resourcePort(),
  extra: {
    readonly terminalLauncher?: HostNodeProviderTerminalLauncher
    readonly probeAuth?: HostNodeClaudeAuthProbe
  } = {}
): HostNodeClaudeProvider {
  return new HostNodeClaudeProvider({
    runPort,
    offers: CLAUDE_OFFERS,
    resources,
    spawn,
    now: () => NOW,
    ...extra
  })
}

function recordedAuthProbe(exitCode: number | null): {
  readonly probeAuth: HostNodeClaudeAuthProbe
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

const SUCCESS_STREAM = [
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-9' })}\n`,
  `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello ' }] }
  })}\n`,
  `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] }
  })}\n`,
  `${JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false }] }
  })}\n`,
  `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'session-9',
    usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
    result: 'Hello world'
  })}\n`
]

describe('HostNodeClaudeProvider status and auth', () => {
  it('reports a missing binary as a present unavailable row, never an omission', async () => {
    const provider = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({
        resolveBinary: async () => ({ binaryPath: null, source: 'missing' as const })
      })
    )
    const status = await provider.getStatus()
    expect(status.providerId).toBe('claude')
    expect(status.status).toBe('unavailable')
    expect(status.label).toBe('Claude')
  })

  it('reports auth_required when unauthenticated and withholds dead sign-in flows without a launcher', async () => {
    const provider = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    )
    expect((await provider.getStatus()).status).toBe('auth_required')
    expect((await provider.getAuthStatus()).state).toBe('unauthenticated')
    expect(await provider.getAuthFlows()).toEqual([])
    await expect(provider.beginAuth('auth-1')).rejects.toBeInstanceOf(HostNodeClaudeValidationError)
  })

  it('reports ready and withholds sign-in flows once authenticated', async () => {
    const provider = providerWith(new FakeRunPort(), scriptedSpawn({}).spawn)
    expect((await provider.getStatus()).status).toBe('ready')
    expect(await provider.getAuthFlows()).toEqual([])
  })

  it('lets an explicit resource authState win over an injected probe', async () => {
    const failing = recordedAuthProbe(1)
    const authenticated = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'authenticated' as const }),
      { probeAuth: failing.probeAuth }
    )
    expect((await authenticated.getStatus()).status).toBe('ready')
    expect((await authenticated.getAuthStatus()).state).toBe('authenticated')
    expect(failing.calls).toEqual([])

    const succeeding = recordedAuthProbe(0)
    const unauthenticated = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unauthenticated' as const }),
      { probeAuth: succeeding.probeAuth }
    )
    expect((await unauthenticated.getStatus()).status).toBe('auth_required')
    expect((await unauthenticated.getAuthStatus()).state).toBe('unauthenticated')
    expect(succeeding.calls).toEqual([])
  })

  it('probes `auth status` by exit code when resource auth is unknown', async () => {
    const readyProbe = recordedAuthProbe(0)
    const ready = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unknown' as const }),
      { probeAuth: readyProbe.probeAuth }
    )
    expect((await ready.getStatus()).status).toBe('ready')
    expect((await ready.getAuthStatus()).state).toBe('authenticated')
    expect(readyProbe.calls.length).toBeGreaterThan(0)
    expect(readyProbe.calls).toEqual(
      readyProbe.calls.map(() => ({
        binaryPath: '/usr/local/bin/claude',
        args: ['auth', 'status']
      }))
    )

    const requiredProbe = recordedAuthProbe(1)
    const required = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unknown' as const }),
      { probeAuth: requiredProbe.probeAuth }
    )
    expect((await required.getStatus()).status).toBe('auth_required')
    expect((await required.getAuthStatus()).state).toBe('unauthenticated')
    expect(requiredProbe.calls.length).toBeGreaterThan(0)
    expect(requiredProbe.calls).toEqual(
      requiredProbe.calls.map(() => ({
        binaryPath: '/usr/local/bin/claude',
        args: ['auth', 'status']
      }))
    )
  })

  it('never projects probe stdout or stderr into Host status surfaces', async () => {
    const leaked = 'sk-ant-secret account@example.com'
    const probeAuth: HostNodeClaudeAuthProbe = async (input) => {
      void input
      return { exitCode: 0, stdout: leaked, stderr: leaked } as never
    }
    const provider = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unknown' as const }),
      { probeAuth }
    )
    const status = await provider.getStatus()
    const auth = await provider.getAuthStatus()
    expect(JSON.stringify(status)).not.toContain('sk-ant')
    expect(JSON.stringify(status)).not.toContain('account@example.com')
    expect(JSON.stringify(auth)).not.toContain('sk-ant')
    expect(JSON.stringify(auth)).not.toContain('account@example.com')
    expect(status.status).toBe('ready')
  })

  it('advertises login and launches exact argv only when a launcher is injected', async () => {
    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const withLauncher = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unauthenticated' as const }),
      { terminalLauncher: launcher }
    )
    expect(await withLauncher.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'claude:login' })
    ])
    await expect(withLauncher.beginAuth('auth-1')).resolves.toBeUndefined()
    expect(launcher.launchForProvider).toHaveBeenCalledWith('claude', {
      argv: ['/usr/local/bin/claude', 'auth', 'login']
    })
    await expect(withLauncher.getAuthStatus()).resolves.toMatchObject({
      state: 'unauthenticated'
    })

    const withoutLauncher = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    )
    expect(await withoutLauncher.getAuthFlows()).toEqual([])
    await expect(withoutLauncher.beginAuth('auth-1')).rejects.toThrow(
      /interactive terminal login is unavailable/i
    )
    expect(launcher.launchForProvider).toHaveBeenCalledTimes(1)
  })

  it('survives a resource port that throws instead of resolving', async () => {
    const provider = providerWith(
      new FakeRunPort(),
      scriptedSpawn({}).spawn,
      resourcePort({
        resolveBinary: async () => {
          throw new Error('probe exploded')
        }
      })
    )
    expect((await provider.getStatus()).status).toBe('unavailable')
  })
})

describe('HostNodeClaudeProvider argv', () => {
  it('maps postures fail-closed so an unknown mode never writes', () => {
    expect(claudePermissionModeFor('full_access')).toBe('bypassPermissions')
    expect(claudePermissionModeFor('auto_edit')).toBe('acceptEdits')
    expect(claudePermissionModeFor('read_only')).toBe('plan')
    expect(claudePermissionModeFor('plan')).toBe('plan')
    // The App's `default` is an SDK token with no CLI equivalent, and its
    // "prompt the user" meaning cannot be honoured headlessly.
    expect(claudePermissionModeFor('default')).toBe('plan')
    // The important case: anything unrecognised must clamp to plan.
    expect(claudePermissionModeFor('something-new')).toBe('plan')
    expect(claudePermissionModeFor('')).toBe('plan')
  })

  it('only ever emits a mode the Claude CLI actually accepts', () => {
    // Regression guard for a bug this lane shipped and caught: the App maps its
    // approval mode onto the SDK vocabulary, which includes `default`. The CLI
    // rejects `default` outright, so copying the App's mapping produced an
    // invalid flag that a fake-spawn test could never have surfaced.
    const approvalModes = [
      'plan',
      'read_only',
      'default',
      'auto_edit',
      'full_access',
      'something-new',
      ''
    ]
    for (const approvalMode of approvalModes) {
      expect(CLAUDE_CLI_PERMISSION_MODES).toContain(claudePermissionModeFor(approvalMode))
    }
    expect(CLAUDE_CLI_PERMISSION_MODES).not.toContain('default')
  })

  it('builds stream-json argv and resumes only a canonical session id', () => {
    const args = buildHostNodeClaudeArgs({
      prompt: 'Do the thing',
      modelId: 'claude-opus-5',
      approvalMode: 'auto_edit',
      providerSessionId: 'session-9'
    })
    expect(args).toEqual([
      '-p',
      'Do the thing',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      'session-9'
    ])
    expect(
      buildHostNodeClaudeArgs({
        prompt: 'p',
        modelId: 'claude-opus-5',
        approvalMode: 'plan',
        providerSessionId: ' not canonical '
      })
    ).not.toContain('--resume')
  })
})

describe('HostNodeClaudeProvider stream parsing', () => {
  it('carries a partial trailing line across chunk boundaries', () => {
    const first = parseHostNodeClaudeChunk('{"type":"a"}\n{"type":"b"', '')
    expect(first.lines).toHaveLength(1)
    expect(first.carry).toBe('{"type":"b"')
    const second = parseHostNodeClaudeChunk('}\n', first.carry)
    expect(second.lines).toHaveLength(1)
    expect(second.lines[0].json).toEqual({ type: 'b' })
    expect(second.carry).toBe('')
  })

  it('drops non-JSON stdout instead of treating it as presentation text', () => {
    const parsed = parseHostNodeClaudeChunk('warning: something\n[]\n{"type":"ok"}\n', '')
    expect(parsed.lines).toEqual([{ json: { type: 'ok' } }])
  })
})

describe('HostNodeClaudeProvider selection validation', () => {
  it('rejects a thread that is not offered by the catalog', async () => {
    const runPort = new FakeRunPort()
    const provider = providerWith(runPort, scriptedSpawn({}).spawn)

    runPort.thread = threadFixture({ modelId: 'not-a-claude-model' })
    await expect(
      provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET })
    ).rejects.toBeInstanceOf(HostNodeClaudeValidationError)

    runPort.thread = threadFixture({ reasoningId: 'not-a-level' })
    await expect(
      provider.run({ runId: 'run-2', threadId: 'thread-1', prompt: 'hi', target: TARGET })
    ).rejects.toBeInstanceOf(HostNodeClaudeValidationError)

    runPort.thread = threadFixture({ providerId: 'codex' })
    await expect(
      provider.run({ runId: 'run-3', threadId: 'thread-1', prompt: 'hi', target: TARGET })
    ).rejects.toBeInstanceOf(HostNodeClaudeValidationError)

    // Nothing may be persisted for a rejected selection.
    expect(runPort.begins).toEqual([])
    expect(runPort.finish).toBeNull()
  })

  it('rejects a missing thread and a non-canonical run id', async () => {
    const runPort = new FakeRunPort()
    const provider = providerWith(runPort, scriptedSpawn({}).spawn)
    runPort.thread = null
    await expect(
      provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET })
    ).rejects.toBeInstanceOf(HostNodeClaudeValidationError)
    await expect(
      provider.run({ runId: ' bad ', threadId: 'thread-1', prompt: 'hi', target: TARGET })
    ).rejects.toBeInstanceOf(HostNodeClaudeValidationError)
  })
})

describe('HostNodeClaudeProvider run', () => {
  it('streams content and tools, records usage, and completes', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM, exitCode: 0 })
    const provider = providerWith(runPort, spawn)

    const result = await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'Say hello',
      target: TARGET
    })

    expect(result.status).toBe('completed')
    expect(result.sessionId).toBe('session-9')

    // Argv reached the process with the thread's own model and posture.
    expect(captured[0].args).toContain('claude-opus-5')
    expect(captured[0].args).toContain('plan')
    expect(captured[0].cwd).toBe('/tmp/ws')

    const kinds = runPort.events.map((event) => event.type)
    expect(kinds).toContain('run.started')
    expect(kinds).toContain('run.content')
    expect(kinds).toContain('run.tool')

    const toolEvents = runPort.events.filter((event) => event.type === 'run.tool')
    expect(toolEvents.map((event) => event.phase)).toEqual(['started', 'finished'])
    expect(toolEvents[1].status).toBe('success')

    expect(runPort.transcripts.map((entry) => entry.role)).toEqual(['user', 'assistant'])
    expect(runPort.transcripts[1].text).toContain('Hello')

    expect(runPort.finish?.status).toBe('completed')
    expect(runPort.finish?.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5
    })
    expect(runPort.finish?.providerSessionId).toBe('session-9')
    expect(runPort.updates.map((entry) => entry.phase)).toContain('streaming')
  })

  it('fails the run when the provider reports an error result', async () => {
    const runPort = new FakeRunPort()
    const { spawn } = scriptedSpawn({
      stdout: [
        `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'session-9' })}\n`
      ],
      exitCode: 1
    })
    const result = await providerWith(runPort, spawn).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })
    expect(result.status).toBe('failed')
    expect(runPort.finish?.status).toBe('failed')
    expect(runPort.finish?.errorCode).toBe('provider_failed')
  })

  it('records stderr as a bounded warning summary rather than transcript text', async () => {
    const runPort = new FakeRunPort()
    const { spawn } = scriptedSpawn({
      stdout: SUCCESS_STREAM,
      stderr: ['some noise', 'more noise'],
      exitCode: 0
    })
    await providerWith(runPort, spawn).run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })
    expect(runPort.finish?.warningSummaries).toEqual(['Claude reported stderr during the run.'])
    expect(runPort.transcripts.some((entry) => entry.text.includes('some noise'))).toBe(false)
  })

  it('reports setup failure without launching when the binary is missing', async () => {
    const runPort = new FakeRunPort()
    const { spawn, captured } = scriptedSpawn({ stdout: SUCCESS_STREAM })
    const provider = providerWith(
      runPort,
      spawn,
      resourcePort({
        resolveBinary: async () => ({ binaryPath: null, source: 'missing' as const })
      })
    )

    const result = await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })

    expect(result.status).toBe('failed')
    expect(captured).toHaveLength(0)
    expect(runPort.finish?.errorCode).toBe('provider_setup_unavailable')
    expect(runPort.transcripts.some((entry) => entry.role === 'system')).toBe(true)
  })

  it('cancels only the exact run id and reports cancelled', async () => {
    const runPort = new FakeRunPort()
    const killed: string[] = []
    let provider: HostNodeClaudeProvider | undefined
    const spawn: HostNodeClaudeSpawn = (input) => {
      // Cancel mid-stream, exactly as an out-of-band run.cancel would.
      expect(provider?.cancel('a-different-run')).toBe(false)
      expect(provider?.cancel('run-1')).toBe(true)
      for (const chunk of SUCCESS_STREAM) input.onStdout(chunk)
      return {
        kill: (signal) => killed.push(String(signal)),
        exit: Promise.resolve({ code: 0, signal: null })
      }
    }
    provider = providerWith(runPort, spawn)

    const result = await provider.run({
      runId: 'run-1',
      threadId: 'thread-1',
      prompt: 'hi',
      target: TARGET
    })

    expect(result.status).toBe('cancelled')
    expect(runPort.finish?.status).toBe('cancelled')
    expect(killed).toContain('SIGTERM')
    expect(runPort.updates.map((entry) => entry.phase)).toContain('cancelling')
  })

  it('clears cancellation registration so the same run id can be reused', async () => {
    const runPort = new FakeRunPort()
    const provider = providerWith(runPort, scriptedSpawn({ stdout: SUCCESS_STREAM }).spawn)
    const request = { runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET }

    await provider.run(request)
    expect(runPort.cleared).toEqual(['run-1'])
    // A stale active-run entry would make the second call throw duplicate.
    await expect(provider.run(request)).resolves.toMatchObject({ status: 'completed' })
    expect(runPort.cleared).toEqual(['run-1', 'run-1'])
    // Cancelling a finished run is a no-op, not a throw.
    expect(provider.cancel('run-1')).toBe(false)
  })

  it('shuts down without leaving an active run behind', async () => {
    const provider = providerWith(
      new FakeRunPort(),
      scriptedSpawn({ stdout: SUCCESS_STREAM }).spawn
    )
    await provider.run({ runId: 'run-1', threadId: 'thread-1', prompt: 'hi', target: TARGET })
    await expect(provider.shutdown()).resolves.toBeUndefined()
  })
})

describe('HostNodeClaudeProvider factory', () => {
  it('exposes catalog offers and advertises no unresumable interactions', () => {
    const factory = createHostNodeClaudeProviderFactory()
    expect(factory.providerId).toBe('claude')
    expect(factory.offers.providerId).toBe('claude')
    expect(factory.offers.models.length).toBeGreaterThan(0)
    // The blocker is the CLI transport, not the resolver: `register` is
    // awaitable (see the C1 note below) and Codex consumes it. Headless `-p`
    // simply never produces an approval request to resume. Advertising either
    // flag here would make the domain's derived capabilities dishonest.
    expect(factory.supportsApprovals).toBe(false)
    // Headless `-p` stream-json has no stdin protocol and no
    // `--permission-prompt-tool` (`canUseTool` is SDK-only). There is no
    // question event source; do not flip supportsQuestions without one.
    expect(factory.supportsQuestions).toBe(false)
  })

  it('creates an instance bound to the injected run port', () => {
    const runPort = new FakeRunPort()
    const instance = createHostNodeClaudeProviderFactory({
      resources: resourcePort(),
      spawn: scriptedSpawn({}).spawn
      // C1 made register() awaitable. A stub must return a promise that never
      // settles: this adapter registers nothing, and a resolved/rejected stub
      // would either fake a settlement or raise an unhandled rejection.
    }).create({ runPort, interactions: { register: () => new Promise<never>(() => {}) } })
    expect(instance.providerId).toBe('claude')
  })

  it('refuses offers belonging to another provider', () => {
    const cursorOffers = hostProviderOffers('cursor', true)!
    expect(() => createHostNodeClaudeProviderFactory({ offers: cursorOffers })).toThrow()
  })

  it('passes an injected launcher through so detached Hosts stay flow-silent by default', async () => {
    const launcher = { launchForProvider: vi.fn(async () => undefined) }
    const withLauncher = createHostNodeClaudeProviderFactory({
      resources: resourcePort({ getAuthState: async () => 'unauthenticated' as const }),
      terminalLauncher: launcher
    }).create({
      runPort: new FakeRunPort(),
      interactions: { register: () => new Promise<never>(() => {}) }
    })
    expect(await withLauncher.getAuthFlows()).toEqual([
      expect.objectContaining({ flowId: 'claude:login' })
    ])

    const detached = createHostNodeClaudeProviderFactory({
      resources: resourcePort({ getAuthState: async () => 'unauthenticated' as const })
    }).create({
      runPort: new FakeRunPort(),
      interactions: { register: () => new Promise<never>(() => {}) }
    })
    expect(await detached.getAuthFlows()).toEqual([])
  })
})
