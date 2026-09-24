import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerUsageRatesHandlers,
  usageRatesChatDepsFromFullRecords,
  type UsageRatesSenderScope
} from './usageRatesHandlers'
import { buildRemoteWelcomeDashboard } from '../WelcomeDashboardRemote'
import {
  emptyMessageActivity,
  messageActivityDayKey,
  messageActivityFromChats,
  type MessageActivityAggregate
} from '../../shared/messageActivityAggregate'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
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
      getChatList: vi.fn(() => [] as any[]),
      getMessageActivity: vi.fn(
        async (): Promise<MessageActivityAggregate> => emptyMessageActivity()
      ),
      /** The full-history getter, deliberately unwired: any broadcast reaching for it goes red. */
      getChats: vi.fn((): never => {
        throw new Error('full-history getChats() must not back a remote broadcast')
      }),
      getWorkspaces: vi.fn(() => [] as any[]),
      getSettings: vi.fn(() => ({ dashboardStatPrefs: { resetAt: 0 } }) as any),
      evaluateRemoteCapability: vi.fn(
        (_input: { workspaceId: string; capability: string }): boolean => true
      ),
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
      fetchAntigravityUsageSnapshot: vi.fn(async (): Promise<any> => null),
      fetchQuotaSnapshotHook: vi.fn(async (): Promise<any[]> => []),
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
    expect(handlerFor('quota-snapshot-hook:get')).toBeTypeOf('function')
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

  it('keeps the long-horizon daily rollup main-only too', async () => {
    // Same reach as external history: it is a global, cross-workspace record of
    // when and how much every provider was used.
    const { deps } = createDeps()
    deps.assertMainRendererSender.mockImplementation(() => {
      throw new Error('Only the main renderer can read external usage history.')
    })
    registerUsageRatesHandlers(deps)

    await expect(handlerFor('get-daily-usage-rollup')({})).rejects.toThrow(
      'Only the main renderer can read external usage history.'
    )
  })

  it('serves the credential-free native quota hook only to the main renderer', async () => {
    const { deps } = createDeps()
    const snapshot = {
      provider: 'deepseek' as const,
      source: 'taskwraith-native' as const,
      configured: true as const,
      fetchedAt: '2026-08-02T01:54:22.000Z',
      stale: false,
      windows: [],
      balances: []
    }
    deps.fetchQuotaSnapshotHook.mockResolvedValue([snapshot])
    registerUsageRatesHandlers(deps)

    await expect(handlerFor('quota-snapshot-hook:get')({})).resolves.toEqual([snapshot])
    expect(deps.assertMainRendererSender).toHaveBeenCalledOnce()

    deps.assertMainRendererSender.mockImplementation(() => {
      throw new Error('Only the main renderer can read the quota hook.')
    })
    expect(() => handlerFor('quota-snapshot-hook:get')({})).toThrow(
      'Only the main renderer can read the quota hook.'
    )
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
    const NOW = new Date(2026, 4, 22, 12, 0).getTime()
    const DAY = 86_400_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const records = [
      {
        id: 'r1',
        provider: 'codex',
        timestamp: NOW - DAY,
        workspaceId: 'ws-1',
        chatId: 'chat-1',
        runId: 'run-1',
        model: 'gpt-5-codex',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        durationMs: 500,
        usageKind: 'run'
      }
    ]
    const activity: MessageActivityAggregate = {
      lifetimeDayKeys: [messageActivityDayKey(NOW - 2 * DAY), messageActivityDayKey(NOW)],
      rangeMessageCount: 3,
      rangeDayKeys: [messageActivityDayKey(NOW)],
      rangeChatIds: ['chat-1', 'chat-2'],
      hasAnyMessage: true
    }
    deps.getExternalUsageCached.mockResolvedValue([{ source: 'provider' }])
    deps.getUsage.mockReturnValue(records)
    deps.getSettings.mockReturnValue({ dashboardStatPrefs: { resetAt: NOW - 5 * DAY } } as any)
    deps.getMessageActivity.mockResolvedValue(activity)

    callbacks.triggerUsageRollup()
    await flushAsyncTasks()

    expect(deps.broadcastUsageRollup).toHaveBeenCalledTimes(1)
    // The dashboard is built from the aggregate the provider answered for the
    // 30-day window after the settings reset — no chat record is read.
    expect(deps.getMessageActivity).toHaveBeenCalledWith({
      resetAt: NOW - 5 * DAY,
      rangeStart: NOW - 30 * DAY
    })
    expect(deps.broadcastWelcomeDashboard).toHaveBeenCalledTimes(1)
    expect(deps.broadcastWelcomeDashboard).toHaveBeenCalledWith({
      dashboard: buildRemoteWelcomeDashboard(records as any, activity, [], NOW, NOW - 5 * DAY)
    })
    expect(deps.getChats).not.toHaveBeenCalled()
  })

  it('logs and skips the welcome dashboard when the activity provider fails', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.getUsage.mockReturnValue([{ value: 1 }, { value: 2 }, { value: 3 }] as any)
    deps.getMessageActivity.mockRejectedValue(new Error('catalogue unavailable'))

    callbacks.triggerUsageRollup()
    await flushAsyncTasks()

    expect(deps.broadcastUsageRollup).toHaveBeenCalledTimes(1)
    expect(deps.broadcastWelcomeDashboard).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      '[remote] welcome dashboard broadcast failed:',
      expect.any(Error)
    )
    error.mockRestore()
  })

  it('offers a full-record adapter for a store without the thread catalogue', async () => {
    const chats = [
      {
        appChatId: 'c1',
        workspaceId: 'ws-1',
        runs: [],
        messages: [{ timestamp: new Date(2026, 4, 22, 12, 0).toISOString() }]
      }
    ]
    const adapter = usageRatesChatDepsFromFullRecords(() => chats as any)
    expect(adapter.getChatList()).toBe(chats)
    const request = { resetAt: 0, rangeStart: 0 }
    expect(await adapter.getMessageActivity(request)).toEqual(
      messageActivityFromChats(chats, request)
    )
  })

  it('counts running first-launch workspaces from inventory rows, never full records', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)
    deps.getWorkspaces.mockReturnValue([
      { id: 'ws-1', displayName: 'One' },
      { id: 'ws-2', displayName: 'Two' },
      { id: 'ws-hidden', displayName: 'Hidden' }
    ])
    deps.evaluateRemoteCapability.mockImplementation(
      ({ workspaceId }) => workspaceId !== 'ws-hidden'
    )
    const running = { status: 'running', runningRunCount: 2 }
    const idle = { status: 'idle', runningRunCount: 0 }
    deps.getChatList.mockReturnValue([
      // Catalogue rows: the distilled count decides, however many runs it covers.
      { appChatId: 'c1', workspaceId: 'ws-1', runs: [], cataloguePresentation: running },
      { appChatId: 'c2', workspaceId: 'ws-1', runs: [], cataloguePresentation: idle },
      // A full record still answers from its run array.
      { appChatId: 'c3', workspaceId: 'ws-2', runs: [{ runId: 'r3', status: 'running' }] },
      // A legacy chat-list row answers from the run it kept.
      {
        appChatId: 'c4',
        workspaceId: 'ws-2',
        runs: [],
        lastRun: { runId: 'r4', status: 'running' }
      },
      {
        appChatId: 'c5',
        workspaceId: 'ws-2',
        runs: [],
        lastRun: { runId: 'r5', status: 'success' }
      },
      // Invisible or unscoped chats never count.
      { appChatId: 'c6', workspaceId: 'ws-hidden', runs: [], cataloguePresentation: running },
      { appChatId: 'c7', workspaceId: undefined, runs: [], cataloguePresentation: running }
    ])

    callbacks.triggerFirstLaunch()
    await flushAsyncTasks()

    expect(deps.broadcastFirstLaunchState).toHaveBeenCalledTimes(1)
    const { state } = deps.broadcastFirstLaunchState.mock.calls[0][0] as {
      state: { workspace: Record<string, unknown> }
    }
    expect(state.workspace).toMatchObject({
      visibleCount: 2,
      totalCount: 3,
      runningCount: 3,
      hasVisibleWorkspaces: true
    })
    expect(deps.getChatList).toHaveBeenCalled()
    expect(deps.getChats).not.toHaveBeenCalled()
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

    callbacks.triggerUsageModel()
    await flushAsyncTasks()

    expect(deps.broadcastModelUsage).toHaveBeenCalledTimes(1)
  })

  it('adds native AntiGravity and supplemental API-credit meters to the iOS projection', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)

    deps.fetchAntigravityUsageSnapshot.mockResolvedValue({
      provider: 'antigravity',
      source: 'agy-usage-tui',
      configured: true,
      fetchedAt: '2026-08-02T01:54:22.000Z',
      planType: 'Google AI Pro',
      windows: [
        {
          id: 'agy-weekly',
          label: 'Gemini Weekly',
          runs: 0,
          totalTokens: 0,
          usedPercent: 0.03235,
          remainingPercent: 99.96765,
          limitLabel: '99.97% remaining',
          resetAt: '2026-08-08T17:20:35.000Z',
          trackingOnly: false
        }
      ]
    })
    deps.fetchQuotaSnapshotHook.mockResolvedValue([
      {
        provider: 'deepseek',
        source: 'taskwraith-native',
        configured: true,
        fetchedAt: '2026-08-02T01:54:22.000Z',
        stale: false,
        planType: 'API Credits',
        windows: [
          {
            id: 'deepseek-credit',
            label: 'Credit used',
            usedPercent: 9.2,
            remainingPercent: 90.8,
            limitLabel: '$0.92 of $10.00',
            valueText: '$0.92',
            unit: 'USD'
          }
        ],
        balances: []
      }
    ])

    callbacks.triggerUsageModel()
    await flushAsyncTasks()

    expect(deps.broadcastModelUsage).toHaveBeenCalledWith({
      usage: expect.objectContaining({
        providers: [
          expect.objectContaining({
            provider: 'antigravity',
            planName: 'Google AI Pro',
            windows: [expect.objectContaining({ label: 'Gemini Weekly', usedPercent: 0 })]
          }),
          expect.objectContaining({
            provider: 'deepseek',
            planName: 'API Credits',
            windows: [
              expect.objectContaining({
                label: 'Credit used',
                valueText: '$0.92',
                usedPercent: 9
              })
            ]
          })
        ]
      })
    })
  })

  it('adds spend and AntiGravity budget fields without changing quota providers', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)

    deps.fetchCodexUsageSnapshot.mockResolvedValue({
      windows: [{ id: 'codex-5h', label: '5h', usedPercent: 42 }]
    })
    deps.fetchClaudeUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchKimiUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchCursorUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.getSettings.mockReturnValue({
      currency: 'USD',
      antigravityGeminiApiMonthlySpendCapUsd: 10
    })
    deps.getCurrentProviderRates.mockReturnValue({
      baseline: {
        antigravity: {
          models: [
            {
              modelId: 'gemini-api:gemini-2.5-flash',
              inputUsdPerMillion: 2,
              outputUsdPerMillion: 10
            }
          ]
        }
      }
    } as any)
    deps.getUsage.mockReturnValue([
      {
        id: 'usage-1',
        provider: 'antigravity',
        timestamp: Date.now() - 1_000,
        workspaceId: 'ws-1',
        chatId: 'chat-1',
        runId: 'run-1',
        model: 'gemini-api:gemini-2.5-flash',
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        durationMs: 100
      }
    ])

    callbacks.triggerUsageModel()
    await flushAsyncTasks()

    expect(deps.broadcastModelUsage).toHaveBeenCalledWith({
      usage: expect.objectContaining({
        providers: expect.arrayContaining([expect.objectContaining({ provider: 'codex' })]),
        spend: expect.objectContaining({
          providers: expect.arrayContaining([
            expect.objectContaining({
              provider: 'antigravity',
              windows: expect.arrayContaining([
                expect.objectContaining({ id: 'day', costText: '$2.00' })
              ])
            })
          ])
        }),
        antigravityBudget: expect.objectContaining({
          provider: 'antigravity',
          spentText: '$2.00',
          capText: '$10.00',
          usedPercent: 20
        })
      })
    })
  })

  it('broadcasts AntiGravity spend and budget when quota snapshots are empty', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)

    deps.fetchCodexUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchClaudeUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchKimiUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.fetchCursorUsageSnapshot.mockResolvedValue({ windows: [] })
    deps.getSettings.mockReturnValue({
      currency: 'USD',
      antigravityGeminiApiMonthlySpendCapUsd: 10
    })
    deps.getCurrentProviderRates.mockReturnValue({
      baseline: {
        antigravity: {
          models: [
            {
              modelId: 'gemini-api:gemini-2.5-flash',
              inputUsdPerMillion: 2,
              outputUsdPerMillion: 10
            }
          ]
        }
      }
    } as any)
    deps.getUsage.mockReturnValue([
      {
        id: 'usage-antigravity-only',
        provider: 'antigravity',
        timestamp: Date.now() - 1_000,
        workspaceId: 'ws-1',
        chatId: 'chat-1',
        runId: 'run-1',
        model: 'gemini-api:gemini-2.5-flash',
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        durationMs: 100
      }
    ])

    callbacks.triggerUsageModel()
    await flushAsyncTasks()

    expect(deps.broadcastModelUsage).toHaveBeenCalledWith({
      usage: expect.objectContaining({
        providers: [],
        spend: expect.objectContaining({
          providers: expect.arrayContaining([
            expect.objectContaining({ provider: 'antigravity' })
          ])
        }),
        antigravityBudget: expect.objectContaining({
          provider: 'antigravity',
          capText: '$10.00'
        })
      })
    })
  })

  it('keeps the legacy no-data broadcast silent', async () => {
    const { deps, callbacks } = createDeps()
    registerUsageRatesHandlers(deps)

    callbacks.triggerUsageModel()
    await flushAsyncTasks()

    expect(deps.broadcastModelUsage).not.toHaveBeenCalled()
  })
})
