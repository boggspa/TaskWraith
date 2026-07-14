/*
 * GitCommitControls — the real, user-driven Git affordance that lives
 * inside the composer above-bar's diff-action menu.
 *
 * This replaces the previous "Commit Changes" entry, which injected a
 * natural-language prompt at the agent ("Commit N files…, review the
 * diff, then run the commit") and relied on the model to drive git.
 * Now the user drives it directly through the stable preload Git API
 * (shipped in the main process / GitService — see
 * src/main/services/GitService.ts):
 *
 *   window.api.gitSnapshot → read repo status (branch, file counts,
 *                            staged/unstaged, ahead/behind, remote)
 *   window.api.gitStage    → `git add` (we stage all changes)
 *   window.api.gitCommit   → `git commit -m <message>`
 *   window.api.createGithubPr → open a GitHub PR (gated on readiness)
 *
 * The ordering mirrors the safety story the composer already tells:
 *   1. Review changes  (FIRST — open Diff Studio before mutating)
 *   2. Stage + Commit  (explicit message + button; no prompt injection)
 *   3. Create PR       (only when the repo is valid + branch suitable)
 *
 * The component owns its own snapshot fetch so App.tsx stays thin, and
 * lifts the snapshot up via `onSnapshot` so the above-bar header can
 * surface live git state (branch / changed-file count / staged state /
 * push + PR readiness) without a second IPC round-trip.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitPrReadiness, GitRepositorySnapshot, GitResult } from '../../../main/services/GitService'

export interface GitCommitControlsProps {
  /** Workspace path to operate on. When absent the controls render a
   * "no workspace" hint and disable all git actions. */
  workspacePath: string | null | undefined
  /** Owning chat for an external repository grant. Registered workspace
   * repositories omit this and retain the existing workspace-scoped path. */
  chatId?: string
  /** Whether the parent diff-action menu is currently open. We lazily
   * fetch the snapshot only while open to avoid background IPC churn. */
  open: boolean
  /** True when the latest run produced a reviewable diff. Drives the
   * Review-changes enablement so the FIRST safety step matches the rest
   * of the above-bar. */
  hasReviewableDiff: boolean
  /** Open Diff Studio (the canonical "review changes" entry point). */
  onReviewChanges: () => void
  /** Close the parent menu (after a terminal action). */
  onClose: () => void
  /** Create a GitHub PR for this workspace. The parent owns the
   * per-path PR state machine + the actual createGithubPr call so the
   * other above-bar rows stay coherent; we just gate + delegate. */
  onCreatePr: () => void
  /** Current PR state for this workspace path (from the parent's
   * per-path map). Drives the Create-PR label/disabled visuals. */
  prState: { status: 'idle' | 'pending' | 'success' | 'error'; message?: string }
  /** Lifts the freshest snapshot (or null on failure) up to the parent
   * so the above-bar header can render live git state. Called on every
   * successful/failed fetch and after stage/commit refreshes. */
  onSnapshot?: (snapshot: GitRepositorySnapshot | null) => void
}

type ActionState = {
  status: 'idle' | 'working' | 'error' | 'success'
  message?: string
}

/**
 * FALLBACK PR-readiness — used only while the canonical backend
 * `githubPrReadiness` is loading or unavailable (older build / `gh`
 * missing). When the backend readiness resolves it is preferred.
 *
 * Whether the repo is in a state where opening a PR can plausibly
 * succeed. Mirrors GitService.createPullRequest's own guards (not
 * detached, has a branch, has a remote) plus a "there is something to
 * PR" heuristic so a pristine repo with no local work doesn't offer a
 * PR button that the backend would only reject. We deliberately stay a
 * touch permissive on the "commits vs base" check — if the user is
 * ahead, dirty, or already tracking an upstream, there is something to
 * turn into a PR; the backend surfaces the precise "push first" error
 * when needed.
 */
function computePrReadiness(snapshot: GitRepositorySnapshot | null): {
  canCreate: boolean
  reason: string
} {
  if (!snapshot) return { canCreate: false, reason: 'Not a Git repository.' }
  if (snapshot.detached || !snapshot.branch) {
    return { canCreate: false, reason: 'Detached HEAD — switch to a branch to open a PR.' }
  }
  if (!snapshot.remoteUrl) {
    return { canCreate: false, reason: 'No git remote configured — add one to open a PR.' }
  }
  const hasSomethingToPr = !snapshot.clean || snapshot.ahead > 0 || Boolean(snapshot.upstream)
  if (!hasSomethingToPr) {
    return { canCreate: false, reason: 'No commits to turn into a PR yet.' }
  }
  return { canCreate: true, reason: '' }
}

export function GitCommitControls({
  workspacePath,
  chatId,
  open,
  hasReviewableDiff,
  onReviewChanges,
  onClose,
  onCreatePr,
  prState,
  onSnapshot
}: GitCommitControlsProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null)
  // Canonical PR readiness from the backend (Codex's githubPrReadiness,
  // 8d348fc) — checks detached / remote / push-first AND existing PRs via
  // gh. Preferred over the local computePrReadiness mirror; null while it
  // loads or if the API / `gh` is unavailable, in which case we fall back.
  const [serverReadiness, setServerReadiness] = useState<GitPrReadiness | null>(null)
  const [loadState, setLoadState] = useState<ActionState>({ status: 'idle' })
  const [commitState, setCommitState] = useState<ActionState>({ status: 'idle' })
  const [pushState, setPushState] = useState<ActionState>({ status: 'idle' })
  const [message, setMessage] = useState('')
  // Guards against setState-after-unmount when the menu closes mid-IPC.
  const mountedRef = useRef(true)
  // Keep the latest onSnapshot without making fetch effects depend on
  // an inline callback identity (parents often pass a fresh arrow).
  // Synced in an effect (matching ChangelogSheet/BugReportSheet's
  // `dismissRef` pattern) rather than during render.
  const onSnapshotRef = useRef(onSnapshot)
  useEffect(() => {
    onSnapshotRef.current = onSnapshot
  }, [onSnapshot])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshSnapshot = useCallback(async () => {
    if (!workspacePath) {
      setSnapshot(null)
      setLoadState({ status: 'idle' })
      onSnapshotRef.current?.(null)
      return
    }
    if (typeof window.api?.gitSnapshot !== 'function') {
      setLoadState({ status: 'error', message: 'Git is unavailable in this build.' })
      onSnapshotRef.current?.(null)
      return
    }
    setLoadState({ status: 'working' })
    try {
      const result: GitResult<GitRepositorySnapshot> = await window.api.gitSnapshot({
        workspacePath,
        ...(chatId ? { chatId } : {})
      })
      if (!mountedRef.current) return
      if (result.ok) {
        setSnapshot(result.data)
        setLoadState({ status: 'idle' })
        onSnapshotRef.current?.(result.data)
      } else {
        setSnapshot(null)
        setLoadState({ status: 'error', message: result.error || 'Not a Git repository.' })
        onSnapshotRef.current?.(null)
      }
    } catch (error) {
      if (!mountedRef.current) return
      setSnapshot(null)
      setLoadState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to read Git status.'
      })
      onSnapshotRef.current?.(null)
    }
  }, [chatId, workspacePath])

  // Canonical PR-readiness fetch (backend, gh-aware). Runs alongside the
  // snapshot fetch; any failure leaves serverReadiness null so the local
  // mirror takes over — this never blocks commit/status. Guarded for
  // older builds that predate the githubPrReadiness API.
  const refreshReadiness = useCallback(async () => {
    if (!workspacePath || typeof window.api?.githubPrReadiness !== 'function') {
      setServerReadiness(null)
      return
    }
    try {
      const result = await window.api.githubPrReadiness({
        workspacePath,
        ...(chatId ? { chatId } : {})
      })
      if (!mountedRef.current) return
      setServerReadiness(result.ok ? result.data : null)
    } catch {
      if (!mountedRef.current) return
      setServerReadiness(null)
    }
  }, [chatId, workspacePath])

  // Lazily (re)fetch whenever the menu opens or the workspace changes.
  useEffect(() => {
    if (!open) return
    void refreshSnapshot()
    void refreshReadiness()
  }, [open, refreshSnapshot, refreshReadiness])

  const handleCommit = useCallback(async () => {
    const trimmed = message.trim()
    if (!workspacePath) {
      setCommitState({ status: 'error', message: 'Open a workspace to commit.' })
      return
    }
    if (!trimmed) {
      setCommitState({ status: 'error', message: 'Enter a commit message first.' })
      return
    }
    if (typeof window.api?.gitStage !== 'function' || typeof window.api?.gitCommit !== 'function') {
      setCommitState({ status: 'error', message: 'Git is unavailable in this build.' })
      return
    }
    setCommitState({ status: 'working', message: 'Staging changes…' })
    try {
      // Stage everything the user is reviewing, then commit. Two
      // explicit steps so a stage failure surfaces distinctly from a
      // commit failure (e.g. nothing staged, hook rejection).
      const staged = await window.api.gitStage({
        workspacePath,
        ...(chatId ? { chatId } : {}),
        all: true
      })
      if (!mountedRef.current) return
      if (!staged.ok) {
        setCommitState({ status: 'error', message: staged.error || 'Failed to stage changes.' })
        return
      }
      setCommitState({ status: 'working', message: 'Committing…' })
      const committed = await window.api.gitCommit({
        workspacePath,
        ...(chatId ? { chatId } : {}),
        message: trimmed
      })
      if (!mountedRef.current) return
      if (!committed.ok) {
        setCommitState({ status: 'error', message: committed.error || 'Failed to commit.' })
        // Refresh so the status block reflects the (now-staged) state.
        void refreshSnapshot()
        return
      }
      // Success: clear the draft, reflect the post-commit snapshot, and
      // surface the new state. We keep the menu open so the user can
      // immediately push/PR if they want.
      setMessage('')
      setSnapshot(committed.data)
      onSnapshotRef.current?.(committed.data)
      // The new commit changes ahead/push state — refresh the canonical PR gate.
      void refreshReadiness()
      setCommitState({ status: 'success', message: 'Committed.' })
    } catch (error) {
      if (!mountedRef.current) return
      setCommitState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to commit.'
      })
    }
  }, [chatId, message, workspacePath, refreshSnapshot, refreshReadiness])

  // Phase Git-U5 — push the committed branch so a PR can open. First push (no
  // upstream yet) sets the upstream; later pushes are a plain `git push`.
  // GitService.push re-validates branch/remote, so a race fails safely.
  const handlePush = useCallback(async () => {
    if (!workspacePath) {
      setPushState({ status: 'error', message: 'Open a workspace to push.' })
      return
    }
    if (typeof window.api?.gitPush !== 'function') {
      setPushState({ status: 'error', message: 'Git is unavailable in this build.' })
      return
    }
    setPushState({ status: 'working', message: 'Pushing…' })
    try {
      const pushed = await window.api.gitPush({
        workspacePath,
        ...(chatId ? { chatId } : {}),
        setUpstream: !snapshot?.upstream
      })
      if (!mountedRef.current) return
      if (!pushed.ok) {
        setPushState({ status: 'error', message: pushed.error || 'Failed to push.' })
        return
      }
      setSnapshot(pushed.data)
      onSnapshotRef.current?.(pushed.data)
      // Pushing clears the "push first" gate — refresh the canonical PR readiness.
      void refreshReadiness()
      setPushState({ status: 'success', message: 'Pushed.' })
    } catch (error) {
      if (!mountedRef.current) return
      setPushState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to push.'
      })
    }
  }, [chatId, workspacePath, snapshot?.upstream, refreshReadiness])

  // Prefer the canonical backend readiness (gh-aware: detached, remote,
  // push-first, AND existing-PR detection); fall back to the local mirror
  // while it loads or if the API / `gh` is unavailable.
  const prReadiness: { canCreate: boolean; reason: string } = serverReadiness
    ? { canCreate: serverReadiness.canCreatePullRequest, reason: serverReadiness.reason ?? '' }
    : computePrReadiness(snapshot)
  const prLabel =
    prState.status === 'pending'
      ? 'Creating…'
      : prState.status === 'success'
        ? 'PR opened'
        : prState.status === 'error'
          ? 'Retry PR'
          : 'Create PR'

  const counts = snapshot?.counts
  const hasStaged = (counts?.staged ?? 0) > 0
  const changedCount = counts?.changed ?? 0
  // Commit is allowed whenever there is anything to stage+commit OR
  // something already staged. (The backend re-checks staged-ness, so a
  // race that leaves nothing staged still fails safely with a message.)
  const canCommit =
    Boolean(workspacePath) &&
    snapshot != null &&
    commitState.status !== 'working' &&
    (changedCount > 0 || hasStaged)
  // Push gating mirrors GitService.push's guards (branch + remote) plus a
  // "there's something to push" check: no upstream yet, or local commits ahead.
  const pushReason = !snapshot
    ? 'Not a Git repository.'
    : snapshot.detached || !snapshot.branch
      ? 'Detached HEAD — switch to a branch to push.'
      : !snapshot.remoteUrl
        ? 'No git remote configured — add one to push.'
        : snapshot.upstream && (snapshot.ahead ?? 0) === 0
          ? 'Nothing to push — branch is up to date.'
          : ''
  const canPush =
    Boolean(workspacePath) && snapshot != null && pushState.status !== 'working' && pushReason === ''
  const pushLabel =
    pushState.status === 'working'
      ? 'Pushing…'
      : pushState.status === 'success'
        ? 'Pushed'
        : pushState.status === 'error'
          ? 'Retry push'
          : !snapshot?.upstream
            ? 'Publish branch'
            : 'Push'

  return (
    <div className="composer-git-controls" role="group" aria-label="Git controls">
      {/* Live repo status, driven entirely by gitSnapshot. */}
      <div className="composer-git-status" aria-live="polite">
        {loadState.status === 'working' && !snapshot ? (
          <span className="composer-git-status-line is-muted">Reading Git status…</span>
        ) : loadState.status === 'error' ? (
          <span className="composer-git-status-line is-error">
            {loadState.message || 'Not a Git repository.'}
          </span>
        ) : snapshot ? (
          <>
            <span className="composer-git-status-line">
              <strong className="composer-git-branch">
                {snapshot.detached ? 'detached HEAD' : snapshot.branch || 'unknown branch'}
              </strong>
              {snapshot.clean ? <span className="composer-git-status-clean">clean</span> : null}
            </span>
            {!snapshot.clean ? (
              <span className="composer-git-status-line composer-git-status-counts-line">
                <span className="composer-git-status-counts">
                  {changedCount} {changedCount === 1 ? 'change' : 'changes'}
                  {hasStaged ? ` · ${counts?.staged} staged` : ''}
                  {(counts?.unstaged ?? 0) > 0 ? ` · ${counts?.unstaged} unstaged` : ''}
                  {(counts?.untracked ?? 0) > 0 ? ` · ${counts?.untracked} new` : ''}
                </span>
              </span>
            ) : null}
            {(snapshot.ahead > 0 || snapshot.behind > 0 || !snapshot.upstream) && (
              <span className="composer-git-status-line is-muted">
                {!snapshot.upstream
                  ? 'No upstream — push to set one.'
                  : `${snapshot.ahead} ahead · ${snapshot.behind} behind ${snapshot.upstream}`}
              </span>
            )}
          </>
        ) : (
          <span className="composer-git-status-line is-muted">No workspace selected.</span>
        )}
      </div>

      {/* 1. Review changes — the FIRST safety step, before any mutation. */}
      <button
        type="button"
        className="composer-git-menu-item"
        onClick={() => {
          onReviewChanges()
          onClose()
        }}
        disabled={!hasReviewableDiff}
        title={
          hasReviewableDiff
            ? 'Open Diff Studio to review the latest run changes'
            : 'No latest run diff is available yet'
        }
      >
        Review changes
      </button>

      {/* 2. Stage + commit — explicit message + button (no prompt injection). */}
      <div className="composer-git-commit">
        <input
          type="text"
          className="composer-git-commit-input"
          value={message}
          placeholder="Commit message"
          aria-label="Commit message"
          onChange={(event) => {
            setMessage(event.target.value)
            if (commitState.status === 'error' || commitState.status === 'success') {
              setCommitState({ status: 'idle' })
            }
          }}
          onKeyDown={(event) => {
            // Enter commits (mirrors the dedicated button) so the flow is
            // keyboard-complete; Escape bubbles to the menu's own handler.
            if (event.key === 'Enter' && canCommit && message.trim()) {
              event.preventDefault()
              void handleCommit()
            }
          }}
          disabled={!workspacePath || commitState.status === 'working'}
        />
        <button
          type="button"
          className={`composer-above-bar-action composer-git-commit-button ${
            commitState.status === 'working' ? 'is-pending' : ''
          } ${commitState.status === 'error' ? 'is-error' : ''} ${
            commitState.status === 'success' ? 'is-success' : ''
          }`}
          onClick={() => void handleCommit()}
          disabled={!canCommit || !message.trim()}
          title={
            !workspacePath
              ? 'Open a workspace to commit'
              : changedCount === 0 && !hasStaged
                ? 'No changes to commit'
                : 'Stage all changes and commit with this message'
          }
        >
          {commitState.status === 'working' ? 'Committing…' : 'Stage all & Commit'}
        </button>
      </div>
      {commitState.message && commitState.status !== 'idle' && (
        <span
          className={`composer-git-feedback ${
            commitState.status === 'error'
              ? 'is-error'
              : commitState.status === 'success'
                ? 'is-success'
                : 'is-muted'
          }`}
          role={commitState.status === 'error' ? 'alert' : undefined}
        >
          {commitState.message}
        </span>
      )}

      {/* 3. Push — publish the branch / push ahead commits so a PR can open. */}
      <button
        type="button"
        className={`composer-git-menu-item ${
          pushState.status === 'working' ? 'is-pending' : ''
        } ${pushState.status === 'error' ? 'is-error' : ''} ${
          pushState.status === 'success' ? 'is-success' : ''
        }`}
        onClick={() => void handlePush()}
        disabled={!canPush}
        title={
          pushState.message ||
          (canPush
            ? !snapshot?.upstream
              ? 'Publish this branch to its remote (sets upstream)'
              : `Push ${snapshot?.ahead ?? 0} local commit${(snapshot?.ahead ?? 0) === 1 ? '' : 's'}`
            : pushReason)
        }
      >
        {pushLabel}
      </button>

      {/* 4. Create PR — gated on validity + branch suitability. */}
      <button
        type="button"
        className={`composer-git-menu-item composer-git-pr ${
          prState.status === 'pending' ? 'is-pending' : ''
        } ${prState.status === 'error' ? 'is-error' : ''} ${
          prState.status === 'success' ? 'is-success' : ''
        }`}
        onClick={() => {
          onCreatePr()
          onClose()
        }}
        disabled={prState.status === 'pending' || !prReadiness.canCreate}
        title={
          prState.message ||
          (prReadiness.canCreate
            ? 'Open a GitHub pull request for this branch'
            : prReadiness.reason)
        }
      >
        {prLabel}
        {!prReadiness.canCreate && prState.status !== 'pending' && (
          <span className="composer-git-pr-reason">{prReadiness.reason}</span>
        )}
      </button>
    </div>
  )
}
