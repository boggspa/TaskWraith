import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle } from '../../../main/store/types'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { XSymbolIcon } from './AppChromeSymbols'
import { branchTone } from './GitStatusChips'
import {
  branchCheckoutDisabledReason,
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
  type GitWorktreeEntry,
  worktreeActionDisabledReason
} from '../lib/gitBranchWorktreeUi'
import {
  normalizeWorkspacePath,
  resolveWorktreeSelectionFromSnapshot,
  type ComposerWorktreeSelection
} from '../lib/composerWorktreeSelection'
import './ComposerBranchWorktreePopover.css'

export interface ComposerBranchWorktreePopoverProps {
  workspacePath: string | null | undefined
  /** Owning chat for an external repository grant. */
  chatId?: string
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

export interface ComposerBranchPopoverPosition {
  left: number
  top: number
  width: number
  placement: PopoverPlacement
}

export function computeComposerBranchPopoverPosition(
  rect: Pick<DOMRect, 'left' | 'top' | 'bottom'>,
  viewport: { width: number; height: number },
  popoverSize: { width: number; height: number },
  composerRect?: Pick<DOMRect, 'left' | 'width'>
): ComposerBranchPopoverPosition {
  const margin = 8
  const availableWidth = Math.max(0, viewport.width - margin * 2)
  const width = Math.min(Math.max(0, composerRect?.width ?? popoverSize.width), availableWidth)
  const height = Math.min(popoverSize.height, viewport.height - margin * 2)
  const preferredLeft = composerRect?.left ?? rect.left
  const left = Math.min(
    Math.max(preferredLeft, margin),
    Math.max(margin, viewport.width - width - margin)
  )
  const aboveAnchorTop = rect.top - 8
  if (aboveAnchorTop - height >= margin) {
    return { left, top: aboveAnchorTop, width, placement: 'above' }
  }
  const belowTop = rect.bottom + 8
  if (belowTop + height <= viewport.height - margin) {
    return { left, top: belowTop, width, placement: 'below' }
  }
  return {
    left,
    top: Math.max(margin + height, aboveAnchorTop),
    width,
    placement: 'above'
  }
}

function BranchPopoverFactLine({
  label,
  secondary = false,
  children
}: {
  label: string
  secondary?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className={`composer-branch-popover-fact-line${secondary ? ' is-secondary' : ''}`}>
      <small>{label}</small>
      <span className="composer-branch-popover-fact-values">{children}</span>
    </span>
  )
}

function BranchPopoverTreeValues({
  snapshot,
  unavailableLabel
}: {
  snapshot?: GitRepositorySnapshot | null
  unavailableLabel: string
}): React.JSX.Element {
  if (!snapshot) return <i>{unavailableLabel}</i>
  if (snapshot.clean) return <i className="is-clean">clean</i>
  const additions = snapshot.lineStats?.additions ?? 0
  const deletions = snapshot.lineStats?.deletions ?? 0
  const untracked = snapshot.counts?.untracked ?? 0
  const changed = Math.max(0, (snapshot.counts?.changed ?? 0) - untracked)
  return (
    <>
      <em className="composer-diff-add">+{additions}</em>
      <em className="composer-diff-del">−{deletions}</em>
      <i>
        {changed} changed · {untracked} new
      </i>
    </>
  )
}

export function ComposerBranchPopoverBranchRow({
  branch,
  gitSnapshot,
  disabled,
  onSelect
}: {
  branch: GitBranchEntry
  gitSnapshot?: GitRepositorySnapshot | null
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  // A selected linked worktree supplies the composer's live snapshot. Do not
  // project that snapshot onto the configured checkout's current branch row.
  const matchingSnapshot =
    branch.isCurrent && gitSnapshot && !gitSnapshot.detached && gitSnapshot.branch === branch.name
      ? gitSnapshot
      : null
  const upstream = matchingSnapshot?.upstream || branch.upstream
  const subtitle = branch.isCurrent
    ? 'Configured checkout'
    : branch.upstream
      ? `Tracks ${branch.upstream}`
      : 'Local branch · no upstream'
  return (
    <button
      type="button"
      className={`composer-branch-popover-item${branch.isCurrent ? ' is-current' : ''}`}
      disabled={disabled}
      aria-current={branch.isCurrent ? 'true' : undefined}
      title={branch.name}
      onClick={onSelect}
    >
      <span className="composer-branch-popover-target-kind" aria-hidden="true">
        ⎇
      </span>
      <span className="composer-branch-popover-target-copy">
        <strong>{branch.name}</strong>
        <small>{subtitle}</small>
      </span>
      <span className="composer-branch-popover-facts">
        <BranchPopoverFactLine label="checkout">
          <i className={branch.isCurrent ? 'is-current' : 'is-action'}>
            {branch.isCurrent ? 'current' : 'select'}
          </i>
        </BranchPopoverFactLine>
        <BranchPopoverFactLine label="tree">
          <BranchPopoverTreeValues snapshot={matchingSnapshot} unavailableLabel="ref only" />
        </BranchPopoverFactLine>
        <BranchPopoverFactLine label="upstream" secondary>
          {matchingSnapshot && upstream ? (
            <>
              <em className="is-ahead">↑{matchingSnapshot.ahead}</em>
              <em className="is-behind">↓{matchingSnapshot.behind}</em>
              <i title={upstream}>{upstream}</i>
            </>
          ) : (
            <i title={upstream}>{upstream || 'none'}</i>
          )}
        </BranchPopoverFactLine>
      </span>
    </button>
  )
}

export function ComposerBranchPopoverWorktreeRow({
  worktree,
  gitSnapshot,
  disabled,
  isComposerTarget = false,
  isComposerSelectionActive = false,
  onSelect
}: {
  worktree: GitWorktreeEntry
  gitSnapshot?: GitRepositorySnapshot | null
  disabled: boolean
  /** This is where the composer will run, not necessarily Git's active checkout. */
  isComposerTarget?: boolean
  /** A linked worktree is selected, so the configured checkout becomes an escape action. */
  isComposerSelectionActive?: boolean
  onSelect: () => void
}): React.JSX.Element {
  const label = worktree.branch || 'detached HEAD'
  const snapshotPath = gitSnapshot?.repoRoot || gitSnapshot?.requestedPath
  const matchingSnapshot =
    snapshotPath && normalizeWorkspacePath(snapshotPath) === normalizeWorkspacePath(worktree.path)
      ? gitSnapshot
      : null
  const checkoutLabel = isComposerTarget
    ? 'selected'
    : worktree.isCurrent && isComposerSelectionActive
      ? 'use checkout'
      : worktree.isCurrent
        ? 'active'
        : 'select'
  const checkoutClass = isComposerTarget
    ? 'is-composer-target'
    : worktree.isCurrent
      ? 'is-current'
      : 'is-action'
  const subtitle = isComposerTarget
    ? `Composer target · ${worktree.path}`
    : worktree.isCurrent
      ? 'Configured checkout'
      : worktree.path
  const title = isComposerTarget
    ? `Composer runs use this worktree: ${worktree.path}`
    : worktree.isCurrent && isComposerSelectionActive
      ? 'Use the configured checkout for composer runs without changing Git checkout'
      : worktree.path
  return (
    <button
      type="button"
      className={`composer-branch-popover-item${worktree.isCurrent ? ' is-current' : ''}${
        isComposerTarget ? ' is-composer-target' : ''
      }`}
      disabled={disabled}
      aria-current={isComposerTarget ? 'location' : worktree.isCurrent ? 'true' : undefined}
      title={title}
      onClick={onSelect}
    >
      <span className="composer-branch-popover-target-kind" aria-hidden="true">
        ⑂
      </span>
      <span className="composer-branch-popover-target-copy">
        <strong>{label}</strong>
        <small>{subtitle}</small>
      </span>
      <span className="composer-branch-popover-facts">
        <BranchPopoverFactLine label="checkout">
          <i className={checkoutClass}>{checkoutLabel}</i>
        </BranchPopoverFactLine>
        <BranchPopoverFactLine label="tree">
          <BranchPopoverTreeValues
            snapshot={worktree.isCurrent || isComposerTarget ? matchingSnapshot : null}
            unavailableLabel={isComposerTarget ? 'measuring…' : 'not measured'}
          />
        </BranchPopoverFactLine>
        <BranchPopoverFactLine label="head" secondary>
          <i title={worktree.head}>{worktree.head?.slice(0, 9) || 'unknown'}</i>
        </BranchPopoverFactLine>
      </span>
    </button>
  )
}

export function ComposerBranchWorktreePopover({
  workspacePath,
  chatId,
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
    width: number
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
  const activeWorktreePath = composerWorktreeSelection?.effectiveWorkspacePath
  const hasComposerWorktreeSelection = Boolean(activeWorktreePath)
  const configuredCheckoutBranch =
    branches.find((branch) => branch.isCurrent)?.name ||
    worktrees.find((worktree) => worktree.isCurrent)?.branch ||
    fallbackBranch ||
    'this workspace'
  const triggerLabel = activeWorktreeLabel ? `worktree: ${activeWorktreeLabel}` : branchLabel
  const toneClass = `git-tone-${branchTone(detached ? undefined : branchLabel, detached)}`

  const refreshLists = useCallback(async (): Promise<void> => {
    if (!workspacePath || !apiAvailable) return
    setLoading(true)
    const [branchResult, worktreeResult] = await Promise.all([
      listGitBranches(workspacePath, chatId),
      listGitWorktrees(workspacePath, chatId)
    ])
    setBranches(branchResult.branches.filter((entry) => !entry.isRemote))
    setWorktrees(worktreeResult.worktrees)
    if (!branchResult.ok && branchResult.error) {
      setStatus(branchResult.error)
      setStatusTone('error')
    }
    setLoading(false)
  }, [apiAvailable, chatId, workspacePath])

  const refreshSnapshot = useCallback(async (): Promise<void> => {
    if (!workspacePath || typeof window.api?.gitSnapshot !== 'function') return
    try {
      const res = await window.api.gitSnapshot({
        workspacePath,
        ...(chatId ? { chatId } : {})
      })
      onSnapshotRefresh?.(res?.ok ? res.data : null)
    } catch {
      onSnapshotRefresh?.(null)
    }
  }, [chatId, onSnapshotRefresh, workspacePath])

  const updatePosition = useCallback((): void => {
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const composerArea = trigger.closest('.composer-area')
    const composerSurface = composerArea?.querySelector<HTMLElement>('.composer-surface')
    const composerRect = (composerSurface || composerArea)?.getBoundingClientRect()
    const popoverHeight = popoverRef.current?.offsetHeight || 280
    setPosition(
      computeComposerBranchPopoverPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: 640, height: popoverHeight },
        composerRect ? { left: composerRect.left, width: composerRect.width } : undefined
      )
    )
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
    const repositionFrame = window.requestAnimationFrame(updatePosition)
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
      window.cancelAnimationFrame(repositionFrame)
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
    onWorktreeSelectionChange(
      resolveWorktreeSelectionFromSnapshot(workspacePath, snapshot),
      snapshot
    )
  }

  const clearComposerWorktreeSelection = (): void => {
    // This only clears the renderer-local composer target. It deliberately
    // does not call `git checkout`: the configured worktree is already active.
    onWorktreeSelectionChange?.(null, null)
    closePopover()
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
        const res = await window.api.gitSnapshot({
          workspacePath,
          ...(chatId ? { chatId } : {})
        })
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

  const branchDisabledReason = branchCheckoutDisabledReason({
    workspacePath,
    apiAvailable,
    dirty
  })
  const worktreeDisabledReason = worktreeActionDisabledReason({
    workspacePath,
    apiAvailable
  })
  const triggerDisabledReason = !workspacePath
    ? 'No workspace'
    : !apiAvailable
      ? 'Branch and worktree controls unavailable until backend IPC lands'
      : ''
  const dirtyStatus = dirty
    ? 'Dirty worktree — branch checkout disabled; worktrees still available'
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
              width: position.width,
              transform: position.placement === 'above' ? 'translateY(-100%)' : undefined
            }}
            role="dialog"
            aria-label="Branch and worktree"
          >
            <div className="composer-branch-popover-header">
              <strong>Branch & worktree</strong>
              <small>
                {loading
                  ? 'Refreshing targets…'
                  : `${branches.length} local branch${branches.length === 1 ? '' : 'es'} · ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}`}
              </small>
              <button
                type="button"
                className="composer-branch-popover-close"
                onClick={closePopover}
                title="Close branch and worktree"
                aria-label="Close branch and worktree"
              >
                <XSymbolIcon />
              </button>
            </div>
            <div className="composer-branch-popover-body">
              {hasComposerWorktreeSelection && (
                <div className="composer-branch-popover-selection-summary" role="status">
                  <span>Composer target</span>
                  <strong title={activeWorktreeLabel}>{activeWorktreeLabel}</strong>
                  <small title={activeWorktreePath}>{activeWorktreePath}</small>
                  <i>Configured checkout remains {configuredCheckoutBranch}</i>
                </div>
              )}
              <div className="composer-branch-popover-section">
                <div className="composer-branch-popover-section-title">
                  <span>Branches</span>
                  <small>Changes configured checkout</small>
                </div>
                {loading ? (
                  <div className="composer-branch-popover-status">Loading branches…</div>
                ) : branches.length === 0 ? (
                  <div className="composer-branch-popover-status">No local branches found.</div>
                ) : (
                  branches.map((branch) => (
                    <ComposerBranchPopoverBranchRow
                      key={branch.name}
                      disabled={working || branch.isCurrent || Boolean(branchDisabledReason)}
                      branch={branch}
                      gitSnapshot={gitSnapshot}
                      onSelect={() =>
                        void runAction(
                          () => checkoutGitBranch(workspacePath!, branch.name, chatId),
                          'branch-checkout'
                        )
                      }
                    />
                  ))
                )}
              </div>

              <div className="composer-branch-popover-section">
                <div className="composer-branch-popover-section-title">
                  <span>Create branch</span>
                  <small>From current HEAD</small>
                </div>
                <div className="composer-branch-popover-create">
                  <input
                    className="composer-branch-popover-input"
                    value={newBranchName}
                    placeholder="feature/my-branch"
                    disabled={working || Boolean(branchDisabledReason)}
                    onChange={(event) => setNewBranchName(event.target.value)}
                  />
                  <button
                    type="button"
                    className="composer-branch-popover-create-button"
                    disabled={working || !newBranchName.trim() || Boolean(branchDisabledReason)}
                    onClick={() =>
                      void runAction(
                        () =>
                          createGitBranch(
                            workspacePath!,
                            newBranchName.trim(),
                            gitSnapshot?.branch,
                            chatId
                          ),
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
                  <div className="composer-branch-popover-section-title">
                    <span>Worktrees</span>
                    <small>
                      {hasComposerWorktreeSelection ? 'Composer run target' : 'Isolated checkouts'}
                    </small>
                  </div>
                  {worktrees.map((worktree) => {
                    const isComposerTarget = Boolean(
                      activeWorktreePath &&
                      normalizeWorkspacePath(worktree.path) ===
                        normalizeWorkspacePath(activeWorktreePath)
                    )
                    const canUseConfiguredCheckout = Boolean(
                      worktree.isCurrent &&
                      hasComposerWorktreeSelection &&
                      onWorktreeSelectionChange
                    )
                    return (
                      <ComposerBranchPopoverWorktreeRow
                        key={worktree.path}
                        disabled={
                          working ||
                          isComposerTarget ||
                          (!canUseConfiguredCheckout &&
                            (worktree.isCurrent || Boolean(worktreeDisabledReason)))
                        }
                        worktree={worktree}
                        gitSnapshot={gitSnapshot}
                        isComposerTarget={isComposerTarget}
                        isComposerSelectionActive={hasComposerWorktreeSelection}
                        onSelect={() => {
                          if (canUseConfiguredCheckout) {
                            clearComposerWorktreeSelection()
                            return
                          }
                          void runAction(
                            () => selectGitWorktree(workspacePath!, worktree.path, chatId),
                            'worktree'
                          )
                        }}
                      />
                    )
                  })}
                  <div className="composer-branch-popover-create">
                    <input
                      className="composer-branch-popover-input"
                      value={newWorktreeName}
                      placeholder="task-isolation"
                      disabled={working || Boolean(worktreeDisabledReason)}
                      onChange={(event) => setNewWorktreeName(event.target.value)}
                    />
                    <button
                      type="button"
                      className="composer-branch-popover-create-button"
                      disabled={working || !newWorktreeName.trim() || Boolean(worktreeDisabledReason)}
                      onClick={() =>
                        void runAction(
                          () =>
                            createGitWorktree(
                              workspacePath!,
                              {
                                name: newWorktreeName.trim(),
                                branch: newWorktreeName.trim()
                              },
                              chatId
                            ),
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
                  triggerDisabledReason ||
                  (activeWorktreeLabel
                    ? `Runs use isolated worktree: ${composerWorktreeSelection?.effectiveWorkspacePath || activeWorktreeLabel}`
                    : dirtyStatus)}
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
          triggerDisabledReason ||
          (activeWorktreeLabel
            ? `Isolated worktree active (${composerWorktreeSelection?.effectiveWorkspacePath || activeWorktreeLabel})`
            : 'Switch branch or worktree')
        }
        onClick={() => {
          if (dirty) {
            setStatus(dirtyStatus)
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
