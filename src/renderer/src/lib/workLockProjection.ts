import {
  workLockProjectionIsActive,
  type WorkLockProjection,
  type WorkLockProjectionSnapshot,
  type WorkLockProjectionStatus
} from '../../../shared/workLockProjection'

export type WorkLockProjectionTone = 'active' | 'attention' | 'recovered'

export interface WorkLockDisplayRow {
  lock: WorkLockProjection
  statusLabel: string
  statusDescription: string
  tone: WorkLockProjectionTone
  targetLabel: string
  ownerLabel: string
  workspaceLabel: string
  baseWorkspaceLabel: string
  isCurrentCheckout: boolean
  ageLabel: string
  sinceLabel: string
}

function comparablePath(value: string): string {
  if (!value || value.trim().length === 0) return ''
  if (value === '/' || value === '\\' || /^[A-Za-z]:[\\/]$/.test(value)) return value
  return value.replace(/[\\/]+$/, '')
}

function pathBaseName(value: string): string {
  const normalized = comparablePath(value)
  return normalized.split(/[\\/]/).pop() || normalized
}

export function workLockStatusPresentation(status: WorkLockProjectionStatus): {
  label: string
  description: string
  tone: WorkLockProjectionTone
} {
  if (status === 'orphan_live') {
    return {
      label: 'Owner still active',
      description:
        'The original owner is still running, so TaskWraith is keeping this edit protected.',
      tone: 'active'
    }
  }
  if (status === 'recovery_blocked') {
    return {
      label: 'Recovery paused',
      description:
        'TaskWraith kept this edit protected because safe recovery could not be confirmed.',
      tone: 'attention'
    }
  }
  if (status === 'recovered') {
    return {
      label: 'Recovered safely',
      description:
        'TaskWraith released this edit after confirming that its previous owner had ended.',
      tone: 'recovered'
    }
  }
  return {
    label: 'Active edit',
    description: 'TaskWraith is coordinating this edit with the active owner.',
    tone: 'active'
  }
}

export function formatWorkLockTarget(lock: WorkLockProjection): string {
  if (lock.target.kind === 'workspace') return 'Whole workspace'
  if (lock.target.kind === 'tree') return `${lock.target.path.replace(/[\\/]+$/, '')}/**`
  if (lock.target.kind === 'file') return lock.target.path
  if (lock.target.isInsertion)
    return `${lock.target.path} · insert at line ${lock.target.startLine}`
  const lineLabel =
    lock.target.startLine === lock.target.endLine
      ? `line ${lock.target.startLine}`
      : `lines ${lock.target.startLine}–${lock.target.endLine}`
  return `${lock.target.path} · ${lineLabel}`
}

export function formatWorkLockAge(acquiredAt: string, nowMs: number): string {
  const acquiredMs = Date.parse(acquiredAt)
  if (!Number.isFinite(acquiredMs)) return 'recently'
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - acquiredMs) / 1000))
  if (elapsedSeconds < 60) return 'just now'
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function workLockOwnerLabel(lock: WorkLockProjection): string {
  const provider = lock.owner.provider ? ` · ${lock.owner.provider}` : ''
  return `${lock.owner.displayName}${provider}`
}

export function buildWorkLockDisplayRows(input: {
  snapshot: WorkLockProjectionSnapshot | null
  effectiveWorkspacePath?: string
  nowMs: number
}): WorkLockDisplayRow[] {
  const currentPath = comparablePath(input.effectiveWorkspacePath || '')
  const locks = input.snapshot?.locks || []

  return locks
    .map((lock): WorkLockDisplayRow => {
      const presentation = workLockStatusPresentation(lock.status)
      const acquiredMs = Date.parse(lock.acquiredAt)
      return {
        lock,
        statusLabel: presentation.label,
        statusDescription: presentation.description,
        tone: presentation.tone,
        targetLabel: formatWorkLockTarget(lock),
        ownerLabel: workLockOwnerLabel(lock),
        workspaceLabel:
          lock.workspace.worktreeName ||
          pathBaseName(lock.workspace.effectivePath) ||
          lock.workspace.effectivePath,
        baseWorkspaceLabel: pathBaseName(lock.workspace.basePath) || lock.workspace.basePath,
        isCurrentCheckout:
          Boolean(currentPath) && comparablePath(lock.workspace.effectivePath) === currentPath,
        ageLabel: formatWorkLockAge(lock.acquiredAt, input.nowMs),
        sinceLabel: Number.isFinite(acquiredMs)
          ? new Date(acquiredMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'Recently'
      }
    })
    .sort((left, right) => {
      const leftActive = workLockProjectionIsActive(left.lock.status) ? 0 : 1
      const rightActive = workLockProjectionIsActive(right.lock.status) ? 0 : 1
      return (
        leftActive - rightActive ||
        Number(right.isCurrentCheckout) - Number(left.isCurrentCheckout) ||
        left.lock.acquiredAt.localeCompare(right.lock.acquiredAt) ||
        left.lock.lockId.localeCompare(right.lock.lockId)
      )
    })
}

export function countActiveWorkLocks(snapshot: WorkLockProjectionSnapshot | null): number {
  return (snapshot?.locks || []).filter((lock) => workLockProjectionIsActive(lock.status)).length
}
