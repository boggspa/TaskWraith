/*
 * ExternalPathAboveRow — one stacked above-bar row per external-path
 * grant. Renders branch + repo name when the grant points to a git
 * repo (per the runtime probe from slice 1); falls back to the path's
 * basename when it's a single file or non-repo folder.
 *
 * Slice 3 of the external-path-redesign arc. Per-repo diff stats and
 * per-repo Create-PR are deferred to slice 6 — this slice ships the
 * scaffolding (row layout + branch label + revoke affordance) so the
 * stack shape is in place before the runtime detector (slice 5)
 * starts producing new grants.
 *
 * The wrapping `.composer-above-bar` class lets this row inherit ALL
 * the per-shell above-bar styling that the primary row already uses
 * (Codex tucked tab, Claude bare-text, Modular floating, Stub
 * parchment, etc.). The stack container in App.tsx renders both the
 * primary row and any number of these secondary rows back-to-back.
 */

import type { ComposerStyle, ExternalPathGrant } from '../../../main/store/types'
import type { ExternalPathGitMetadata } from '../lib/ExternalPathRepoDetect'
import { describeExternalPath } from '../lib/ExternalPathRepoDetect'
import { getPoolIconAsset, preparePoolIconSvg } from '../lib/agentPoolIconAssets'
import { getProviderName } from './Sidebar'
import { useState } from 'react'
import { branchTone, GitMergeBadge, GitPrLifecycleChip, GitSyncChip } from './GitStatusChips'
import { GitCommitControls } from './GitCommitControls'
import { AnimatedDiffNumber } from './AnimatedDiffNumber'
import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'

/**
 * 1.0.5-EW42b — Derive a human-readable "where did this grant
 * come from?" label from the `grant.id` prefix, the `provider`,
 * and the `createdAt` ISO timestamp.
 *
 * Grant id prefixes:
 *   - `runtime-${ts}-${rand}`               → agent's tool call
 *                                             tripped the runtime
 *                                             external-path
 *                                             detector + the user
 *                                             approved.
 *   - `proactive-${ts}-${provider}-${rand}` → 1.0.5-EW42a: user
 *                                             clicked "Grant
 *                                             read access to
 *                                             another folder…" in
 *                                             the composer
 *                                             workspace switcher.
 *   - `${digits}-${rand}` (legacy)          → manual picker from
 *                                             pre-EW42a code
 *                                             paths (now gone, but
 *                                             persisted grants
 *                                             from older sessions
 *                                             may still match).
 *
 * The tooltip line answers the user's "what triggered this?"
 * question — historically the banner appeared mysteriously, and
 * EW42b makes the trigger visible via hover.
 */
export function buildExternalPathOriginTooltip(
  grant: ExternalPathGrant,
  overrides?: { providerLabel?: string; access?: 'read' | 'write' }
): string {
  const providerName = overrides?.providerLabel ?? getProviderName(grant.provider)
  const accessLabel = (overrides?.access ?? grant.access) === 'write' ? 'edit access' : 'read access'
  const origin = (() => {
    if (grant.id.startsWith('proactive-')) {
      return 'You granted this via the composer workspace switcher.'
    }
    if (grant.id.startsWith('runtime-')) {
      return `${providerName} requested access during a tool call; you approved it.`
    }
    return `Granted manually via an older picker.`
  })()
  const when = (() => {
    try {
      const ts = new Date(grant.createdAt)
      if (Number.isNaN(ts.getTime())) return grant.createdAt
      return ts.toLocaleString()
    } catch {
      return grant.createdAt
    }
  })()
  return `${providerName} · ${accessLabel} · ${when}\n${origin}`
}

interface ExternalPathDiffStats {
  additions: number
  deletions: number
  filesChanged: number
}

interface ExternalPathAboveRowProps {
  grant: ExternalPathGrant
  /**
   * This row represents ALL provider-grants for one path (an ensemble mints
   * one grant per participant-provider for the same folder). `access` is the
   * union (write if ANY provider can write) and `providers` is the full list
   * for the tooltip — so one folder reads as one native row, not N duplicates.
   */
  access?: 'read' | 'write'
  providers?: ExternalPathGrant['provider'][]
  /** Live per-path git snapshot — drives the branch tone, merge badge + sync chip. */
  snapshot?: GitRepositorySnapshot | null
  /** Best-effort PR lifecycle for this path, when GitHub/gh can resolve it. */
  pr?: GitPrSummary | null
  repoMetadata: ExternalPathGitMetadata | null
  /**
   * Per-repo diff stats from `externalPathDiffStatsByGrant` (slice 6).
   * Optional — omitted when nothing's been touched in this grant's
   * scope, in which case the row renders without the diff pill.
   */
  diffStats?: ExternalPathDiffStats
  onRevoke: (grant: ExternalPathGrant) => void
  /**
   * 1.0.6-EW66-1d — Per-path Create-PR state + handler. When the
   * grant is WRITE access and `onCreatePr` is supplied, the row
   * gains a "Create PR" action (matching the primary workspace
   * row) scoped to this grant's path. READ grants ignore both —
   * they render the existing reference-only banner. State is keyed
   * by path in the parent, so all of an ensemble's same-path write
   * rows reflect one repo's PR progress together.
   */
  createPrState?: { status: 'idle' | 'pending' | 'success' | 'error'; message?: string }
  onCreatePr?: (grant: ExternalPathGrant) => void
  /** Per-path "Review changes" — opens Diff Studio scoped to this path. */
  onReviewChanges?: () => void
  /** Cursor shell — detached satellite pills above the merged stack. */
  cursorLeadDetached?: boolean
  composerStyle?: ComposerStyle
}

const gitCommitTriggerAsset = getPoolIconAsset('pool:glyph-git-commit')
const gitCommitTriggerSvg = gitCommitTriggerAsset
  ? preparePoolIconSvg(gitCommitTriggerAsset, 22, 'currentColor')
  : ''

function GitCommitTriggerIcon(): React.JSX.Element {
  return (
    <span
      className="composer-git-commit-trigger-icon"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: gitCommitTriggerSvg }}
    />
  )
}

function BranchGlyph(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="7" r="1.6" />
      <path d="M4 5.1v5.8M5.6 7c2 0 4.8 0 4.8-1.5" />
    </svg>
  )
}

function FileGlyph(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
  )
}

function RevokeGlyph(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

function ReadGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.3" />
      <path d="M10.3 10.3L14 14" />
    </svg>
  )
}

function WriteGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11.5 2.5l2 2" />
      <path d="M3 13l1-3 7.5-7.5 2 2L6 12z" />
    </svg>
  )
}

export function ExternalPathAboveRow({
  grant,
  access,
  providers,
  snapshot,
  pr,
  repoMetadata,
  diffStats,
  onRevoke,
  createPrState,
  onCreatePr,
  onReviewChanges,
  cursorLeadDetached = false,
  composerStyle
}: ExternalPathAboveRowProps): React.JSX.Element {
  const descriptor = describeExternalPath(grant.path, { gitMetadata: repoMetadata })
  // Union access (write if ANY provider for this path can write) drives the
  // single pill; falls back to the representative grant's own access.
  const effectiveAccess = access ?? grant.access
  const isWrite = effectiveAccess === 'write'
  // 1.0.6-EW66-1d — WRITE grants pointing at a git repo get a
  // Create-PR action matching the primary workspace row, scoped to
  // this grant's path. Mirror the primary's label/state machine.
  const prStatus = createPrState?.status ?? 'idle'
  // First-class: every connected repo row gets the full action set (not just
  // write-access Create-PR). The read/write distinction now lives in the
  // compact access icon instead.
  const showRepoActions = descriptor.isRepo && typeof onCreatePr === 'function'
  const createPrLabel =
    prStatus === 'pending'
      ? 'Creating…'
      : prStatus === 'success'
        ? 'PR opened'
        : prStatus === 'error'
          ? 'Retry PR'
          : 'Create PR'
  // 1.0.5-EW42b — `accessLabel` was used here pre-EW42b to build
  // a minimal `<path> (<accessLabel> access)` title. EW42b
  // replaces that with the richer multi-line tooltip below
  // (provider + access verb + timestamp + origin source), so the
  // separate variable is no longer needed.
  const hasDiff =
    diffStats && (diffStats.filesChanged > 0 || diffStats.additions > 0 || diffStats.deletions > 0)
  // Context-aware headline + per-row commit/push/PR menu, mirroring the primary
  // workspace row (Review changes → Push/Publish → Create PR).
  const [diffMenuOpen, setDiffMenuOpen] = useState(false)
  const needsPush = Boolean(
    snapshot &&
      !snapshot.detached &&
      snapshot.branch &&
      snapshot.remoteUrl &&
      (!snapshot.upstream || (snapshot.ahead ?? 0) > 0)
  )
  const actionLabel = hasDiff
    ? 'Review changes'
    : needsPush
      ? snapshot && !snapshot.upstream
        ? 'Publish branch'
        : 'Push'
      : createPrLabel
  const useGitIconAction = composerStyle === 'codex' && Boolean(gitCommitTriggerSvg)
  const actionTitle =
    createPrState?.message || `Review, commit, push, or open a PR for ${descriptor.basename}`
  // 1.0.5-EW42b — Build a rich tooltip that explains what created
  // this grant (composer-proactive vs. agent-approval vs. legacy
  // manual picker), which provider it's scoped to, and when it
  // was issued. Hover on the whole row shows the path + this
  // origin block; hover on the access pill shows the same block
  // narrowed to the access label so the most relevant signal sits
  // where the user's eye lands.
  const providerLabel =
    providers && providers.length > 0
      ? providers.map((provider) => getProviderName(provider)).join(', ')
      : getProviderName(grant.provider)
  const originTooltip = buildExternalPathOriginTooltip(grant, {
    providerLabel,
    access: effectiveAccess
  })

  const diffCluster = hasDiff ? (
    <span className="composer-above-bar-center-cluster">
      <div className="composer-above-bar-pill composer-above-bar-pill--changes">
        <span
          className="composer-above-bar-files"
          title={`${diffStats!.filesChanged} ${
            diffStats!.filesChanged === 1 ? 'file' : 'files'
          } changed in this path`}
        >
          <AnimatedDiffNumber value={diffStats!.filesChanged} strong />{' '}
          {diffStats!.filesChanged === 1 ? 'file changed' : 'files changed'}
        </span>
      </div>
      {(diffStats!.additions > 0 || diffStats!.deletions > 0) && (
        <div className="composer-above-bar-pill composer-above-bar-pill--stats">
          <span className="composer-above-bar-stats">
            <AnimatedDiffNumber
              value={diffStats!.additions}
              prefix="+"
              className="composer-diff-add"
            />
            <AnimatedDiffNumber
              value={diffStats!.deletions}
              prefix="-"
              className="composer-diff-del"
            />
          </span>
        </div>
      )}
    </span>
  ) : null

  const trailingCluster = (
    <span className="composer-above-bar-trailing-cluster">
      {showRepoActions && (
        <span className="composer-diff-action-menu-wrap">
          <button
            type="button"
            className={`composer-above-bar-action ${useGitIconAction ? 'composer-above-bar-action--git-commit-icon' : ''} ${prStatus === 'pending' ? 'is-pending' : ''} ${
              prStatus === 'error' ? 'is-error' : ''
            } ${prStatus === 'success' ? 'is-success' : ''}`}
            onClick={() => setDiffMenuOpen((open) => !open)}
            disabled={prStatus === 'pending'}
            aria-haspopup="menu"
            aria-expanded={diffMenuOpen}
            aria-label={useGitIconAction ? `${actionLabel}. ${actionTitle}` : undefined}
            title={actionTitle}
          >
            {useGitIconAction ? <GitCommitTriggerIcon /> : actionLabel}
          </button>
          {diffMenuOpen && (
            <div className="composer-diff-action-menu" role="menu">
              <GitCommitControls
                workspacePath={grant.path}
                open={diffMenuOpen}
                hasReviewableDiff={Boolean(hasDiff)}
                onReviewChanges={() => onReviewChanges?.()}
                onClose={() => setDiffMenuOpen(false)}
                onCreatePr={() => onCreatePr?.(grant)}
                prState={createPrState ?? { status: 'idle' }}
              />
            </div>
          )}
        </span>
      )}
      <span
        className="composer-above-bar-secondary-access composer-above-bar-secondary-access-icon"
        title={`${isWrite ? 'Edit' : 'Read'} access — ${originTooltip}`}
        aria-label={isWrite ? 'Edit access' : 'Read access'}
      >
        {isWrite ? <WriteGlyph /> : <ReadGlyph />}
      </span>
      <button
        type="button"
        className="composer-above-bar-secondary-revoke"
        onClick={() => onRevoke(grant)}
        title={`Revoke external path: ${grant.path}`}
        aria-label={`Revoke external path access to ${grant.path}`}
      >
        <RevokeGlyph />
      </button>
    </span>
  )

  return (
    <div
      className={`composer-above-bar composer-above-bar-secondary style-unified${
        cursorLeadDetached ? ' composer-above-bar--cursor-lead' : ''
      }`}
      data-external-path-grant-id={grant.id}
      data-external-path-is-repo={descriptor.isRepo ? 'true' : 'false'}
      title={`${grant.path}\n\n${originTooltip}`}
    >
      <div className="composer-above-bar-pill composer-above-bar-pill--git">
        <span className="composer-above-bar-branch">
          {descriptor.isRepo ? <BranchGlyph /> : <FileGlyph />}
          <span>
            {descriptor.basename}
            {descriptor.isRepo && (snapshot?.branch || descriptor.branch) ? (
              <>
                {' · '}
                <span
                  className={`composer-above-bar-secondary-branch git-tone-${branchTone(
                    snapshot?.detached ? undefined : (snapshot?.branch ?? descriptor.branch),
                    snapshot?.detached ?? false
                  )}`}
                >
                  {snapshot?.detached ? 'detached HEAD' : snapshot?.branch || descriptor.branch}
                </span>
              </>
            ) : null}
          </span>
        </span>
        {snapshot && <GitMergeBadge snapshot={snapshot} />}
        {snapshot && <GitSyncChip snapshot={snapshot} />}
        <GitPrLifecycleChip pr={pr ?? null} snapshot={snapshot} />
      </div>
      {diffCluster}
      <div className="composer-above-bar-pill composer-above-bar-pill--action">{trailingCluster}</div>
    </div>
  )
}
