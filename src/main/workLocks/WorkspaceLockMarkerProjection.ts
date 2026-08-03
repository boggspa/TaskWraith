import { createHash } from 'node:crypto'

import type { WorkspaceLockHunk, WorkspaceLockLease } from './WorkspaceLockTypes'

const ACTIVE_STATUSES = new Set<WorkspaceLockLease['status']>([
  'held',
  'orphan_live',
  'recovery_blocked'
])

export interface WorkspaceLockMarkerProjectionOptions {
  /**
   * Authority-supplied time at which this derived checkout view was made.
   * It is intentionally not persisted in the manual-marker-compatible body.
   */
  projectedAt: string
  /**
   * Short renewable expiry chosen by the authority. A marker alone never
   * extends a lock: the durable authority remains the source of truth.
   */
  expiresAt: string
}

/** One runtime-owned marker to atomically persist into an effective worktree. */
export interface WorkspaceLockMarkerProjection {
  /** Canonical effective-worktree root, safe to pass to marker persistence. */
  root: string
  /** Acquisition-time dev:ino identity used to reject root substitution. */
  rootObjectIdentity: string
  filename: string
  content: string
  lockOwnerId: string
  ownerRunId: string
  authorityInstanceId: string
  /** Auditable membership without exposing process-birth identities. */
  leaseIds: readonly string[]
}

interface MarkerGroup {
  root: string
  rootObjectIdentity: string
  lockOwnerId: string
  ownerRunId: string
  authorityInstanceId: string
  leases: WorkspaceLockLease[]
}

interface MarkerHunk {
  path: string
  baseline: string
  startLine: number
  endLine: number
}

/**
 * Produce the user-visible, runtime-owned work markers from authoritative
 * leases. These files are a projection for people and git hooks, never the
 * authority used to grant, retain, or recover a lock.
 */
export function projectWorkspaceLockMarkers(
  leases: readonly WorkspaceLockLease[],
  options: WorkspaceLockMarkerProjectionOptions
): WorkspaceLockMarkerProjection[] {
  const projectedAt = parseIsoTime(options.projectedAt, 'projectedAt')
  const expiresAt = parseIsoTime(options.expiresAt, 'expiresAt')
  if (expiresAt <= projectedAt) {
    throw new Error('Workspace-lock marker expiresAt must be later than projectedAt.')
  }

  const groups = new Map<string, MarkerGroup>()
  for (const lease of leases) {
    if (!ACTIVE_STATUSES.has(lease.status)) continue
    const root = lease.claim.worktreeCanonicalPath
    const rootObjectIdentity = lease.claim.worktreeObjectIdentity
    if (!rootObjectIdentity) {
      throw new Error('Workspace-lock marker lease lacks a physical worktree identity.')
    }
    const lockOwnerId = lease.owner.lockOwnerId
    const ownerRunId = lease.owner.runId
    const authorityInstanceId = lease.authorityInstanceId
    const key = JSON.stringify([root, lockOwnerId, authorityInstanceId])
    const group = groups.get(key)
    if (group) {
      if (group.rootObjectIdentity !== rootObjectIdentity) {
        throw new Error('Workspace-lock marker root maps to multiple physical identities.')
      }
      if (group.ownerRunId !== ownerRunId) {
        throw new Error('Workspace-lock marker owner identity maps to multiple runs.')
      }
      const representative = group.leases[0]
      if (
        representative.owner.pid !== lease.owner.pid ||
        representative.owner.processBirthIdentity !== lease.owner.processBirthIdentity ||
        (representative.owner.lifecycle || 'run') !== (lease.owner.lifecycle || 'run')
      ) {
        throw new Error(
          'Workspace-lock marker owner identity maps to multiple process incarnations.'
        )
      }
      group.leases.push(lease)
    } else {
      groups.set(key, {
        root,
        rootObjectIdentity,
        lockOwnerId,
        ownerRunId,
        authorityInstanceId,
        leases: [lease]
      })
    }
  }

  return [...groups.values()]
    .sort(compareGroups)
    .map((group) => projectGroup(group, options.expiresAt))
}

/** Runtime-marker filename accepted by NodeWorkspaceLockPersistence. */
export function workspaceLockRuntimeMarkerFilename(
  authorityInstanceId: string,
  lockOwnerId: string
): string {
  if (!authorityInstanceId || !lockOwnerId) {
    throw new Error('Workspace-lock marker filename requires authority and owner identities.')
  }
  const instancePrefix = sanitizeRuntimeMarkerInstanceId(authorityInstanceId)
  return `.WORK-IN-PROGRESS-taskwraith-runtime-${instancePrefix}-${sha256(
    authorityInstanceId
  )}-${sha256(lockOwnerId)}.md`
}

/** Keep the human-readable filename segment within the persistence allowlist. */
export function sanitizeRuntimeMarkerInstanceId(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (sanitized || 'instance').slice(0, 32)
}

function projectGroup(group: MarkerGroup, expiresAt: string): WorkspaceLockMarkerProjection {
  const leases = [...group.leases].sort(compareLeases)
  const representative = leases[0]
  const trees = sortedUnique(
    leases.filter((lease) => lease.claim.kind === 'tree').map((lease) => relativePath(lease))
  )
  const paths = sortedUnique(
    leases
      .filter((lease) => lease.claim.kind === 'file' || lease.claim.kind === 'hunk')
      .map((lease) => relativePath(lease))
  )
  const treeDigests = sortedUnique(trees.map(sha256))
  const pathDigests = sortedUnique(paths.map(sha256))
  const statuses = sortedUnique(leases.map((lease) => lease.status))
  const hunks = uniqueHunks(
    leases
      .filter((lease) => lease.claim.kind === 'hunk')
      .map((lease) => ({ path: relativePath(lease), ...requiredHunk(lease.claim.hunk) }))
  )
  const started = leases.reduce(
    (earliest, lease) => (lease.acquiredAt < earliest ? lease.acquiredAt : earliest),
    representative.acquiredAt
  )
  const lines = [
    '---',
    'derived: true',
    `lockOwnerId: ${yamlString(group.lockOwnerId)}`,
    `authorityInstanceId: ${yamlString(group.authorityInstanceId)}`,
    `session: ${yamlString(group.ownerRunId)}`,
    'agent: "taskwraith-runtime"',
    `pid: ${representative.owner.pid}`,
    `lifecycle: ${yamlString(representative.owner.lifecycle || 'run')}`,
    'authorityBlocking: true',
    'statuses:',
    ...statuses.map((status) => `  - ${yamlString(status)}`),
    `started: ${yamlString(started)}`,
    `expires: ${yamlString(expiresAt)}`,
    `worktree: ${yamlString(group.root)}`,
    `workspaceWide: ${leases.some((lease) => lease.claim.kind === 'workspace') ? 'true' : 'false'}`,
    'trees:',
    ...trees.map((tree) => `  - ${yamlString(tree)}`),
    'treeDigests:',
    ...treeDigests.map((digest) => `  - ${yamlString(digest)}`),
    'paths:',
    ...paths.map((path) => `  - ${yamlString(path)}`),
    'pathDigests:',
    ...pathDigests.map((digest) => `  - ${yamlString(digest)}`)
  ]

  if (representative.owner.displayName?.trim()) {
    lines.push(`owner: ${yamlString(representative.owner.displayName.trim())}`)
  }
  lines.push(`runId: ${yamlString(group.ownerRunId)}`)
  if (representative.owner.chatId) {
    lines.push(`taskId: ${yamlString(representative.owner.chatId)}`)
    lines.push(`chatId: ${yamlString(representative.owner.chatId)}`)
  }
  if (representative.owner.chatTitle?.trim()) {
    lines.push(`task: ${yamlString(representative.owner.chatTitle.trim())}`)
    lines.push(`chatTitle: ${yamlString(representative.owner.chatTitle.trim())}`)
  }
  if (representative.owner.provider) {
    lines.push(`provider: ${yamlString(representative.owner.provider)}`)
  }
  if (representative.owner.participantId) {
    lines.push(`participantId: ${yamlString(representative.owner.participantId)}`)
  }
  if (representative.owner.laneId) {
    lines.push(`laneId: ${yamlString(representative.owner.laneId)}`)
  }
  lines.push(`birthReceiptHash: ${yamlString(sha256(representative.owner.processBirthIdentity))}`)
  if (hunks.length) {
    lines.push('hunks:')
    for (const hunk of hunks) {
      lines.push(`  - path: ${yamlString(hunk.path)}`)
      lines.push(`    baseline: ${yamlString(hunk.baseline)}`)
      lines.push(`    startLine: ${hunk.startLine}`)
      lines.push(`    endLine: ${hunk.endLine}`)
    }
  }
  lines.push('---', 'Derived from active TaskWraith workspace locks. Do not edit manually.', '')

  return {
    root: group.root,
    rootObjectIdentity: group.rootObjectIdentity,
    filename: workspaceLockRuntimeMarkerFilename(group.authorityInstanceId, group.lockOwnerId),
    content: lines.join('\n'),
    lockOwnerId: group.lockOwnerId,
    ownerRunId: group.ownerRunId,
    authorityInstanceId: group.authorityInstanceId,
    leaseIds: leases.map((lease) => lease.leaseId)
  }
}

function compareGroups(left: MarkerGroup, right: MarkerGroup): number {
  return (
    compareStrings(left.root, right.root) ||
    compareStrings(left.authorityInstanceId, right.authorityInstanceId) ||
    compareStrings(left.lockOwnerId, right.lockOwnerId)
  )
}

function compareLeases(left: WorkspaceLockLease, right: WorkspaceLockLease): number {
  return (
    compareStrings(left.leaseId, right.leaseId) ||
    compareStrings(left.claim.kind, right.claim.kind) ||
    compareStrings(relativePath(left), relativePath(right)) ||
    compareStrings(left.acquiredAt, right.acquiredAt)
  )
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function relativePath(lease: WorkspaceLockLease): string {
  const value = lease.claim.relativeTargetPath
  if (value === undefined) {
    if (lease.claim.kind === 'workspace') return '.'
    throw new Error('Workspace-lock marker target lacks a relative path.')
  }
  if (value === '.' && lease.claim.kind === 'tree') return value
  assertCanonicalRelativePath(value)
  return value
}

function requiredHunk(hunk: WorkspaceLockHunk | undefined): WorkspaceLockHunk {
  if (!hunk) throw new Error('Workspace-lock hunk lease lacks a hunk descriptor.')
  return hunk
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function uniqueHunks(hunks: readonly MarkerHunk[]): MarkerHunk[] {
  const byKey = new Map<string, MarkerHunk>()
  for (const hunk of hunks) {
    byKey.set(JSON.stringify([hunk.path, hunk.baseline, hunk.startLine, hunk.endLine]), hunk)
  }
  return [...byKey.values()].sort(
    (left, right) =>
      compareStrings(left.path, right.path) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      compareStrings(left.baseline, right.baseline)
  )
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseIsoTime(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!value || Number.isNaN(parsed)) {
    throw new Error(`Workspace-lock marker ${label} must be an ISO timestamp.`)
  }
  return parsed
}

function assertCanonicalRelativePath(value: string): void {
  if (
    !value ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Workspace-lock marker target must be a canonical relative path.')
  }
}
