/**
 * Microsoft account connect/disconnect IPC.
 *
 * The renderer drives a device-code sign-in but never holds anything
 * sensitive: `device_code` (the pollable secret) stays in main, and only the
 * short `user_code` plus Microsoft's verification URL cross the boundary.
 * There is no channel that returns a token — connection state is a status
 * projection only.
 *
 * Main-renderer only, like every other credential surface here.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  MicrosoftDeviceCodeAuth,
  isValidClientId,
  isValidTenant,
  type DeviceCodeStart,
  type GraphScopeMode
} from '../outlook/MicrosoftDeviceCodeAuth'
import type {
  OutlookConnectionStatus,
  OutlookCredentialStore
} from '../outlook/OutlookCredentialStore'

/** How long a started sign-in stays pollable before it must be restarted. */
const MAX_PENDING_AGE_MS = 20 * 60_000

export interface OutlookAuthHandlerDeps {
  store: OutlookCredentialStore
  assertMainRenderer: (event: IpcMainInvokeEvent) => void
  /** Resolves the signed-in account label after a successful grant. */
  resolveAccount: () => Promise<string | null>
  createAuth?: (clientId: string, tenant: string) => MicrosoftDeviceCodeAuth
  nowMs?: () => number
}

interface PendingSignIn {
  auth: MicrosoftDeviceCodeAuth
  clientId: string
  tenant: string
  scopeMode: GraphScopeMode
  start: DeviceCodeStart
  intervalSeconds: number
  startedAtMs: number
}

export type OutlookSignInStart =
  | {
      ok: true
      userCode: string
      verificationUri: string
      message: string
      expiresInSeconds: number
    }
  | { ok: false; error: string }

export type OutlookSignInPoll =
  | { status: 'pending' }
  | { status: 'connected'; connection: OutlookConnectionStatus }
  | { status: 'declined' | 'expired' | 'no-pending' }
  | { status: 'error'; message: string }

export function registerOutlookAuthHandlers(deps: OutlookAuthHandlerDeps): void {
  const nowMs = deps.nowMs ?? (() => Date.now())
  // One sign-in at a time; starting another replaces the pending attempt.
  let pending: PendingSignIn | null = null

  ipcMain.handle('outlook:status', async (event): Promise<OutlookConnectionStatus> => {
    deps.assertMainRenderer(event)
    return deps.store.status()
  })

  ipcMain.handle(
    'outlook:start-sign-in',
    async (event, payload: unknown): Promise<OutlookSignInStart> => {
      deps.assertMainRenderer(event)
      const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
        string,
        unknown
      >
      const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : ''
      const tenant =
        typeof record.tenant === 'string' && record.tenant.trim() ? record.tenant.trim() : 'common'
      const scopeMode: GraphScopeMode = record.scopeMode === 'write' ? 'write' : 'read'
      if (!isValidClientId(clientId)) {
        return {
          ok: false,
          error: 'Enter the application (client) ID from your Entra app registration.'
        }
      }
      if (!isValidTenant(tenant)) return { ok: false, error: 'That tenant value is not valid.' }

      const auth = deps.createAuth
        ? deps.createAuth(clientId, tenant)
        : new MicrosoftDeviceCodeAuth({ clientId, tenant })
      try {
        const start = await auth.startDeviceCode(scopeMode)
        pending = {
          auth,
          clientId,
          tenant,
          scopeMode,
          start,
          intervalSeconds: start.pollIntervalSeconds,
          startedAtMs: nowMs()
        }
        // device_code deliberately withheld from this projection.
        return {
          ok: true,
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          message: start.message,
          expiresInSeconds: start.expiresInSeconds
        }
      } catch (error) {
        pending = null
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Microsoft sign-in could not start.'
        }
      }
    }
  )

  ipcMain.handle('outlook:poll-sign-in', async (event): Promise<OutlookSignInPoll> => {
    deps.assertMainRenderer(event)
    if (!pending) return { status: 'no-pending' }
    if (nowMs() - pending.startedAtMs > MAX_PENDING_AGE_MS) {
      pending = null
      return { status: 'expired' }
    }

    let outcome: Awaited<ReturnType<MicrosoftDeviceCodeAuth['pollForToken']>>
    try {
      outcome = await pending.auth.pollForToken(pending.start.deviceCode, pending.intervalSeconds)
    } catch {
      return { status: 'error', message: 'Could not reach Microsoft to complete sign-in.' }
    }

    switch (outcome.status) {
      case 'pending':
        return { status: 'pending' }
      case 'slow-down':
        pending.intervalSeconds = outcome.nextIntervalSeconds
        return { status: 'pending' }
      case 'declined':
      case 'expired':
        pending = null
        return { status: outcome.status }
      case 'error':
        pending = null
        return { status: 'error', message: outcome.message }
      case 'granted': {
        const granted = pending
        pending = null
        const saved = deps.store.save({
          clientId: granted.clientId,
          tenant: granted.tenant,
          scopeMode: granted.scopeMode,
          account: null,
          tokens: outcome.tokens
        })
        if (!saved.ok) {
          return {
            status: 'error',
            message:
              'This device cannot encrypt stored credentials, so the Microsoft session was not saved.'
          }
        }
        // Label the connection with the account, best-effort — a failure
        // here must not lose a sign-in that already succeeded.
        try {
          const account = await deps.resolveAccount()
          if (account) {
            deps.store.save({
              clientId: granted.clientId,
              tenant: granted.tenant,
              scopeMode: granted.scopeMode,
              account,
              tokens: { ...outcome.tokens, account }
            })
          }
        } catch {
          // Connection stands without a display name.
        }
        return { status: 'connected', connection: deps.store.status() }
      }
    }
  })

  ipcMain.handle('outlook:disconnect', async (event): Promise<OutlookConnectionStatus> => {
    deps.assertMainRenderer(event)
    pending = null
    return deps.store.clear().status
  })
}
