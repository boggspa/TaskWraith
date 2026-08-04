import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { GitHubSatelliteRow } from './GitHubSatelliteRow'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'

/**
 * Slice-6 reachability regression (SolReview gate a1c-solreview-gate-2026-07-24).
 *
 * Before this fix, GitHubSatelliteRow returned null whenever there was no PR
 * lifecycle AND no CI, so a gh-auth / no-open-PR failure rendered NOTHING — the
 * promised "GitHub CLI not authenticated" / "No open PR to watch" surface was
 * unreachable and the silent gh-auth gap remained. With a `watchDisabledReason`
 * the row now renders a hoverable warning affordance that anchors the popover's
 * disabled Watch toggle + specific reason, so the failure is no longer silent.
 *
 * These are static-markup render tests: with no hover the popover's `anchorRect`
 * is null so it returns before its portal, letting us assert the row's own
 * (non-portaled) reachability without a DOM.
 */
const snapshot = { remoteUrl: 'git@github.com:acme/widgets.git' } as GitRepositorySnapshot

describe('GitHubSatelliteRow — Slice-6 watch-error reachability', () => {
  it('renders a MUTED affordance when there is no PR/CI but a watch-disabled reason (gh-auth failure)', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={null}
        ci={null}
        snapshot={snapshot}
        watchDisabledReason="GitHub CLI not authenticated"
      />
    )
    // The row no longer disappears — it surfaces the affordance, but quiet
    // gray, not warning amber: nothing is wrong until the user is watching.
    expect(markup).not.toBe('')
    expect(markup).toContain('github-satellite-row')
    expect(markup).toContain('tone-muted')
    expect(markup).not.toContain('tone-warning')
    // Dotless at rest: the status dot is reserved for live CI monitoring
    // (the CI indicator and an armed watch), not the discoverability affordance.
    expect(markup).not.toContain('github-satellite-dot')
  })

  it('escalates the affordance to warning amber once watching is actually ON', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={null}
        ci={null}
        snapshot={snapshot}
        isWatching
        onToggleWatch={() => {}}
        watchStatusMessage="Watching for an open pull request"
      />
    )
    expect(markup).toContain('tone-warning')
    // An armed watch IS monitoring — it keeps its dot.
    expect(markup).toContain('github-satellite-dot')
  })

  it('stays silent (returns null) when there is no PR/CI AND no watch reason — behavior unchanged', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow pr={null} ci={null} snapshot={snapshot} />
    )
    expect(markup).toBe('')
  })

  it('shows the green "Pushed" tick when every local commit is on the upstream', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={null}
        ci={null}
        snapshot={
          {
            remoteUrl: 'git@github.com:acme/widgets.git',
            branch: 'feature/demo',
            upstream: 'origin/feature/demo',
            ahead: 0,
            behind: 0
          } as GitRepositorySnapshot
        }
      />
    )
    expect(markup).toContain('github-satellite-icon--push')
    expect(markup).toContain('tone-success')
    expect(markup).toContain('Pushed')
    expect(markup).toContain('All local commits pushed')
  })

  it('hides "Pushed" while commits are ahead of the upstream (the rows keep the ↑N count)', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={null}
        ci={null}
        snapshot={
          {
            remoteUrl: 'git@github.com:acme/widgets.git',
            branch: 'feature/demo',
            upstream: 'origin/feature/demo',
            ahead: 3,
            behind: 0
          } as GitRepositorySnapshot
        }
      />
    )
    expect(markup).not.toContain('Pushed')
  })

  it('renders nothing without a GitHub remote, even with a watch reason', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={null}
        ci={null}
        snapshot={null}
        watchDisabledReason="No open PR to watch"
      />
    )
    expect(markup).toBe('')
  })

  it('keeps an active watch visible without a remote so the user can turn it off', () => {
    const markup = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={null}
        ci={null}
        snapshot={null}
        isWatching
        onToggleWatch={() => {}}
        watchStatusMessage="GitHub CLI isn't authenticated"
      />
    )
    expect(markup).toContain('github-satellite-row')
    expect(markup).toContain('GitHub CLI isn&#x27;t authenticated')
  })
})
