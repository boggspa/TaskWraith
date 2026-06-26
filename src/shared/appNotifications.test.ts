import { describe, it, expect } from 'vitest'
import {
  APP_NOTIFICATIONS,
  activeAppNotifications,
  appNotificationDismissKey,
  appNotificationTone,
  type AppNotification
} from './appNotifications'

const sample: AppNotification[] = [
  { id: 'a', kind: 'deprecation', title: 'A', body: 'a' },
  { id: 'b', kind: 'addition', title: 'B', body: 'b' },
  { id: 'c', kind: 'feature', title: 'C', body: 'c', dismissible: false },
  { id: 'd', kind: 'info', title: 'D', body: 'd', expiresAt: 1000 }
]

describe('appNotificationTone', () => {
  it('makes only deprecation red; everything else uses the default card', () => {
    expect(appNotificationTone('deprecation')).toBe('danger')
    expect(appNotificationTone('addition')).toBe('default')
    expect(appNotificationTone('feature')).toBe('default')
    expect(appNotificationTone('info')).toBe('default')
  })
})

describe('appNotificationDismissKey', () => {
  it('builds a stable per-id key', () => {
    expect(appNotificationDismissKey('gemini-retirement-2026-06-18')).toBe(
      'taskwraith.appNotification.gemini-retirement-2026-06-18.dismissed'
    )
  })
})

describe('activeAppNotifications', () => {
  it('drops dismissed dismissible notices, keeps order', () => {
    const active = activeAppNotifications({
      notifications: sample,
      now: 0,
      isDismissed: (n) => n.id === 'a'
    })
    expect(active.map((n) => n.id)).toEqual(['b', 'c', 'd'])
  })

  it('never drops a non-dismissible notice even if isDismissed returns true', () => {
    const active = activeAppNotifications({
      notifications: sample,
      now: 0,
      isDismissed: () => true
    })
    // a, b, d are dismissible → gone; c (dismissible:false) survives.
    expect(active.map((n) => n.id)).toEqual(['c'])
  })

  it('drops notices at/after their expiry', () => {
    const beforeExpiry = activeAppNotifications({
      notifications: sample,
      now: 999,
      isDismissed: () => false
    })
    expect(beforeExpiry.map((n) => n.id)).toContain('d')
    const atExpiry = activeAppNotifications({
      notifications: sample,
      now: 1000,
      isDismissed: () => false
    })
    expect(atExpiry.map((n) => n.id)).not.toContain('d')
  })

  it('defaults to the real registry when no list is passed', () => {
    const active = activeAppNotifications({ now: 0, isDismissed: () => false })
    expect(active.length).toBe(APP_NOTIFICATIONS.length)
  })
})

describe('APP_NOTIFICATIONS registry', () => {
  it('has unique, dot-safe ids', () => {
    const ids = APP_NOTIFICATIONS.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('seeds the Gemini deprecation (red) with its legacy dismiss key', () => {
    const gemini = APP_NOTIFICATIONS.find((n) => n.id === 'gemini-retirement-2026-06-18')
    expect(gemini).toBeDefined()
    expect(gemini && appNotificationTone(gemini.kind)).toBe('danger')
    expect(gemini?.legacyDismissKey).toBe('taskwraith.geminiRetirementBannerDismissed.v1')
  })

  it('seeds the Grok Composer 2.5 Fast addition (default card)', () => {
    const grok = APP_NOTIFICATIONS.find((n) => n.kind === 'addition')
    expect(grok).toBeDefined()
    expect(grok && appNotificationTone(grok.kind)).toBe('default')
    expect(grok?.title).toMatch(/Composer 2\.5 Fast/)
  })

  it('seeds the AntiGravity policy notice as a neutral info card', () => {
    const antigravity = APP_NOTIFICATIONS.find(
      (n) => n.id === 'antigravity-not-planned-2026-06-26'
    )
    expect(antigravity).toBeDefined()
    expect(antigravity && appNotificationTone(antigravity.kind)).toBe('default')
    expect(antigravity?.kind).toBe('info')
    expect(antigravity?.title).toBe('AntiGravity will not be added.')
    expect(antigravity?.body).toContain('Google AntiGravity')
  })
})
