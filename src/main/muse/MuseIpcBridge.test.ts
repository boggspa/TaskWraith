import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createChildProcessMuseSpawn,
  defaultMuseAuthJsonPath,
  museExecEventToCompatPayload,
  readDefaultMuseAuthJsonText,
  runMuseProviderFromIpc,
  type MuseIpcBridgeDeps
} from './MuseIpcBridge'
import type { MuseRunOutcome, MuseRunSpawnHandle } from './MuseRun'
import { unavailableMuseMeterSnapshot, museMeterSnapshotToProviderStats } from './MuseUsage'

const temps: string[] = []

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function fakeSpawnHandle(code = 0): MuseRunSpawnHandle {
  return {
    pid: 42,
    kill() {
      // Test double does not own a process.
    },
    onStdout() {
      // This test double does not emit stdout.
    },
    onStderr() {
      // This test double does not emit stderr.
    },
    async wait() {
      return { code, signal: null }
    }
  }
}

function successOutcome(overrides: Partial<MuseRunOutcome> = {}): MuseRunOutcome {
  const meter = unavailableMuseMeterSnapshot('run-muse-1')
  return {
    status: 'success',
    sessionId: 'run-muse-1',
    exitCode: 0,
    assistantText: 'hello muse',
    events: [],
    meter,
    providerStats: museMeterSnapshotToProviderStats(meter),
    warnings: [],
    argv: ['exec', '--json'],
    effort: 'high',
    writeCapable: false,
    skillPinHash: 'a'.repeat(64),
    leasePath: '/tmp/lease',
    ...overrides
  }
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'say hi',
    workspace: '/tmp/muse-ws',
    appRunId: 'run-muse-1',
    appChatId: 'chat-1',
    model: 'muse-spark-1.2',
    approvalMode: 'plan',
    ...overrides
  }
}

function baseDeps(overrides: Partial<MuseIpcBridgeDeps> = {}): MuseIpcBridgeDeps {
  const temporaryRoot = tempDir('muse-ipc-')
  return {
    resolveBinary: async () => ({ binaryPath: '/usr/local/bin/muse', source: 'path' }),
    getTemporaryRoot: () => temporaryRoot,
    spawn: () => fakeSpawnHandle(0),
    sendCompatLine: vi.fn(),
    readAuthJsonText: async () =>
      JSON.stringify({ providers: { meta: { api_key: 'k'.repeat(24) } } }),
    readMetaApiKeyEnv: () => null,
    ...overrides
  }
}

describe('defaultMuseAuthJsonPath', () => {
  it('uses XDG_CONFIG_HOME/muse/auth.json when set', () => {
    expect(defaultMuseAuthJsonPath({ XDG_CONFIG_HOME: '/custom/xdg' }, '/home/user')).toBe(
      join('/custom/xdg', 'muse', 'auth.json')
    )
  })

  it('falls back to ~/.config/muse/auth.json', () => {
    expect(defaultMuseAuthJsonPath({}, '/home/user')).toBe(
      join('/home/user', '.config', 'muse', 'auth.json')
    )
  })
})

describe('museExecEventToCompatPayload', () => {
  it('maps content and terminal events to Pi/Grok-shaped compat lines', () => {
    expect(
      museExecEventToCompatPayload({
        type: 'content',
        payloadType: 'run.output.delta',
        text: 'hello',
        raw: {}
      })
    ).toEqual({ type: 'content', text: 'hello', provider: 'muse' })

    expect(
      museExecEventToCompatPayload({
        type: 'terminal',
        payloadType: 'run.terminal.completed',
        text: 'done',
        terminal: 'completed',
        raw: {}
      })
    ).toEqual({
      type: 'result',
      status: 'success',
      subtype: 'success',
      provider: 'muse'
    })
  })

  it('stamps the requested model onto follow-up lifecycle inits', () => {
    expect(
      museExecEventToCompatPayload(
        {
          type: 'run_started',
          payloadType: 'run.lifecycle.started',
          sessionId: 'sess-1',
          raw: {}
        },
        { model: 'muse-spark-1.2' }
      )
    ).toEqual({
      type: 'init',
      session_id: 'sess-1',
      provider: 'muse',
      timestamp: expect.any(String),
      model: 'muse-spark-1.2'
    })
  })

  it('maps tool_use and tool_result onto Claude/Codex-shaped compat lines', () => {
    expect(
      museExecEventToCompatPayload({
        type: 'tool_use',
        payloadType: 'runtime.session',
        toolId: 'call_write',
        toolName: 'write_file',
        toolInput: { path: 'a.py', content: 'x' },
        raw: {}
      })
    ).toEqual({
      type: 'tool_use',
      provider: 'muse',
      tool_name: 'write_file',
      tool_id: 'call_write',
      id: 'call_write',
      parameters: { path: 'a.py', content: 'x' }
    })

    expect(
      museExecEventToCompatPayload({
        type: 'tool_result',
        payloadType: 'runtime.session',
        toolId: 'call_write',
        toolOutput: 'wrote a.py',
        toolStatus: 'success',
        raw: {}
      })
    ).toEqual({
      type: 'tool_result',
      provider: 'muse',
      tool_id: 'call_write',
      id: 'call_write',
      output: 'wrote a.py',
      content: 'wrote a.py'
    })
  })
})

describe('runMuseProviderFromIpc', () => {
  const event = { sender: { id: 'webcontents-stub' } }

  it('fails closed with a clear error when the Muse binary is missing', async () => {
    const settleSetupFailure = vi.fn()
    const runMuseProvider = vi.fn()
    await runMuseProviderFromIpc(event, basePayload(), {
      ...baseDeps({
        resolveBinary: async () => ({ binaryPath: null, error: 'muse not on PATH' }),
        settleSetupFailure,
        runMuseProvider
      })
    })

    expect(runMuseProvider).not.toHaveBeenCalled()
    expect(settleSetupFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        setupRequired: true,
        message: expect.stringMatching(/muse not on PATH|muse binary|not found|not installed/i)
      })
    )
  })

  it('fails closed telling the user to run muse login when credentials are absent', async () => {
    const settleSetupFailure = vi.fn()
    const runMuseProvider = vi.fn()
    await runMuseProviderFromIpc(event, basePayload(), {
      ...baseDeps({
        readAuthJsonText: async () => null,
        readMetaApiKeyEnv: () => null,
        settleSetupFailure,
        runMuseProvider
      })
    })

    expect(runMuseProvider).not.toHaveBeenCalled()
    expect(settleSetupFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        setupRequired: true,
        message: expect.stringMatching(/muse login/i)
      })
    )
  })

  it('throws when binary is missing and no settleSetupFailure hook is wired', async () => {
    await expect(
      runMuseProviderFromIpc(
        event,
        basePayload(),
        baseDeps({
          resolveBinary: async () => ({ binaryPath: null, error: 'muse not on PATH' }),
          settleSetupFailure: undefined
        })
      )
    ).rejects.toThrow(/muse not on PATH/i)
  })

  it('requires workspace, prompt, and appRunId', async () => {
    await expect(
      runMuseProviderFromIpc(event, basePayload({ workspace: '' }), baseDeps())
    ).rejects.toThrow(/workspace/i)
    await expect(
      runMuseProviderFromIpc(event, basePayload({ prompt: '   ' }), baseDeps())
    ).rejects.toThrow(/prompt/i)
    await expect(
      runMuseProviderFromIpc(event, basePayload({ appRunId: undefined }), baseDeps())
    ).rejects.toThrow(/appRunId|run id/i)
  })

  it('mints a UUID --session-id instead of using TaskWraith appRunId', async () => {
    // Regression: Muse CLI rejects non-UUID --session-id with exit 2 and empty
    // JSONL (~100ms). Bridge used to pass createAppRunId()-shaped appRunId.
    const runMuseProvider = vi.fn<NonNullable<MuseIpcBridgeDeps['runMuseProvider']>>(async () =>
      successOutcome()
    )
    const appRunId = `${Date.now()}-0o0k5nn6qpef`

    await runMuseProviderFromIpc(event, basePayload({ appRunId, providerSessionId: null }), {
      ...baseDeps({
        readAuthJsonText: async () =>
          JSON.stringify({ providers: { meta: { api_key: 'meta-secret' } } }),
        runMuseProvider
      })
    })

    expect(runMuseProvider).toHaveBeenCalledOnce()
    const input = runMuseProvider.mock.calls[0]?.[0] as { sessionId?: string; runId?: string }
    expect(input.runId).toBe(appRunId)
    expect(input.sessionId).not.toBe(appRunId)
    expect(input.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  it('reuses a UUID providerSessionId when one is already present', async () => {
    const runMuseProvider = vi.fn(async () => successOutcome())
    const sessionId = '123e4567-e89b-12d3-a456-426614174000'

    await runMuseProviderFromIpc(event, basePayload({ providerSessionId: sessionId }), {
      ...baseDeps({
        readAuthJsonText: async () =>
          JSON.stringify({ providers: { meta: { api_key: 'meta-secret' } } }),
        runMuseProvider
      })
    })

    expect(runMuseProvider).toHaveBeenCalledWith(expect.objectContaining({ sessionId }))
  })

  it('surfaces muse stderr on a failed synthetic result so Inspect is not blank', async () => {
    const sendCompatLine = vi.fn()
    const runMuseProvider = vi.fn(async () =>
      successOutcome({
        status: 'failed',
        exitCode: 2,
        assistantText: '',
        warnings: [
          'muse stderr: invalid --session-id: 1786386574521-0o0k5nn6qpef\n(expected a UUID, e.g. 123e4567-e89b-12d3-a456-426614174000)'
        ]
      })
    )

    await runMuseProviderFromIpc(event, basePayload(), {
      ...baseDeps({
        sendCompatLine,
        readAuthJsonText: async () =>
          JSON.stringify({ providers: { meta: { api_key: 'meta-secret' } } }),
        runMuseProvider
      })
    })

    expect(sendCompatLine).toHaveBeenCalledWith(
      event.sender,
      expect.objectContaining({
        type: 'result',
        status: 'failed',
        subtype: 'error',
        provider: 'muse',
        result: expect.stringMatching(/invalid --session-id|expected a UUID/i)
      }),
      expect.anything()
    )
  })

  it('calls runMuseProvider with binary, spawn, temporaryRoot, and apiKey from auth.json', async () => {
    const runMuseProvider = vi.fn(async () => successOutcome())
    const spawn = vi.fn(() => fakeSpawnHandle(0))
    const sendCompatLine = vi.fn()
    const finishRun = vi.fn()
    const apiKey = 'meta-secret-from-login'

    const outcome = await runMuseProviderFromIpc(event, basePayload(), {
      ...baseDeps({
        spawn,
        sendCompatLine,
        finishRun,
        readAuthJsonText: async () => JSON.stringify({ providers: { meta: { api_key: apiKey } } }),
        runMuseProvider
      })
    })

    expect(runMuseProvider).toHaveBeenCalledOnce()
    expect(runMuseProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: '/usr/local/bin/muse',
        workspacePath: '/tmp/muse-ws',
        prompt: 'say hi',
        runId: 'run-muse-1',
        apiKey,
        spawn,
        temporaryRoot: expect.any(String)
      })
    )
    expect(outcome).toMatchObject({ status: 'success', assistantText: 'hello muse' })
    expect(sendCompatLine).toHaveBeenCalledWith(
      event.sender,
      expect.objectContaining({ type: 'result', status: 'success', provider: 'muse' }),
      expect.anything()
    )
    expect(finishRun).toHaveBeenCalledWith(
      expect.objectContaining({ appRunId: 'run-muse-1', status: 'completed' })
    )
  })

  it('passes muse login OAuth through as run-local auth.json instead of an API key', async () => {
    const runMuseProvider = vi.fn(async () => successOutcome())
    const authJsonText = JSON.stringify({
      schema_version: 1,
      providers: {
        meta: {
          mechanism: 'oauth',
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          expires_at: 1_900_000_000
        }
      }
    })
    const readAuthJsonText = vi.fn(async () => authJsonText)

    await runMuseProviderFromIpc(event, basePayload(), {
      ...baseDeps({ readAuthJsonText, runMuseProvider })
    })

    expect(readAuthJsonText).toHaveBeenCalledOnce()
    expect(runMuseProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authJsonText
      })
    )
  })

  it('accepts a payload API key without requiring a second credential source', async () => {
    const runMuseProvider = vi.fn(async () => successOutcome())

    await runMuseProviderFromIpc(
      event,
      basePayload({ museApiKey: 'payload-meta-key' }),
      baseDeps({
        readAuthJsonText: async () => null,
        readMetaApiKeyEnv: () => null,
        runMuseProvider
      })
    )

    expect(runMuseProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'payload-meta-key', authJsonText: null })
    )
  })

  it('keeps META_API_KEY precedence over a saved account login', async () => {
    const runMuseProvider = vi.fn(async () => successOutcome({ assistantText: 'ok' }))
    const readAuthJsonText = vi.fn(async () =>
      JSON.stringify({
        providers: { meta: { mechanism: 'oauth', access_token: 'saved-oauth-secret' } }
      })
    )

    await runMuseProviderFromIpc(event, basePayload(), {
      ...baseDeps({
        readAuthJsonText,
        readMetaApiKeyEnv: () => 'env-meta-key',
        runMuseProvider
      })
    })

    expect(runMuseProvider).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'env-meta-key', authJsonText: null })
    )
    expect(readAuthJsonText).not.toHaveBeenCalled()
  })
})

describe('createChildProcessMuseSpawn', () => {
  it('adapts child_process.spawn into a MuseRunSpawnHandle and pipes stdin', async () => {
    const stdoutHandlers: Array<(chunk: Buffer | string) => void> = []
    const closeHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    const stdin = { write: vi.fn(), end: vi.fn() }
    const child = {
      pid: 7,
      stdin,
      stdout: {
        on: vi.fn((event: string, listener: (chunk: Buffer | string) => void) => {
          if (event === 'data') stdoutHandlers.push(listener)
        })
      },
      stderr: {
        on: vi.fn()
      },
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (event === 'close') closeHandlers.push(listener as any)
        if (event === 'error') {
          /* unused */
        }
      }),
      once: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (event === 'close') closeHandlers.push(listener as any)
      }),
      kill: vi.fn()
    }
    const spawnImpl = vi.fn(() => child as any)
    const spawn = createChildProcessMuseSpawn(spawnImpl as any)
    const handle = spawn({
      binaryPath: '/bin/muse',
      argv: ['exec', '--json'],
      cwd: '/ws',
      env: { PATH: '/bin', MUSE_NO_AUTO_UPDATE: '1' },
      stdin: 'secret-key'
    })

    expect(spawnImpl).toHaveBeenCalledWith(
      '/bin/muse',
      ['exec', '--json'],
      expect.objectContaining({ cwd: '/ws', env: expect.objectContaining({ PATH: '/bin' }) })
    )
    expect(stdin.write).toHaveBeenCalledWith('secret-key')
    expect(stdin.end).toHaveBeenCalled()

    const chunks: string[] = []
    handle.onStdout((chunk) => chunks.push(chunk))
    stdoutHandlers[0]?.('hello')
    expect(chunks).toEqual(['hello'])

    const waited = handle.wait()
    closeHandlers[0]?.(0, null)
    await expect(waited).resolves.toEqual({ code: 0, signal: null })
  })
})

describe('readDefaultMuseAuthJsonText', () => {
  it('reads the default muse login auth.json path when present', async () => {
    const root = tempDir('muse-auth-home-')
    mkdirSync(join(root, '.config', 'muse'), { recursive: true })
    const authPath = join(root, '.config', 'muse', 'auth.json')
    writeFileSync(
      authPath,
      JSON.stringify({ providers: { meta: { api_key: 'from-login' } } }),
      'utf8'
    )

    const text = await readDefaultMuseAuthJsonText({ env: {}, home: root })
    expect(text).toContain('from-login')
    expect(defaultMuseAuthJsonPath({}, root)).toBe(authPath)
  })
})
