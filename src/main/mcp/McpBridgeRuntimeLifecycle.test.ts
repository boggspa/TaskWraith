import { mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  brokerRequest,
  GeminiMcpBridgePreparationAbortedError,
  McpBridgeRuntime
} from './McpBridgeRuntime'

const TEST_INSTANCE_EPOCH = 'f'.repeat(32)

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function preparationError(preparing: Promise<unknown>) {
  const error = await preparing.catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(GeminiMcpBridgePreparationAbortedError)
  return error as GeminiMcpBridgePreparationAbortedError
}

describe('McpBridgeRuntime broker lifecycle', () => {
  it('stops run-scoped Gemini preparation after cancellation crosses a broker await', async () => {
    const brokerStarted = deferred<void>()
    const installGeminiToolContextForRun = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      installGeminiToolContextForRun
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockReturnValue(brokerStarted.promise)
    const repair = vi.spyOn(runtime, 'repairGeminiMcpBridge')
    const controller = new AbortController()

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      { appRunId: 'run-1' },
      'workspace',
      false,
      {
        setupSignal: controller.signal,
        isRunAuthorized: () => !controller.signal.aborted
      }
    )
    controller.abort()
    brokerStarted.resolve()

    const error = await preparationError(preparing)
    expect(error.receipt).toEqual({
      kind: 'run-authority-revoked',
      boundary: 'broker-start',
      sharedBridgeState: 'retained-for-other-runs',
      runContextCleanup: 'not-required'
    })
    expect(repair).not.toHaveBeenCalled()
    expect(installGeminiToolContextForRun).not.toHaveBeenCalled()
  })

  it('checks full run authority after repair before starting the status probe', async () => {
    const repairFinished = deferred<never>()
    const installGeminiToolContextForRun = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      installGeminiToolContextForRun
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockResolvedValue()
    const repair = vi
      .spyOn(runtime, 'repairGeminiMcpBridge')
      .mockReturnValue(repairFinished.promise)
    const status = vi.spyOn(runtime, 'getGeminiMcpBridgeStatus')
    let authorized = true

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      { appRunId: 'run-repair' },
      'workspace',
      false,
      { isRunAuthorized: () => authorized }
    )
    await vi.waitFor(() => expect(repair).toHaveBeenCalledOnce())
    authorized = false
    repairFinished.resolve({ available: true } as never)

    const error = await preparationError(preparing)
    expect(error.receipt.boundary).toBe('bridge-repair')
    expect(status).not.toHaveBeenCalled()
    expect(installGeminiToolContextForRun).not.toHaveBeenCalled()
  })

  it('checks cancellation after status before starting a write-tool self-test', async () => {
    const statusFinished = deferred<never>()
    const installGeminiToolContextForRun = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      installGeminiToolContextForRun
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockResolvedValue()
    vi.spyOn(runtime, 'repairGeminiMcpBridge').mockResolvedValue({
      available: true
    } as never)
    const status = vi
      .spyOn(runtime, 'getGeminiMcpBridgeStatus')
      .mockReturnValue(statusFinished.promise)
    const selfTest = vi.spyOn(runtime, 'selfTestGeminiMcpBridgeProcess')
    const controller = new AbortController()

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      { appRunId: 'run-status' },
      'workspace',
      false,
      {
        requireWriteTools: true,
        setupSignal: controller.signal
      }
    )
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce())
    controller.abort()
    statusFinished.resolve({ available: true } as never)

    const error = await preparationError(preparing)
    expect(error.receipt.boundary).toBe('bridge-status')
    expect(selfTest).not.toHaveBeenCalled()
    expect(installGeminiToolContextForRun).not.toHaveBeenCalled()
  })

  it('checks cancellation after the write-tool self-test before installing run context', async () => {
    const selfTestFinished = deferred<{ ok: boolean }>()
    const installGeminiToolContextForRun = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      getGeminiMcpSocketPath: () => '/tmp/taskwraith-gemini.sock',
      installGeminiToolContextForRun
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockResolvedValue()
    vi.spyOn(runtime, 'repairGeminiMcpBridge').mockResolvedValue({
      available: true
    } as never)
    vi.spyOn(runtime, 'getGeminiMcpBridgeStatus').mockResolvedValue({
      available: true
    } as never)
    const selfTest = vi
      .spyOn(runtime, 'selfTestGeminiMcpBridgeProcess')
      .mockReturnValue(selfTestFinished.promise)
    const controller = new AbortController()

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      { appRunId: 'run-self-test' },
      'workspace',
      false,
      {
        requireWriteTools: true,
        setupSignal: controller.signal
      }
    )
    await vi.waitFor(() => expect(selfTest).toHaveBeenCalledOnce())
    controller.abort()
    selfTestFinished.resolve({ ok: true })

    const error = await preparationError(preparing)
    expect(error.receipt.boundary).toBe('bridge-self-test')
    expect(installGeminiToolContextForRun).not.toHaveBeenCalled()
  })

  it('cleans up the exact run context when cancellation crosses its install await', async () => {
    const contextInstalled = deferred<never>()
    const installGeminiToolContextForRun = vi.fn(() => contextInstalled.promise)
    const cleanupInstalledRunContextOnRevocation = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      installGeminiToolContextForRun
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockResolvedValue()
    vi.spyOn(runtime, 'repairGeminiMcpBridge').mockResolvedValue({
      available: true
    } as never)
    vi.spyOn(runtime, 'getGeminiMcpBridgeStatus').mockResolvedValue({
      available: true
    } as never)
    const closeBroker = vi.spyOn(runtime, 'closeGeminiMcpBroker')
    const controller = new AbortController()
    const route = { appRunId: 'run-install', appChatId: 'chat-install' }

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      route,
      'workspace',
      false,
      {
        setupSignal: controller.signal,
        cleanupInstalledRunContextOnRevocation
      }
    )
    await vi.waitFor(() => expect(installGeminiToolContextForRun).toHaveBeenCalledOnce())
    controller.abort()
    contextInstalled.resolve(route as never)

    const error = await preparationError(preparing)
    expect(error.receipt).toEqual({
      kind: 'run-authority-revoked',
      boundary: 'run-context-install',
      sharedBridgeState: 'retained-for-other-runs',
      runContextCleanup: 'completed'
    })
    expect(cleanupInstalledRunContextOnRevocation).toHaveBeenCalledOnce()
    expect(cleanupInstalledRunContextOnRevocation).toHaveBeenCalledWith(
      expect.objectContaining(route)
    )
    expect(closeBroker).not.toHaveBeenCalled()
  })

  it('attempts exact cleanup when a context install rejects after authority was revoked', async () => {
    const contextInstalled = deferred<never>()
    const cleanupInstalledRunContextOnRevocation = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: false }),
      installGeminiToolContextForRun: () => contextInstalled.promise
    } as never)
    let authorized = true

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      { appRunId: 'run-install-reject', appChatId: 'chat-install-reject' },
      'workspace',
      false,
      {
        isRunAuthorized: () => authorized,
        cleanupInstalledRunContextOnRevocation
      }
    )
    authorized = false
    contextInstalled.reject(new Error('install failed after stop'))

    const error = await preparationError(preparing)
    expect(error.receipt.runContextCleanup).toBe('completed')
    expect(cleanupInstalledRunContextOnRevocation).toHaveBeenCalledOnce()
  })

  it('fences the settings mutation when authority changes during the warning projection', async () => {
    let authorized = true
    const updateSettings = vi.fn()
    const sendAgentCompatLine = vi.fn(() => {
      authorized = false
    })
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: false }),
      updateSettings,
      sendAgentCompatLine,
      installGeminiToolContextForRun: vi.fn()
    } as never)

    const preparing = runtime.prepareGeminiMcpBridgeForRun(
      {} as never,
      '/workspace',
      { appRunId: 'run-warning' },
      'workspace',
      false,
      {
        requireWriteTools: true,
        isRunAuthorized: () => authorized
      }
    )

    const error = await preparationError(preparing)
    expect(error.receipt.boundary).toBe('bridge-enable-warning')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'rebinds when the stored server is listening but its Unix socket path disappeared',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'taskwraith-mcp-lifecycle-'))
      const socketPath = join(directory, 'broker.sock')
      const executeGeminiMcpTool = vi.fn(async () => ({ text: 'rebound' }))
      const runtime = new McpBridgeRuntime({
        getGeminiMcpSocketPath: () => socketPath,
        getGeminiMcpBrokerToken: () => 'token-1',
        getInstanceEpoch: () => TEST_INSTANCE_EPOCH,
        executeGeminiMcpTool
      } as never)

      try {
        await runtime.startGeminiMcpBroker()
        expect((await stat(socketPath)).isSocket()).toBe(true)

        // Reproduce the production failure: the NetServer still reports itself
        // as listening after another lifecycle path unlinks its pathname.
        await unlink(socketPath)
        await runtime.startGeminiMcpBroker()

        expect((await stat(socketPath)).isSocket()).toBe(true)
        await expect(
          brokerRequest(socketPath, {
            token: 'token-1',
            instanceEpoch: TEST_INSTANCE_EPOCH,
            tool: 'read_file',
            arguments: { path: 'README.md' },
            parentProvider: 'kimi'
          })
        ).resolves.toMatchObject({ ok: true, text: 'rebound' })
        expect(executeGeminiMcpTool).toHaveBeenCalledOnce()
      } finally {
        runtime.closeGeminiMcpBroker()
        await new Promise((resolve) => setImmediate(resolve))
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports an in-flight broker request when its client transport disconnects',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'taskwraith-mcp-abandonment-'))
      const socketPath = join(directory, 'broker.sock')
      const execution = deferred<{ text: string }>()
      const executeGeminiMcpTool = vi.fn(() => execution.promise)
      const onBrokerRequestAbandoned = vi.fn()
      const runtime = new McpBridgeRuntime({
        getGeminiMcpSocketPath: () => socketPath,
        getGeminiMcpBrokerToken: () => 'token-1',
        getInstanceEpoch: () => TEST_INSTANCE_EPOCH,
        executeGeminiMcpTool,
        onBrokerRequestAbandoned
      } as never)

      try {
        await runtime.startGeminiMcpBroker()
        const request = {
          id: 759,
          token: 'token-1',
          instanceEpoch: TEST_INSTANCE_EPOCH,
          tool: 'run_shell_command',
          arguments: { command: 'long-command' },
          appRunId: 'run-abandoned',
          appChatId: 'chat-abandoned',
          parentProvider: 'kimi'
        }
        const socket = createConnection(socketPath)
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('error', reject)
        })
        socket.write(`${JSON.stringify(request)}\n`)
        await vi.waitFor(() => expect(executeGeminiMcpTool).toHaveBeenCalledOnce())
        socket.destroy()

        await vi.waitFor(() =>
          expect(onBrokerRequestAbandoned).toHaveBeenCalledWith(
            expect.objectContaining({ id: 759, appRunId: 'run-abandoned' }),
            'client-disconnected'
          )
        )
        execution.resolve({ text: 'late result' })
      } finally {
        runtime.closeGeminiMcpBroker()
        await new Promise((resolve) => setImmediate(resolve))
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
})
