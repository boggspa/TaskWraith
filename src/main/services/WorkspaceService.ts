import { parse } from 'path'
import { realpath, stat } from 'fs/promises'
import {
  capabilitiesForRemoteWorkspaceEntry,
  isRemoteWorkspaceCapability,
  type RemoteWorkspaceEntry
} from '../RemoteWorkspaceAllowlist'
import type { TrustStatusResult, WorkspaceRecord } from '../store/types'

export type RemoteAllowlistUpsertInput = Omit<RemoteWorkspaceEntry, 'createdAt' | 'updatedAt'>

export interface WorkspaceServiceStore {
  getWorkspaces: () => WorkspaceRecord[]
  addOrUpdateWorkspace: (
    workspacePath: string,
    partial?: Partial<WorkspaceRecord>
  ) => WorkspaceRecord
  addOrUpdateWorkspaceViaHost?: (
    workspacePath: string,
    partial?: Partial<WorkspaceRecord>
  ) => Promise<WorkspaceRecord>
  pinWorkspaceRealPath: (
    workspaceId: string,
    expectedPath: string,
    realPath: string
  ) => WorkspaceRecord | null
  pinWorkspaceRealPathViaHost?: (
    workspaceId: string,
    expectedPath: string,
    realPath: string
  ) => Promise<WorkspaceRecord | null>
  removeWorkspace: (id: string) => void
  removeWorkspaceViaHost?: (id: string) => Promise<void>
  clearWorkspaces: () => void
  clearWorkspacesViaHost?: () => Promise<void>
  legacyStoreWritesOpen?: () => boolean
}

export interface WorkspaceAllowlistStore {
  list: () => RemoteWorkspaceEntry[]
  upsert: (entry: RemoteAllowlistUpsertInput) => RemoteWorkspaceEntry
  remove: (workspaceId: string) => boolean
  clear: () => void
}

export interface WorkspaceServiceDeps {
  appStore: WorkspaceServiceStore
  allowlist: WorkspaceAllowlistStore
  canonicalPath: (path: string) => string
  /** Resolve only an existing directory, returning its canonical filesystem path. */
  resolveRealDirectory?: (path: string) => Promise<string>
  selectDirectory: () => Promise<string | null>
  checkTrust: (workspacePath: string) => TrustStatusResult
}

/** Narrow Host setup input; never accepts grants, remote policy, or a full record. */
export interface RegisterWorkspaceInput {
  readonly selectedPath: string
  readonly displayName?: unknown
  readonly pinned?: unknown
}

/**
 * WorkspaceService — Phase B4 extraction.
 *
 * Owns the workspace/admin IPC policy while keeping path persistence
 * inside AppStore and remote allowlist persistence inside the existing
 * RemoteWorkspaceAllowlist instance.
 */
export class WorkspaceService {
  constructor(private deps: WorkspaceServiceDeps) {}

  getWorkspaces(): WorkspaceRecord[] {
    return this.deps.appStore.getWorkspaces()
  }

  addOrUpdateWorkspace(path: string, partial: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
    const workspacePath = this.requireRegisteredWorkspace(path)
    return this.deps.appStore.addOrUpdateWorkspace(
      workspacePath,
      this.safeWorkspacePartial(partial)
    )
  }

  addOrUpdateWorkspaceViaHost(
    path: string,
    partial: Partial<WorkspaceRecord> = {}
  ): Promise<WorkspaceRecord> {
    const workspacePath = this.requireRegisteredWorkspace(path)
    if (!this.deps.appStore.addOrUpdateWorkspaceViaHost) {
      throw new Error('Host-routed workspace upsert is unavailable.')
    }
    return this.deps.appStore.addOrUpdateWorkspaceViaHost(
      workspacePath,
      this.safeWorkspacePartial(partial)
    )
  }

  legacyStoreWritesOpen(): boolean {
    return this.deps.appStore.legacyStoreWritesOpen?.() ?? true
  }

  removeWorkspace(id: string): void {
    this.deps.appStore.removeWorkspace(id)
  }

  removeWorkspaceViaHost(id: string): Promise<void> {
    if (!this.deps.appStore.removeWorkspaceViaHost) {
      throw new Error('Host-routed workspace removal is unavailable.')
    }
    return this.deps.appStore.removeWorkspaceViaHost(id)
  }

  clearWorkspaces(): void {
    this.deps.appStore.clearWorkspaces()
  }

  clearWorkspacesViaHost(): Promise<void> {
    if (!this.deps.appStore.clearWorkspacesViaHost) {
      throw new Error('Host-routed workspace clear is unavailable.')
    }
    return this.deps.appStore.clearWorkspacesViaHost()
  }

  async selectWorkspace(): Promise<WorkspaceRecord | null> {
    const path = await this.deps.selectDirectory()
    if (!path) return null
    return this.addWorkspaceFromNativeSelection(path)
  }

  /**
   * Host-adaptable native-selection registration. The filesystem realpath is
   * the idempotency key; lexical aliases never create a second workspace and
   * this method never issues a path grant or remote allowlist entry.
   */
  async registerWorkspace(input: RegisterWorkspaceInput): Promise<WorkspaceRecord> {
    if (!input || typeof input !== 'object') {
      throw new Error('Workspace registration input is required.')
    }
    const lexicalPath = this.deps.canonicalPath(
      requireNonEmptyString(input.selectedPath, 'Workspace selection')
    )
    this.assertSafeWorkspaceRoot(lexicalPath)
    const realPath = await this.resolveRealDirectory(lexicalPath)
    const existing = this.deps.appStore.getWorkspaces().find((workspace) => {
      const candidate = workspace.realPath || workspace.path
      return this.tryCanonicalPath(candidate) === realPath
    })
    const partial: Partial<WorkspaceRecord> = { realPath }
    const displayName = sanitizeWorkspaceDisplayName(input.displayName)
    if (displayName !== undefined) partial.displayName = displayName
    if (typeof input.pinned === 'boolean') partial.pinned = input.pinned

    // Preserve an existing record's stable id/path while pinning its verified
    // canonical realpath. A newly selected directory is stored by realpath.
    if (this.legacyStoreWritesOpen()) {
      return this.deps.appStore.addOrUpdateWorkspace(existing?.path || realPath, partial)
    }
    if (!this.deps.appStore.addOrUpdateWorkspaceViaHost) {
      throw new Error('Host-routed workspace upsert is unavailable.')
    }
    return this.deps.appStore.addOrUpdateWorkspaceViaHost(existing?.path || realPath, partial)
  }

  /**
   * Conservatively pins legacy workspace records at startup. Only a direct
   * lexical path whose canonical spelling already equals its filesystem
   * realpath is adopted. Existing pins are never repaired or rotated here.
   *
   * Error honesty: missing/unreadable/unsafe legacy paths stay silently
   * unpinned (they were never writable to begin with), but a REFUSED write —
   * the Host-owned gate, or the Host itself failing — is made visible once per
   * launch rather than swallowed, and never fails startup: reconciliation
   * simply retries next launch.
   */
  async reconcileWorkspaceRealPaths(log?: (line: string) => void): Promise<number> {
    let pinned = 0
    const refusals: Array<{ workspaceId: string; error: unknown }> = []
    for (const workspace of this.deps.appStore.getWorkspaces()) {
      if (workspace.realPath) continue
      let realPath: string
      try {
        const lexicalPath = this.deps.canonicalPath(workspace.path)
        this.assertSafeWorkspaceRoot(lexicalPath)
        realPath = await this.resolveRealDirectory(lexicalPath)
        if (this.deps.canonicalPath(realPath) !== lexicalPath) continue
      } catch {
        // Missing, unreadable, non-directory, and otherwise unsafe legacy
        // paths remain unpinned until the user selects them again.
        continue
      }
      try {
        const updated = this.legacyStoreWritesOpen()
          ? this.deps.appStore.pinWorkspaceRealPath(workspace.id, workspace.path, realPath)
          : await this.deps.appStore.pinWorkspaceRealPathViaHost?.(
              workspace.id,
              workspace.path,
              realPath
            )
        if (!updated) continue
        pinned++
        log?.(`[workspace-target] pinned ${workspace.id} (${workspace.path})`)
      } catch (error) {
        refusals.push({ workspaceId: workspace.id, error })
      }
    }
    if (refusals.length > 0) {
      console.warn(
        `[workspace-target] realpath pinning was refused for ${refusals.length} workspace(s) ` +
          `(${refusals.map((refusal) => refusal.workspaceId).join(', ')}); startup continues and the pin retries next launch:`,
        refusals[0].error
      )
    }
    return pinned
  }

  listRemoteAllowlist(): RemoteWorkspaceEntry[] {
    return this.deps.allowlist.list()
  }

  upsertRemoteAllowlist(entry: RemoteAllowlistUpsertInput): RemoteWorkspaceEntry {
    if (!entry || typeof entry !== 'object') {
      throw new Error('bridge-allowlist-upsert: entry must be an object')
    }
    const workspaceId = requireNonEmptyString(entry.workspaceId, 'workspaceId')
    const path = requireNonEmptyString(entry.path, 'path')
    if (entry.mode !== 'read-only' && entry.mode !== 'read-write') {
      throw new Error(
        `bridge-allowlist-upsert: mode must be 'read-only' or 'read-write' (got '${entry.mode}')`
      )
    }
    if (
      entry.expiresAt !== undefined &&
      (typeof entry.expiresAt !== 'number' || entry.expiresAt <= 0)
    ) {
      throw new Error(
        'bridge-allowlist-upsert: expiresAt must be a positive number (ms since epoch)'
      )
    }
    if (
      entry.capabilities !== undefined &&
      (!Array.isArray(entry.capabilities) || !entry.capabilities.every(isRemoteWorkspaceCapability))
    ) {
      throw new Error('bridge-allowlist-upsert: capabilities must be RemoteWorkspaceCapability[]')
    }
    const target = this.resolveAllowlistTarget(workspaceId, path)
    return this.deps.allowlist.upsert({
      workspaceId: target.workspaceId,
      path: target.path,
      mode: entry.mode,
      ...(entry.capabilities !== undefined ? { capabilities: entry.capabilities } : {}),
      expiresAt: entry.expiresAt
    })
  }

  /**
   * Resolve user-supplied allowlist identifiers to the REAL workspace
   * record. Allowlist visibility + per-action evaluation match on the
   * store's workspace `id` (a uuid the user has no way to know), but the
   * Settings form historically accepted free text — entries like
   * `workspaceId: "Test 1"` / `path: "'/Users/x/Test 1'"` (display name
   * as id, quotes pasted into the path) matched nothing and silently
   * denied everything. Resolution order: exact id → canonicalized path →
   * displayName (only when unambiguous). Unresolvable input is kept
   * as-is (trimmed/unquoted) so policy stays deny-by-default rather than
   * guessing.
   */
  private resolveAllowlistTarget(
    workspaceId: string,
    path: string
  ): { workspaceId: string; path: string } {
    const cleanId = workspaceId.trim()
    const cleanPath = stripWrappingQuotes(path.trim())
    const workspaces = this.deps.appStore.getWorkspaces()
    const byId = workspaces.find((ws) => ws.id === cleanId)
    if (byId) return { workspaceId: byId.id, path: byId.path }
    const normalized = this.tryCanonicalPath(cleanPath)
    if (normalized) {
      const byPath = workspaces.find(
        (ws) => this.tryCanonicalPath(ws.path) === normalized
      )
      if (byPath) return { workspaceId: byPath.id, path: byPath.path }
    }
    const byName = workspaces.filter((ws) => (ws.displayName || '').trim() === cleanId)
    if (byName.length === 1) return { workspaceId: byName[0].id, path: byName[0].path }
    return { workspaceId: cleanId, path: cleanPath }
  }

  /**
   * Startup repair for the misentered-identifier class above: any
   * persisted entry whose workspaceId doesn't match a real workspace is
   * re-resolved (path, then unique displayName) and rewritten with the
   * real id + canonical path. Returns the number of repaired entries.
   * Unresolvable entries are left untouched — they keep denying, and the
   * Settings panel shows them for manual cleanup.
   */
  reconcileRemoteAllowlist(log?: (line: string) => void): number {
    const knownIds = new Set(this.deps.appStore.getWorkspaces().map((ws) => ws.id))
    let repaired = 0
    for (const entry of this.deps.allowlist.list()) {
      if (knownIds.has(entry.workspaceId)) continue
      const target = this.resolveAllowlistTarget(entry.workspaceId, entry.path)
      if (!knownIds.has(target.workspaceId)) continue
      this.deps.allowlist.remove(entry.workspaceId)
      this.deps.allowlist.upsert({
        workspaceId: target.workspaceId,
        path: target.path,
        mode: entry.mode,
        capabilities: [...capabilitiesForRemoteWorkspaceEntry(entry)],
        expiresAt: entry.expiresAt
      })
      repaired++
      log?.(
        `[remote-allowlist] repaired entry '${entry.workspaceId}' → ${target.workspaceId} (${target.path})`
      )
    }
    return repaired
  }

  private tryCanonicalPath(value: string): string | null {
    try {
      return this.deps.canonicalPath(value)
    } catch {
      return null
    }
  }

  removeRemoteAllowlist(workspaceId: string): boolean {
    return this.deps.allowlist.remove(requireNonEmptyString(workspaceId, 'workspaceId'))
  }

  clearRemoteAllowlist(): true {
    this.deps.allowlist.clear()
    return true
  }

  checkTrust(workspacePath: string): TrustStatusResult {
    return this.deps.checkTrust(this.requireRegisteredWorkspace(workspacePath))
  }

  findRegisteredWorkspace(workspacePath: string): WorkspaceRecord | undefined {
    const normalized = this.deps.canonicalPath(workspacePath)
    return this.deps.appStore
      .getWorkspaces()
      .find((workspace) => this.deps.canonicalPath(workspace.path) === normalized)
  }

  requireRegisteredWorkspace(workspacePath: string, label = 'Workspace'): string {
    const normalized = this.deps.canonicalPath(requireNonEmptyString(workspacePath, label))
    this.assertSafeWorkspaceRoot(normalized)
    if (!this.findRegisteredWorkspace(normalized)) {
      throw new Error(`${label} must be selected through TaskWraith before it can be used.`)
    }
    return normalized
  }

  async addWorkspaceFromNativeSelection(workspacePath: string): Promise<WorkspaceRecord> {
    const normalized = this.deps.canonicalPath(requireNonEmptyString(workspacePath, 'Workspace'))
    this.assertSafeWorkspaceRoot(normalized)
    const realPath = await this.resolveRealDirectory(normalized)
    return this.deps.appStore.addOrUpdateWorkspace(normalized, { realPath })
  }

  private safeWorkspacePartial(partial: Partial<WorkspaceRecord> = {}): Partial<WorkspaceRecord> {
    const allowed: Partial<WorkspaceRecord> = {}
    if (typeof partial.displayName === 'string') allowed.displayName = partial.displayName
    if (typeof partial.branch === 'string') allowed.branch = partial.branch
    if (typeof partial.pinned === 'boolean') allowed.pinned = partial.pinned
    if ('geminiWorktree' in partial) {
      const geminiWorktree = sanitizeWorkspaceGeminiWorktree(partial.geminiWorktree)
      if (geminiWorktree) allowed.geminiWorktree = geminiWorktree
    }
    return allowed
  }

  private assertSafeWorkspaceRoot(workspacePath: string): void {
    const normalized = this.deps.canonicalPath(workspacePath)
    const root = parse(normalized).root
    if (normalized === root) {
      throw new Error('Filesystem roots cannot be registered as workspaces.')
    }
  }

  private async resolveRealDirectory(workspacePath: string): Promise<string> {
    const resolver = this.deps.resolveRealDirectory || resolveRealDirectory
    const resolved = this.deps.canonicalPath(await resolver(workspacePath))
    this.assertSafeWorkspaceRoot(resolved)
    return resolved
  }
}

async function resolveRealDirectory(workspacePath: string): Promise<string> {
  const resolved = await realpath(workspacePath)
  const info = await stat(resolved)
  if (!info.isDirectory()) {
    throw new Error('Workspace must resolve to a directory.')
  }
  return resolved
}

function sanitizeWorkspaceGeminiWorktree(
  value: unknown
): WorkspaceRecord['geminiWorktree'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const sanitized: WorkspaceRecord['geminiWorktree'] = {
    enabled: Boolean(record.enabled)
  }
  if (typeof record.name === 'string' && record.name.trim()) {
    sanitized.name = record.name.trim()
  }
  return sanitized
}

function sanitizeWorkspaceDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, 160)
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

/** Strip one matching pair of wrapping quotes — `'/a/b'` or `"/a/b"` →
 * `/a/b`. Pasted shell-quoted paths are the common allowlist typo. */
function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1).trim()
    }
  }
  return value
}
