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
  title: 'Gemini has been retired.',
  body: 'No longer available for new runs.'
}
const addition: AppNotification = {
  id: 'add-1',
  kind: 'addition',
  title: 'Grok Composer 2.5 Fast is here.',
  body: 'A faster agentic coding model.'
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
    expect(html).toContain('Gemini has been retired.')
    expect(html).toContain('notification-card--danger')
    expect(html).not.toContain('notification-zone--rotating')
    expect(html).not.toContain('notification-zone-dots')
  })

  it('uses the default (non-red) card for additions', () => {
    const html = renderToStaticMarkup(<NotificationZone notifications={[addition]} />)
    expect(html).toContain('notification-card--default')
    expect(html).not.toContain('notification-card--danger')
  })

  it('rotates when more than one is active: first card shown, one dot per notice', () => {
    const html = renderToStaticMarkup(
      <NotificationZone notifications={[deprecation, addition]} />
    )
    expect(html).toContain('notification-zone--rotating')
    expect(html).toContain('is-swipe-enabled')
    // First notice is the visible card.
    expect(html).toContain('Gemini has been retired.')
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
})
