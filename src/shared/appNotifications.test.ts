import { describe, it, expect } from 'vitest'
import {
  APP_NOTIFICATIONS,
  CHANGELOG_FEATURE_NOTIFICATION_POOL,
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
  it('returns the full pool when maxCount exceeds pool size', () => {
    const picked = selectChangelogFeatureNotifications(
      CHANGELOG_FEATURE_NOTIFICATION_POOL.slice(0, 2),
      0,
      4
    )
    expect(picked.map((n) => n.id)).toEqual([
      'changelog-plan-mode-workflow-2026-07-01',
      'changelog-ensemble-recovery-2026-07-01'
    ])
  })

  it('rotates the daily window through a larger pool', () => {
    const dayZero = selectChangelogFeatureNotifications(CHANGELOG_FEATURE_NOTIFICATION_POOL, 0, 2)
    const nextDay = selectChangelogFeatureNotifications(
      CHANGELOG_FEATURE_NOTIFICATION_POOL,
      86_400_000,
      2
    )
    expect(dayZero.map((n) => n.id)).toEqual([
      'changelog-plan-mode-workflow-2026-07-01',
      'changelog-ensemble-recovery-2026-07-01'
    ])
    expect(nextDay.map((n) => n.id)).toEqual([
      'changelog-ensemble-recovery-2026-07-01',
      'changelog-read-fanout-skip-2026-07-01'
    ])
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

  it('does not keep stale Gemini or Grok carousel notices', () => {
    const ids = resolveAppNotifications(0).map((n) => n.id)
    expect(ids).not.toContain('gemini-retirement-2026-06-18')
    expect(ids).not.toContain('grok-composer-2-5-fast-2026-06-19')
    expect(ids).not.toContain('scheduled-composer-queue-2026-06-28')
    expect(ids).not.toContain('ollama-ornith-models-2026-06-28')
  })

  it('seeds the local Ollama models addition with Ornith + LFM (default card)', () => {
    const models = PINNED_APP_NOTIFICATIONS.find((n) => n.id === 'ollama-local-models-2026-06-30')
    expect(models).toBeDefined()
    expect(models && appNotificationTone(models.kind)).toBe('default')
    expect(models && appNotificationAccent(models)).toBe('default')
    expect(models?.kind).toBe('addition')
    expect(models?.title).toBe('New local Ollama models are available.')
    expect(models?.body).toContain('Ornith 1.0 (9B Param)')
    expect(models?.body).toContain('Ornith 1.0 (35B Param)')
    expect(models?.body).toContain('256K-context')
    expect(models?.body).toContain('LFM 2.5 (8B-1A)')
    expect(models?.body).toContain('131K-context')
    expect(models?.body).toContain('tool/thinking')
  })

  it('seeds the Ensemble composer-toggle notice with the green Ensemble signpost', () => {
    const ensemble = PINNED_APP_NOTIFICATIONS.find(
      (n) => n.id === 'ensemble-composer-toggle-2026-07-03'
    )
    expect(ensemble).toBeDefined()
    expect(ensemble && appNotificationTone(ensemble.kind)).toBe('default')
    expect(ensemble && appNotificationAccent(ensemble)).toBe('ensemble')
    expect(ensemble?.kind).toBe('feature')
    expect(ensemble?.icon).toBe('ensemble')
    expect(ensemble?.dismissible).toBe(true)
    expect(ensemble?.title).toBe('Ensemble starts from new drafts now.')
    expect(ensemble?.body).toContain('Ensemble glyph')
    expect(ensemble?.body).toContain('composer bottom row')
    expect(ensemble?.body).toContain('New Ensemble Chat menu entry')
    expect(ensemble?.body).toContain('Ensembles +')
  })

  it('seeds the Claude Sonnet 5 addition with the Claude accent', () => {
    const sonnet = PINNED_APP_NOTIFICATIONS.find((n) => n.id === 'claude-sonnet-5-2026-06-30')
    expect(sonnet).toBeDefined()
    expect(sonnet && appNotificationTone(sonnet.kind)).toBe('default')
    expect(sonnet && appNotificationAccent(sonnet)).toBe('claude')
    expect(sonnet?.kind).toBe('addition')
    expect(sonnet?.title).toBe('Claude Sonnet 5 is available.')
    expect(sonnet?.body).toContain('adaptive thinking')
    expect(sonnet?.body).toContain('1M context')
    expect(sonnet?.body).toContain('128K max output')
    expect(sonnet?.body).toContain('85.2% SWE-bench Verified')
    expect(sonnet?.body).toContain('$2/$10 per MTok')
  })

  it('seeds the Claude Fable return notice with official model stats', () => {
    const returned = PINNED_APP_NOTIFICATIONS.find(
      (n) => n.id === 'claude-fable-mythos-return-2026-07-01'
    )
    expect(returned).toBeDefined()
    expect(returned && appNotificationTone(returned.kind)).toBe('default')
    expect(returned && appNotificationAccent(returned)).toBe('claude')
    expect(returned?.kind).toBe('addition')
    expect(returned?.title).toBe('Claude Fable 5 access is returning.')
    expect(returned?.body).toContain('currently available')
    expect(returned?.body).toContain('July 7, 2026')
    expect(returned?.body).toContain('SDK/API-only')
    expect(returned?.body).toContain('1M context')
    expect(returned?.body).toContain('128K max output')
    expect(returned?.body).toContain('adaptive thinking')
    expect(returned?.body).toContain('Fast tier')
    expect(returned?.body).toContain('$10/$50 per MTok')
    expect(returned?.body).not.toContain('Mythos')
  })

  it('keeps scheduled sends in the dynamic changelog pool', () => {
    const scheduled = CHANGELOG_FEATURE_NOTIFICATION_POOL.find(
      (n) => n.id === 'changelog-scheduled-queue-2026-06-28'
    )
    expect(scheduled).toBeDefined()
    expect(scheduled?.title).toBe('Scheduled sends are visible now.')
    expect(scheduled?.body).toContain('Schedule clock')
  })

  it('seeds 1.7.0 workflow and recovery highlights in the dynamic changelog pool', () => {
    const ids = CHANGELOG_FEATURE_NOTIFICATION_POOL.map((n) => n.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'changelog-plan-mode-workflow-2026-07-01',
        'changelog-ensemble-recovery-2026-07-01',
        'changelog-read-fanout-skip-2026-07-01',
        'changelog-boss-roster-swap-2026-07-01'
      ])
    )
    const plan = CHANGELOG_FEATURE_NOTIFICATION_POOL.find(
      (n) => n.id === 'changelog-plan-mode-workflow-2026-07-01'
    )
    expect(plan?.body).toContain('Read-only (recon) stays separate')
    const recovery = CHANGELOG_FEATURE_NOTIFICATION_POOL.find(
      (n) => n.id === 'changelog-ensemble-recovery-2026-07-01'
    )
    expect(recovery?.body).toContain('one grouped recovery message')
    const rosterSwap = CHANGELOG_FEATURE_NOTIFICATION_POOL.find(
      (n) => n.id === 'changelog-boss-roster-swap-2026-07-01'
    )
    expect(rosterSwap?.body).toContain('provider/model choices')
  })

  it('seeds the AntiGravity policy notice as a neutral info card', () => {
    const antigravity = PINNED_APP_NOTIFICATIONS.find(
      (n) => n.id === 'antigravity-not-planned-2026-06-26'
    )
    expect(antigravity).toBeDefined()
    expect(antigravity && appNotificationTone(antigravity.kind)).toBe('default')
    expect(antigravity && appNotificationAccent(antigravity)).toBe('default')
    expect(antigravity?.kind).toBe('info')
    expect(antigravity?.title).toBe('AntiGravity will not be added.')
    expect(antigravity?.body).toContain('Google AntiGravity')
  })

  it('exports APP_NOTIFICATIONS as a resolveAppNotifications snapshot', () => {
    expect(APP_NOTIFICATIONS).toEqual(resolveAppNotifications(0))
  })
})
