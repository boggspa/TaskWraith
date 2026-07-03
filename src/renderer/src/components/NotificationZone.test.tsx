import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NotificationZone, notificationDirectionForDrag } from './NotificationZone'
import type { AppNotification } from '../../../shared/appNotifications'

/**
 * Server-rendered smoke tests (the codebase uses renderToStaticMarkup, no
 * jsdom — auto-rotate/dismiss interaction lives in manual / e2e). These cover
 * the static contract: zero DOM when empty, single-card vs rotating layout,
 * the danger-vs-default tone, and that the dismiss affordance respects
 * `dismissible`.
 */

const deprecation: AppNotification = {
  id: 'dep-1',
  kind: 'deprecation',
  title: 'Legacy provider retired.',
  body: 'No longer available for new runs.'
}
const addition: AppNotification = {
  id: 'add-1',
  kind: 'addition',
  title: 'Ornith local models are available.',
  body: 'New local coding models are selectable.'
}
const claudeAddition: AppNotification = {
  id: 'claude-sonnet-5-2026-06-30',
  kind: 'addition',
  title: 'Claude Sonnet 5 is available.',
  body: 'Adaptive thinking and 1M context are available.',
  accent: 'claude'
}
const ensembleFeature: AppNotification = {
  id: 'ensemble-composer-toggle-2026-07-03',
  kind: 'feature',
  title: 'Ensemble starts from new drafts now.',
  body: 'Use the Ensemble glyph in the composer bottom row.',
  accent: 'ensemble',
  icon: 'ensemble'
}

describe('NotificationZone', () => {
  it('maps horizontal drags to carousel directions', () => {
    expect(notificationDirectionForDrag(-64, 4)).toBe('prev')
    expect(notificationDirectionForDrag(64, 4)).toBe('next')
    expect(notificationDirectionForDrag(20, 2)).toBeNull()
    expect(notificationDirectionForDrag(64, 80)).toBeNull()
  })

  it('renders nothing when there are no active notifications', () => {
    expect(renderToStaticMarkup(<NotificationZone notifications={[]} />)).toBe('')
  })

  it('renders a single card with no rotation wrapper or dots', () => {
    const html = renderToStaticMarkup(<NotificationZone notifications={[deprecation]} />)
    expect(html).toContain('Legacy provider retired.')
    expect(html).toContain('notification-card--danger')
    expect(html).not.toContain('notification-zone--rotating')
    expect(html).not.toContain('notification-zone-dots')
  })

  it('uses the default (non-red) card for additions', () => {
    const html = renderToStaticMarkup(<NotificationZone notifications={[addition]} />)
    expect(html).toContain('notification-card--default')
    expect(html).toContain('notification-card--accent-default')
    expect(html).not.toContain('notification-card--danger')
  })

  it('adds the Claude provider accent class for Claude model announcements', () => {
    const html = renderToStaticMarkup(<NotificationZone notifications={[claudeAddition]} />)
    expect(html).toContain('Claude Sonnet 5 is available.')
    expect(html).toContain('notification-card--default')
    expect(html).toContain('notification-card--accent-claude')
    expect(html).not.toContain('notification-card--danger')
  })

  it('adds the Ensemble accent and glyph for the composer-toggle announcement', () => {
    const html = renderToStaticMarkup(<NotificationZone notifications={[ensembleFeature]} />)
    expect(html).toContain('Ensemble starts from new drafts now.')
    expect(html).toContain('notification-card--default')
    expect(html).toContain('notification-card--accent-ensemble')
    expect(html).toContain('provider-glyph-ensemble')
    expect(html).not.toContain('notification-card--danger')
  })

  it('keeps danger styling even when a danger notice carries the Ensemble accent', () => {
    const html = renderToStaticMarkup(
      <NotificationZone
        notifications={[
          { ...ensembleFeature, id: 'ensemble-danger', kind: 'deprecation' }
        ]}
      />
    )
    expect(html).toContain('notification-card--danger')
    expect(html).toContain('notification-card--accent-ensemble')
  })

  it('rotates when more than one is active: first card shown, one dot per notice', () => {
    const html = renderToStaticMarkup(
      <NotificationZone notifications={[deprecation, addition]} />
    )
    expect(html).toContain('notification-zone--rotating')
    expect(html).toContain('is-swipe-enabled')
    // First notice is the visible card.
    expect(html).toContain('Legacy provider retired.')
    // One dot per notice; first is active.
    const dotMatches = html.match(/notification-zone-dot/g) ?? []
    expect(dotMatches.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('notification-zone-dot is-active')
    expect(html).toContain('Show previous notification')
    expect(html).toContain('Show next notification')
    expect(html).toContain('data-swipe-ignore="true"')
  })

  it('omits the dismiss button for a non-dismissible notice', () => {
    const html = renderToStaticMarkup(
      <NotificationZone notifications={[{ ...addition, dismissible: false }]} />
    )
    expect(html).not.toContain('notification-card-dismiss')
  })

  it('drops expired notifications when now is past expiresAt', () => {
    const expired: AppNotification = {
      id: 'expired-1',
      kind: 'info',
      title: 'Timed notice.',
      body: 'Should not render.',
      expiresAt: 1_000
    }
    expect(
      renderToStaticMarkup(<NotificationZone notifications={[expired]} now={1_000} />)
    ).toBe('')
    expect(
      renderToStaticMarkup(<NotificationZone notifications={[expired]} now={999} />)
    ).toContain('Timed notice.')
  })
})
