import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle } from '../../../main/store/types'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { branchTone } from './GitStatusChips'
import {
  checkoutGitBranch,
  createGitBranch,
  createGitWorktree,
  formatBranchLabel,
  gitBranchWorktreeApiAvailable,
  isWorktreeDirty,
  listGitBranches,
  listGitWorktrees,
  selectGitWorktree,
  type GitBranchEntry,
  type GitWorktreeEntry
} from '../lib/gitBranchWorktreeUi'
import {
  resolveWorktreeSelectionFromSnapshot,
  type ComposerWorktreeSelection
} from '../lib/composerWorktreeSelection'
import './ComposerBranchWorktreePopover.css'

export interface ComposerBranchWorktreePopoverProps {
  workspacePath: string | null | undefined
  gitSnapshot: GitRepositorySnapshot | null | undefined
  fallbackBranch?: string
  detached?: boolean
  composerStyle: ComposerStyle
  composerWorktreeSelection?: ComposerWorktreeSelection | null
  onSnapshotRefresh?: (snapshot: GitRepositorySnapshot | null) => void
  onWorktreeSelectionChange?: (
    selection: ComposerWorktreeSelection | null,
    snapshot: GitRepositorySnapshot | null
  ) => void
}

type PopoverPlacement = 'above' | 'below'

function computePopoverPosition(
  rect: DOMRect,
  popoverSize: { width: number; height: number }
): { left: number; top: number; placement: PopoverPlacement } {
  const margin = 8
  const width = Math.min(popoverSize.width, window.innerWidth - margin * 2)
  const height = Math.min(popoverSize.height, window.innerHeight - margin * 2)
  const left = Math.min(
    Math.max(rect.left, margin),
    Math.max(margin, window.innerWidth - width - margin)
  )
  const aboveAnchorTop = rect.top - 8
  if (aboveAnchorTop - height >= margin) {
    return { left, top: aboveAnchorTop, placement: 'above' }
  }
  const belowTop = rect.bottom + 8
  if (belowTop + height <= window.innerHeight - margin) {
    return { left, top: belowTop, placement: 'below' }
  }
  return {
    left,
    top: Math.max(margin + height, aboveAnchorTop),
    placement: 'above'
  }
}

export function ComposerBranchWorktreePopover({
  workspacePath,
  gitSnapshot,
  fallbackBranch,
  detached = false,
  composerStyle,
  composerWorktreeSelection,
  onSnapshotRefresh,
  onWorktreeSelectionChange
}: ComposerBranchWorktreePopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{
    left: number
    top: number
    placement: PopoverPlacement
  } | null>(null)
  const [branches, setBranches] = useState<GitBranchEntry[]>([])
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [status, setStatus] = useState('')
  const [statusTone, setStatusTone] = useState<'default' | 'error' | 'warning'>('default')
  const [newBranchName, setNewBranchName] = useState('')
  const [newWorktreeName, setNewWorktreeName] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const apiAvailable = gitBranchWorktreeApiAvailable()
  const dirty = isWorktreeDirty(gitSnapshot)
  const branchLabel = formatBranchLabel(gitSnapshot, fallbackBranch)
  const activeWorktreeLabel = composerWorktreeSelection?.label
  const triggerLabel = activeWorktreeLabel ? `worktree: ${activeWorktreeLabel}` : branchLabel
  const toneClass = `git-tone-${branchTone(detached ? undefined : branchLabel, detached)}`

  const refreshLists = useCallback(async (): Promise<void> => {
    if (!workspacePath || !apiAvailable) return
    setLoading(true)
    const [branchResult, worktreeResult] = await Promise.all([
      listGitBranches(workspacePath),
      listGitWorktrees(workspacePath)
    ])
    setBranches(branchResult.branches.filter((entry) => !entry.isRemote))
    setWorktrees(worktreeResult.worktrees)
    if (!branchResult.ok && branchResult.error) {
      setStatus(branchResult.error)
      setStatusTone('error')
    }
    setLoading(false)
  }, [apiAvailable, workspacePath])

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    if (!workspacePath || typeof window.api?.gitSnapshot !== 'function') return
    try {
      const res = await window.api.gitSnapshot({ workspacePath })
      onSnapshotRefresh?.(res?.ok ? res.data : null)
    } catch {
      onSnapshotRefresh?.(null)
    }
  }, [onSnapshotRefresh, workspacePath])

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const popoverHeight = popoverRef.current?.offsetHeight || 280
    setPosition(computePopoverPosition(rect, { width: 320, height: popoverHeight }))
  }, [])

  const closePopover = useCallback((): void => {
    setOpen(false)
    setStatus('')
    setStatusTone('default')
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshLists()
    updatePosition()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      closePopover()
    }
    const onReposition = (): void => updatePosition()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [closePopover, open, refreshLists, updatePosition])

  const publishWorktreeSelection = (
    snapshot: GitRepositorySnapshot | null,
    mode: 'branch-checkout' | 'worktree'
  ): void => {
    if (!workspacePath || !onWorktreeSelectionChange) return
    if (mode === 'branch-checkout') {
      onWorktreeSelectionChange(null, snapshot)
      return
    }
    onWorktreeSelectionChange(resolveWorktreeSelectionFromSnapshot(workspacePath, snapshot), snapshot)
  }

  const runAction = async (
    action: () => Promise<{ ok: boolean; error?: string; snapshot?: GitRepositorySnapshot }>,
    selectionMode: 'branch-checkout' | 'worktree' | 'none' = 'none'
  ): Promise<void> => {
    if (!workspacePath) return
    setWorking(true)
    setStatus('')
    setStatusTone('default')
    const result = await action()
    if (!result.ok) {
      setStatus(result.error || 'Git action failed.')
      setStatusTone('error')
      setWorking(false)
      return
    }
    let resolvedSnapshot = result.snapshot || null
    if (resolvedSnapshot) onSnapshotRefresh?.(resolvedSnapshot)
    else {
      await refreshSnapshot()
      try {
        const res = await window.api.gitSnapshot({ workspacePath })
        resolvedSnapshot = res?.ok ? res.data : null
      } catch {
        resolvedSnapshot = null
      }
    }
    if (selectionMode !== 'none') {
      publishWorktreeSelection(resolvedSnapshot, selectionMode)
    }
    await refreshLists()
    setWorking(false)
    closePopover()
  }

  const disabledReason = !workspacePath
    ? 'No workspace'
    : !apiAvailable
      ? 'Branch controls unavailable until backend IPC lands'
      : dirty
        ? 'Commit or stash changes before switching branch'
        : ''

  const popover =
    open && position && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-branch-popover shell-${composerStyle}`}
            style={{
              left: position.left,
              top: position.top,
              transform: position.placement === 'above' ? 'translateY(-100%)' : undefined
            }}
            role="dialog"
            aria-label="Branch and worktree"
          >
            <div className="composer-branch-popover-header">
              <span>Branch & worktree</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={closePopover}>
                Close
              </button>
            </div>
            <div className="composer-branch-popover-body">
              <div className="composer-branch-popover-section">
                <div className="composer-branch-popover-section-title">Branches</div>
                {loading ? (
                  <div className="composer-branch-popover-status">Loading branches…</div>
                ) : branches.length === 0 ? (
                  <div className="composer-branch-popover-status">No local branches found.</div>
                ) : (
                  branches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      className={`composer-branch-popover-item${branch.isCurrent ? ' is-current' : ''}`}
                      disabled={working || branch.isCurrent || Boolean(disabledReason)}
                      onClick={() =>
                        void runAction(
                          () => checkoutGitBranch(workspacePath!, branch.name),
                          'branch-checkout'
                        )
                      }
                    >
                      <span>{branch.name}</span>
                      {branch.isCurrent ? <span>current</span> : null}
                    </button>
                  ))
                )}
              </div>

              <div className="composer-branch-popover-section">
                <div className="composer-branch-popover-section-title">Create branch</div>
                <div className="composer-branch-popover-create">
                  <input
                    className="settings-select"
                    value={newBranchName}
                    placeholder="feature/my-branch"
                    disabled={working || Boolean(disabledReason)}
                    onChange={(event) => setNewBranchName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={working || !newBranchName.trim() || Boolean(disabledReason)}
                    onClick={() =>
                      void runAction(
                        () =>
                          createGitBranch(workspacePath!, newBranchName.trim(), gitSnapshot?.branch),
                        'branch-checkout'
                      )
                    }
                  >
                    Create & checkout
                  </button>
                </div>
              </div>

              {worktrees.length > 0 || apiAvailable ? (
                <div className="composer-branch-popover-section">
                  <div className="composer-branch-popover-section-title">Worktrees</div>
                  {worktrees.map((worktree) => (
                    <button
                      key={worktree.path}
                      type="button"
                      className={`composer-branch-popover-item${worktree.isCurrent ? ' is-current' : ''}`}
                      disabled={working || worktree.isCurrent || Boolean(disabledReason)}
                      title={worktree.path}
                      onClick={() =>
                        void runAction(
                          () => selectGitWorktree(workspacePath!, worktree.path),
                          'worktree'
                        )
                      }
                    >
                      <span>{worktree.branch || worktree.path.split('/').pop()}</span>
                      {worktree.isCurrent ? <span>active</span> : null}
                    </button>
                  ))}
                  <div className="composer-branch-popover-create">
                    <input
                      className="settings-select"
                      value={newWorktreeName}
                      placeholder="task-isolation"
                      disabled={working || Boolean(disabledReason)}
                      onChange={(event) => setNewWorktreeName(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={working || !newWorktreeName.trim() || Boolean(disabledReason)}
                      onClick={() =>
                        void runAction(
                          () =>
                            createGitWorktree(workspacePath!, {
                              name: newWorktreeName.trim(),
                              branch: gitSnapshot?.branch
                            }),
                          'worktree'
                        )
                      }
                    >
                      Create isolated worktree
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="composer-branch-popover-footer">
              <span
                className={`composer-branch-popover-status${
                  statusTone === 'error' ? ' is-error' : statusTone === 'warning' ? ' is-warning' : ''
                }`}
              >
                {status ||
                  disabledReason ||
                  (activeWorktreeLabel
                    ? `Runs use isolated worktree: ${composerWorktreeSelection?.effectiveWorkspacePath || activeWorktreeLabel}`
                    : dirty
                      ? 'Dirty worktree — checkout disabled'
                      : '')}
              </span>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-branch-trigger composer-above-bar-secondary-branch ${toneClass}${
          activeWorktreeLabel ? ' is-linked-worktree' : ''
        }`}
        disabled={!workspacePath}
        title={
          disabledReason ||
          (activeWorktreeLabel
            ? `Isolated worktree active (${composerWorktreeSelection?.effectiveWorkspacePath || activeWorktreeLabel})`
            : 'Switch branch or worktree')
        }
        onClick={() => {
          if (dirty) {
            setStatus('Commit or stash changes before switching branch.')
            setStatusTone('warning')
          }
          setOpen((prev) => !prev)
        }}
      >
        {triggerLabel}
      </button>
      {popover}
    </>
  )
}