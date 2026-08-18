import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ReleaseLeaseView,
  describeLeaseRemaining,
  describeLeaseScope,
  formatLeaseDuration,
  type ReleaseLeaseSnapshotView
} from './ReleaseLeasePanel'

const NOW = Date.parse('2026-08-18T12:00:00.000Z')

function makeLease(overrides: Partial<ReleaseLeaseSnapshotView> = {}): ReleaseLeaseSnapshotView {
  return {
    id: 'lease-1',
    commandClasses: 'all',
    grantedAt: '2026-08-18T11:00:00.000Z',
    expiresAt: '2026-08-18T14:00:00.000Z',
    origin: 'desktop-ui',
    ...overrides
  }
}

function render(props: Partial<React.ComponentProps<typeof ReleaseLeaseView>> = {}): string {
  return renderToStaticMarkup(
    <ReleaseLeaseView leases={[]} nowMs={NOW} minutes={120} scopeToWorkspace={false} {...props} />
  )
}

describe('describeLeaseRemaining', () => {
  it('answers "is this still open?" rather than printing a timestamp', () => {
    expect(describeLeaseRemaining('2026-08-18T14:00:00.000Z', NOW)).toBe('2 hr left')
    expect(describeLeaseRemaining('2026-08-18T12:45:00.000Z', NOW)).toBe('45 min left')
    expect(describeLeaseRemaining('2026-08-18T13:30:00.000Z', NOW)).toBe('1 hr 30 min left')
  })

  it('reads Expired at and past the boundary, never a negative duration', () => {
    expect(describeLeaseRemaining('2026-08-18T12:00:00.000Z', NOW)).toBe('Expired')
    expect(describeLeaseRemaining('2026-08-18T11:00:00.000Z', NOW)).toBe('Expired')
    expect(describeLeaseRemaining('not-a-date', NOW)).toBe('Expired')
  })
})

describe('describeLeaseScope', () => {
  it('spells out an unscoped lease instead of showing the raw sentinel', () => {
    expect(describeLeaseScope('all')).toBe('All release commands')
    expect(describeLeaseScope([])).toBe('All release commands')
    expect(describeLeaseScope(['git push', 'gh release'])).toBe('git push, gh release')
  })
})

describe('formatLeaseDuration', () => {
  it('renders each offered duration readably', () => {
    expect(formatLeaseDuration(30)).toBe('30 min')
    expect(formatLeaseDuration(120)).toBe('2 hr')
    expect(formatLeaseDuration(720)).toBe('12 hr')
  })
})

describe('ReleaseLeaseView', () => {
  it('states plainly that release commands are blocked when no lease is active', () => {
    const html = render()
    expect(html).toContain('No active lease')
    expect(html).toContain('Release commands are blocked for every agent.')
    expect(html).toContain('Grant lease')
    // Nothing to revoke, so the bulk control must not be offered.
    expect(html).not.toContain('Revoke all')
  })

  it('shows an active lease with its scope, remaining time, and reach', () => {
    const html = render({ leases: [makeLease()] })
    expect(html).toContain('1 active lease')
    expect(html).toContain('All release commands')
    expect(html).toContain('2 hr left')
    expect(html).toContain('any workspace')
    expect(html).toContain('Revoke all')
  })

  it('names the workspace when the lease is scoped to one', () => {
    const html = render({
      leases: [makeLease({ workspacePath: '/Users/dev/AGBench', commandClasses: ['git push'] })]
    })
    expect(html).toContain('/Users/dev/AGBench')
    expect(html).toContain('git push')
    expect(html).not.toContain('any workspace')
  })

  it('hides an expired lease rather than showing it as authorization', () => {
    const html = render({
      leases: [makeLease({ expiresAt: '2026-08-18T11:59:00.000Z' })]
    })
    expect(html).toContain('No active lease')
    expect(html).toContain('Release commands are blocked for every agent.')
  })

  it('pluralises the active count', () => {
    const html = render({
      leases: [makeLease(), makeLease({ id: 'lease-2' })]
    })
    expect(html).toContain('2 active leases')
  })

  it('offers the workspace limit only when there is a workspace to limit to', () => {
    expect(render({ currentWorkspacePath: '/Users/dev/AGBench' })).toContain(
      'Limit to this workspace'
    )
    expect(render({ currentWorkspacePath: null })).not.toContain('Limit to this workspace')
  })

  it('surfaces an error and disables the controls while busy', () => {
    const html = render({ busy: true, error: 'Lease service unavailable.' })
    expect(html).toContain('Lease service unavailable.')
    expect(html).toContain('disabled')
  })

  it('shows the note the user attached to a lease', () => {
    const html = render({ leases: [makeLease({ note: 'v1.9.6 AFK release run' })] })
    expect(html).toContain('v1.9.6 AFK release run')
  })
})
