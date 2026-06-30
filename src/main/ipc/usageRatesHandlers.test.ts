import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerUsageRatesHandlers } from './usageRatesHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown
type UsageCallback = (() => void) | null

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  let usageRollupCallback: UsageCallback = null
  let usageModelCallback: UsageCallback = null
  let firstLaunchCallback: UsageCallback = null

  return {
    deps: {
      recordUsage: vi.fn(),
      getUsage: vi.fn(() => [] as any[]),
      getExternalUsageCached: vi.fn(async () => [] as any[]),
      onUsageChanged: vi.fn(),
      getChats: vi.fn(() => [] as any[]),
      getWorkspaces: vi.fn(() => [] as any[]),
      getSettings: vi.fn(() => ({ dashboardStatPrefs: { resetAt: 0 } }) as any),
      evaluateRemoteCapability: vi.fn(() => true),
      canonicalRemoteWorkspaceId: vi.fn(
        (workspaceId: string | null | undefined) => workspaceId ?? null
      ),
      broadcastUsageRollup: vi.fn(),
      broadcastWelcomeDashboard: vi.fn(),
      hasRemoteBroadcaster: vi.fn(() => true),
      broadcastModelUsage: vi.fn(),
      broadcastFirstLaunchState: vi.fn(),
      fetchCodexUsageSnapshot: vi.fn(async (): Promise<any> => null),
      fetchClaudeUsageSnapshot: vi.fn(async (): Promise<any> => null),
      fetchKimiUsageSnapshot: vi.fn(async (): Promise<any> => null),
      fetchCursorUsageSnapshot: vi.fn(async (): Promise<any> => null),
      getProviderCapabilityContract: vi.fn(async () => null as any),
      registerRemoteUsageRollupTrigger: vi.fn((cb: () => void) => {
        usageRollupCallback = cb
      }),
      registerRemoteModelUsageTrigger: vi.fn((cb: () => void) => {
        usageModelCallback = cb
      }),
      registerRemoteFirstLaunchStateTrigger: vi.fn((cb: () => void) => {
        firstLaunchCallback = cb
      })
    },
    callbacks: {
      triggerUsageRollup: () => {
        if (usageRollupCallback) usageRollupCallback()
      },
      triggerUsageModel: () => {
        if (usageModelCallback) usageModelCallback()
      },
      triggerFirstLaunch: () => {
        if (firstLaunchCallback) firstLaunchCallback()
      }
    }
  }
}

function flushAsyncTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('registerUsageRatesHandlers', () => {
  it('registers usage handlers and remote trigger registrations', () => {
    const { deps } = createDeps()
    registerUsageRatesHandlers(deps)

    expect(handlerFor('record-usage')).toBeTypeOf('function')
    expect(handlerFor('get-usage')).toBeTypeOf('function')
    expect(handlerFor('get-external-usage')).toBeTypeOf('function')
    expect(deps.registerRemoteUsageRollupTrigger).toHaveBeenCalledOnce()
    expect(deps.registerRemoteModelUsageTrigger).toHaveBeenCalledOnce()
    expect(deps.registerRemoteFirstLaunchStateTrigger).toHaveBeenCalledOnce()
  })

  it('forwards record usage and triggers local usage-changed notifications', () => {
    const { deps } = createDeps()
    registerUsageRatesHandlers(deps)
    const usage = { provider: 'codex', tokens: 123 }

    deps.recordUsage.mockReturnValue(usage)
    expect(handlerFor('record-usage')({}, usage)).toBe(usage)

    expect(deps.recordUsage).toHaveBeenCalledWith(usage)
    expect(deps.onUsageChanged).toHaveBeenCalledTimes(1)
  })

  it('proxies usage reads to store-backed dependencies', async () => {
    const { deps } = createDeps()
    registerUsageRatesHandlers(deps)
    deps.getUsage.mockReturnValue([{ value: 1 }])
    deps.getExternalUsageCached.mockResolvedValue([{ value: 'external' }])

    expect(handlerFor('get-usage')({}, 'ws-1', 'chat-1')).toEqual([{ value: 1 }])
    expect(deps.getUsage).toHaveBeenCalledWith('ws-1', 'chat-1')

    const externalUsage = await handlerFor('get-external-usage')({}, { force: true })
    expect(externalUsage).toEqual([{ value: 'external' }])
    expect(deps.getExternalUsageCached).toHaveBeenCalledWith({ maxAgeMs: 0 })
  })

  it('triggers remote usage rollup and welcome dashboard broadcasts', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)

    deps.getExternalUsageCached.mockResolvedValue([{ source: 'provider' }])
    deps.getUsage.mockReturnValue([{ value: 1 }])

    callbacks.triggerUsageRollup()
    await Promise.resolve()

    expect(deps.broadcastUsageRollup).toHaveBeenCalledTimes(1)
    expect(deps.broadcastWelcomeDashboard).toHaveBeenCalledTimes(1)
  })

  it('triggers remote model usage broadcasts', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)

    deps.fetchCodexUsageSnapshot.mockResolvedValue({
      windows: [{ id: '1', label: 'main', usedPercent: 42 }]
    })
    deps.fetchClaudeUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchKimiUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchCursorUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.getChats.mockReturnValue([{ workspaceId: 'ws-1', runs: [{ status: 'running' }] }])

    callbacks.triggerUsageModel()
    await flushAsyncTasks()

    expect(deps.broadcastModelUsage).toHaveBeenCalledTimes(1)
  })
})
