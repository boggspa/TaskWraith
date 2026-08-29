import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import {
  isWebSiteLoginAccess,
  type SharedJarCandidate,
  type WebSiteLogin,
  type WebSiteLoginAccess
} from '../../shared/webSiteLogin'

/**
 * IPC for authorized site sessions (docs/appdrive/authorized-site-sessions.md).
 *
 * Main-renderer only. These channels grant and revoke the authority an agent has
 * over a real account, so a popout or a secondary surface has no business
 * reaching them.
 *
 * NOTHING HERE CARRIES A SECRET, in either direction. The renderer never sends a
 * password (there is none to send - the user types it into a window main owns,
 * see WebLoginSignInWindow) and never receives a cookie. The projection is the
 * catalogue row, which is an origin, a label, a status and an access level.
 */

export interface WebLoginRemoveResult {
  ok: boolean
  error?: string
}

export interface WebLoginSignInResult {
  ok: boolean
  reason?: string
  /** Origins the human passed through that this site does not yet authorize.
   *  An OFFER for the UI to present; never applied here. */
  suggestedOrigins?: string[]
  site?: WebSiteLogin | null
}

export interface WebLoginHandlerDeps {
  assertSenderCanManageWebLogins: (event: IpcMainInvokeEvent) => void
  listSites: () => WebSiteLogin[]
  addSite: (input: { origin: string; label?: string }) => {
    ok: boolean
    error?: string
    site?: WebSiteLogin
  }
  updateSite: (
    id: string,
    patch: { label?: string; extraOrigins?: string[]; agentAccess?: WebSiteLoginAccess }
  ) => { ok: boolean; error?: string; site?: WebSiteLogin }
  /** Clears the site's partition and drops the row, in that order. */
  removeSite: (id: string) => Promise<WebLoginRemoveResult>
  /** Clears the site's partition and keeps the row. */
  signOutSite: (id: string) => Promise<WebLoginRemoveResult>
  signInSite: (id: string) => Promise<WebLoginSignInResult>
  /** Sign-ins still sitting in the old shared Canvas Browser jar. An OFFER:
   *  no cookie is ever copied, the user re-authenticates into the new jar. */
  listMigrationCandidates: () => Promise<SharedJarCandidate[]>
  dismissMigrationCandidate: (origin: string) => WebLoginRemoveResult
  clearSharedJar: () => Promise<WebLoginRemoveResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  return value.trim()
}

/** Unknown top-level keys are rejected rather than ignored, matching the other
 *  handler modules: a typo in a field name should fail loudly, not silently
 *  apply a default the caller did not intend. */
function assertExactKeys(
  value: unknown,
  allowed: string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Malformed ${label} request.`)
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`Malformed ${label} request.`)
  }
  return value
}

function parseAddRequest(raw: unknown): { origin: string; label?: string } {
  const value = assertExactKeys(raw, ['origin', 'label'], 'site login add')
  const origin = requireId(value.origin, 'Site address')
  if ('label' in value && value.label !== undefined && typeof value.label !== 'string') {
    throw new Error('Malformed site login add request.')
  }
  const label = typeof value.label === 'string' ? value.label : undefined
  return { origin, ...(label !== undefined ? { label } : {}) }
}

function parseUpdateRequest(raw: unknown): {
  id: string
  patch: { label?: string; extraOrigins?: string[]; agentAccess?: WebSiteLoginAccess }
} {
  const value = assertExactKeys(
    raw,
    ['id', 'label', 'extraOrigins', 'agentAccess'],
    'site login update'
  )
  const id = requireId(value.id, 'Site id')
  const patch: { label?: string; extraOrigins?: string[]; agentAccess?: WebSiteLoginAccess } = {}
  if ('label' in value && value.label !== undefined) {
    if (typeof value.label !== 'string') throw new Error('Malformed site login update request.')
    patch.label = value.label
  }
  if ('extraOrigins' in value && value.extraOrigins !== undefined) {
    if (
      !Array.isArray(value.extraOrigins) ||
      value.extraOrigins.some((e) => typeof e !== 'string')
    ) {
      throw new Error('Malformed site login update request.')
    }
    patch.extraOrigins = value.extraOrigins as string[]
  }
  if ('agentAccess' in value && value.agentAccess !== undefined) {
    if (!isWebSiteLoginAccess(value.agentAccess)) {
      throw new Error('Unknown agent access level.')
    }
    patch.agentAccess = value.agentAccess
  }
  return { id, patch }
}

function parseIdRequest(raw: unknown, label: string): string {
  const value = assertExactKeys(raw, ['id'], label)
  return requireId(value.id, 'Site id')
}

function parseOriginRequest(raw: unknown, label: string): string {
  const value = assertExactKeys(raw, ['origin'], label)
  if (typeof value.origin !== 'string') throw new Error('Site address must be a string.')
  return value.origin
}

export const WEB_LOGIN_IPC_CHANNELS = [
  'web-login:list',
  'web-login:add',
  'web-login:update',
  'web-login:remove',
  'web-login:sign-in',
  'web-login:sign-out',
  'web-login:migration-candidates',
  'web-login:migration-dismiss',
  'web-login:clear-shared-jar'
] as const

export function registerWebLoginHandlers(deps: WebLoginHandlerDeps): void {
  ipcMain.handle('web-login:list', async (event) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.listSites()
  })

  ipcMain.handle('web-login:add', async (event, raw: unknown) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.addSite(parseAddRequest(raw))
  })

  ipcMain.handle('web-login:update', async (event, raw: unknown) => {
    deps.assertSenderCanManageWebLogins(event)
    const { id, patch } = parseUpdateRequest(raw)
    return deps.updateSite(id, patch)
  })

  ipcMain.handle('web-login:remove', async (event, raw: unknown) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.removeSite(parseIdRequest(raw, 'site login remove'))
  })

  ipcMain.handle('web-login:sign-in', async (event, raw: unknown) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.signInSite(parseIdRequest(raw, 'site login sign-in'))
  })

  ipcMain.handle('web-login:sign-out', async (event, raw: unknown) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.signOutSite(parseIdRequest(raw, 'site login sign-out'))
  })

  ipcMain.handle('web-login:migration-candidates', async (event) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.listMigrationCandidates()
  })

  ipcMain.handle('web-login:migration-dismiss', async (event, raw: unknown) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.dismissMigrationCandidate(parseOriginRequest(raw, 'site login migration dismiss'))
  })

  ipcMain.handle('web-login:clear-shared-jar', async (event) => {
    deps.assertSenderCanManageWebLogins(event)
    return deps.clearSharedJar()
  })
}
