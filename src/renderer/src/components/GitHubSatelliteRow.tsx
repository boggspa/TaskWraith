import type {
  GitCiStatusSummary,
  GitPrSummary,
  GitRepositorySnapshot
} from '../../../main/services/GitService'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'
import { prLifecycle, summarizeChecks } from './GitStatusChips'
import {
  buildSatellitePopoverModel,
  GitHubSatellitePopover,
  repoNameFromRemote,
  useSatelliteHover
} from './GitHubSatellitePopover'
import { buildCiNotice, type CiNotice } from '../lib/ciNotice'

/*
 * GitHub PR/CI/Merge "satellite" row — a compact, icon-only strip that sits
 * just above the primary above-bar and surfaces the upstream GitHub state for
 * the current workspace. It is the rudimentary, TaskWraith-native answer to
 * Claude Code's stack of PR cards: one row of glyphs, each opening the PR/CI
 * on GitHub, that only appears when there is a real remote + PR/CI to show.
 *
 * Reuses the existing chip brains (`prLifecycle`, `summarizeChecks`) and the
 * shared `ToolFamilyIcon` glyphs so the icon language stays consistent with the
 * text chips it replaces on the primary row. Slice 3 wraps each icon in a
 * hover popover; Slice 4 feeds the live `ci` summary from `githubCiStatus`.
 */

export interface GitHubSatelliteRowProps {
  pr: GitPrSummary | null
  /** Live `githubCiStatus()` summary, when available. Falls back to `pr.checks`. */
  ci?: GitCiStatusSummary | null
  snapshot?: GitRepositorySnapshot | null
  /** Soft-action: post a CI-failure/PR-blocked notice to the thread (no steer). */
  onNotify?: (notice: CiNotice) => void
  /** Slice-6 watch-PR opt-in gate. When provided, the popover shows the per-chat Watch toggle. */
  isWatching?: boolean
  onToggleWatch?: (next: boolean) => void
  /**
   * When set, the Watch toggle is disabled and this specific, actionable reason is
   * surfaced — and the row renders a hoverable warning affordance even when no PR/CI
   * exists, so a gh-auth / no-open-PR failure is no longer silent.
   */
  watchDisabledReason?: string
  /** Live progress / failure copy shown in the popover without changing authorization. */
  watchStatusMessage?: string
}

type CiTone = 'success' | 'danger' | 'warning' | 'muted'

interface CiResolved {
  tone: CiTone
  label: string
  title: string
  url?: string
}

function openUrl(url: string | undefined): void {
  if (url && typeof window.api.openExternalOrPath === 'function') {
    void window.api.openExternalOrPath(url)
  }
}

/**
 * Resolve the CI indicator, preferring the live `ciStatus()` classification and
 * falling back to the PR's `statusCheckRollup`. Returns null when there is no
 * CI signal at all, so a repo with no checks stays quiet.
 */
function resolveCi(
  pr: GitPrSummary | null,
  ci: GitCiStatusSummary | null | undefined
): CiResolved | null {
  const liveChecks = ci?.checks?.length ? ci.checks : undefined
  const checks = liveChecks ?? pr?.checks
  const summary = summarizeChecks(checks)
  const liveStatus = ci?.status
  const hasLiveSignal = Boolean(liveStatus && (ci?.checks?.length || ci?.runs?.length))
  if (summary.total === 0 && !hasLiveSignal) return null

  const tone: CiTone = hasLiveSignal
    ? liveStatus === 'passed'
      ? 'success'
      : liveStatus === 'failed'
        ? 'danger'
        : liveStatus === 'pending' || liveStatus === 'blocked'
          ? 'warning'
          : 'muted'
    : summary.fail > 0
      ? 'danger'
      : summary.pending > 0
        ? 'warning'
        : 'success'

  const label =
    tone === 'danger' && summary.fail > 0
      ? String(summary.fail)
      : tone === 'warning' && summary.pending > 0
        ? String(summary.pending)
        : ''

  const parts = [
    summary.pass > 0 ? `${summary.pass} passed` : null,
    summary.fail > 0 ? `${summary.fail} failing` : null,
    summary.pending > 0 ? `${summary.pending} pending` : null
  ].filter(Boolean)
  const title = `CI${liveStatus ? ` ${liveStatus}` : ''}${parts.length ? ` — ${parts.join(' · ')}` : ''}`

  const url =
    pr?.url ||
    checks?.find((check) => {
      const conclusion = (check.conclusion || '').toLowerCase()
      return conclusion && !['success', 'neutral', 'skipped'].includes(conclusion)
    })?.url

  return { tone, label, title, url }
}

function SatelliteIndicator({
  kind,
  tone,
  title,
  label,
  url,
  onHoverStart,
  onHoverEnd,
  children
}: {
  kind: 'pr' | 'ci' | 'push'
  tone: string
  title: string
  label?: string
  url?: string
  onHoverStart?: (el: HTMLElement) => void
  onHoverEnd?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const clickable = Boolean(url)
  const open = (): void => openUrl(url)
  return (
    <span
      className={`github-satellite-icon github-satellite-icon--${kind} tone-${tone}${
        clickable ? ' is-clickable' : ''
      }`}
      title={`${title}${clickable ? ' — open on GitHub' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? open : undefined}
      onMouseEnter={(e) => onHoverStart?.(e.currentTarget)}
      onMouseLeave={() => onHoverEnd?.()}
      onFocus={(e) => onHoverStart?.(e.currentTarget)}
      onBlur={() => onHoverEnd?.()}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
    >
      {children}
      {label ? <span className="github-satellite-icon-label">{label}</span> : null}
    </span>
  )
}

export function GitHubSatelliteRow({
  pr,
  ci,
  snapshot,
  onNotify,
  isWatching,
  onToggleWatch,
  watchDisabledReason,
  watchStatusMessage
}: GitHubSatelliteRowProps): React.JSX.Element | null {
  // Hook must run unconditionally, before any early return.
  const hover = useSatelliteHover()

  // No GitHub remote → nothing to be a satellite of.
  if (!snapshot?.remoteUrl && !isWatching) return null

  const lifecycle = pr && pr.number != null ? prLifecycle(pr, snapshot) : null
  const ciResolved = resolveCi(pr, ci)
  // "Pushed" — every local commit is on the upstream (the green tick that
  // used to live in the workspace rows as the `Synced` chip). Strictly an
  // ahead===0 signal: being behind the remote doesn't unpush anything (the
  // title mentions it instead).
  const pushed = Boolean(
    snapshot?.branch && !snapshot.detached && snapshot.upstream && (snapshot.ahead ?? 0) === 0
  )

  // Only surface the row for relevant GH/PR/CI actions, the pushed tick — or
  // a watch-error affordance (gh-auth / no-open-PR) so the failure is no
  // longer silent (Slice-6).
  if (!lifecycle && !ciResolved && !watchDisabledReason && !isWatching && !pushed) return null
  const watchOnly = !lifecycle && !ciResolved

  const prNumberLabel = typeof pr?.number === 'number' ? `#${pr.number}` : 'PR'
  const popoverModel = buildSatellitePopoverModel(pr, ci, snapshot)
  const notice = buildCiNotice(pr, ci, repoNameFromRemote(snapshot?.remoteUrl))

  return (
    <div className="github-satellite-row" role="group" aria-label="GitHub pull request status">
      {pushed && (
        <SatelliteIndicator
          kind="push"
          tone="success"
          title={`All local commits pushed — ${snapshot?.branch} matches ${snapshot?.upstream}${
            (snapshot?.behind ?? 0) > 0
              ? ` (${snapshot?.behind} behind upstream; fetch to refresh)`
              : ''
          }`}
          label="Pushed"
          onHoverStart={hover.show}
          onHoverEnd={hover.scheduleClose}
        >
          <span className="github-satellite-tick" aria-hidden>
            ✓
          </span>
          <ToolFamilyIcon family="git" size={14} />
        </SatelliteIndicator>
      )}
      {lifecycle && pr && (
        <SatelliteIndicator
          kind="pr"
          tone={lifecycle.tone}
          title={lifecycle.title}
          label={prNumberLabel}
          url={pr.url}
          onHoverStart={hover.show}
          onHoverEnd={hover.scheduleClose}
        >
          <ToolFamilyIcon family={lifecycle.merged ? 'merge' : 'pull-request'} size={14} />
        </SatelliteIndicator>
      )}
      {ciResolved && (
        <SatelliteIndicator
          kind="ci"
          tone={ciResolved.tone}
          title={ciResolved.title}
          label={ciResolved.label}
          url={ciResolved.url}
          onHoverStart={hover.show}
          onHoverEnd={hover.scheduleClose}
        >
          <span className={`github-satellite-dot tone-${ciResolved.tone}`} aria-hidden />
          <ToolFamilyIcon family="ci" size={14} />
        </SatelliteIndicator>
      )}
      {watchOnly && (watchDisabledReason || isWatching) && (
        <SatelliteIndicator
          kind="pr"
          // Quiet by default: with no PR/CI this is only a discoverability
          // affordance (open the popover, see why watching is unavailable),
          // so it sits muted gray. It earns the warning amber only once the
          // user has actually turned watching ON — then "watching, but no
          // PR/CI to show" is a state worth flagging.
          tone={isWatching ? 'warning' : 'muted'}
          title={watchDisabledReason || watchStatusMessage || 'Watching this pull request'}
          label="PR"
          onHoverStart={hover.show}
          onHoverEnd={hover.scheduleClose}
        >
          <span
            className={`github-satellite-dot tone-${isWatching ? 'warning' : 'muted'}`}
            aria-hidden
          />
          <ToolFamilyIcon family="pull-request" size={14} />
        </SatelliteIndicator>
      )}
      <GitHubSatellitePopover
        model={popoverModel}
        notice={notice}
        onNotify={onNotify}
        isWatching={isWatching}
        onToggleWatch={onToggleWatch}
        watchDisabledReason={watchDisabledReason}
        watchStatusMessage={watchStatusMessage}
        anchorRect={hover.anchorRect}
        onMouseEnter={hover.keepOpen}
        onMouseLeave={hover.scheduleClose}
      />
    </div>
  )
}
