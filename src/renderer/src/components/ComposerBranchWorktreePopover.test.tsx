import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import {
  ComposerBranchPopoverBranchRow,
  ComposerBranchPopoverWorktreeRow,
  computeComposerBranchPopoverPosition
} from './ComposerBranchWorktreePopover'

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

const snapshot: GitRepositorySnapshot = {
  requestedPath: '/repo',
  repoRoot: '/repo',
  branch: 'master',
  commit: '83bbc32c8abcdef',
  detached: false,
  upstream: 'origin/master',
  remoteName: 'origin',
  remoteUrl: 'git@example.com:taskwraith.git',
  ahead: 53,
  behind: 0,
  files: [],
  counts: { changed: 3, staged: 0, unstaged: 3, untracked: 1 },
  clean: false,
  mergeState: null,
  conflicts: 0,
  lineStats: { additions: 22, deletions: 2 }
}

describe('ComposerBranchWorktreePopover positioning', () => {
  it('matches the composer width and left edge', () => {
    expect(
      computeComposerBranchPopoverPosition(
        { left: 320, top: 620, bottom: 640 },
        { width: 1000, height: 800 },
        { width: 320, height: 300 },
        { left: 120, width: 760 }
      )
    ).toEqual({ left: 120, top: 612, width: 760, placement: 'above' })
  })

  it('clamps a wide composer to the viewport gutters', () => {
    const position = computeComposerBranchPopoverPosition(
      { left: 20, top: 200, bottom: 220 },
      { width: 600, height: 700 },
      { width: 320, height: 300 },
      { left: -40, width: 900 }
    )

    expect(position.left).toBe(8)
    expect(position.width).toBe(584)
  })

  it('allows the inline composer width without defining local material chrome', () => {
    const css = readFileSync(
      'src/renderer/src/components/ComposerBranchWorktreePopover.css',
      'utf8'
    )
    const popover = cssBlockStartingAt(
      css,
      '.composer-combined-picker-popover.composer-branch-popover {'
    )

    expect(popover).toContain('max-width: calc(100vw - 1rem)')
    expect(popover).toContain('box-sizing: border-box')
    expect(popover).not.toMatch(
      /\n\s*(?:background|box-shadow|backdrop-filter|-webkit-backdrop-filter|border)\s*:/
    )
  })
})

describe('ComposerBranchWorktreePopover target chrome', () => {
  it('keeps the existing above-row branch tone wiring', () => {
    const source = readFileSync(
      'src/renderer/src/components/ComposerBranchWorktreePopover.tsx',
      'utf8'
    )

    expect(source).toContain(
      'composer-branch-trigger composer-above-bar-secondary-branch ${toneClass}'
    )
    expect(source).toContain(
      'composer-combined-picker-popover composer-branch-popover shell-${composerStyle}'
    )
  })

  it('renders a branch with Observatory-style identity and Git facts', () => {
    const html = renderToStaticMarkup(
      <ComposerBranchPopoverBranchRow
        branch={{ name: 'master', isCurrent: true, upstream: 'origin/master' }}
        gitSnapshot={snapshot}
        disabled
        onSelect={() => undefined}
      />
    )

    expect(html).toContain('composer-branch-popover-target-kind')
    expect(html).toContain('Configured checkout')
    expect(html).toContain('<small>checkout</small>')
    expect(html).toContain('<small>tree</small>')
    expect(html).toContain('<small>upstream</small>')
    expect(html).toContain('<em class="composer-diff-add">+22</em>')
    expect(html).toContain('<em class="composer-diff-del">−2</em>')
    expect(html).toContain('2 changed · 1 new')
    expect(html).toContain('<em class="is-ahead">↑53</em>')
    expect(html).toContain('<em class="is-behind">↓0</em>')
  })

  it('renders a worktree with path, checkout, tree, and HEAD facts', () => {
    const html = renderToStaticMarkup(
      <ComposerBranchPopoverWorktreeRow
        worktree={{
          path: '/repo-worktrees/feature',
          branch: 'feature/rich-popover',
          head: 'a16d0b9e2abcdef',
          isCurrent: false
        }}
        gitSnapshot={snapshot}
        disabled={false}
        onSelect={() => undefined}
      />
    )

    expect(html).toContain('feature/rich-popover')
    expect(html).toContain('/repo-worktrees/feature')
    expect(html).toContain('<small>checkout</small>')
    expect(html).toContain('<i class="is-action">select</i>')
    expect(html).toContain('<small>tree</small>')
    expect(html).toContain('not measured')
    expect(html).toContain('<small>head</small>')
    expect(html).toContain('a16d0b9e2')
  })

  it('keeps the shell background inherited while adding the target grid and facts rail', () => {
    const css = readFileSync(
      'src/renderer/src/components/ComposerBranchWorktreePopover.css',
      'utf8'
    )
    const popover = cssBlockStartingAt(
      css,
      '.composer-combined-picker-popover.composer-branch-popover {'
    )
    const target = cssBlockStartingAt(css, '.composer-branch-popover-item {')
    const facts = cssBlockStartingAt(css, '.composer-branch-popover-facts {')

    expect(popover).not.toMatch(/\n\s*background\s*:/)
    expect(target).toContain(
      'grid-template-columns: 18px minmax(9rem, 1.15fr) minmax(14rem, 0.85fr)'
    )
    expect(facts).toContain('font-variant-numeric: tabular-nums')
  })
})
