import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

/**
 * RemoteWorkspaceAllowlist — Electron-side policy primitive for what an iOS
 * device is allowed to do against which workspace.
 *
 * Mirrors the shape of `CodexBridge/Sources/WorkspaceSecurity/
 * WorkspaceAllowlist.swift`, but the model lives Electron-side because
 * TaskWraith's main process owns the
 * workspace list and the agent runtime. The Swift bridge daemon never has
 * to know about workspaces directly; it just relays a `workspaceID` in
 * `bridge.requestPrepareStartTurnAck` and BridgeActionRouter consults this
 * allowlist before deciding.
 *
 * **Default policy: closed.** A workspace is NOT remote-accessible until the
 * user explicitly adds an entry. There is no "everything is read-only by
 * default" mode — the iOS device only sees workspaces the user has opted in.
 *
 * **Per-action revalidation** (per the C4 plan): `evaluate(...)` is called on
 * every iOS-initiated request, not just once at session open. A workspace
 * entry can carry an `expiresAt` so a paired phone can be granted access
 * for a bounded window (e.g. "next 2 hours") without manual revocation. We
 * also re-check provider + approvalMode on every call, because both might
 * have been tightened on the desktop between iOS requests.
 *
 * **Persistence** is best-effort JSON via atomic tmp-and-rename. When no
 * `storagePath` is provided the allowlist is purely in-memory (used by
 * tests and for ephemeral dev sessions). On read errors the in-memory
 * state is empty — we prefer "deny everything" over "load a possibly-
 * tampered allowlist".
 */

export type RemoteWorkspaceMode = 'read-only' | 'read-write'

export type RemoteWorkspaceCapability =
  | 'monitor'
  | 'approve'
  | 'answer'
  | 'cancel'
  | 'startTurn'
  | 'diffReview'
  | 'steer'
  | 'fileBrowse'
  | 'fileRead'
  | 'fileWrite'
  /**
   * External publication from a paired device: git push and PR creation.
   * Deliberately separate from fileWrite so a phone that can edit/commit files
   * does not automatically gain publish authority.
   */
  | 'externalPublish'
  /**
   * Admin-only remote capability. Not part of read-write task-console
   * defaults; it must be explicitly present on an allowlist entry before a
   * paired device can pin/unpin chats or workspaces.
   */
  | 'pin'
  /**
   * Admin-only remote capability. Not part of read-write task-console
   * defaults; it must be explicitly present on an allowlist entry before a
   * paired device can toggle session YOLO.
   */
  | 'yolo'

export const READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'monitor',
  'approve'
]

export const READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'monitor',
  'approve',
  'answer',
  'cancel',
  'startTurn',
  'diffReview',
  'steer',
  'fileBrowse',
  'fileRead',
  'fileWrite'
]

/** Pre-file-editor read-write set. Entries persisted WITHOUT explicit
 * capabilities predate remote file editing — they materialize to THIS set,
 * not the expanded default (security review: a new power must not silently
 * attach to old grants). New grants + the Devices panel checkboxes write
 * explicit capability lists, which include the file trio when chosen. */
export const LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] =
  ['monitor', 'approve', 'answer', 'cancel', 'startTurn', 'diffReview', 'steer']

export const ADMIN_REMOTE_WORKSPACE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'externalPublish',
  'pin',
  'yolo'
]

/** T71/T72 — the reserved workspace-id phones use for scope-global chats
 * (chats with no workspace). Evaluated as a SYNTHETIC entry — never
 * persisted, never listed, only live when at least one real workspace is
 * allowlisted. Real workspace ids are UUIDs/paths, so 'global' can't
 * collide. */
export const GLOBAL_REMOTE_SCOPE = 'global'

/** What a paired device may do in global chats: the CONVERSATIONAL set —
 * initiate and participate (startTurn/answer/approve/cancel), steer global
 * ensembles, and monitor. Deliberately absent: diffReview + the file trio
 * (global chats have no workspace and phone-origin turns must never mutate
 * files) and the admin caps. The no-mutation guarantee itself is enforced
 * by the approval-mode clamp below plus the forced-plan dispatch in
 * composerPromptFn. */
export const GLOBAL_REMOTE_SCOPE_CAPABILITIES: readonly RemoteWorkspaceCapability[] = [
  'monitor',
  'approve',
  'answer',
  'cancel',
  'startTurn',
  'steer'
]

/** The virtual entry `evaluate` returns for the global scope. The phone may
 * use any provider, but the ONLY approval mode is `plan` — a phone-origin
 * turn in a global chat always runs read-only (no file mutation). */
function globalRemoteScopeEntry(): RemoteWorkspaceEntry {
  return {
    workspaceId: GLOBAL_REMOTE_SCOPE,
    path: '',
    mode: 'read-only',
    capabilities: [...GLOBAL_REMOTE_SCOPE_CAPABILITIES],
    allowedProviders: [],
    allowedApprovalModes: ['plan'],
    createdAt: 0,
    updatedAt: 0
  }
}

export interface RemoteWorkspaceCapabilityDescription {
  capability: RemoteWorkspaceCapability
  label: string
  description: string
  adminOnly: boolean
}

export const REMOTE_WORKSPACE_CAPABILITY_DESCRIPTIONS: Record<
  RemoteWorkspaceCapability,
  RemoteWorkspaceCapabilityDescription
> = {
  monitor: {
    capability: 'monitor',
    label: 'Monitor tasks',
    description: 'View remote task status, transcript projections, and pending prompts.',
    adminOnly: false
  },
  approve: {
    capability: 'approve',
    label: 'Approve prompts',
    description: 'Respond to desktop-origin approval requests from a paired device.',
    adminOnly: false
  },
  answer: {
    capability: 'answer',
    label: 'Answer questions',
    description: 'Send answers back to agent questions that are waiting for user input.',
    adminOnly: false
  },
  cancel: {
    capability: 'cancel',
    label: 'Cancel work',
    description: 'Cancel active runs, rounds, or pending wakeups from a paired device.',
    adminOnly: false
  },
  startTurn: {
    capability: 'startTurn',
    label: 'Start turns',
    description: 'Start a new provider turn against the allowlisted workspace.',
    adminOnly: false
  },
  diffReview: {
    capability: 'diffReview',
    label: 'Review diffs',
    description: 'Inspect bounded diff summaries sent to the paired device.',
    adminOnly: false
  },
  steer: {
    capability: 'steer',
    label: 'Steer ensembles',
    description: 'Queue, steer, skip, or wake Ensemble participants from the paired device.',
    adminOnly: false
  },
  fileBrowse: {
    capability: 'fileBrowse',
    label: 'Browse files',
    description: 'List editable files in the allowlisted workspace from a paired device.',
    adminOnly: false
  },
  fileRead: {
    capability: 'fileRead',
    label: 'Read files',
    description: 'Open UTF-8 text files in the allowlisted workspace from a paired device.',
    adminOnly: false
  },
  fileWrite: {
    capability: 'fileWrite',
    label: 'Write files',
    description: 'Save UTF-8 text files in the allowlisted workspace from a paired device.',
    adminOnly: false
  },
  externalPublish: {
    capability: 'externalPublish',
    label: 'Publish externally (admin)',
    description: 'Push branches or create pull requests from a paired device.',
    adminOnly: true
  },
  pin: {
    capability: 'pin',
    label: 'Pin items (admin)',
    description: 'Pin or unpin chats and workspaces from a paired device.',
    adminOnly: true
  },
  yolo: {
    capability: 'yolo',
    label: 'Session YOLO (admin)',
    description: 'Toggle the desktop session YOLO approval bypass from a paired device.',
    adminOnly: true
  }
}

export interface RemoteWorkspaceEntry {
  /** Stable id used by TaskWraith's internal workspace registry. */
  workspaceId: string
  /** Absolute path on disk. Informational; not used for evaluation today. */
  path: string
  /** `read-only`: iOS can watch + approve, never mutate. `read-write`: iOS
   * can compose, run, and approve. The router uses this to gate actions
   * that mutate state (Phase C-late, when typed action payloads land). */
  mode: RemoteWorkspaceMode
  /** Optional future policy shape. When omitted, `mode` maps to the default
   * capability sets above so existing allowlist entries keep working until
   * the persisted store and renderer grow first-class capability controls. */
  capabilities?: RemoteWorkspaceCapability[]
  /** Provider IDs (e.g. `'gemini'`, `'codex'`, `'claude'`, `'kimi'`) that the
   * iOS client may select for this workspace. Empty array = no providers
   * allowed (the workspace is read-only-watch in practice). */
  allowedProviders: string[]
  /** Approval modes (`'default'`, `'plan'`, `'allow-all'`) the iOS client
   * may select. Typically `['default', 'plan']` for phone clients; we leave
   * `'allow-all'` out by default since that's a desktop-only escalation. */
  allowedApprovalModes: string[]
  /** Optional auto-revoke timestamp (ms since epoch). The desktop UI can
   * surface "expires in N minutes". After this point the entry is treated
   * as denied without being deleted (a grace period for renewal). */
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

export interface PrepareStartTurnEvaluation {
  workspaceId: string
  /** Optional — the iOS prepare-start-turn payload may not always include a
   * provider hint. When omitted, only workspace + expiry + mode are checked. */
  provider?: string
  /** Same caveat as `provider`. */
  approvalMode?: string
  /** Optional fine-grained capability required by the action being evaluated. */
  capability?: RemoteWorkspaceCapability
}

export type AllowlistDecision =
  | { allowed: true; entry: RemoteWorkspaceEntry }
  | { allowed: false; reason: string }

export interface RemoteWorkspaceAllowlistOptions {
  /** Filesystem path for the JSON allowlist file. When omitted, the
   * allowlist is in-memory only (tests, ephemeral dev). */
  storagePath?: string
  /** Clock injectable for tests. */
  now?: () => number
  /** Logger sink. Defaults to no-op. Production wires console.log. */
  log?: (line: string) => void
}

interface PersistedShape {
  version: number
  entries: RemoteWorkspaceEntry[]
}

const SCHEMA_VERSION = 1

export class RemoteWorkspaceAllowlist {
  private readonly entries = new Map<string, RemoteWorkspaceEntry>()
  private readonly storagePath?: string
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(options: RemoteWorkspaceAllowlistOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    if (this.storagePath) {
      this.loadFromDisk()
    }
  }

  /** Number of entries currently held (active + expired). */
  size(): number {
    return this.entries.size
  }

  /** Add or replace an entry. Timestamps are managed internally. */
  upsert(entry: Omit<RemoteWorkspaceEntry, 'createdAt' | 'updatedAt'>): RemoteWorkspaceEntry {
    const now = this.now()
    const existing = this.entries.get(entry.workspaceId)
    const merged: RemoteWorkspaceEntry = {
      ...entry,
      // Materialize capabilities EXPLICITLY at write time: new/updated
      // grants get the full current default for their mode, so only
      // entries persisted before this change (no explicit list) count as
      // legacy — and those deliberately exclude later-added powers (the
      // file-editing trio). Callers passing an explicit list keep it.
      capabilities: entry.capabilities ?? [...capabilitiesForRemoteWorkspaceMode(entry.mode)],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.entries.set(entry.workspaceId, merged)
    this.persist()
    this.log(
      `[RemoteWorkspaceAllowlist] upserted workspaceId=${entry.workspaceId} mode=${entry.mode}`
    )
    return merged
  }

  /** Remove an entry. Returns whether anything was removed. */
  remove(workspaceId: string): boolean {
    const had = this.entries.delete(workspaceId)
    if (had) {
      this.persist()
      this.log(`[RemoteWorkspaceAllowlist] removed workspaceId=${workspaceId}`)
    }
    return had
  }

  /** Snapshot of all entries (caller may not mutate the array members). */
  list(): RemoteWorkspaceEntry[] {
    return Array.from(this.entries.values())
  }

  /** Stable fingerprint of the effective remote allowlist policy. */
  fingerprint(): string {
    const effectivePolicy = {
      schemaVersion: SCHEMA_VERSION,
      globalScope: {
        enabled: this.entries.size > 0,
        capabilities: [...GLOBAL_REMOTE_SCOPE_CAPABILITIES].sort(),
        allowedApprovalModes: ['plan']
      },
      entries: Array.from(this.entries.values())
        .map((entry) => ({
          workspaceId: entry.workspaceId,
          path: entry.path,
          mode: entry.mode,
          capabilities: [...capabilitiesForRemoteWorkspaceEntry(entry)].sort(),
          allowedProviders: [...entry.allowedProviders].sort(),
          allowedApprovalModes: [...entry.allowedApprovalModes].sort(),
          ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {})
        }))
        .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    }
    return createHash('sha256').update(stableJson(effectivePolicy)).digest('hex')
  }

  get(workspaceId: string): RemoteWorkspaceEntry | null {
    return this.entries.get(workspaceId) ?? null
  }

  /** Drop every entry. Useful for tests and the future admin "revoke all"
   * action. Persists immediately. */
  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.persist()
    this.log('[RemoteWorkspaceAllowlist] cleared all entries')
  }

  /** Per-action revalidation hook. Called on every iOS request that names
   * a workspace. Returns a structured decision so the router can surface a
   * useful reason in the ack message. */
  evaluate(check: PrepareStartTurnEvaluation): AllowlistDecision {
    // T71/T72 — the synthetic GLOBAL scope: scope-global chats (no
    // workspace) are CONVERSATIONAL from a paired device — initiate,
    // participate, answer, approve, cancel, steer ensembles — but every
    // phone-origin turn runs in plan mode (no file mutation). The virtual
    // entry exists only when the user has allowlisted at least one real
    // workspace (an empty allowlist stays a blank slate) and is never
    // persisted or listed. File/diff/admin capabilities deny outright;
    // any approval mode other than 'plan' denies with the why.
    if (check.workspaceId === GLOBAL_REMOTE_SCOPE) {
      if (this.entries.size === 0) {
        return {
          allowed: false,
          reason: 'Global chats are not shared while the workspace allowlist is empty'
        }
      }
      if (
        check.capability !== undefined &&
        !GLOBAL_REMOTE_SCOPE_CAPABILITIES.includes(check.capability)
      ) {
        const description = describeRemoteWorkspaceCapability(check.capability)
        return {
          allowed: false,
          reason: `Capability "${check.capability}" (${description.label}) is not allowed for global chats — paired devices get conversation only, with no file access`
        }
      }
      if (check.approvalMode !== undefined && check.approvalMode !== 'plan') {
        return {
          allowed: false,
          reason: `Approval mode "${check.approvalMode}" is not allowed for global chats — phone-origin turns always run in plan mode (no file changes)`
        }
      }
      return { allowed: true, entry: globalRemoteScopeEntry() }
    }
    const entry = this.entries.get(check.workspaceId)
    if (!entry) {
      return {
        allowed: false,
        reason: `Workspace "${check.workspaceId}" is not on the remote allowlist`
      }
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      return {
        allowed: false,
        reason: `Workspace "${check.workspaceId}" allowlist entry expired at ${new Date(entry.expiresAt).toISOString()}`
      }
    }
    if (check.provider !== undefined && !entry.allowedProviders.includes(check.provider)) {
      return {
        allowed: false,
        reason: `Provider "${check.provider}" is not allowed for workspace "${check.workspaceId}"`
      }
    }
    const approvalMode = check.approvalMode ?? 'default'
    if (!entry.allowedApprovalModes.includes(approvalMode)) {
      return {
        allowed: false,
        reason: `Approval mode "${approvalMode}" is not allowed for workspace "${check.workspaceId}"`
      }
    }
    if (
      check.capability !== undefined &&
      !capabilitiesForRemoteWorkspaceEntry(entry).includes(check.capability)
    ) {
      const description = describeRemoteWorkspaceCapability(check.capability)
      return {
        allowed: false,
        reason: `Capability "${check.capability}" (${description.label}) is not allowed for workspace "${check.workspaceId}"`
      }
    }
    return { allowed: true, entry }
  }

  // MARK: - Persistence

  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const data: PersistedShape = {
        version: SCHEMA_VERSION,
        entries: Array.from(this.entries.values())
      }
      const serialized = JSON.stringify(data, null, 2)
      const tmpPath = `${this.storagePath}.tmp`
      writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 })
      renameSync(tmpPath, this.storagePath)
      chmodSync(this.storagePath, 0o600)
    } catch (err) {
      this.log(
        `[RemoteWorkspaceAllowlist] persist failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private loadFromDisk(): void {
    if (!this.storagePath || !existsSync(this.storagePath)) return
    try {
      const raw = readFileSync(this.storagePath, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!isPersistedShape(parsed)) {
        this.log(
          `[RemoteWorkspaceAllowlist] discarded malformed allowlist file at ${this.storagePath}`
        )
        return
      }
      if (parsed.version !== SCHEMA_VERSION) {
        // Future migration hook lands here. For now: drop unknown versions.
        this.log(
          `[RemoteWorkspaceAllowlist] unknown schema version ${parsed.version} — starting empty`
        )
        return
      }
      for (const entry of parsed.entries) {
        if (isValidEntry(entry)) {
          this.entries.set(entry.workspaceId, entry)
        }
      }
      this.log(
        `[RemoteWorkspaceAllowlist] loaded ${this.entries.size} entries from ${this.storagePath}`
      )
    } catch (err) {
      this.log(
        `[RemoteWorkspaceAllowlist] load failed (starting empty): ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

export function capabilitiesForRemoteWorkspaceMode(
  mode: RemoteWorkspaceMode
): readonly RemoteWorkspaceCapability[] {
  return mode === 'read-only'
    ? READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES
    : READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES
}

export function capabilitiesForRemoteWorkspaceEntry(
  entry: RemoteWorkspaceEntry
): readonly RemoteWorkspaceCapability[] {
  if (entry.capabilities) return entry.capabilities
  // No explicit list = a legacy grant: read-write materializes WITHOUT the
  // file-editing trio (added later); read-only is unchanged.
  return entry.mode === 'read-only'
    ? READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES
    : LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES
}

export function isAdminRemoteWorkspaceCapability(
  capability: RemoteWorkspaceCapability
): boolean {
  return ADMIN_REMOTE_WORKSPACE_CAPABILITIES.includes(capability)
}

export function describeRemoteWorkspaceCapability(
  capability: RemoteWorkspaceCapability
): RemoteWorkspaceCapabilityDescription {
  return REMOTE_WORKSPACE_CAPABILITY_DESCRIPTIONS[capability]
}

export function isRemoteWorkspaceCapability(value: unknown): value is RemoteWorkspaceCapability {
  return (
    value === 'monitor' ||
    value === 'approve' ||
    value === 'answer' ||
    value === 'cancel' ||
    value === 'startTurn' ||
    value === 'diffReview' ||
    value === 'steer' ||
    value === 'fileBrowse' ||
    value === 'fileRead' ||
    value === 'fileWrite' ||
    value === 'externalPublish' ||
    value === 'pin' ||
    value === 'yolo'
  )
}

function isPersistedShape(value: unknown): value is PersistedShape {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.version === 'number' && Array.isArray(v.entries)
}

function isValidEntry(value: unknown): value is RemoteWorkspaceEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.workspaceId === 'string' &&
    typeof v.path === 'string' &&
    (v.mode === 'read-only' || v.mode === 'read-write') &&
    (v.capabilities === undefined ||
      (Array.isArray(v.capabilities) &&
        (v.capabilities as unknown[]).every(isRemoteWorkspaceCapability))) &&
    Array.isArray(v.allowedProviders) &&
    (v.allowedProviders as unknown[]).every((p) => typeof p === 'string') &&
    Array.isArray(v.allowedApprovalModes) &&
    (v.allowedApprovalModes as unknown[]).every((p) => typeof p === 'string') &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number' &&
    (v.expiresAt === undefined || typeof v.expiresAt === 'number')
  )
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}
