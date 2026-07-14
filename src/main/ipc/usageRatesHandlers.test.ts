import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerUsageRatesHandlers,
  type UsageRatesSenderScope
} from './usageRatesHandlers'

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
      resolveSenderUsageScope: vi.fn(
        (_event: unknown): UsageRatesSenderScope => ({ kind: 'main' })
      ),
      assertMainRendererSender: vi.fn(),
      globalUsageWorkspaceId: '__taskwraith_global_chats__',
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
      getCurrentFxRates: vi.fn(() => ({ rates: { USD: 1 }, source: 'live' })),
      refreshFxRates: vi.fn(async (force: boolean) => ({ refreshed: force })),
      getCurrentProviderRates: vi.fn(() => ({ codex: { inputUsdPer1M: 10 } })),
      probeAllProviderRates: vi.fn(async () => ({ probe: 'ok' })),
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
    expect(handlerFor('fx-rates:get')).toBeTypeOf('function')
    expect(handlerFor('fx-rates:refresh')).toBeTypeOf('function')
    expect(handlerFor('providerRates:get')).toBeTypeOf('function')
    expect(handlerFor('providerRates:probe')).toBeTypeOf('function')
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

  it('forces popout usage reads to the durable owning chat and workspace', () => {
    const { deps } = createDeps()
    deps.resolveSenderUsageScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-test-1',
      chatScope: 'workspace',
      workspaceId: 'test-1'
    })
    deps.getUsage.mockReturnValue([{ value: 'owned' }])
    registerUsageRatesHandlers(deps)

    expect(handlerFor('get-usage')({})).toEqual([{ value: 'owned' }])
    expect(deps.getUsage).toHaveBeenCalledWith('test-1', 'chat-test-1')

    expect(handlerFor('get-usage')({}, 'test-1', 'chat-test-1')).toEqual([{ value: 'owned' }])
  })

  it('rejects Test 1 popout usage reads that name Test 3', () => {
    const { deps } = createDeps()
    deps.resolveSenderUsageScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-test-1',
      chatScope: 'workspace',
      workspaceId: 'test-1'
    })
    registerUsageRatesHandlers(deps)

    expect(() => handlerFor('get-usage')({}, 'test-3', 'chat-test-1')).toThrow(
      'Renderer cannot access usage for another workspace.'
    )
    expect(deps.getUsage).not.toHaveBeenCalled()
  })

  it('rejects popout usage reads for another chat in the same workspace', () => {
    const { deps } = createDeps()
    deps.resolveSenderUsageScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-owned',
      chatScope: 'workspace',
      workspaceId: 'test-1'
    })
    registerUsageRatesHandlers(deps)

    expect(() => handlerFor('get-usage')({}, 'test-1', 'chat-other')).toThrow(
      'Renderer cannot access usage for another chat.'
    )
    expect(deps.getUsage).not.toHaveBeenCalled()
  })

  it('rejects forged popout usage records before store writes or notifications', () => {
    const { deps } = createDeps()
    deps.resolveSenderUsageScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-owned',
      chatScope: 'workspace',
      workspaceId: 'test-1'
    })
    registerUsageRatesHandlers(deps)
    const ownedUsage = {
      workspaceId: 'test-1',
      chatId: 'chat-owned',
      runId: 'run-1',
      model: 'gpt-5.6-terra',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationMs: 100
    }

    expect(handlerFor('record-usage')({}, ownedUsage)).toBeUndefined()
    expect(deps.recordUsage).toHaveBeenCalledWith(ownedUsage)

    deps.recordUsage.mockClear()
    deps.onUsageChanged.mockClear()
    expect(() => handlerFor('record-usage')({}, { ...ownedUsage, workspaceId: 'test-3' })).toThrow(
      'Renderer cannot record usage for another workspace.'
    )
    expect(() => handlerFor('record-usage')({}, { ...ownedUsage, chatId: 'chat-other' })).toThrow(
      'Renderer cannot record usage for another chat.'
    )
    expect(deps.recordUsage).not.toHaveBeenCalled()
    expect(deps.onUsageChanged).not.toHaveBeenCalled()
  })

  it('keeps global popouts out of real workspace usage while accepting the global ledger key', () => {
    const { deps } = createDeps()
    deps.resolveSenderUsageScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-global',
      chatScope: 'global'
    })
    registerUsageRatesHandlers(deps)
    const globalUsage = {
      workspaceId: '__taskwraith_global_chats__',
      chatId: 'chat-global',
      runId: 'run-global',
      model: 'grok-4.5-fast',
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      durationMs: 20
    }

    expect(handlerFor('get-usage')({})).toEqual([])
    expect(deps.getUsage).toHaveBeenCalledWith(undefined, 'chat-global')
    expect(() => handlerFor('get-usage')({}, 'test-1', 'chat-global')).toThrow(
      'Global chat renderers cannot read workspace usage.'
    )
    expect(handlerFor('record-usage')({}, globalUsage)).toBeUndefined()
    expect(() => handlerFor('record-usage')({}, { ...globalUsage, workspaceId: 'test-1' })).toThrow(
      'Renderer cannot record usage for another workspace.'
    )
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

  it('keeps external provider history main-only', async () => {
    const { deps } = createDeps()
    deps.assertMainRendererSender.mockImplementation(() => {
      throw new Error('Only the main renderer can read external usage history.')
    })
    registerUsageRatesHandlers(deps)

    expect(() => handlerFor('get-external-usage')({}, { force: true })).toThrow(
      'Only the main renderer can read external usage history.'
    )
    expect(deps.getExternalUsageCached).not.toHaveBeenCalled()
  })

  it('proxies FX rate and provider rate handlers with the current coercion behavior', async () => {
    const { deps } = createDeps()
    registerUsageRatesHandlers(deps)

    expect(handlerFor('fx-rates:get')({})).toEqual({ rates: { USD: 1 }, source: 'live' })
    expect(deps.getCurrentFxRates).toHaveBeenCalledOnce()

    await expect(handlerFor('fx-rates:refresh')({}, true)).resolves.toEqual({ refreshed: true })
    expect(deps.refreshFxRates).toHaveBeenCalledWith(true)

    await expect(
      handlerFor('fx-rates:refresh')({}, undefined as unknown as boolean)
    ).resolves.toEqual({ refreshed: false })
    expect(deps.refreshFxRates).toHaveBeenLastCalledWith(false)

    await expect(handlerFor('fx-rates:refresh')({}, 1 as unknown as boolean)).resolves.toEqual({
      refreshed: true
    })
    expect(deps.refreshFxRates).toHaveBeenLastCalledWith(true)

    expect(handlerFor('providerRates:get')({})).toEqual({ codex: { inputUsdPer1M: 10 } })
    expect(deps.getCurrentProviderRates).toHaveBeenCalledOnce()

    await expect(handlerFor('providerRates:probe')({})).resolves.toEqual({ probe: 'ok' })
    expect(deps.probeAllProviderRates).toHaveBeenCalledOnce()
    expect(deps.assertMainRendererSender).not.toHaveBeenCalled()
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
