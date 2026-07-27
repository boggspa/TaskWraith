import type { ReactNode } from 'react'
import {
  sidebarGitIndicatorLabel,
  sidebarGitIndicatorTone,
  type SidebarGitIndicator
} from '../lib/sidebarGitIndicators'

/*
 * The git status icons that ride the right-hand end of the sidebar's active-row
 * identity face ("TaskWraith/tw-tui   ✓ ⑂"). Model + precedence live in
 * lib/sidebarGitIndicators.ts; this file is glyphs and nothing else.
 *
 * Glyphs are local SVG rather than ToolFamilyIcon members, matching how
 * GitStatusChips.tsx keeps its own git glyphs: these are drawn for an 11px
 * slot and there is no shared "closed pull request" family to reuse.
 *
 * The strip sits inside the ticker's `aria-hidden` identity segment (that whole
 * face is decorative — the row's accessible name is the thread title), so each
 * icon carries a `title` for hover and the row keeps its own aria-label.
 */

const SVG_PROPS = {
  width: 11,
  height: 11,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

/** Pushed / synced — a bare tick. */
function SyncedGlyph(): ReactNode {
  return (
    <svg {...SVG_PROPS}>
      <path d="M2.9 8.6 6.3 12 13.1 4.4" />
    </svg>
  )
}

/** Open pull request — GitHub's branch-into-trunk arrow. */
function PullRequestGlyph(): ReactNode {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="4" cy="3.6" r="1.5" />
      <circle cx="4" cy="12.4" r="1.5" />
      <circle cx="12" cy="12.4" r="1.5" />
      <path d="M4 5.1v5.8" />
      <path d="M12 10.9V6.4a2 2 0 0 0-2-2H8.2" />
      <path d="m9.8 2.9-1.7 1.5 1.7 1.5" />
    </svg>
  )
}

/** Ready to merge — a ringed tick, distinct from the bare "pushed" tick. */
function ReadyGlyph(): ReactNode {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="m5.2 8.2 2 2 3.6-4.2" />
    </svg>
  )
}

/** Merged — the fork rejoining its base. The only final-success state. */
function MergedGlyph(): ReactNode {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="4" cy="3.6" r="1.5" />
      <circle cx="4" cy="12.4" r="1.5" />
      <circle cx="12" cy="12.4" r="1.5" />
      <path d="M4 5.1v5.8" />
      <path d="M5.4 7.2c3.7 0 5.4 1.7 6.1 3.8" />
    </svg>
  )
}

/** Closed without merging — the pull-request line, cancelled. */
function ClosedGlyph(): ReactNode {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="4" cy="3.6" r="1.5" />
      <circle cx="4" cy="12.4" r="1.5" />
      <path d="M4 5.1v5.8" />
      <path d="m9.6 5.4 4.4 4.4" />
      <path d="m14 5.4-4.4 4.4" />
    </svg>
  )
}

function indicatorGlyph(indicator: SidebarGitIndicator): ReactNode {
  switch (indicator.kind) {
    case 'pushed':
      return <SyncedGlyph />
    case 'ahead':
      return (
        <>
          <span aria-hidden>↑</span>
          {indicator.count ?? 0}
        </>
      )
    case 'pr-ready':
      return <ReadyGlyph />
    case 'pr-merged':
      return <MergedGlyph />
    case 'pr-closed':
      return <ClosedGlyph />
    case 'pr-open':
    case 'pr-queued':
      return <PullRequestGlyph />
  }
}

export function SidebarGitIndicatorStrip({
  indicators
}: {
  indicators: readonly SidebarGitIndicator[]
}): ReactNode {
  if (indicators.length === 0) return null
  return (
    <span className="sidebar-git-indicators">
      {indicators.map((indicator) => (
        <span
          key={`${indicator.kind}-${indicator.prNumber ?? indicator.count ?? ''}-${
            indicator.ownThread ? 'own' : 'live'
          }`}
          className={`sidebar-git-indicator kind-${indicator.kind} tone-${sidebarGitIndicatorTone(
            indicator.kind
          )}`}
          title={sidebarGitIndicatorLabel(indicator)}
        >
          {indicatorGlyph(indicator)}
        </span>
      ))}
    </span>
  )
}
