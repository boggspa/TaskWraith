import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { ComposerWelcomeBranchPicker } from './ComposerWelcomeBranchPicker'

const snapshot: GitRepositorySnapshot = {
  requestedPath: '/repo',
  repoRoot: '/repo',
  branch: 'master',
  commit: '83bbc32c8abcdef',
  detached: false,
  upstream: 'origin/master',
  remoteName: 'origin',
  remoteUrl: 'git@example.com:taskwraith.git',
  ahead: 0,
  behind: 0,
  files: [],
  counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
  clean: true,
  mergeState: null,
  conflicts: 0,
  lineStats: { additions: 0, deletions: 0 }
}

const readSource = (relative: string): string => readFileSync(join(process.cwd(), relative), 'utf8')

describe('ComposerWelcomeBranchPicker', () => {
  it('shows the checked-out branch so a new thread names its own starting point', () => {
    const markup = renderToStaticMarkup(
      <ComposerWelcomeBranchPicker
        workspacePath="/repo"
        gitSnapshot={snapshot}
        composerStyle="claude"
      />
    )
    expect(markup).toContain('composer-welcome-branch-picker')
    expect(markup).toContain('>master<')
  })

  it('falls back to the workspace branch before any snapshot has arrived', () => {
    const markup = renderToStaticMarkup(
      <ComposerWelcomeBranchPicker
        workspacePath="/repo"
        gitSnapshot={null}
        fallbackBranch="main"
        composerStyle="claude"
      />
    )
    expect(markup).toContain('>main<')
  })

  it('reports an active isolated worktree instead of the base branch', () => {
    const markup = renderToStaticMarkup(
      <ComposerWelcomeBranchPicker
        workspacePath="/repo"
        gitSnapshot={snapshot}
        composerStyle="claude"
        composerWorktreeSelection={{
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo/.worktrees/task',
          label: 'task-branch',
          source: 'composer'
        }}
      />
    )
    expect(markup).toContain('worktree: task-branch')
    expect(markup).not.toContain('>master<')
  })

  it('reuses the above-row picker rather than forking a second branch UI', () => {
    const source = readSource('src/renderer/src/components/ComposerWelcomeBranchPicker.tsx')
    expect(source).toContain('<ComposerBranchWorktreePopover')
    // The workspace switcher already names the workspace in the same row's LEFT
    // zone, so this must not print it a second time.
    expect(source).not.toContain('resolveWorkspaceDisplayName')
  })
})

describe('welcome branch picker placement in the composer', () => {
  const composer = readSource('src/renderer/src/components/Composer.tsx')

  it('borrows the right telemetry zone the token tally leaves empty', () => {
    const zoneStart = composer.indexOf(
      '<div className="composer-telemetry-side composer-telemetry-side--right">'
    )
    expect(zoneStart).toBeGreaterThan(-1)
    const zoneEnd = composer.indexOf('</div>', zoneStart)
    const zone = composer.slice(zoneStart, zoneEnd)
    expect(zone).toContain('<ComposerWelcomeBranchPicker')
    expect(zone).toContain('<LiveThreadTokenTally')
  })

  it('gates placement on the shared rule instead of an inline condition', () => {
    expect(composer).toContain('shouldShowComposerWelcomeBranchPicker({')
    expect(composer).toContain('hasThreadTokenTally: Boolean(threadTokenTallyHasValue)')
  })

  it('hands the picker the same workspace path and worktree selection as the above-row', () => {
    const start = composer.indexOf('<ComposerWelcomeBranchPicker')
    const props = composer.slice(start, composer.indexOf('/>', start))
    expect(props).toContain('workspacePath={composerGitActionBasePath}')
    expect(props).toContain('gitSnapshot={primaryGitSnapshot}')
    expect(props).toContain('onWorktreeSelectionChange={onComposerWorktreeChange}')
  })

  it('keeps the picker inside the tally width ceiling so the icon cluster stays centred', () => {
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    const tally = css.match(/\.composer-thread-token-tally\s*\{[^}]*\}/)?.[0] ?? ''
    const picker = css.match(/\.composer-welcome-branch-picker\s*\{[^}]*\}/)?.[0] ?? ''
    const ceiling = tally.match(/max-width:\s*([^;]+);/)?.[1]
    expect(ceiling).toBeTruthy()
    expect(picker).toContain(`max-width: ${ceiling};`)
  })
})
