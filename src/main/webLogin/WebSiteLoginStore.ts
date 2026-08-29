import * as fs from 'fs'
import * as path from 'path'

import {
  MAX_WEB_SITE_LOGINS,
  MAX_WEB_SITE_LOGIN_EXTRA_ORIGINS,
  MAX_WEB_SITE_BLOCKED_EMBEDS,
  MAX_WEB_SITE_LOGIN_LABEL,
  isWebSiteLoginAccess,
  isWebSiteLoginId,
  normalizeWebSiteOrigin,
  parseWebSiteLogin,
  proposeWebSiteLoginId,
  type WebSiteLogin,
  type WebSiteLoginAccess,
  type WebSiteLoginStatus
} from '../../shared/webSiteLogin'

/**
 * The app-global catalogue of sites the user has chosen to stay signed into.
 *
 * THIS STORE HOLDS NO SECRET, and that is deliberate rather than an oversight:
 * the session itself lives in Chromium's own per-partition cookie store,
 * encrypted at rest under the OS key (login keychain on macOS, DPAPI on
 * Windows; on Linux it depends on the available secret-service backend — the
 * same caveat `safeStorage` carries everywhere else here). Nothing in
 * TaskWraith's address space ever holds a plaintext credential for these sites,
 * so there is no envelope to leak and no `safeStorage` dependency to fail
 * closed against.
 *
 * A row is a catalogue entry — an origin, a label, and how much authority the
 * user has granted an agent over it. See
 * `docs/appdrive/authorized-site-sessions.md`.
 *
 * Scope is app-global, not per-Project: a login is an account, not a project
 * asset, which is the same reason the Canvas Browser profile is app-wide.
 */

export interface WebSiteLoginStoreOptions {
  userDataPath?: string
  storePath?: string
  now?: () => Date
  log?: (line: string) => void
}

export interface WebSiteLoginMutationResult {
  ok: boolean
  error?: string
  site?: WebSiteLogin
}

export interface AddWebSiteLoginInput {
  origin: string
  label?: string
  extraOrigins?: string[]
}

export interface UpdateWebSiteLoginInput {
  label?: string
  extraOrigins?: string[]
  agentAccess?: WebSiteLoginAccess
}

interface WebSiteLoginStateFile {
  schemaVersion: 1
  sites: WebSiteLogin[]
  /**
   * Ids that have been used and removed. NEVER handed out again.
   *
   * The partition is derived deterministically from the id, and the id is
   * derived deterministically from the host — so without this, removing
   * example.com and re-adding it produced the SAME id, the same
   * `persist:taskwraith-site-example-com` directory, and a row that reads
   * "never signed in" while the browser is still logged in. Clearing the
   * partition on removal is the primary fix and belongs to the caller that owns
   * the profile registry; this list is the backstop for when that ordering is
   * got wrong, which costs one directory on disk instead of a live session the
   * user believes they deleted.
   */
  retiredIds: string[]
}

const EMPTY_STATE: WebSiteLoginStateFile = { schemaVersion: 1, sites: [], retiredIds: [] }
const MAX_RETIRED_IDS = 1024

function readJson<T>(filePath: string, fallback: T, log: (line: string) => void): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    }
  } catch (error) {
    log(`[WebSiteLoginStore] Failed to read ${filePath}: ${String(error)}`)
  }
  return fallback
}

function writeJson(filePath: string, state: WebSiteLoginStateFile): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tempPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

/** One bad row drops; it never bricks the file. A user who has signed into ten
 *  sites should not lose nine of them to one hand-edit. */
function normalizeState(value: unknown): WebSiteLoginStateFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_STATE }
  const raw = (value as Partial<WebSiteLoginStateFile>).sites
  if (!Array.isArray(raw)) return { ...EMPTY_STATE }
  const sites: WebSiteLogin[] = []
  const seenIds = new Set<string>()
  for (const entry of raw) {
    if (sites.length >= MAX_WEB_SITE_LOGINS) break
    const parsed = parseWebSiteLogin(entry)
    if (!parsed || seenIds.has(parsed.id)) continue
    seenIds.add(parsed.id)
    sites.push(parsed)
  }
  const rawRetired = (value as Partial<WebSiteLoginStateFile>).retiredIds
  const retiredIds: string[] = []
  if (Array.isArray(rawRetired)) {
    for (const entry of rawRetired) {
      if (!isWebSiteLoginId(entry) || retiredIds.includes(entry)) continue
      if (retiredIds.length >= MAX_RETIRED_IDS) break
      retiredIds.push(entry)
    }
  }
  return { schemaVersion: 1, sites, retiredIds }
}

function cleanExtraOrigins(input: unknown, siteOrigin: string): string[] | null {
  if (input === undefined) return null
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const entry of input) {
    const normalized = normalizeWebSiteOrigin(entry)
    if (!normalized || normalized === siteOrigin || out.includes(normalized)) continue
    if (out.length >= MAX_WEB_SITE_LOGIN_EXTRA_ORIGINS) break
    out.push(normalized)
  }
  return out
}

export class WebSiteLoginStore {
  private readonly storePath: string
  private readonly now: () => Date
  private readonly log: (line: string) => void

  constructor(options: WebSiteLoginStoreOptions = {}) {
    this.storePath =
      options.storePath || path.join(options.userDataPath || process.cwd(), 'web-site-logins.json')
    this.now = options.now ?? (() => new Date())
    this.log = options.log ?? (() => {})
  }

  list(): WebSiteLogin[] {
    return this.readState().sites
  }

  get(id: string): WebSiteLogin | null {
    return this.readState().sites.find((site) => site.id === id) ?? null
  }

  add(input: AddWebSiteLoginInput): WebSiteLoginMutationResult {
    const origin = normalizeWebSiteOrigin(input.origin)
    if (!origin) {
      return { ok: false, error: 'Enter a site address, for example example.com.' }
    }
    const state = this.readState()
    if (state.sites.length >= MAX_WEB_SITE_LOGINS) {
      return { ok: false, error: `At most ${MAX_WEB_SITE_LOGINS} sites can be saved.` }
    }
    if (state.sites.some((site) => site.origin === origin)) {
      return { ok: false, error: `${origin} is already saved.` }
    }
    const id = proposeWebSiteLoginId(origin, [
      ...state.sites.map((site) => site.id),
      ...state.retiredIds
    ])
    if (!id) {
      return { ok: false, error: 'Could not derive an id for that site.' }
    }
    const label =
      (input.label ?? '').trim().slice(0, MAX_WEB_SITE_LOGIN_LABEL) || new URL(origin).host
    const site: WebSiteLogin = {
      id,
      label,
      origin,
      extraOrigins: cleanExtraOrigins(input.extraOrigins, origin) ?? [],
      // A newly added site grants an agent NOTHING. Promotion is a separate,
      // deliberate act: signing in is consent to BE signed in, not consent to
      // be acted for.
      agentAccess: 'off',
      status: 'never',
      createdAt: this.now().toISOString()
    }
    state.sites.push(site)
    this.writeState(state)
    return { ok: true, site }
  }

  update(id: string, patch: UpdateWebSiteLoginInput): WebSiteLoginMutationResult {
    const state = this.readState()
    const index = state.sites.findIndex((site) => site.id === id)
    if (index < 0) return { ok: false, error: 'That site is no longer saved.' }
    const current = state.sites[index]
    if (patch.agentAccess !== undefined && !isWebSiteLoginAccess(patch.agentAccess)) {
      return { ok: false, error: 'Unknown agent access level.' }
    }
    const label =
      patch.label === undefined
        ? current.label
        : patch.label.trim().slice(0, MAX_WEB_SITE_LOGIN_LABEL) || current.label
    const extraOrigins =
      cleanExtraOrigins(patch.extraOrigins, current.origin) ?? current.extraOrigins
    const next: WebSiteLogin = {
      ...current,
      label,
      extraOrigins,
      agentAccess: patch.agentAccess ?? current.agentAccess
    }
    state.sites[index] = next
    this.writeState(state)
    return { ok: true, site: next }
  }

  /**
   * Drop the catalogue row and retire its id.
   *
   * ORDERING IS LOAD-BEARING: the caller must clear that site's partition FIRST
   * (`WebSiteProfileRegistry.forgetSite`). This method cannot do it — the store
   * owns no profile — and retiring the id is what keeps a wrong order from
   * silently handing the old cookie jar to a re-added site.
   */
  remove(id: string): boolean {
    const state = this.readState()
    const next = state.sites.filter((site) => site.id !== id)
    if (next.length === state.sites.length) return false
    const retiredIds = state.retiredIds.includes(id)
      ? state.retiredIds
      : [...state.retiredIds, id].slice(-MAX_RETIRED_IDS)
    this.writeState({ schemaVersion: 1, sites: next, retiredIds })
    return true
  }

  /** Status is advisory — only a real request proves a session is live — so a
   *  status write never fails the caller. */
  setStatus(id: string, status: WebSiteLoginStatus): WebSiteLogin | null {
    const state = this.readState()
    const index = state.sites.findIndex((site) => site.id === id)
    if (index < 0) return null
    const stamp = this.now().toISOString()
    const next: WebSiteLogin = {
      ...state.sites[index],
      status,
      ...(status === 'signed-in' ? { lastSignedInAt: stamp } : {}),
      lastVerifiedAt: stamp
    }
    state.sites[index] = next
    this.writeState(state)
    return next
  }

  /**
   * Note that the fence refused an embed this site asked for.
   *
   * Advisory and idempotent. It never widens anything - only the user does that
   * - and it drops silently if the origin is already authorized, so a race
   * between the widening and a late block cannot resurrect a stale warning.
   */
  recordBlockedEmbed(id: string, origin: string): void {
    const normalized = normalizeWebSiteOrigin(origin)
    if (!normalized) return
    const state = this.readState()
    const index = state.sites.findIndex((site) => site.id === id)
    if (index < 0) return
    const site = state.sites[index]
    if (site.origin === normalized || site.extraOrigins.includes(normalized)) return
    const current = site.blockedEmbedOrigins ?? []
    if (current.includes(normalized)) return
    state.sites[index] = {
      ...site,
      blockedEmbedOrigins: [...current, normalized].slice(-MAX_WEB_SITE_BLOCKED_EMBEDS)
    }
    this.writeState(state)
  }

  private readState(): WebSiteLoginStateFile {
    return normalizeState(readJson<unknown>(this.storePath, EMPTY_STATE, this.log))
  }

  private writeState(state: WebSiteLoginStateFile): void {
    writeJson(this.storePath, normalizeState(state))
  }
}
