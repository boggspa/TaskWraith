import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { classifyReleaseCommand } from './ReleaseCommandPolicy'
import type {
  ReleaseCommandApprovalSource,
  ReleaseCommandCheckOptions
} from './ReleaseCommandPolicy'

/**
 * Session release lease.
 *
 * `ReleaseCommandPolicy` blocks release-class commands (git push, gh release,
 * notarytool, npm publish, ...) unless the caller presents an approval source.
 * Two of the five declared sources were ever wired: `externalPublishReceipt`
 * for the dedicated git_push/git_create_pr executors, and `approvedHostCommand`
 * for the Codex approval re-run. Every other route — the brokered MCP shell,
 * run_task, and background processes — had no way to satisfy the gate at all,
 * so an agent working to an explicit user directive with nobody at the keyboard
 * simply stalled. That is what this lease exists to fix.
 *
 * The lease is a machine-readable form of "I am going AFK, you are authorized
 * to publish": the user grants it once, it carries a ceiling and an explicit
 * command-class scope, and it satisfies the gate on every route while it is
 * live. Default-closed is preserved — no lease, no release command.
 */

/** Hard ceiling on a single grant. A lease is session scope, not a standing grant. */
export const RELEASE_LEASE_MAX_MINUTES = 720
export const RELEASE_LEASE_DEFAULT_MINUTES = 120

export type ReleaseLeaseOrigin = 'desktop-ui' | 'ios-bridge' | 'host'

/** `'all'` covers every release class; a list covers exactly the named classes. */
export type ReleaseLeaseCommandScope = 'all' | string[]

export interface ReleaseAuthorizationLeaseGrantInput {
  commandClasses?: ReleaseLeaseCommandScope
  /** Scope the lease to one workspace. Omitted leases cover any workspace. */
  workspacePath?: string
  minutes?: number
  note?: string
  origin?: ReleaseLeaseOrigin
}

export interface ReleaseAuthorizationLease {
  id: string
  commandClasses: ReleaseLeaseCommandScope
  workspacePath?: string
  grantedAt: string
  expiresAt: string
  note?: string
  origin: ReleaseLeaseOrigin
}

export interface ReleaseLeaseApprovalQuery {
  command: unknown
  source: ReleaseCommandApprovalSource
  workspacePath?: string
}

export interface ReleaseLeaseApproval {
  lease: ReleaseAuthorizationLease
  commandClass: string
  approval: ReleaseCommandCheckOptions
}

export interface ReleaseAuthorizationLeaseRegistryOptions {
  now?: () => number
  idFactory?: () => string
  log?: (line: string) => void
}

function normalizeWorkspacePath(value: unknown): string | undefined {
  const text = String(value || '').trim()
  if (!text) return undefined
  try {
    return resolve(text)
  } catch {
    return undefined
  }
}

function normalizeCommandScope(
  value: ReleaseLeaseCommandScope | undefined
): ReleaseLeaseCommandScope {
  if (!value || value === 'all') return 'all'
  const classes = value
    .map((entry) =>
      String(entry || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean)
  return classes.length ? Array.from(new Set(classes)) : 'all'
}

function clampMinutes(value: unknown): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes <= 0) return RELEASE_LEASE_DEFAULT_MINUTES
  return Math.min(Math.floor(minutes), RELEASE_LEASE_MAX_MINUTES)
}

export class ReleaseAuthorizationLeaseRegistry {
  private readonly leases = new Map<string, ReleaseAuthorizationLease>()
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly log?: (line: string) => void

  constructor(options: ReleaseAuthorizationLeaseRegistryOptions = {}) {
    this.now = options.now || (() => Date.now())
    this.idFactory = options.idFactory || (() => randomUUID())
    this.log = options.log
  }

  grant(input: ReleaseAuthorizationLeaseGrantInput = {}): ReleaseAuthorizationLease {
    const grantedAtMs = this.now()
    const minutes = clampMinutes(input.minutes)
    const lease: ReleaseAuthorizationLease = {
      id: this.idFactory(),
      commandClasses: normalizeCommandScope(input.commandClasses),
      grantedAt: new Date(grantedAtMs).toISOString(),
      expiresAt: new Date(grantedAtMs + minutes * 60_000).toISOString(),
      origin: input.origin || 'desktop-ui'
    }
    const workspacePath = normalizeWorkspacePath(input.workspacePath)
    if (workspacePath) lease.workspacePath = workspacePath
    const note = String(input.note || '').trim()
    if (note) lease.note = note.slice(0, 400)
    this.leases.set(lease.id, lease)
    this.log?.(
      `[release-lease] granted ${lease.id} for ${minutes}m scope=${
        lease.commandClasses === 'all' ? 'all' : lease.commandClasses.join(',')
      } workspace=${lease.workspacePath || 'any'}`
    )
    return lease
  }

  /** Revoke one lease by id, or every lease when no id is given. Returns the count revoked. */
  revoke(id?: string): number {
    if (!id) {
      const count = this.leases.size
      this.leases.clear()
      if (count) this.log?.(`[release-lease] revoked all (${count})`)
      return count
    }
    const removed = this.leases.delete(id)
    if (removed) this.log?.(`[release-lease] revoked ${id}`)
    return removed ? 1 : 0
  }

  /** Live leases, pruning anything that has expired. */
  active(): ReleaseAuthorizationLease[] {
    const nowMs = this.now()
    for (const [id, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) <= nowMs) this.leases.delete(id)
    }
    return Array.from(this.leases.values())
  }

  /**
   * The single call every enforcement route makes. Returns an approval only
   * when the command is genuinely release-class AND a live, in-scope lease
   * covers it; `null` otherwise, so the caller's existing block reason stands.
   */
  approvalFor(query: ReleaseLeaseApprovalQuery): ReleaseLeaseApproval | null {
    const classified = classifyReleaseCommand(query.command)
    if (!classified) return null
    return this.approvalForClass(classified.commandClass, query)
  }

  /**
   * Approve a class the caller already resolved. `releaseScriptBlockReason`
   * blocks a package script on its NAME as well as its body, and a bare task
   * name does not classify as a command — so that route has to name its own
   * class rather than hand us a command line.
   */
  approvalForClass(
    commandClass: string,
    query: Omit<ReleaseLeaseApprovalQuery, 'command'>
  ): ReleaseLeaseApproval | null {
    const normalizedClass = String(commandClass || '')
      .trim()
      .toLowerCase()
    if (!normalizedClass) return null
    const requestedWorkspace = normalizeWorkspacePath(query.workspacePath)
    for (const lease of this.active()) {
      if (lease.workspacePath && lease.workspacePath !== requestedWorkspace) continue
      if (lease.commandClasses !== 'all' && !lease.commandClasses.includes(normalizedClass))
        continue
      return {
        lease,
        commandClass,
        approval: { allowReleaseCommand: true, approvalSource: query.source }
      }
    }
    return null
  }
}
