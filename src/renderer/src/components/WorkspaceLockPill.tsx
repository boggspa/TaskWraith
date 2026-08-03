import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useWorkspaceLocks } from '../hooks/useWorkspaceLocks'
import {
  buildWorkLockDisplayRows,
  countActiveWorkLocks,
  type WorkLockDisplayRow
} from '../lib/workLockProjection'
import {
  workspaceLockRecoveryMessage,
  type WorkLockProjectionSnapshot
} from '../../../shared/workLockProjection'
import { getProviderLabel } from '../lib/providerLabels'
import {
  resolveWorkspaceLockPopoverPosition,
  type WorkspaceLockPopoverPosition
} from '../lib/workspaceLockPopoverPosition'
import { DigitOdometer } from './DigitOdometer'
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
  const activeCount = countActiveWorkLocks(snapshot)
  const recoveredCount = rows.length - activeCount
  const label = `${activeCount} active edit${activeCount === 1 ? '' : 's'}`
  const attention = rows.some((row) => row.tone === 'attention')
  const hasDetails = rows.length > 0

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<WorkspaceLockPopoverPosition | null>(null)
  const popoverOpen = open && hasDetails

  useEffect(() => {
    if (!popoverOpen) return

    const updatePosition = (): void => {
      const trigger = triggerRef.current
      if (!trigger) return
      setPosition(
        resolveWorkspaceLockPopoverPosition({
          triggerRect: trigger.getBoundingClientRect(),
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        })
      )
    }

    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [popoverOpen])

  useEffect(() => {
    if (!popoverOpen) return
    const closeWhenOutside = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', closeWhenOutside, true)
    document.addEventListener('keydown', closeWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeWhenOutside, true)
      document.removeEventListener('keydown', closeWithEscape)
    }
  }, [popoverOpen])

  const togglePopover = (): void => {
    if (!hasDetails) return
    setPosition(null)
    setOpen((current) => !current)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`workspace-lock-pill workspace-lock-trigger${attention ? ' has-recovery-attention' : ''}`}
        data-active-lock-count={activeCount}
        aria-label={
          hasDetails
            ? `${label}. ${popoverOpen ? 'Hide' : 'Show'} workspace edit coordination details.`
            : `${label}. No workspace edit coordination details.`
        }
        aria-haspopup={hasDetails ? 'dialog' : undefined}
        aria-expanded={hasDetails ? popoverOpen : undefined}
        disabled={!hasDetails}
        onClick={togglePopover}
      >
        <span className="workspace-lock-pill-dot" aria-hidden="true" />
        <span>
          <DigitOdometer value={activeCount} ariaLabel={String(activeCount)} />
          <span aria-hidden="true"> active edit{activeCount === 1 ? '' : 's'}</span>
        </span>
      </button>
      {!hasDetails && recoveryMessage && (
        <p
          className="workspace-lock-recovery-result workspace-lock-recovery-result--standalone"
          role="status"
        >
          {recoveryMessage}
        </p>
      )}
      {popoverOpen && position && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popoverRef}
              className={`workspace-lock-popover workspace-lock-popover--${position.placement}`}
              role="dialog"
              aria-label="Workspace edit coordination details"
              style={{
                left: `${position.left}px`,
                top: `${position.top}px`,
                width: `${position.width}px`,
                maxHeight: `${position.maxHeight}px`,
                transform: position.placement === 'above' ? 'translateY(-100%)' : undefined
              }}
            >
              <div className="workspace-lock-popover-header">
                <strong>
                  {activeCount > 0 ? 'Active workspace edits' : 'Workspace edit recovery'}
                </strong>
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
              {recoveryMessage && (
                <p className="workspace-lock-recovery-result">{recoveryMessage}</p>
              )}
            </div>,
            document.body
          )
        : null}
    </>
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
      setRecoveryMessage(workspaceLockRecoveryMessage(result))
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
