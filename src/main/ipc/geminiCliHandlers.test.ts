import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerGeminiCliHandlers, type GeminiCliHandlersDeps } from './geminiCliHandlers'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const spawnMock = vi.hoisted(() => vi.fn())
const resolveCliProviderBinaryMock = vi.hoisted(() => vi.fn())
const createCliEnvMock = vi.hoisted(() => vi.fn(() => ({ PATH: '/usr/bin' })))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('../providers/CliProviderRuntime', () => ({
  resolveCliProviderBinary: resolveCliProviderBinaryMock,
  createCliEnv: createCliEnvMock
}))

vi.mock('../geminiCapabilityTypes', () => ({
  GEMINI_CAPABILITY_KINDS: ['commands', 'memory']
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
  spawnMock.mockReset()
  resolveCliProviderBinaryMock.mockReset()
  createCliEnvMock.mockClear()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

const EVENT = { sender: { id: 1 } }

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

/** Minimal EventEmitter-ish child process the version probe drives. */
function fakeProc(): {
  proc: Record<string, unknown>
  emit: (event: string, payload?: unknown) => void
  emitStdout: (chunk: string) => void
  attached: () => boolean
} {
  const listeners = new Map<string, (payload?: unknown) => void>()
  const stdoutListeners = new Map<string, (payload?: unknown) => void>()
  const proc = {
    stdout: {
      on: (event: string, cb: (payload?: unknown) => void) => {
        stdoutListeners.set(event, cb)
      }
    },
    on: (event: string, cb: (payload?: unknown) => void) => {
      listeners.set(event, cb)
    }
  }
  return {
    proc,
    emit: (event, payload) => listeners.get(event)?.(payload),
    emitStdout: (chunk) => stdoutListeners.get('data')?.(Buffer.from(chunk)),
    attached: () => listeners.has('close')
  }
}

/**
 * The handler awaits binary resolution before spawning, so the probe's
 * listeners are attached a microtask later. Emitting before then would
 * silently hit an empty listener map and hang the test rather than the code.
 */
async function startVersionProbe(): Promise<{
  child: ReturnType<typeof fakeProc>
  pending: unknown
}> {
  const child = fakeProc()
  spawnMock.mockReturnValue(child.proc)
  const pending = handlerFor('get-gemini-version')(EVENT)
  await vi.waitFor(() => expect(child.attached()).toBe(true))
  return { child, pending }
}

function createDeps(overrides: Partial<GeminiCliHandlersDeps> = {}) {
  const deps: GeminiCliHandlersDeps = {
    assertMainRendererSender: vi.fn(),
    resolveCapabilityWorkspace: vi.fn(async (workspace?: string) => workspace),
    repairKnownStaleGeminiMcpBridgeConfigs: vi.fn(async () => undefined),
    readGeminiCapabilitySection: vi.fn(async (kind) => ({ kind }) as never),
    getGeminiMcpBridgeStatus: vi.fn(async () => ({ installed: true }) as never),
    installGeminiMcpBridge: vi.fn(async () => ({ installed: true }) as never),
    setGeminiMcpBridgeEnabled: vi.fn(async () => ({ enabled: true }) as never),
    listGeminiSessions: vi.fn(async () => ({ sessions: [] }) as never),
    ...overrides
  }
  return deps
}

describe('registerGeminiCliHandlers', () => {
  it('registers every Gemini CLI channel once, in composition-root order', () => {
    registerGeminiCliHandlers(createDeps())

    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'get-gemini-version',
      'get-gemini-capabilities',
      'get-gemini-mcp-bridge-status',
      'install-gemini-mcp-bridge',
      'set-gemini-mcp-bridge-enabled',
      'list-gemini-sessions'
    ])
  })

  it('reports an unknown version without spawning when no binary resolves', async () => {
    resolveCliProviderBinaryMock.mockResolvedValue({ binaryPath: null })
    registerGeminiCliHandlers(createDeps())

    await expect(handlerFor('get-gemini-version')(EVENT)).resolves.toBe('unknown')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns the resolved binary without a shell and trims its version output', async () => {
    resolveCliProviderBinaryMock.mockResolvedValue({ binaryPath: '/opt/gemini' })
    registerGeminiCliHandlers(createDeps())

    const { child, pending } = await startVersionProbe()
    child.emitStdout('  0.4.2\n')
    child.emit('close', 0)

    await expect(pending).resolves.toBe('0.4.2')
    expect(spawnMock).toHaveBeenCalledWith(
      '/opt/gemini',
      ['--version'],
      expect.objectContaining({ shell: false })
    )
    expect(createCliEnvMock).toHaveBeenCalledWith(
      { FORCE_COLOR: '0', NO_COLOR: '1' },
      '/opt/gemini'
    )
  })

  it('falls back to unknown on a non-zero exit, empty output, or spawn error', async () => {
    resolveCliProviderBinaryMock.mockResolvedValue({ binaryPath: '/opt/gemini' })
    registerGeminiCliHandlers(createDeps())

    const nonZero = await startVersionProbe()
    nonZero.child.emitStdout('0.4.2')
    nonZero.child.emit('close', 1)
    await expect(nonZero.pending).resolves.toBe('unknown')

    const empty = await startVersionProbe()
    empty.child.emit('close', 0)
    await expect(empty.pending).resolves.toBe('unknown')

    const failed = await startVersionProbe()
    failed.child.emit('error', new Error('ENOENT'))
    await expect(failed.pending).resolves.toBe('unknown')
  })

  it('requires main-renderer authority on every privileged Gemini channel', async () => {
    const deps = createDeps()
    vi.mocked(deps.assertMainRendererSender).mockImplementation(() => {
      throw new Error('Only the main renderer can manage workspace authority.')
    })
    registerGeminiCliHandlers(deps)

    for (const channel of [
      'get-gemini-capabilities',
      'install-gemini-mcp-bridge',
      'set-gemini-mcp-bridge-enabled',
      'list-gemini-sessions'
    ]) {
      await expect(handlerFor(channel)(EVENT, 'arg')).rejects.toThrow(
        'Only the main renderer can manage workspace authority.'
      )
    }

    expect(deps.resolveCapabilityWorkspace).not.toHaveBeenCalled()
    expect(deps.installGeminiMcpBridge).not.toHaveBeenCalled()
    expect(deps.setGeminiMcpBridgeEnabled).not.toHaveBeenCalled()
    expect(deps.listGeminiSessions).not.toHaveBeenCalled()
  })

  it('keeps the bridge status probe unauthenticated and auto-repairing', async () => {
    const deps = createDeps()
    registerGeminiCliHandlers(deps)

    await handlerFor('get-gemini-mcp-bridge-status')(EVENT)

    expect(deps.assertMainRendererSender).not.toHaveBeenCalled()
    expect(deps.getGeminiMcpBridgeStatus).toHaveBeenCalledWith({ autoRepairIfEnabled: true })
  })

  it('reads every capability kind against the resolved workspace', async () => {
    const deps = createDeps()
    registerGeminiCliHandlers(deps)

    const state = (await handlerFor('get-gemini-capabilities')(EVENT, '/tmp/ws')) as {
      workspace?: string
      sections: Record<string, unknown>
    }

    expect(deps.resolveCapabilityWorkspace).toHaveBeenCalledWith('/tmp/ws')
    expect(deps.repairKnownStaleGeminiMcpBridgeConfigs).toHaveBeenCalledWith('/tmp/ws')
    expect(deps.readGeminiCapabilitySection).toHaveBeenCalledTimes(2)
    expect(deps.readGeminiCapabilitySection).toHaveBeenCalledWith('commands', '/tmp/ws')
    expect(state.workspace).toBe('/tmp/ws')
    expect(Object.keys(state.sections).sort()).toEqual(['commands', 'memory'])
  })

  it('never fails a capability read because stale-bridge repair threw', async () => {
    const deps = createDeps({
      repairKnownStaleGeminiMcpBridgeConfigs: vi.fn(async () => {
        throw new Error('repair exploded')
      })
    })
    registerGeminiCliHandlers(deps)

    await expect(handlerFor('get-gemini-capabilities')(EVENT, '/tmp/ws')).resolves.toMatchObject({
      workspace: '/tmp/ws'
    })
    expect(deps.readGeminiCapabilitySection).toHaveBeenCalledTimes(2)
  })

  it('coerces the bridge-enabled argument to a boolean', async () => {
    const deps = createDeps()
    registerGeminiCliHandlers(deps)

    await handlerFor('set-gemini-mcp-bridge-enabled')(EVENT, 1)
    expect(deps.setGeminiMcpBridgeEnabled).toHaveBeenCalledWith(true)

    await handlerFor('set-gemini-mcp-bridge-enabled')(EVENT, undefined)
    expect(deps.setGeminiMcpBridgeEnabled).toHaveBeenLastCalledWith(false)
  })

  it('installs the bridge and lists sessions through the injected collaborators', async () => {
    const deps = createDeps()
    registerGeminiCliHandlers(deps)

    await expect(handlerFor('install-gemini-mcp-bridge')(EVENT)).resolves.toEqual({
      installed: true
    })
    expect(deps.installGeminiMcpBridge).toHaveBeenCalledWith()

    await expect(handlerFor('list-gemini-sessions')(EVENT)).resolves.toEqual({ sessions: [] })
  })
})
