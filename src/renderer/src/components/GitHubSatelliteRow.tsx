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
  kind: 'pr' | 'ci'
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
  onNotify
}: GitHubSatelliteRowProps): React.JSX.Element | null {
  // Hook must run unconditionally, before any early return.
  const hover = useSatelliteHover()

  // No GitHub remote → nothing to be a satellite of.
  if (!snapshot?.remoteUrl) return null

  const lifecycle = pr && pr.number != null ? prLifecycle(pr, snapshot) : null
  const ciResolved = resolveCi(pr, ci)

  // Only surface the row for relevant GH/PR/CI actions.
  if (!lifecycle && !ciResolved) return null

  const prNumberLabel = typeof pr?.number === 'number' ? `#${pr.number}` : 'PR'
  const popoverModel = buildSatellitePopoverModel(pr, ci, snapshot)
  const notice = buildCiNotice(pr, ci, repoNameFromRemote(snapshot?.remoteUrl))

  return (
    <div className="github-satellite-row" role="group" aria-label="GitHub pull request status">
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
      <GitHubSatellitePopover
        model={popoverModel}
        notice={notice}
        onNotify={onNotify}
        anchorRect={hover.anchorRect}
        onMouseEnter={hover.keepOpen}
        onMouseLeave={hover.scheduleClose}
      />
    </div>
  )
}
