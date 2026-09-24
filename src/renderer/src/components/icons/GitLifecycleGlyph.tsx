import type { ReactNode } from 'react'

/*
 * The git lifecycle glyphs — pushed, open, ready, merged, closed — drawn once
 * and shared by every surface that grades a branch or a pull request.
 *
 * They started in SidebarGitIndicatorStrip for an 11px slot; the Commits
 * inspector's pull-request cards now draw the same shapes at a larger size,
 * so the vocabulary a human learns in the sidebar reads the same in the
 * Inspector. The colour half of that vocabulary is GitHub's and lives with
 * each surface's own `tone-*` / `is-*` rules — see the note in
 * lib/sidebarGitIndicators.ts about the one surface that has it inverted.
 *
 * Local SVG rather than ToolFamilyIcon members, matching how GitStatusChips
 * keeps its own git glyphs: there is no shared "closed pull request" family
 * to reuse.
 */

export type GitLifecycleGlyphKind = 'synced' | 'open' | 'ready' | 'merged' | 'closed'

function svgProps(size: number): Record<string, unknown> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
}

/** Pushed / synced — a bare tick. */
function SyncedGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.9 8.6 6.3 12 13.1 4.4" />
    </svg>
  )
}

/** Open pull request — GitHub's branch-into-trunk arrow. */
function OpenGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg {...svgProps(size)}>
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
function ReadyGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg {...svgProps(size)}>
      <circle cx="8" cy="8" r="6.1" />
      <path d="m5.2 8.2 2 2 3.6-4.2" />
    </svg>
  )
}

/** Merged — the fork rejoining its base. The only final-success state. */
function MergedGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg {...svgProps(size)}>
      <circle cx="4" cy="3.6" r="1.5" />
      <circle cx="4" cy="12.4" r="1.5" />
      <circle cx="12" cy="12.4" r="1.5" />
      <path d="M4 5.1v5.8" />
      <path d="M5.4 7.2c3.7 0 5.4 1.7 6.1 3.8" />
    </svg>
  )
}

/** Closed without merging — the pull-request line, cancelled. */
function ClosedGlyph({ size }: { size: number }): ReactNode {
  return (
    <svg {...svgProps(size)}>
      <circle cx="4" cy="3.6" r="1.5" />
      <circle cx="4" cy="12.4" r="1.5" />
      <path d="M4 5.1v5.8" />
      <path d="m9.6 5.4 4.4 4.4" />
      <path d="m14 5.4-4.4 4.4" />
    </svg>
  )
}

export function GitLifecycleGlyph({
  kind,
  size = 11
}: {
  kind: GitLifecycleGlyphKind
  size?: number
}): ReactNode {
  switch (kind) {
    case 'synced':
      return <SyncedGlyph size={size} />
    case 'ready':
      return <ReadyGlyph size={size} />
    case 'merged':
      return <MergedGlyph size={size} />
    case 'closed':
      return <ClosedGlyph size={size} />
    case 'open':
      return <OpenGlyph size={size} />
  }
}
