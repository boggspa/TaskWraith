/**
 * Pure ownership resolver for agent AppShots capture targets.
 *
 * A PID is owned when it is:
 * - the chat's currently attached Screen Watch window, or
 * - a TaskWraith-tracked spawn for this chat, or
 * - a live LaunchAttempt for this chat, or
 * - a live launch/spawn whose cwd/workspace sits inside the chat workspace
 *   (workspace-artifact path — e.g. `npm run dev` from project artifacts).
 *
 * Foreign PIDs fail closed here; the approval gate may still prompt for them
 * under Ask / Full Access, but auto-allow never does.
 */

export type AppshotsOwnershipKind =
  | 'attached'
  | 'spawned'
  | 'launch'
  | 'workspace-artifact'

export type AppshotsOwnershipReason =
  | AppshotsOwnershipKind
  | 'foreign'
  | 'missing'
  | 'mismatch'

export interface AppshotsOwnedProcess {
  pid: number
  kind: AppshotsOwnershipKind
  chatId?: string
  label?: string
  processStartedAt?: string
}

export interface AppshotsAttachedCandidate {
  pid: number
  chatId?: string
  processStartedAt?: string
  label?: string
}

export interface AppshotsSpawnCandidate {
  pid: number
  chatId?: string
  workspacePath?: string
  startedAt?: string
  provider?: string
  label?: string
}

export interface AppshotsLaunchCandidate {
  pid?: number
  chatId?: string
  status: string
  workspacePath?: string
  cwd?: string
  processStartedAt?: string
  targetLabel?: string
}

export interface AppshotsTargetOwnershipInput {
  chatId?: string
  requestedPid?: number | null
  attached?: AppshotsAttachedCandidate | null
  spawns?: ReadonlyArray<AppshotsSpawnCandidate>
  launches?: ReadonlyArray<AppshotsLaunchCandidate>
  workspacePath?: string | null
}

export interface AppshotsTargetOwnershipResult {
  allowed: boolean
  reason: AppshotsOwnershipReason
  target?: AppshotsOwnedProcess
}

const LIVE_LAUNCH_STATUSES = new Set(['starting', 'running', 'stopping'])

function isFinitePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function normalizePath(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

/** True when `candidate` is the workspace root or a path inside it. */
export function isPathInsideWorkspaceRoot(
  workspacePath: string | null | undefined,
  candidate: string | null | undefined
): boolean {
  const root = normalizePath(workspacePath)
  const path = normalizePath(candidate)
  if (!root || !path) return false
  if (path === root) return true
  return path.startsWith(`${root}/`)
}

function liveLaunch(launch: AppshotsLaunchCandidate): boolean {
  return LIVE_LAUNCH_STATUSES.has(String(launch.status || '').trim())
}

function sameChat(chatId: string | undefined, other: string | undefined): boolean {
  const a = String(chatId || '').trim()
  const b = String(other || '').trim()
  return Boolean(a && b && a === b)
}

function asOwned(
  pid: number,
  kind: AppshotsOwnershipKind,
  extra?: Omit<Partial<AppshotsOwnedProcess>, 'pid' | 'kind'>
): AppshotsTargetOwnershipResult {
  return {
    allowed: true,
    reason: kind,
    target: { pid, kind, ...extra }
  }
}

/**
 * Resolve whether the requested (or attached) PID is owned by this chat /
 * workspace for AppShots capture purposes.
 */
export function resolveAppshotsTargetOwnership(
  input: AppshotsTargetOwnershipInput
): AppshotsTargetOwnershipResult {
  const chatId = String(input.chatId || '').trim() || undefined
  const attached = input.attached && isFinitePid(input.attached.pid) ? input.attached : null
  const requested =
    input.requestedPid === undefined || input.requestedPid === null
      ? null
      : isFinitePid(input.requestedPid)
        ? Math.trunc(input.requestedPid)
        : null

  if (requested === null && !attached) {
    return { allowed: false, reason: 'missing' }
  }

  // Attached window — omit pid to use it, or pass the same pid.
  if (attached) {
    const attachedOkForChat = !chatId || !attached.chatId || sameChat(chatId, attached.chatId)
    if (attachedOkForChat && (requested === null || requested === attached.pid)) {
      return asOwned(attached.pid, 'attached', {
        chatId: attached.chatId || chatId,
        processStartedAt: attached.processStartedAt,
        label: attached.label
      })
    }
    if (requested !== null && requested === attached.pid && !attachedOkForChat) {
      return { allowed: false, reason: 'mismatch' }
    }
  }

  if (requested === null) {
    return { allowed: false, reason: 'missing' }
  }

  // Chat-scoped TaskWraith spawn.
  for (const entry of input.spawns || []) {
    if (!isFinitePid(entry.pid) || entry.pid !== requested) continue
    if (chatId && entry.chatId && !sameChat(chatId, entry.chatId)) continue
    if (chatId && !entry.chatId) {
      // Spawn without chat attribution: only accept when workspace-bound.
      if (!isPathInsideWorkspaceRoot(input.workspacePath, entry.workspacePath)) continue
      return asOwned(requested, 'workspace-artifact', {
        chatId,
        processStartedAt: entry.startedAt,
        label: entry.label || entry.provider
      })
    }
    if (!chatId || sameChat(chatId, entry.chatId) || !entry.chatId) {
      return asOwned(requested, 'spawned', {
        chatId: entry.chatId || chatId,
        processStartedAt: entry.startedAt,
        label: entry.label || entry.provider
      })
    }
  }

  // Live launch attempts.
  for (const entry of input.launches || []) {
    if (!isFinitePid(entry.pid) || entry.pid !== requested) continue
    if (!liveLaunch(entry)) continue

    if (chatId && sameChat(chatId, entry.chatId)) {
      return asOwned(requested, 'launch', {
        chatId,
        processStartedAt: entry.processStartedAt,
        label: entry.targetLabel
      })
    }

    // Workspace artifact: live launch rooted in this workspace even if chat differs.
    if (
      isPathInsideWorkspaceRoot(input.workspacePath, entry.cwd) ||
      isPathInsideWorkspaceRoot(input.workspacePath, entry.workspacePath)
    ) {
      return asOwned(requested, 'workspace-artifact', {
        chatId: entry.chatId || chatId,
        processStartedAt: entry.processStartedAt,
        label: entry.targetLabel
      })
    }
  }

  // Attached mismatch already handled; anything else is foreign.
  if (attached && requested !== attached.pid) {
    return { allowed: false, reason: 'foreign' }
  }

  return { allowed: false, reason: 'foreign' }
}
