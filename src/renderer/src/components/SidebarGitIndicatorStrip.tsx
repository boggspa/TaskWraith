import type { ReactNode } from 'react'
import { GitLifecycleGlyph } from './icons/GitLifecycleGlyph'
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
 * Glyphs live in icons/GitLifecycleGlyph so the Commits inspector's
 * pull-request cards draw the same shapes; this file is the sidebar's
 * kind -> glyph mapping and nothing else.
 *
 * The strip sits inside the ticker's `aria-hidden` identity segment (that whole
 * face is decorative — the row's accessible name is the thread title), so each
 * icon carries a `title` for hover and the row keeps its own aria-label.
 */

function indicatorGlyph(indicator: SidebarGitIndicator): ReactNode {
  switch (indicator.kind) {
    case 'pushed':
      return <GitLifecycleGlyph kind="synced" />
    case 'ahead':
      return (
        <>
          <span aria-hidden>↑</span>
          {indicator.count ?? 0}
        </>
      )
    case 'pr-ready':
      return <GitLifecycleGlyph kind="ready" />
    case 'pr-merged':
      return <GitLifecycleGlyph kind="merged" />
    case 'pr-closed':
      return <GitLifecycleGlyph kind="closed" />
    case 'pr-open':
    case 'pr-queued':
      return <GitLifecycleGlyph kind="open" />
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
