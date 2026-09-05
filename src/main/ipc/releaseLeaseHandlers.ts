import { ipcMain } from 'electron'
import type {
  ReleaseAuthorizationLease,
  ReleaseAuthorizationLeaseGrantInput
} from '../ReleaseAuthorizationLease'

export const RELEASE_LEASE_GRANT_CHANNEL = 'release-lease-grant'
export const RELEASE_LEASE_STATUS_CHANNEL = 'release-lease-status'
export const RELEASE_LEASE_REVOKE_CHANNEL = 'release-lease-revoke'

export interface ReleaseLeaseHandlerDeps {
  /**
   * Session lease registry. Injected because the singleton lives in index.ts
   * bootstrap scope alongside the ReleaseCommandPolicy wiring that also uses
   * it; only the IPC registration cluster moved here.
   */
  leaseRegistry: {
    grant: (input?: ReleaseAuthorizationLeaseGrantInput) => ReleaseAuthorizationLease
    active: () => ReleaseAuthorizationLease[]
    revoke: (leaseId?: string) => number
  }
}

export function registerReleaseLeaseHandlers(deps: ReleaseLeaseHandlerDeps): void {
  // Session release lease. The user grants this when they intend an agent to
  // publish unattended; it satisfies ReleaseCommandPolicy on every route for
  // its lifetime, and is capped + revocable.
  ipcMain.handle(
    RELEASE_LEASE_GRANT_CHANNEL,
    async (
      _,
      input: {
        minutes?: number
        commandClasses?: 'all' | string[]
        workspacePath?: string
        note?: string
      } = {}
    ) => deps.leaseRegistry.grant({ ...input, origin: 'desktop-ui' })
  )

  ipcMain.handle(RELEASE_LEASE_STATUS_CHANNEL, async () => deps.leaseRegistry.active())

  ipcMain.handle(RELEASE_LEASE_REVOKE_CHANNEL, async (_, leaseId?: string) => ({
    revoked: deps.leaseRegistry.revoke(leaseId)
  }))
}

export function unregisterReleaseLeaseHandlers(): void {
  ipcMain.removeHandler(RELEASE_LEASE_GRANT_CHANNEL)
  ipcMain.removeHandler(RELEASE_LEASE_STATUS_CHANNEL)
  ipcMain.removeHandler(RELEASE_LEASE_REVOKE_CHANNEL)
}
