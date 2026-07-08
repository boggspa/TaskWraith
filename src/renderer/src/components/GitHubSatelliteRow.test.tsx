import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GitHubSatelliteRow } from './GitHubSatelliteRow'
import type {
  GitCiStatusSummary,
  GitPrSummary,
  GitRepositorySnapshot
} from '../../../main/services/GitService'

const remote = {
  remoteUrl: 'https://github.com/acme/app.git',
  commit: 'abc123',
  branch: 'feat/x'
} as GitRepositorySnapshot

describe('GitHubSatelliteRow', () => {
  it('renders nothing without a git remote', () => {
    const html = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={{ number: 75, state: 'OPEN', url: 'u' } as GitPrSummary}
        snapshot={{} as GitRepositorySnapshot}
      />
    )
    expect(html).toBe('')
  })

  it('renders nothing when a remote exists but there is no PR or CI', () => {
    const html = renderToStaticMarkup(<GitHubSatelliteRow pr={null} snapshot={remote} />)
    expect(html).toBe('')
  })

  it('shows an open PR indicator with its number and open tone', () => {
    const html = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={{ number: 75, state: 'OPEN', url: 'https://gh/pr/75' } as GitPrSummary}
        snapshot={remote}
      />
    )
    expect(html).toContain('github-satellite-icon--pr')
    expect(html).toContain('tone-open')
    expect(html).toContain('#75')
    expect(html).toContain('is-clickable')
  })

  it('uses the merged tone for a merged PR', () => {
    const html = renderToStaticMarkup(
      <GitHubSatelliteRow
        pr={{ number: 75, state: 'MERGED', url: 'u' } as GitPrSummary}
        snapshot={remote}
      />
    )
    expect(html).toContain('tone-merged')
  })

  it('renders a danger CI dot when checks include a failure', () => {
    const pr = {
      number: 75,
      state: 'OPEN',
      url: 'u',
      checks: [{ status: 'completed', conclusion: 'failure' }]
    } as GitPrSummary
    const html = renderToStaticMarkup(<GitHubSatelliteRow pr={pr} snapshot={remote} />)
    expect(html).toContain('github-satellite-icon--ci')
    expect(html).toContain('github-satellite-dot')
    expect(html).toContain('tone-danger')
  })

  it('prefers the live ciStatus classification over pr.checks', () => {
    // pr.checks say failing, but the live ciStatus says passed → success wins.
    const pr = {
      number: 75,
      state: 'OPEN',
      url: 'u',
      checks: [{ status: 'completed', conclusion: 'failure' }]
    } as GitPrSummary
    const ci = {
      status: 'passed',
      checks: [],
      runs: [{ id: 1, conclusion: 'success' }],
      failedLogs: []
    } as unknown as GitCiStatusSummary
    const html = renderToStaticMarkup(<GitHubSatelliteRow pr={pr} ci={ci} snapshot={remote} />)
    expect(html).toContain('github-satellite-icon--ci')
    expect(html).toContain('tone-success')
    expect(html).not.toContain('tone-danger')
  })
})
