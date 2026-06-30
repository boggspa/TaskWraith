import { ipcMain } from 'electron'
import type { TailscaleStatus } from '../TailscaleDetector'
import type { RemoteWorkspaceCapability } from '../RemoteWorkspaceAllowlist'

interface RemoteAllowlistEntryInput {
  workspaceId: string
  path: string
  mode: 'read-only' | 'read-write'
  capabilities?: RemoteWorkspaceCapability[]
  allowedProviders: string[]
  allowedApprovalModes: string[]
  expiresAt?: number
}

export interface BridgeAllowlistHandlersDeps {
  listRemoteAllowlist: () => unknown
  upsertRemoteAllowlist: (entry: RemoteAllowlistEntryInput) => unknown
  removeRemoteAllowlist: (workspaceId: string) => unknown
  clearRemoteAllowlist: () => unknown
  broadcastWorkspaceList: () => void
  broadcastThreadList: () => void
  broadcastRemoteProjectionSnapshot: () => void
  getBridgeDaemonStatus: () => unknown
  getBridgeNetworkingTailscaleStatus: () => Promise<TailscaleStatus>
}

interface BridgeNetworkingTailscaleStatusGetterDeps {
  detectTailscale: () => Promise<TailscaleStatus>
  getNowMs: () => number
}

const TAILSCALE_SUCCESS_CACHE_TTL_MS = 5_000

export function createBridgeNetworkingTailscaleStatusGetter(
  deps: BridgeNetworkingTailscaleStatusGetterDeps
): () => Promise<TailscaleStatus> {
  let cachedTailscaleStatus: TailscaleStatus | null = null
  let cachedTailscaleAt = 0

  return async () => {
    const now = deps.getNowMs()
    const ttl = cachedTailscaleStatus?.available ? TAILSCALE_SUCCESS_CACHE_TTL_MS : 0
    if (!cachedTailscaleStatus || now - cachedTailscaleAt > ttl) {
      cachedTailscaleStatus = await deps.detectTailscale()
      cachedTailscaleAt = now
    }
    return cachedTailscaleStatus
  }
}

function broadcastAllowlistVisibilityChange(deps: BridgeAllowlistHandlersDeps): void {
  deps.broadcastWorkspaceList()
  deps.broadcastThreadList()
  try {
    deps.broadcastRemoteProjectionSnapshot()
  } catch (err) {
    console.error('[BridgeBroadcaster] allowlist visibility broadcast failed:', err)
  }
}

export function registerBridgeAllowlistHandlers(deps: BridgeAllowlistHandlersDeps): void {
  ipcMain.handle('bridge-allowlist-list', () => deps.listRemoteAllowlist())

  ipcMain.handle('bridge-allowlist-upsert', (_, entry: RemoteAllowlistEntryInput) => {
    const result = deps.upsertRemoteAllowlist(entry)
    broadcastAllowlistVisibilityChange(deps)
    return result
  })

  ipcMain.handle('bridge-allowlist-remove', (_, workspaceId: string) => {
    const result = deps.removeRemoteAllowlist(workspaceId)
    broadcastAllowlistVisibilityChange(deps)
    return result
  })

  ipcMain.handle('bridge-allowlist-clear', () => {
    const result = deps.clearRemoteAllowlist()
    broadcastAllowlistVisibilityChange(deps)
    return result
  })

  ipcMain.handle('bridge-networking-status', async () => {
    return {
      lan: deps.getBridgeDaemonStatus(),
      tailscale: await deps.getBridgeNetworkingTailscaleStatus()
    }
  })
}
