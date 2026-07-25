import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  AppSettings,
  ChatRecord,
  ProviderCapabilityContract,
  ProviderId,
  UsageRecord
} from '../store/types'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import { buildDailyTokenSeries } from '../DailyTokenSeries'
import { buildRemoteWelcomeDashboardThrottled } from '../WelcomeDashboardRemote'
import {
  buildRemoteFirstLaunchState,
  type RemoteFirstLaunchWorkspaceSummary
} from '../RemoteFirstLaunchState'
import type { ProviderUsageSummary } from '../ProviderUsageStatus'
import { summarizeProviderUsage } from '../ProviderUsageStatus'
import { buildExternalUsageRollup } from '../ExternalProviderActivity'
import { projectRemoteModelUsageExtras } from '../RemoteModelUsageProjection'
import type { RemoteWorkspaceCapability } from '../RemoteWorkspaceAllowlist'
import type { TaskWraithPluginActivationSnapshot } from '../../shared/plugins/PluginTypes'

type UsageWorkspaceSummary = {
  id: string
  displayName: string
}

type UsageSnapshotWindowLike = {
  id?: string
  label?: string
  usedPercent?: number
  limitLabel?: string
  resetAt?: string
}

type UsageSnapshotLike = {
  windows?: UsageSnapshotWindowLike[]
}

type UsageSnapshotFetcher = () => Promise<UsageSnapshotLike | null>
type NormalizedUsageSnapshotFetcher = () => Promise<NormalizedProviderUsageSnapshot | null>

export type UsageRatesSenderScope =
  | { kind: 'main' }
  | { kind: 'chat'; chatId: string; chatScope: 'global'; workspaceId?: never }
  | { kind: 'chat'; chatId: string; chatScope: 'workspace'; workspaceId: string }

export interface UsageRatesHandlerDeps {
  /**
   * Resolve a renderer to main-owned usage authority. Payload workspace/chat
   * ids are filters, never proof that a secondary renderer owns that scope.
   */
  resolveSenderUsageScope: (event: IpcMainInvokeEvent) => UsageRatesSenderScope
  /** Global external-provider history is not scoped to one chat. */
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  /**
   * Usage records require a workspace-shaped key. Global chats use this
   * synthetic ledger key, which is not a real workspace identity.
   */
  globalUsageWorkspaceId: string
  recordUsage: (usage: Omit<UsageRecord, 'id' | 'timestamp'>) => unknown
  getUsage: (workspaceId?: string, chatId?: string) => UsageRecord[]
  getExternalUsageCached: (options?: { maxAgeMs?: number }) => Promise<UsageRecord[]>
  onUsageChanged: () => void
  getChats: () => ChatRecord[]
  getWorkspaces: () => UsageWorkspaceSummary[]
  getSettings: () => AppSettings
  evaluateRemoteCapability: (input: {
    workspaceId: string
    capability: RemoteWorkspaceCapability
  }) => boolean
  canonicalRemoteWorkspaceId: (workspaceId?: string | null) => string | null
  broadcastUsageRollup: (payload: {
    rollup: unknown
    taskwraithDaily: unknown
    externalDaily: unknown
  }) => void
  broadcastWelcomeDashboard: (payload: { dashboard: unknown }) => void
  hasRemoteBroadcaster: () => boolean
  broadcastModelUsage: (payload: {
    usage: {
      providers: unknown[]
      generatedAt: string
      spend?: unknown
      antigravityBudget?: unknown
    }
  }) => void
  broadcastFirstLaunchState: (payload: { state: unknown }) => void
  fetchCodexUsageSnapshot: UsageSnapshotFetcher
  fetchClaudeUsageSnapshot: UsageSnapshotFetcher
  fetchKimiUsageSnapshot: UsageSnapshotFetcher
  fetchCursorUsageSnapshot: UsageSnapshotFetcher
  getProviderCapabilityContract: (provider: ProviderId) => Promise<ProviderCapabilityContract>
  getPluginActivationSnapshot?: () => TaskWraithPluginActivationSnapshot
  getCurrentFxRates: () => unknown
  refreshFxRates: (force: boolean) => Promise<unknown>
  getCurrentProviderRates: () => unknown
  probeAllProviderRates: () => Promise<unknown>
  registerRemoteUsageRollupTrigger: (trigger: () => void) => void
  registerRemoteModelUsageTrigger: (trigger: () => void) => void
  registerRemoteFirstLaunchStateTrigger: (trigger: () => void) => void
}

const FIRST_LAUNCH_REMOTE_PROVIDERS: ProviderId[] = [
  'codex',
  'claude',
  'kimi',
  'cursor',
  'grok',
  'ollama',
  'pi'
]

const FIRST_LAUNCH_WORKSPACE_CAPABILITIES: Array<
  keyof RemoteFirstLaunchWorkspaceSummary['capabilities']
> = [
  'monitor',
  'approve',
  'answer',
  'startTurn',
  'steer',
  'fileRead',
  'fileWrite',
  'externalPublish'
]

function assertOwnedUsageWorkspace(
  scope: Extract<UsageRatesSenderScope, { kind: 'chat' }>,
  requestedWorkspaceId: string | undefined
): void {
  if (scope.chatScope === 'global') {
    if (requestedWorkspaceId !== undefined) {
      throw new Error('Global chat renderers cannot read workspace usage.')
    }
    return
  }
  if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== scope.workspaceId) {
    throw new Error('Renderer cannot access usage for another workspace.')
  }
}

function assertOwnedUsageChat(
  scope: Extract<UsageRatesSenderScope, { kind: 'chat' }>,
  requestedChatId: string | undefined
): void {
  if (requestedChatId !== undefined && requestedChatId !== scope.chatId) {
    throw new Error('Renderer cannot access usage for another chat.')
  }
}

function scopedUsageRead(
  deps: UsageRatesHandlerDeps,
  scope: UsageRatesSenderScope,
  workspaceId?: string,
  chatId?: string
): UsageRecord[] {
  if (scope.kind === 'main') return deps.getUsage(workspaceId, chatId)
  assertOwnedUsageWorkspace(scope, workspaceId)
  assertOwnedUsageChat(scope, chatId)
  return deps.getUsage(
    scope.chatScope === 'workspace' ? scope.workspaceId : undefined,
    scope.chatId
  )
}

function assertOwnedUsageWrite(
  deps: UsageRatesHandlerDeps,
  scope: UsageRatesSenderScope,
  usage: Omit<UsageRecord, 'id' | 'timestamp'>
): void {
  if (scope.kind === 'main') return
  if (usage.chatId !== scope.chatId) {
    throw new Error('Renderer cannot record usage for another chat.')
  }
  const expectedWorkspaceId =
    scope.chatScope === 'workspace' ? scope.workspaceId : deps.globalUsageWorkspaceId
  if (usage.workspaceId !== expectedWorkspaceId) {
    throw new Error('Renderer cannot record usage for another workspace.')
  }
}

export function registerUsageRatesHandlers(deps: UsageRatesHandlerDeps): void {
  ipcMain.handle('record-usage', (event, usage: Omit<UsageRecord, 'id' | 'timestamp'>) => {
    const scope = deps.resolveSenderUsageScope(event)
    assertOwnedUsageWrite(deps, scope, usage)
    const result = deps.recordUsage(usage)
    deps.onUsageChanged()
    return result
  })

  ipcMain.handle('get-usage', (event, workspaceId?: string, chatId?: string) => {
    const scope = deps.resolveSenderUsageScope(event)
    return scopedUsageRead(deps, scope, workspaceId, chatId)
  })

  ipcMain.handle('get-external-usage', (event, options?: { force?: boolean }) => {
    deps.assertMainRendererSender(event)
    return deps.getExternalUsageCached(options?.force === true ? { maxAgeMs: 0 } : {})
  })

  ipcMain.handle('fx-rates:get', () => deps.getCurrentFxRates())
  ipcMain.handle('fx-rates:refresh', async (_event, force: boolean = false) =>
    deps.refreshFxRates(Boolean(force))
  )
  ipcMain.handle('providerRates:get', () => deps.getCurrentProviderRates())
  ipcMain.handle('providerRates:probe', async () => deps.probeAllProviderRates())

  const broadcastUsageRollupToRemote = (): void => {
    // Same early-bail as broadcastModelUsageToRemote/broadcastFirstLaunchState:
    // building the rollup + two 90-day daily series + the remote welcome
    // dashboard is pure waste when no device has ever paired — the result was
    // silently dropped by optional chaining at the broadcast seam.
    if (!deps.hasRemoteBroadcaster()) return
    void deps
      .getExternalUsageCached()
      .then((externalRecords) => {
        const now = Date.now()
        const taskwraithRecords = deps.getUsage()
        deps.broadcastUsageRollup({
          rollup: buildExternalUsageRollup(externalRecords, now),
          taskwraithDaily: buildDailyTokenSeries(taskwraithRecords, now),
          externalDaily: buildDailyTokenSeries(externalRecords, now)
        })
        try {
          deps.broadcastWelcomeDashboard({
            dashboard: buildRemoteWelcomeDashboardThrottled(taskwraithRecords, now, {
              getChats: () => deps.getChats(),
              getWorkspaces: () =>
                deps
                  .getWorkspaces()
                  .map((workspace) => ({ id: workspace.id, displayName: workspace.displayName })),
              getStatResetAt: () =>
                (deps.getSettings().dashboardStatPrefs as { resetAt?: number } | undefined)
                  ?.resetAt ?? 0
            })
          })
        } catch (err) {
          console.error('[remote] welcome dashboard broadcast failed:', err)
        }
      })
      .catch(() => {})
  }

  deps.registerRemoteUsageRollupTrigger(broadcastUsageRollupToRemote)

  const broadcastModelUsageToRemote = (): void => {
    void (async () => {
      if (!deps.hasRemoteBroadcaster()) return
      const providerFetchers: ReadonlyArray<[ProviderId, UsageSnapshotFetcher]> = [
        ['codex', deps.fetchCodexUsageSnapshot],
        ['claude', deps.fetchClaudeUsageSnapshot],
        ['kimi', deps.fetchKimiUsageSnapshot],
        ['cursor', deps.fetchCursorUsageSnapshot]
      ]

      const entries = await Promise.all(
        providerFetchers.map(async ([provider, fetcher]) => {
          try {
            const snapshot = await fetcher()
            const windows = (snapshot?.windows ?? [])
              .filter((window) => typeof window?.usedPercent === 'number')
              .slice(0, 8)
              .map((window) => ({
                id: String(window?.id || ''),
                label: String(window?.label || ''),
                usedPercent: Math.max(0, Math.min(100, Math.round(window.usedPercent as number))),
                limitLabel: window?.limitLabel,
                ...(window?.resetAt ? { resetAt: window.resetAt } : {})
              }))
            return windows.length > 0 ? { provider, windows } : null
          } catch {
            return null
          }
        })
      )

      const providers = entries.filter(
        (entry): entry is NonNullable<(typeof entries)[number]> => Boolean(entry)
      )
      // Quota windows remain the persisted provider-usage-snapshots.json
      // projection above. Spend and the AntiGravity soft budget are additive
      // companion detail: older iOS builds ignore them and retain this exact
      // quota-only view.
      const extras = projectRemoteModelUsageExtras({
        records: deps.getUsage(),
        settings: deps.getSettings(),
        providerRates: deps.getCurrentProviderRates(),
        fxRates: deps.getCurrentFxRates()
      })
      if (providers.length === 0 && !extras.spend && !extras.antigravityBudget) return
      deps.broadcastModelUsage({
        usage: { providers, generatedAt: new Date().toISOString(), ...extras }
      })
    })()
  }

  deps.registerRemoteModelUsageTrigger(broadcastModelUsageToRemote)
  setTimeout(() => broadcastModelUsageToRemote(), 6_000).unref?.()
  setInterval(() => broadcastModelUsageToRemote(), 7.5 * 60 * 1000).unref?.()

  const buildFirstLaunchWorkspaceSummary = (): RemoteFirstLaunchWorkspaceSummary => {
    const allWorkspaces = deps.getWorkspaces()
    const visibleWorkspaces = allWorkspaces.filter((workspace) =>
      deps.evaluateRemoteCapability({ workspaceId: workspace.id, capability: 'monitor' })
    )
    const visibleWorkspaceIds = new Set(visibleWorkspaces.map((workspace) => workspace.id))
    const visibleChats = deps.getChats().filter((chat) => {
      const workspaceId = deps.canonicalRemoteWorkspaceId(chat.workspaceId)
      return workspaceId ? visibleWorkspaceIds.has(workspaceId) : false
    })
    const runningCount = visibleChats.filter((chat) =>
      (chat.runs ?? []).some((run) => run?.status === 'running')
    ).length
    const capability = (name: keyof RemoteFirstLaunchWorkspaceSummary['capabilities']) =>
      visibleWorkspaces.some((workspace) =>
        deps.evaluateRemoteCapability({ workspaceId: workspace.id, capability: name })
      )

    return {
      visibleCount: visibleWorkspaces.length,
      totalCount: allWorkspaces.length,
      runningCount,
      hasVisibleWorkspaces: visibleWorkspaces.length > 0,
      capabilities: Object.fromEntries(
        FIRST_LAUNCH_WORKSPACE_CAPABILITIES.map((name) => [name, capability(name)])
      ) as RemoteFirstLaunchWorkspaceSummary['capabilities']
    }
  }

  const buildFirstLaunchProviderContracts = async (): Promise<
    Partial<Record<ProviderId, ProviderCapabilityContract | null>>
  > => {
    const entries = await Promise.all(
      FIRST_LAUNCH_REMOTE_PROVIDERS.map(async (provider) => {
        try {
          return [provider, await deps.getProviderCapabilityContract(provider)] as const
        } catch {
          return [provider, null] as const
        }
      })
    )
    return Object.fromEntries(entries) as Partial<Record<ProviderId, ProviderCapabilityContract | null>>
  }

  const FIRST_LAUNCH_USAGE_FETCHERS: Partial<Record<ProviderId, NormalizedUsageSnapshotFetcher>> = {
    codex: deps.fetchCodexUsageSnapshot as NormalizedUsageSnapshotFetcher,
    claude: deps.fetchClaudeUsageSnapshot as NormalizedUsageSnapshotFetcher,
    kimi: deps.fetchKimiUsageSnapshot as NormalizedUsageSnapshotFetcher,
    cursor: deps.fetchCursorUsageSnapshot as NormalizedUsageSnapshotFetcher
  }

  const buildFirstLaunchProviderUsage = async (): Promise<
    Partial<Record<ProviderId, ProviderUsageSummary | null>>
  > => {
    const entries = await Promise.all(
      FIRST_LAUNCH_REMOTE_PROVIDERS.map(async (provider) => {
        const fetcher = FIRST_LAUNCH_USAGE_FETCHERS[provider]
        if (!fetcher) return [provider, null] as const
        try {
          return [provider, summarizeProviderUsage(provider, await fetcher())] as const
        } catch {
          return [provider, null] as const
        }
      })
    )
    return Object.fromEntries(entries) as Partial<Record<ProviderId, ProviderUsageSummary | null>>
  }

  const broadcastFirstLaunchStateToRemote = (): void => {
    void (async () => {
      if (!deps.hasRemoteBroadcaster()) return
      const generatedAt = new Date().toISOString()
      const [providers, usage] = await Promise.all([
        buildFirstLaunchProviderContracts(),
        buildFirstLaunchProviderUsage()
      ])
      deps.broadcastFirstLaunchState({
        state: buildRemoteFirstLaunchState({
          generatedAt,
          providers,
          usage,
          workspace: buildFirstLaunchWorkspaceSummary(),
          providerSetup: deps.getPluginActivationSnapshot?.().providerSetup ?? []
        })
      })
    })().catch((err) => {
      console.error('[remote] first-launch state broadcast failed:', err)
    })
  }

  deps.registerRemoteFirstLaunchStateTrigger(broadcastFirstLaunchStateToRemote)
  setTimeout(() => broadcastFirstLaunchStateToRemote(), 8_000).unref?.()
  setInterval(() => broadcastFirstLaunchStateToRemote(), 10 * 60 * 1000).unref?.()

  // 4s put this squarely inside launch: on a cold per-file cache this is not a
  // cache read but a full multi-GB provider log walk, and it raced window
  // creation for the main process. index.ts holds its own prewarm until after
  // first paint; this rollup broadcast has to clear launch too or it just
  // re-opens the same door. Both funnel into one in-flight scan, so whichever
  // fires first does the work and the other joins it.
  setTimeout(() => {
    void deps.getExternalUsageCached().then(() => broadcastUsageRollupToRemote())
  }, 45_000).unref?.()
  setInterval(() => {
    // Bounded, NON-forced refresh: rescan only when the cache is older than
    // 90 minutes, so every 2h tick refreshes (same ≤2h freshness as before)
    // but through the incremental per-file cache. The old maxAgeMs:0 forced
    // a full multi-GB reparse AND reset the Cursor incremental cache every
    // 2h, forever, even with no remote device paired.
    void deps
      .getExternalUsageCached({ maxAgeMs: 90 * 60 * 1000 })
      .then(() => broadcastUsageRollupToRemote())
  }, 2 * 60 * 60 * 1000).unref?.()
}
