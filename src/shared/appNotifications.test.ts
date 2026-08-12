import { readFileSync } from 'node:fs'
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
      PINNED_APP_NOTIFICATIONS.length +
        selectChangelogFeatureNotifications(CHANGELOG_FEATURE_NOTIFICATION_POOL, 0).length
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
    expect(groups.map((g) => g.provider)).toEqual([
      'grok',
      'cursor',
      'muse',
      'ollama',
      'mistral',
      'pi'
    ])
    expect(groups.map((g) => g.label)).toEqual([
      'Grok',
      'Cursor',
      'Muse',
      'Ollama',
      'Mistral',
      'Pi'
    ])
    // Dropped from the card once they stopped being the newest story.
    expect(groups.map((g) => g.provider)).not.toContain('claude')
    expect(groups.map((g) => g.provider)).not.toContain('antigravity')
    expect(groups.map((g) => g.provider)).not.toContain('kimi')

    const grok = groups.find((g) => g.provider === 'grok')
    expect(grok?.models.map((m) => m.name)).toEqual(['Grok 4.6 Fast'])
    expect(grok?.models[0]?.blurb).toMatch(/500K.*Extra High.*Grok Build/i)

    const cursor = groups.find((g) => g.provider === 'cursor')
    expect(cursor?.models.map((m) => m.name)).toEqual(['Grok 4.6'])
    expect(cursor?.models[0]?.blurb).toMatch(/256K.*Extra High.*Standard\/Fast/i)

    const muse = groups.find((g) => g.provider === 'muse')
    expect(muse?.models.map((m) => m.name)).toEqual(['Muse Spark 1.2'])
    for (const model of muse?.models ?? []) {
      expect(model.accentProvider).toBeUndefined()
    }

    const ollama = groups.find((g) => g.provider === 'ollama')
    // Newest curated local tags — each spoofs its upstream brand hue.
    expect(ollama?.models.map((m) => m.name)).toEqual([
      'Muse Glimmer (30B-MLX)',
      'Nemotron 3.5 Lightning (30B-MLX)',
      'North Mini Code 1.0',
      'GLM-4.7-Flash',
      'Rnj-1'
    ])
    expect(ollama?.models.map((m) => m.accentProvider)).toEqual([
      'meta',
      'nvidia',
      'cohere',
      'zai',
      'essential'
    ])
    // Muse Glimmer is an Ollama runtime entry even though Meta also has its own
    // provider surface; do not split either new local model into a new group.
    expect(groups.find((g) => g.provider === 'meta')).toBeUndefined()

    const mistral = groups.find((g) => g.provider === 'mistral')
    // Mistral's own Vibe seat, distinct from the `mistral/*` BYOK rows Pi
    // serves. Unlike the Pi/Ollama rows these carry NO accentProvider — every
    // model here really is this provider, so the group's own hue is correct.
    expect(mistral?.models.map((m) => m.name)).toEqual(['Devstral Small', 'Mistral Medium 3.5'])
    for (const model of mistral?.models ?? []) {
      expect(model.accentProvider).toBeUndefined()
      // `devstral-2` is the RETIRED ALIAS for mistral-medium-3.5, so a row
      // named "Devstral 2" would advertise the wrong model entirely.
      expect(model.name).not.toMatch(/devstral\s*-?\s*2\b/i)
      // The seat declares `imageAttachments: false` — the contract is
      // per-PROVIDER and its default model (devstral-small) has no vision — so
      // the UI never offers attachment here. Promising it on the card would
      // advertise an affordance that does not exist.
      expect(model.blurb).not.toMatch(/image/i)
      // Mistral publishes no numeric budget and has no usage endpoint; our
      // meter is a local estimate. A card implying a known ceiling would be
      // false, so no quota/allowance language.
      expect(model.blurb).not.toMatch(/quota|allowance|unlimited|\bfree\b/i)
    }

    const pi = groups.find((g) => g.provider === 'pi')
    // One row per BYOK upstream, each spoofing its own brand hue — the classes
    // must stay in lockstep with PI_UPSTREAM_BRANDS.
    expect(pi?.models.map((m) => m.accentProvider)).toEqual([
      'deepseek',
      'zai',
      'qwen',
      'minimax',
      'mistral',
      'groq',
      'cerebras'
    ])
    for (const model of pi?.models ?? []) {
      expect(model.accentProvider).toBeTruthy()
    }

    for (const group of groups) {
      for (const model of group.models) {
        expect(model.name.length).toBeGreaterThan(0)
        expect(model.blurb.length).toBeGreaterThan(0)
        expect(model.blurb.length).toBeLessThanOrEqual(120)
      }
    }
  })

  it('keeps the iOS demo New Additions payload aligned with Electron', () => {
    const newAdditions = PINNED_APP_NOTIFICATIONS.find(
      (notification) => notification.id === NEW_ADDITIONS_NOTIFICATION_ID
    )
    expect(newAdditions).toBeDefined()

    const iosDemoSource = readFileSync(
      new URL(
        '../../ios/TaskWraithKit/Sources/TaskWraithUI/RemoteSessionModel.swift',
        import.meta.url
      ),
      'utf8'
    )
    expect(iosDemoSource).toContain(`"id":"${NEW_ADDITIONS_NOTIFICATION_ID}"`)
    expect(iosDemoSource).toContain(`"body":${JSON.stringify(newAdditions?.body)}`)
    for (const group of newAdditions?.groups ?? []) {
      expect(iosDemoSource).toContain(
        `"provider":${JSON.stringify(group.provider)},"label":${JSON.stringify(group.label)}`
      )
      for (const model of group.models) {
        expect(iosDemoSource).toContain(JSON.stringify(model))
      }
    }
  })

  it('exports APP_NOTIFICATIONS as a resolveAppNotifications snapshot', () => {
    expect(APP_NOTIFICATIONS).toEqual(resolveAppNotifications(0))
  })
})
