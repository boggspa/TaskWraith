import { useState } from 'react'
import { useWorkspaceLocks } from '../hooks/useWorkspaceLocks'
import {
  buildWorkLockDisplayRows,
  countActiveWorkLocks,
  type WorkLockDisplayRow
} from '../lib/workLockProjection'
import type { WorkLockProjectionSnapshot } from '../../../shared/workLockProjection'
import { getProviderLabel } from '../lib/providerLabels'
import './WorkspaceLockPill.css'

export interface WorkspaceLockPillProps {
  workspacePath: string
  effectiveWorkspacePath?: string
  chatId?: string
}

export interface WorkspaceLockPillViewProps {
  snapshot: WorkLockProjectionSnapshot | null
  effectiveWorkspacePath?: string
  nowMs?: number
  onForceRelease?: (lockId: string) => void | Promise<void>
  recoveringLockId?: string | null
  recoveryMessage?: string | null
}

function LockRow({
  row,
  onForceRelease,
  recoveringLockId
}: {
  row: WorkLockDisplayRow
  onForceRelease?: (lockId: string) => void | Promise<void>
  recoveringLockId?: string | null
}): React.JSX.Element {
  const { lock } = row
  const provider = lock.owner.provider ? getProviderLabel(lock.owner.provider) : null
  const identity = [
    provider,
    lock.owner.chatTitle || lock.owner.chatId,
    lock.owner.laneId
      ? `lane ${lock.owner.laneId}`
      : lock.owner.runId
        ? `run ${lock.owner.runId}`
        : null
  ].filter(Boolean)
  const checkoutCopy = lock.workspace.isWorktree
    ? `Worktree ${row.workspaceLabel}`
    : `Base workspace ${row.baseWorkspaceLabel}`

  return (
    <li className={`workspace-lock-row tone-${row.tone}`}>
      <div className="workspace-lock-row-heading">
        <span className="workspace-lock-status">
          <span className="workspace-lock-status-dot" aria-hidden="true" />
          {row.statusLabel}
        </span>
        <time dateTime={lock.acquiredAt} title={`Held since ${lock.acquiredAt}`}>
          {row.ageLabel}
        </time>
      </div>
      <strong className="workspace-lock-target">{row.targetLabel}</strong>
      <span className="workspace-lock-owner">
        {lock.owner.displayName}
        {identity.length > 0 ? ` · ${identity.join(' · ')}` : ''}
      </span>
      <span className="workspace-lock-checkout" title={lock.workspace.effectivePath}>
        {checkoutCopy}
        {row.isCurrentCheckout ? ' · current' : ''}
        {lock.workspace.branch ? ` · ${lock.workspace.branch}` : ''}
      </span>
      <span className="workspace-lock-path">{lock.workspace.effectivePath}</span>
      {lock.workspace.basePath !== lock.workspace.effectivePath && (
        <span className="workspace-lock-base" title={lock.workspace.basePath}>
          Based on {row.baseWorkspaceLabel} · {lock.workspace.basePath}
        </span>
      )}
      <span className="workspace-lock-recovery-copy">{row.statusDescription}</span>
      {lock.status === 'recovery_blocked' && onForceRelease && (
        <button
          type="button"
          className="workspace-lock-recovery-button"
          disabled={Boolean(recoveringLockId)}
          onClick={() => void onForceRelease(lock.lockId)}
        >
          {recoveringLockId === lock.lockId ? 'Reviewing recovery…' : 'Review force release…'}
        </button>
      )}
      <span className="workspace-lock-since">Since {row.sinceLabel}</span>
    </li>
  )
}

export function WorkspaceLockPillView({
  snapshot,
  effectiveWorkspacePath,
  nowMs,
  onForceRelease,
  recoveringLockId,
  recoveryMessage
}: WorkspaceLockPillViewProps): React.JSX.Element | null {
  const sampledAtMs = Date.parse(snapshot?.sampledAt || '')
  const referenceNowMs = nowMs ?? (Number.isFinite(sampledAtMs) ? sampledAtMs : 0)
  const rows = buildWorkLockDisplayRows({
    snapshot,
    effectiveWorkspacePath,
    nowMs: referenceNowMs
  })
  if (rows.length === 0) {
    return recoveryMessage ? (
      <p
        className="workspace-lock-recovery-result workspace-lock-recovery-result--standalone"
        role="status"
      >
        {recoveryMessage}
      </p>
    ) : null
  }

  const activeCount = countActiveWorkLocks(snapshot)
  const recoveredCount = rows.length - activeCount
  const label =
    activeCount > 0
      ? `${activeCount} active edit${activeCount === 1 ? '' : 's'}`
      : `${recoveredCount} edit${recoveredCount === 1 ? '' : 's'} recovered`
  const attention = rows.some((row) => row.tone === 'attention')

  return (
    <details
      className={`workspace-lock-pill${attention ? ' has-recovery-attention' : ''}`}
      data-active-lock-count={activeCount}
    >
      <summary aria-label={`${label}. Show workspace edit coordination details.`}>
        <span className="workspace-lock-pill-dot" aria-hidden="true" />
        <span>{label}</span>
      </summary>
      <div className="workspace-lock-popover" role="status" aria-live="polite">
        <div className="workspace-lock-popover-header">
          <strong>{activeCount > 0 ? 'Active workspace edits' : 'Workspace edit recovery'}</strong>
          <span>
            {activeCount} active
            {recoveredCount > 0 ? ` · ${recoveredCount} recovered` : ''}
          </span>
        </div>
        <ul>
          {rows.map((row) => (
            <LockRow
              key={row.lock.lockId}
              row={row}
              onForceRelease={onForceRelease}
              recoveringLockId={recoveringLockId}
            />
          ))}
        </ul>
        {recoveryMessage && <p className="workspace-lock-recovery-result">{recoveryMessage}</p>}
      </div>
    </details>
  )
}

export function WorkspaceLockPill({
  workspacePath,
  effectiveWorkspacePath,
  chatId
}: WorkspaceLockPillProps): React.JSX.Element | null {
  const { snapshot } = useWorkspaceLocks({
    workspacePath,
    ...(chatId ? { chatId } : {})
  })
  const [recoveringLockId, setRecoveringLockId] = useState<string | null>(null)
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)

  const forceRelease = async (lockId: string): Promise<void> => {
    if (recoveringLockId) return
    setRecoveringLockId(lockId)
    setRecoveryMessage(null)
    try {
      const result = await window.api.forceReleaseRecoveryBlockedWorkLock({
        lockId,
        workspacePath,
        ...(chatId ? { chatId } : {})
      })
      setRecoveryMessage(result.message)
    } catch {
      setRecoveryMessage('Workspace-lock recovery could not be requested.')
    } finally {
      setRecoveringLockId(null)
    }
  }

  return (
    <WorkspaceLockPillView
      snapshot={snapshot}
      effectiveWorkspacePath={effectiveWorkspacePath || workspacePath}
      onForceRelease={forceRelease}
      recoveringLockId={recoveringLockId}
      recoveryMessage={recoveryMessage}
    />
  )
}
