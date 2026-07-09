import { describe, it, expect } from 'vitest'
import {
  APP_NOTIFICATIONS,
  CHANGELOG_FEATURE_NOTIFICATION_POOL,
  NEW_ADDITIONS_NOTIFICATION_ID,
  PINNED_APP_NOTIFICATIONS,
  resolveAppNotifications,
  selectChangelogFeatureNotifications,
  activeAppNotifications,
  appNotificationAccent,
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
    expect(appNotificationDismissKey('ollama-local-models-2026-06-30')).toBe(
      'taskwraith.appNotification.ollama-local-models-2026-06-30.dismissed'
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

  it('defaults to the resolved registry when no list is passed', () => {
    const active = activeAppNotifications({ now: 0, isDismissed: () => false })
    expect(active.length).toBe(resolveAppNotifications(0).length)
  })
})

describe('selectChangelogFeatureNotifications', () => {
  it('returns nothing from the (currently empty) production pool', () => {
    expect(selectChangelogFeatureNotifications(CHANGELOG_FEATURE_NOTIFICATION_POOL, 0)).toEqual([])
  })

  it('returns the full pool when maxCount exceeds pool size', () => {
    const picked = selectChangelogFeatureNotifications(sample.slice(0, 2), 0, 4)
    expect(picked.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('rotates the daily window through a larger pool', () => {
    const dayZero = selectChangelogFeatureNotifications(sample, 0, 2)
    const nextDay = selectChangelogFeatureNotifications(sample, 86_400_000, 2)
    expect(dayZero.map((n) => n.id)).toEqual(['a', 'b'])
    expect(nextDay.map((n) => n.id)).toEqual(['b', 'c'])
  })
})

describe('resolveAppNotifications', () => {
  it('prepends pinned notices before dynamic changelog picks', () => {
    const resolved = resolveAppNotifications(0)
    expect(resolved.slice(0, PINNED_APP_NOTIFICATIONS.length).map((n) => n.id)).toEqual(
      PINNED_APP_NOTIFICATIONS.map((n) => n.id)
    )
    expect(resolved.length).toBe(
      PINNED_APP_NOTIFICATIONS.length + selectChangelogFeatureNotifications(CHANGELOG_FEATURE_NOTIFICATION_POOL, 0).length
    )
  })
})

describe('notification registry', () => {
  it('has unique, dot-safe ids across pinned + pool', () => {
    const ids = [...PINNED_APP_NOTIFICATIONS, ...CHANGELOG_FEATURE_NOTIFICATION_POOL].map(
      (n) => n.id
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no dynamic changelog pool right now — only the pinned New Additions card shows', () => {
    expect(CHANGELOG_FEATURE_NOTIFICATION_POOL).toEqual([])
    expect(resolveAppNotifications(0)).toEqual(PINNED_APP_NOTIFICATIONS)
  })

  it('does not keep stale notices from prior carousels', () => {
    const ids = resolveAppNotifications(0).map((n) => n.id)
    expect(ids).not.toContain('gemini-retirement-2026-06-18')
    expect(ids).not.toContain('grok-composer-2-5-fast-2026-06-19')
    expect(ids).not.toContain('ensemble-composer-toggle-2026-07-03')
    expect(ids).not.toContain('claude-sonnet-5-2026-06-30')
    expect(ids).not.toContain('changelog-scheduled-queue-2026-06-28')
  })

  it('seeds the New Additions card as a default (non-accented) dismissible addition', () => {
    const newAdditions = PINNED_APP_NOTIFICATIONS.find(
      (n) => n.id === NEW_ADDITIONS_NOTIFICATION_ID
    )
    expect(newAdditions).toBeDefined()
    expect(newAdditions && appNotificationTone(newAdditions.kind)).toBe('default')
    expect(newAdditions && appNotificationAccent(newAdditions)).toBe('default')
    expect(newAdditions?.kind).toBe('addition')
    expect(newAdditions?.title).toBe('New Additions')
    expect(newAdditions?.dismissible).toBe(true)
  })

  it('groups the New Additions lineup by provider, in order, with every model non-empty', () => {
    const newAdditions = PINNED_APP_NOTIFICATIONS.find(
      (n) => n.id === NEW_ADDITIONS_NOTIFICATION_ID
    )
    const groups = newAdditions?.groups ?? []
    expect(groups.map((g) => g.provider)).toEqual(['claude', 'codex', 'cursor', 'grok', 'ollama'])
    expect(groups.map((g) => g.label)).toEqual(['Claude', 'Codex', 'Cursor', 'Grok', 'Ollama'])

    const claude = groups.find((g) => g.provider === 'claude')
    expect(claude?.models.map((m) => m.name)).toEqual(['Sonnet 5', 'Fable 5'])

    const codex = groups.find((g) => g.provider === 'codex')
    expect(codex?.models.map((m) => m.name)).toEqual(['GPT 5.6 Luna', 'GPT 5.6 Terra', 'GPT 5.6 Sol'])

    const cursor = groups.find((g) => g.provider === 'cursor')
    expect(cursor?.models.map((m) => m.name)).toEqual(['Cursor Grok 4.5'])

    const grok = groups.find((g) => g.provider === 'grok')
    expect(grok?.models.map((m) => m.name)).toEqual(['Grok 4.5 Fast'])

    const ollama = groups.find((g) => g.provider === 'ollama')
    expect(ollama?.models.map((m) => m.name)).toEqual([
      'Deep Reinforce - Ornith 9B + Ornith 35B',
      'Liquid - LFM 2.5 8B-1A'
    ])

    for (const group of groups) {
      for (const model of group.models) {
        expect(model.name.length).toBeGreaterThan(0)
        expect(model.blurb.length).toBeGreaterThan(0)
        expect(model.blurb.length).toBeLessThanOrEqual(120)
      }
    }
  })

  it('exports APP_NOTIFICATIONS as a resolveAppNotifications snapshot', () => {
    expect(APP_NOTIFICATIONS).toEqual(resolveAppNotifications(0))
  })
})
