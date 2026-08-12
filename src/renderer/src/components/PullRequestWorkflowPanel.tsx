import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { GitUnpushedCommit } from '../../../main/services/GitCommitStack'
import type {
  GitCommitGroupPullRequestResult,
  GitPullRequestLifecycleAction,
  GitPullRequestWorkspaceSnapshot
} from '../../../main/services/GitPullRequestWorkflow'
import type { GitPrSummary } from '../../../main/services/GitService'
import {
  stripTaskWraithCommitGroup,
  taskWraithCommitGroupHashes
} from '../../../shared/gitPullRequestGroups'
import { summarizeChecks } from './GitStatusChips'

export interface PullRequestDraft {
  title: string
  branch: string
  baseBranch: string
  body: string
  draft: boolean
  openInBrowser: boolean
}

interface PullRequestEditDraft {
  number: number
  title: string
  body: string
  baseBranch: string
}

interface PullRequestMergeDraft {
  number: number
  strategy: 'merge' | 'squash' | 'rebase'
  auto: boolean
  deleteBranch: boolean
}

function branchSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function defaultPullRequestDraft(
  commits: readonly GitUnpushedCommit[],
  baseBranch = 'master'
): PullRequestDraft {
  const newest = commits[0]
  const oldest = commits[commits.length - 1]
  const title =
    commits.length > 1 && newest
      ? `${newest.subject} (+${commits.length - 1} commit${commits.length === 2 ? '' : 's'})`
      : newest?.subject || 'Grouped commits'
  const slug = branchSlug(newest?.subject || 'grouped-commits') || 'grouped-commits'
  const suffix = oldest?.hash.slice(0, 7) || 'request'
  const body = commits
    .slice()
    .reverse()
    .map((commit) => `- \`${commit.hash.slice(0, 9)}\` ${commit.subject}`)
    .join('\n')
  return {
    title,
    branch: `codex/${slug}-${suffix}`,
    baseBranch,
    body: body ? `## Commits\n\n${body}` : '',
    draft: true,
    openInBrowser: false
  }
}

/** Original checkout hash -> PRs created from that commit through this Inspector. */
export function pullRequestsByOriginalCommit(
  pullRequests: readonly GitPrSummary[]
): Map<string, GitPrSummary[]> {
  const grouped = new Map<string, GitPrSummary[]>()
  for (const pullRequest of pullRequests) {
    for (const hash of taskWraithCommitGroupHashes(pullRequest.body)) {
      const existing = grouped.get(hash) || []
      existing.push(pullRequest)
      grouped.set(hash, existing)
    }
  }
  return grouped
}

function pullRequestState(pr: GitPrSummary): {
  label: string
  tone: string
} {
  const state = (pr.state || '').toUpperCase()
  if (state === 'MERGED') return { label: 'Merged', tone: 'merged' }
  if (state === 'CLOSED') return { label: 'Closed', tone: 'closed' }
  if (pr.isDraft) return { label: 'Draft', tone: 'draft' }
  if (state === 'OPEN') return { label: 'Ready', tone: 'open' }
  return { label: pr.state || 'Unknown', tone: 'unknown' }
}

function pullRequestChecks(pr: GitPrSummary): string | null {
  const checks = summarizeChecks(pr.checks)
  if (checks.total === 0) return null
  if (checks.fail > 0) return `${checks.fail} failed`
  if (checks.pending > 0) return `${checks.pending} pending`
  return `${checks.pass} passed`
}

function prKey(pr: GitPrSummary, index: number): string {
  return String(pr.number || pr.url || pr.headRefName || index)
}

export function PullRequestWorkflowPanel({
  workspacePath,
  chatId,
  selectedCommits,
  requestOpen,
  fallbackBaseBranch,
  onRequestOpenChange,
  onCreated,
  onSnapshot
}: {
  workspacePath: string
  chatId?: string
  selectedCommits: GitUnpushedCommit[]
  requestOpen: boolean
  fallbackBaseBranch?: string
  onRequestOpenChange: (open: boolean) => void
  onCreated?: (result: GitCommitGroupPullRequestResult) => void
  onSnapshot?: (snapshot: GitPullRequestWorkspaceSnapshot) => void
}): ReactNode {
  const [snapshot, setSnapshot] = useState<GitPullRequestWorkspaceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [draft, setDraft] = useState<PullRequestDraft>(() =>
    defaultPullRequestDraft(selectedCommits, fallbackBaseBranch)
  )
  const [initializedRequest, setInitializedRequest] = useState('')
  const [editing, setEditing] = useState<PullRequestEditDraft | null>(null)
  const [merging, setMerging] = useState<PullRequestMergeDraft | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await window.api.githubPrWorkspace({ workspacePath, chatId }).catch((cause) => ({
      ok: false as const,
      error: cause instanceof Error ? cause.message : 'Could not read pull requests.'
    }))
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setSnapshot(result.data)
    setWarnings(result.data.warnings)
    onSnapshot?.(result.data)
  }, [chatId, onSnapshot, workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const selectedKey = selectedCommits.map((commit) => commit.hash).join(':')
  const resolvedBaseBranch =
    snapshot?.defaultBaseBranch || fallbackBaseBranch || draft.baseBranch || 'master'
  useEffect(() => {
    if (!requestOpen) {
      setInitializedRequest('')
      return
    }
    const requestKey = `${selectedKey}:${resolvedBaseBranch}`
    if (initializedRequest === requestKey) return
    setDraft(defaultPullRequestDraft(selectedCommits, resolvedBaseBranch))
    setInitializedRequest(requestKey)
  }, [initializedRequest, requestOpen, resolvedBaseBranch, selectedCommits, selectedKey])

  const createPullRequest = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (selectedCommits.length === 0) {
        setError('Select at least one commit for the pull request.')
        return
      }
      setBusyAction('create')
      setError(null)
      const result = await window.api
        .githubCreateCommitGroupPr({
          workspacePath,
          chatId,
          commits: selectedCommits.map((commit) => commit.hash),
          branch: draft.branch,
          baseBranch: draft.baseBranch,
          title: draft.title,
          body: draft.body,
          draft: draft.draft,
          openInBrowser: draft.openInBrowser
        })
        .catch((cause) => ({
          ok: false as const,
          error: cause instanceof Error ? cause.message : 'Could not create the pull request.'
        }))
      setBusyAction(null)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setWarnings(result.data.warnings)
      onRequestOpenChange(false)
      onCreated?.(result.data)
      await refresh()
    },
    [chatId, draft, onCreated, onRequestOpenChange, refresh, selectedCommits, workspacePath]
  )

  const managePullRequest = useCallback(
    async (
      pullRequestNumber: number,
      lifecycle: GitPullRequestLifecycleAction
    ): Promise<boolean> => {
      const actionKey = `${pullRequestNumber}:${lifecycle.action}`
      setBusyAction(actionKey)
      setError(null)
      const result = await window.api
        .githubManagePr({
          workspacePath,
          chatId,
          pullRequestNumber,
          lifecycle
        })
        .catch((cause) => ({
          ok: false as const,
          error: cause instanceof Error ? cause.message : 'Could not update the pull request.'
        }))
      setBusyAction(null)
      if (!result.ok) {
        setError(result.error)
        return false
      }
      setWarnings(result.data.warnings)
      await refresh()
      return true
    },
    [chatId, refresh, workspacePath]
  )

  const submitEdit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!editing) return
      const saved = await managePullRequest(editing.number, {
        action: 'edit',
        title: editing.title,
        body: editing.body,
        baseBranch: editing.baseBranch
      })
      if (saved) setEditing(null)
    },
    [editing, managePullRequest]
  )

  const submitMerge = useCallback(
    async (event: FormEvent<HTMLFormElement>, pr: GitPrSummary) => {
      event.preventDefault()
      if (!merging || !pr.number) return
      const mode = merging.auto ? 'enable auto-merge for' : 'merge'
      if (
        !window.confirm(
          `${mode[0].toUpperCase()}${mode.slice(1)} PR #${pr.number} using ${merging.strategy}?`
        )
      ) {
        return
      }
      const merged = await managePullRequest(pr.number, {
        action: 'merge',
        strategy: merging.strategy,
        auto: merging.auto,
        deleteBranch: merging.deleteBranch,
        expectedHeadSha: pr.headRefOid
      })
      if (merged) setMerging(null)
    },
    [managePullRequest, merging]
  )

  const openPullRequest = useCallback(async (pr: GitPrSummary) => {
    if (!pr.url) return
    const result = await window.api.openExternalOrPath(pr.url)
    if (!result.ok) setError(result.error || 'Could not open the pull request.')
  }, [])

  const groupedCommits = useMemo(
    () => pullRequestsByOriginalCommit(snapshot?.pullRequests || []),
    [snapshot?.pullRequests]
  )
  const unavailable = snapshot && !snapshot.available ? snapshot : null
  const creationDisabled =
    busyAction !== null || loading || Boolean(unavailable) || selectedCommits.length === 0

  return (
    <section className="pull-request-workflow" aria-label="Pull request workflow">
      <div className="pull-request-workflow-header">
        <div>
          <strong>Pull requests</strong>
          <span>Group commits and manage their GitHub lifecycle.</span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || busyAction !== null}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {requestOpen && (
        <form
          className="pull-request-form"
          aria-label="Create pull request"
          onSubmit={createPullRequest}
        >
          <div className="pull-request-form-heading">
            <div>
              <strong>New PR request</strong>
              <span>
                {selectedCommits.length} selected commit{selectedCommits.length === 1 ? '' : 's'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onRequestOpenChange(false)}
              disabled={busyAction !== null}
            >
              Cancel
            </button>
          </div>
          <label>
            <span>Title</span>
            <input
              required
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          </label>
          <div className="pull-request-form-columns">
            <label>
              <span>PR branch</span>
              <input
                required
                spellCheck={false}
                value={draft.branch}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, branch: event.target.value }))
                }
              />
            </label>
            <label>
              <span>Base branch</span>
              <input
                required
                spellCheck={false}
                value={draft.baseBranch}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, baseBranch: event.target.value }))
                }
              />
            </label>
          </div>
          <label>
            <span>Body</span>
            <textarea
              rows={6}
              value={draft.body}
              onChange={(event) =>
                setDraft((current) => ({ ...current, body: event.target.value }))
              }
            />
          </label>
          <div className="pull-request-form-options">
            <label>
              <input
                type="checkbox"
                checked={draft.draft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, draft: event.target.checked }))
                }
              />
              Create as draft
            </label>
            <label>
              <input
                type="checkbox"
                checked={draft.openInBrowser}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, openInBrowser: event.target.checked }))
                }
              />
              Open on GitHub after creation
            </label>
          </div>
          <p className="pull-request-form-note">
            TaskWraith replays these commits oldest-first in a temporary worktree. This checkout
            stays on its current branch.
          </p>
          {unavailable?.reason && <p className="pull-request-inline-error">{unavailable.reason}</p>}
          <div className="pull-request-form-actions">
            <button type="submit" className="is-primary" disabled={creationDisabled}>
              {busyAction === 'create'
                ? 'Creating…'
                : draft.draft
                  ? 'Create draft PR'
                  : 'Create PR'}
            </button>
          </div>
        </form>
      )}

      {error && <p className="pull-request-inline-error">{error}</p>}
      {warnings.length > 0 && (
        <div className="pull-request-warnings" role="status">
          {warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      )}

      {!requestOpen && loading && !snapshot ? (
        <div className="pull-request-empty">Loading pull requests…</div>
      ) : unavailable ? (
        <div className="pull-request-empty">
          <strong>GitHub workflow unavailable</strong>
          <span>
            {unavailable.reason || 'Pull requests could not be read for this repository.'}
          </span>
        </div>
      ) : snapshot && snapshot.pullRequests.length === 0 ? (
        <div className="pull-request-empty">
          <strong>No pull requests yet</strong>
          <span>Select commits above to assemble the first request.</span>
        </div>
      ) : (
        <div className="pull-request-list">
          {(snapshot?.pullRequests || []).map((pr, index) => {
            const state = pullRequestState(pr)
            const checkLabel = pullRequestChecks(pr)
            const groupedCount = taskWraithCommitGroupHashes(pr.body).length
            const number = pr.number
            const open = (pr.state || '').toUpperCase() === 'OPEN'
            const closed = (pr.state || '').toUpperCase() === 'CLOSED'
            const isEditing = Boolean(number && editing?.number === number)
            const isMerging = Boolean(number && merging?.number === number)
            return (
              <article className="pull-request-card" key={prKey(pr, index)}>
                <div className="pull-request-card-heading">
                  <div className="pull-request-card-title">
                    <span className={`pull-request-state is-${state.tone}`}>{state.label}</span>
                    <strong title={pr.title}>{pr.title || `Pull request #${number || '—'}`}</strong>
                  </div>
                  {number && <code>#{number}</code>}
                </div>
                <div className="pull-request-card-meta">
                  <span>
                    {pr.headRefName || 'branch'} → {pr.baseRefName || 'base'}
                  </span>
                  {groupedCount > 0 && (
                    <span>
                      {groupedCount} grouped commit{groupedCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {checkLabel && <span>{checkLabel}</span>}
                </div>

                {isEditing && editing ? (
                  <form
                    className="pull-request-edit-form"
                    aria-label={`Edit PR #${number}`}
                    onSubmit={submitEdit}
                  >
                    <label>
                      <span>Title</span>
                      <input
                        required
                        value={editing.title}
                        onChange={(event) =>
                          setEditing((current) =>
                            current ? { ...current, title: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label>
                      <span>Base branch</span>
                      <input
                        required
                        spellCheck={false}
                        value={editing.baseBranch}
                        onChange={(event) =>
                          setEditing((current) =>
                            current ? { ...current, baseBranch: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <label>
                      <span>Body</span>
                      <textarea
                        rows={5}
                        value={editing.body}
                        onChange={(event) =>
                          setEditing((current) =>
                            current ? { ...current, body: event.target.value } : current
                          )
                        }
                      />
                    </label>
                    <div className="pull-request-card-actions">
                      <button type="submit" className="is-primary" disabled={busyAction !== null}>
                        {busyAction === `${number}:edit` ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        disabled={busyAction !== null}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {isMerging && merging ? (
                  <form
                    className="pull-request-merge-form"
                    aria-label={`Merge PR #${number}`}
                    onSubmit={(event) => void submitMerge(event, pr)}
                  >
                    <label>
                      <span>Strategy</span>
                      <select
                        value={merging.strategy}
                        onChange={(event) =>
                          setMerging((current) =>
                            current
                              ? {
                                  ...current,
                                  strategy: event.target.value as PullRequestMergeDraft['strategy']
                                }
                              : current
                          )
                        }
                      >
                        <option value="merge">Merge commit</option>
                        <option value="squash">Squash and merge</option>
                        <option value="rebase">Rebase and merge</option>
                      </select>
                    </label>
                    <div className="pull-request-form-options">
                      <label>
                        <input
                          type="checkbox"
                          checked={merging.auto}
                          onChange={(event) =>
                            setMerging((current) =>
                              current ? { ...current, auto: event.target.checked } : current
                            )
                          }
                        />
                        Auto-merge when ready
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={merging.deleteBranch}
                          onChange={(event) =>
                            setMerging((current) =>
                              current ? { ...current, deleteBranch: event.target.checked } : current
                            )
                          }
                        />
                        Delete PR branch
                      </label>
                    </div>
                    <div className="pull-request-card-actions">
                      <button type="submit" className="is-primary" disabled={busyAction !== null}>
                        {busyAction === `${number}:merge`
                          ? 'Applying…'
                          : merging.auto
                            ? 'Enable auto-merge'
                            : 'Merge'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setMerging(null)}
                        disabled={busyAction !== null}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {!isEditing && !isMerging && (
                  <div className="pull-request-card-actions">
                    <button
                      type="button"
                      disabled={!pr.url}
                      onClick={() => void openPullRequest(pr)}
                    >
                      Open
                    </button>
                    {number && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          setEditing({
                            number,
                            title: pr.title || '',
                            body: stripTaskWraithCommitGroup(pr.body),
                            baseBranch: pr.baseRefName || snapshot?.defaultBaseBranch || 'master'
                          })
                        }
                      >
                        Edit
                      </button>
                    )}
                    {number && open && pr.isDraft && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void managePullRequest(number, { action: 'mark-ready' })}
                      >
                        {busyAction === `${number}:mark-ready` ? 'Updating…' : 'Mark ready'}
                      </button>
                    )}
                    {number && open && !pr.isDraft && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          void managePullRequest(number, { action: 'convert-to-draft' })
                        }
                      >
                        {busyAction === `${number}:convert-to-draft`
                          ? 'Updating…'
                          : 'Convert to draft'}
                      </button>
                    )}
                    {number && open && !pr.isDraft && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() =>
                          setMerging({
                            number,
                            strategy: 'squash',
                            auto: false,
                            deleteBranch: true
                          })
                        }
                      >
                        Merge…
                      </button>
                    )}
                    {number && open && (
                      <button
                        type="button"
                        className="is-danger"
                        disabled={busyAction !== null}
                        onClick={() => {
                          if (!window.confirm(`Close PR #${number}?`)) return
                          void managePullRequest(number, { action: 'close' })
                        }}
                      >
                        {busyAction === `${number}:close` ? 'Closing…' : 'Close'}
                      </button>
                    )}
                    {number && closed && (
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void managePullRequest(number, { action: 'reopen' })}
                      >
                        {busyAction === `${number}:reopen` ? 'Reopening…' : 'Reopen'}
                      </button>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}

      {groupedCommits.size > 0 && (
        <p className="pull-request-group-summary">
          {groupedCommits.size} checkout commit{groupedCommits.size === 1 ? '' : 's'} linked to PR
          requests.
        </p>
      )}
    </section>
  )
}
