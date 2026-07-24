import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  GitCiStatusSummary,
  GitPrSummary,
  GitRepositorySnapshot
} from '../../../main/services/GitService'
import { prLifecycle } from './GitStatusChips'
import { type CiNotice } from '../lib/ciNotice'

/*
 * Hover popover for the GitHub satellite row. Reuses the shared
 * `composer-combined-picker-popover` frosted-glass chrome and mirrors the
 * DiffHoverPreview open/close-delay technique so moving the pointer from the
 * icon onto the card doesn't flicker it shut. The content model is a pure
 * function of the PR/CI/snapshot data so it can be unit-tested without a DOM.
 */

export type SatelliteCheckTone = 'success' | 'danger' | 'warning' | 'muted'

export interface SatellitePopoverModel {
  repoName?: string
  pr: {
    numberLabel: string
    stateLabel: string
    tone: string
    head?: string
    base?: string
    mergeState?: string
    url?: string
  } | null
  ci: {
    statusLabel: string
    tone: SatelliteCheckTone
    counts: { pass: number; fail: number; pending: number }
    checks: Array<{ name: string; tone: SatelliteCheckTone; label: string }>
    url?: string
  } | null
}

/** owner/repo from a remote URL like git@github.com:acme/app.git or https://…/acme/app. */
export function repoNameFromRemote(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined
  const cleaned = remoteUrl.replace(/\.git$/i, '').replace(/\/$/, '')
  const match = cleaned.match(/[/:]([^/:]+)\/([^/:]+)$/)
  return match ? `${match[1]}/${match[2]}` : undefined
}

function checkTone(check: NonNullable<GitPrSummary['checks']>[number]): SatelliteCheckTone {
  const status = (check.status || '').toLowerCase()
  const conclusion = (check.conclusion || '').toLowerCase()
  if (status && status !== 'completed') return 'warning'
  if (['success', 'neutral', 'skipped'].includes(conclusion)) return 'success'
  if (conclusion) return 'danger'
  return 'warning'
}

export function buildSatellitePopoverModel(
  pr: GitPrSummary | null,
  ci: GitCiStatusSummary | null | undefined,
  snapshot: GitRepositorySnapshot | null | undefined
): SatellitePopoverModel {
  const repoName = repoNameFromRemote(snapshot?.remoteUrl)

  let prModel: SatellitePopoverModel['pr'] = null
  if (pr && pr.number != null) {
    const lifecycle = prLifecycle(pr, snapshot)
    prModel = {
      numberLabel: `#${pr.number}`,
      stateLabel: lifecycle.title,
      tone: lifecycle.tone,
      head: pr.headRefName,
      base: pr.baseRefName,
      mergeState: pr.mergeStateStatus,
      url: pr.url
    }
  }

  const sourceChecks = ci?.checks?.length ? ci.checks : pr?.checks
  let ciModel: SatellitePopoverModel['ci'] = null
  if ((sourceChecks && sourceChecks.length) || (ci?.status && ci.runs?.length)) {
    const checks = (sourceChecks ?? []).map((check) => {
      const tone = checkTone(check)
      return {
        name: check.name || 'check',
        tone,
        label:
          tone === 'success'
            ? 'passed'
            : tone === 'danger'
              ? check.conclusion || 'failing'
              : (check.status || 'pending').toLowerCase()
      }
    })
    const counts = checks.reduce(
      (acc, c) => {
        if (c.tone === 'success') acc.pass += 1
        else if (c.tone === 'danger') acc.fail += 1
        else acc.pending += 1
        return acc
      },
      { pass: 0, fail: 0, pending: 0 }
    )
    const liveStatus = ci?.status
    const tone: SatelliteCheckTone = liveStatus
      ? liveStatus === 'passed'
        ? 'success'
        : liveStatus === 'failed'
          ? 'danger'
          : liveStatus === 'pending' || liveStatus === 'blocked'
            ? 'warning'
            : 'muted'
      : counts.fail > 0
        ? 'danger'
        : counts.pending > 0
          ? 'warning'
          : 'success'
    ciModel = {
      statusLabel: liveStatus
        ? `CI ${liveStatus}`
        : counts.fail > 0
          ? 'CI failing'
          : counts.pending > 0
            ? 'CI running'
            : 'CI passing',
      tone,
      counts,
      checks,
      url:
        pr?.url ||
        sourceChecks?.find((c) => checkTone(c) === 'danger')?.url ||
        sourceChecks?.[0]?.url
    }
  }

  return { repoName, pr: prModel, ci: ciModel }
}

/** Single-card hover state machine with a debounced close so the card stays put. */
export function useSatelliteHover(closeDelayMs = 140): {
  anchorRect: DOMRect | null
  show: (el: HTMLElement) => void
  keepOpen: () => void
  scheduleClose: () => void
  close: () => void
} {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const closeTimer = useRef<number | null>(null)

  const clearClose = useCallback(() => {
    if (closeTimer.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  const show = useCallback(
    (el: HTMLElement) => {
      clearClose()
      setAnchorRect(el.getBoundingClientRect())
    },
    [clearClose]
  )
  const keepOpen = useCallback(() => clearClose(), [clearClose])
  const close = useCallback(() => {
    clearClose()
    setAnchorRect(null)
  }, [clearClose])
  const scheduleClose = useCallback(() => {
    clearClose()
    if (typeof window === 'undefined') {
      setAnchorRect(null)
      return
    }
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setAnchorRect(null)
    }, closeDelayMs)
  }, [clearClose, closeDelayMs])

  useEffect(() => () => clearClose(), [clearClose])

  useEffect(() => {
    if (!anchorRect || typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onScroll = (e: Event): void => {
      const target = e.target
      if (target instanceof Element && target.closest('.github-satellite-popover')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [anchorRect, close])

  return { anchorRect, show, keepOpen, scheduleClose, close }
}

const POPOVER_WIDTH = 320

export function GitHubSatellitePopover({
  model,
  notice,
  onNotify,
  isWatching,
  onToggleWatch,
  watchDisabledReason,
  watchStatusMessage,
  anchorRect,
  onMouseEnter,
  onMouseLeave
}: {
  model: SatellitePopoverModel
  notice?: CiNotice | null
  onNotify?: (notice: CiNotice) => void
  /**
   * Slice-6 watch-PR opt-in gate — presentational only. The toggle IS the entire
   * authorization; the parent owns descriptor persistence (saveChat) + the host
   * poller wiring. Rendered only when `onToggleWatch` is provided.
   */
  isWatching?: boolean
  onToggleWatch?: (next: boolean) => void
  /** When set, the toggle is disabled and shows this specific, actionable reason (e.g. "No open PR to watch", "GitHub CLI not authenticated"). */
  watchDisabledReason?: string
  /** Live poll/persistence state shown without disabling an active watch. */
  watchStatusMessage?: string
  anchorRect: DOMRect | null
  onMouseEnter: () => void
  onMouseLeave: () => void
}): React.JSX.Element | null {
  if (!anchorRect || typeof document === 'undefined') return null
  if (!model.pr && !model.ci && !watchDisabledReason && !isWatching) return null

  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - POPOVER_WIDTH - 8))
  const bottom = Math.max(8, window.innerHeight - anchorRect.top + 8)

  return createPortal(
    <div
      className="composer-combined-picker-popover github-satellite-popover"
      style={{ position: 'fixed', left, bottom, width: POPOVER_WIDTH, zIndex: 1200 }}
      role="dialog"
      aria-label="GitHub pull request and CI status"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {model.repoName && <div className="github-satellite-popover-repo">{model.repoName}</div>}
      {model.pr && (
        <div className={`github-satellite-popover-pr tone-${model.pr.tone}`}>
          <div className="github-satellite-popover-pr-head">
            <span className="github-satellite-popover-pr-number">{model.pr.numberLabel}</span>
            <span className="github-satellite-popover-pr-state">{model.pr.stateLabel}</span>
          </div>
          {(model.pr.head || model.pr.base) && (
            <div className="github-satellite-popover-branches">
              <code>{model.pr.head || '?'}</code>
              <span aria-hidden> → </span>
              <code>{model.pr.base || '?'}</code>
            </div>
          )}
          {model.pr.mergeState && (
            <div className="github-satellite-popover-merge">
              Merge state: {model.pr.mergeState.toLowerCase()}
            </div>
          )}
        </div>
      )}
      {model.ci && (
        <div className="github-satellite-popover-ci">
          <div className={`github-satellite-popover-ci-status tone-${model.ci.tone}`}>
            <span className={`github-satellite-dot tone-${model.ci.tone}`} aria-hidden />
            {model.ci.statusLabel}
            <span className="github-satellite-popover-ci-counts">
              {model.ci.counts.pass}✓ · {model.ci.counts.fail}✗ · {model.ci.counts.pending}●
            </span>
          </div>
          {model.ci.checks.length > 0 && (
            <ul className="github-satellite-popover-checks">
              {model.ci.checks.slice(0, 8).map((check, i) => (
                <li key={`${check.name}-${i}`} className={`tone-${check.tone}`}>
                  <span className="github-satellite-popover-check-name">{check.name}</span>
                  <span className="github-satellite-popover-check-label">{check.label}</span>
                </li>
              ))}
              {model.ci.checks.length > 8 && (
                <li className="github-satellite-popover-check-more">
                  +{model.ci.checks.length - 8} more
                </li>
              )}
            </ul>
          )}
        </div>
      )}
      {(onToggleWatch || watchDisabledReason) && (model.pr || watchDisabledReason) && (
        <div className="github-satellite-popover-watch">
          <button
            type="button"
            role="switch"
            aria-checked={isWatching ?? false}
            className="github-satellite-watch-toggle"
            data-on={isWatching ? 'true' : 'false'}
            disabled={Boolean(watchDisabledReason) || !onToggleWatch}
            onClick={() => onToggleWatch?.(!(isWatching ?? false))}
            title={watchDisabledReason ?? (isWatching ? 'Stop watching this PR' : 'Watch this PR')}
          >
            <span className="github-satellite-watch-track" aria-hidden>
              <span className="github-satellite-watch-thumb" />
            </span>
            <span className="github-satellite-watch-label">
              {isWatching ? 'Watching this PR' : 'Watch this PR'}
            </span>
          </button>
          <span className="github-satellite-watch-hint">
            {watchDisabledReason ??
              watchStatusMessage ??
              'Notify this thread when checks finish'}
          </span>
        </div>
      )}
      {notice?.shouldOffer && onNotify && (
        <div className="github-satellite-popover-actions">
          <button
            type="button"
            className="github-satellite-notify-button"
            onClick={() => onNotify(notice)}
            title={notice.detail}
          >
            Notify thread
          </button>
          <span className="github-satellite-notify-hint">Shares a note — doesn&apos;t interrupt</span>
        </div>
      )}
      {(model.pr?.url || model.ci?.url) && (
        <div className="github-satellite-popover-footer">Click an icon to open on GitHub</div>
      )}
    </div>,
    document.body
  )
}
