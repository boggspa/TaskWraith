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
  it('makes deprecation and error red, warning amber; everything else uses the default card', () => {
    expect(appNotificationTone('deprecation')).toBe('danger')
    expect(appNotificationTone('error')).toBe('danger')
    expect(appNotificationTone('warning')).toBe('warning')
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
      // Mistral leads for Large 4 (2026-10-06), the headline of this lineup.
      // Claude follows for Opus 5.5 (2026-09-22), with Codex right behind it
      // for GPT-6 Sol and Luna (same day).
      'mistral',
      'claude',
      'codex',
      'kimi',
      'devin',
      'antigravity',
      'grok',
      'cursor',
      'muse',
      'ollama',
      'pi'
    ])
    expect(groups.map((g) => g.label)).toEqual([
      'Mistral',
      'Claude',
      'Codex',
      'Kimi',
      'Devin',
      'AntiGravity',
      'Grok',
      'Cursor',
      'Muse',
      'Ollama',
      'Pi'
    ])
    // Dropped from the card once they stopped being the newest story.
    expect(groups.map((g) => g.provider)).not.toContain('gemini')

    // K2.8 Preview took over the standard `kimi-for-coding` route on
    // 2026-09-11 and Highspeed became its own row rather than a Fast toggle,
    // so the card announces BOTH rows — a K2.8-only card would read as if the
    // Highspeed capability had gone away with the toggle.
    const kimi = groups.find((g) => g.provider === 'kimi')
    expect(kimi?.models.map((m) => m.name)).toEqual(['K2.8 Preview', 'K2.7 Code Highspeed'])
    expect(kimi?.models[0]?.blurb).toMatch(/1M context.*Low, High, or Max/i)
    expect(kimi?.models[1]?.blurb).toMatch(/own row.*256K.*always-on/i)
    for (const model of kimi?.models ?? []) {
      expect(model.accentProvider).toBeUndefined()
    }

    // Claude leads for Sonnet 5.5 (2026-09-28) and Opus 5.5 (2026-09-22), with
    // Fable 5.1 (2026-09-01) still listed beneath them; Devin is a whole new seat led by Cognition's own SWE
    // models — never a 'CLI default'.
    const claude = groups.find((g) => g.provider === 'claude')
    expect(claude?.models.map((m) => m.name)).toEqual(['Sonnet 5.5', 'Opus 5.5', 'Fable 5.1'])
    expect(claude?.models[0]?.blurb).toMatch(/1M context.*adaptive thinking.*\$2\/\$10/i)
    expect(claude?.models[1]?.blurb).toMatch(/1M context.*adaptive thinking.*\$4\/\$20/i)
    expect(claude?.models[2]?.blurb).toMatch(/1M context.*adaptive thinking.*Legacy/i)
    // Codex: GPT-6.1 Sol (2026-09-29), then GPT-6 Sol and Luna (2026-09-22),
    // lead the group above Astra (2026-09-03), each blurb carrying the window,
    // ladder and list price.
    const codex = groups.find((g) => g.provider === 'codex')
    expect(codex?.models.map((m) => m.name)).toEqual([
      'GPT-6.1 Sol',
      'GPT-6 Sol',
      'GPT-6 Luna',
      'GPT-6 Astra'
    ])
    expect(codex?.models[0]?.blurb).toMatch(
      /near-Astra.*1\.05M context.*Low through Max.*\$2\/\$10/i
    )
    expect(codex?.models[1]?.blurb).toMatch(/1\.05M context.*Low through Max.*\$2\/\$10/i)
    expect(codex?.models[2]?.blurb).toMatch(/high-volume.*1\.05M.*\$0\.10\/\$0\.50/i)
    expect(codex?.models[3]?.blurb).toMatch(/most capable GPT-6.*organisation/i)
    const devin = groups.find((g) => g.provider === 'devin')
    expect(devin?.models.map((m) => m.name)).toEqual([
      'SWE-2',
      'SWE-1.6 Slow',
      'SWE-1.6 · SWE-1.6 Fast',
      'SWE-1.7 · SWE-1.7 Lightning'
    ])
    // SWE-2 leads: it is Cognition's newest and the reason for this refresh.
    // Its blurb says the plan requirement because Devin badges it Pro and the
    // free-plan gate hides it, so a free seat would otherwise see it announced
    // and never find the row.
    expect(devin?.models[0]?.blurb).toMatch(/Medium, High, or Max/i)
    expect(devin?.models[0]?.blurb).toMatch(/Pro/)
    expect(devin?.models[1]?.blurb).toMatch(/seat default/i)
    expect(devin?.models[3]?.blurb).toMatch(/effort slider/i)
    for (const model of devin?.models ?? []) {
      expect(model.name).not.toMatch(/cli default/i)
    }

    const antigravity = groups.find((g) => g.provider === 'antigravity')
    expect(antigravity?.models.map((m) => m.name)).toEqual(['Gemini 3.8 Flash'])
    expect(antigravity?.models[0]?.blurb).toMatch(/Low.*Medium.*High.*official agy CLI/i)
    expect(antigravity?.models[0]?.blurb).not.toMatch(/API key|separately billed/i)

    const grok = groups.find((g) => g.provider === 'grok')
    expect(grok?.models.map((m) => m.name)).toEqual(['Grok 4.7', 'Grok 4.7 Fast'])
    expect(grok?.models[0]?.blurb).toMatch(/500K.*Extra High/i)

    const cursor = groups.find((g) => g.provider === 'cursor')
    expect(cursor?.models.map((m) => m.name)).toEqual(['Grok 4.6'])
    expect(cursor?.models[0]?.blurb).toMatch(/256K.*Extra High.*Standard\/Fast/i)

    const muse = groups.find((g) => g.provider === 'muse')
    expect(muse?.models.map((m) => m.name)).toEqual([
      'Muse Spark 1.3',
      'Muse Contributor Spark 1.3'
    ])
    expect(muse?.models[0]?.blurb).toMatch(/newest Spark.*1M context.*\$1\.25\/\$4\.25/)
    expect(muse?.models[1]?.blurb).toMatch(/\$0\.10\/\$0\.20.*product improvement/i)
    for (const model of muse?.models ?? []) {
      expect(model.accentProvider).toBeUndefined()
    }

    const mistral = groups.find((g) => g.provider === 'mistral')
    expect(mistral?.models.map((m) => m.name)).toEqual([
      'Mistral Large 4',
      'Mistral 3.5 Medium',
      'Mistral Large 3',
      'Mistral Medium (Latest)',
      'Mistral Medium 3.1',
      'Mistral Medium 3',
      'Mistral Small 4',
      'Leanstral 1.5 (Labs)',
      'GLM-5.2 (via Mistral)',
      'GLM-5.2 (Mistral Hosted)',
      'GLM-5.3 (via Mistral)',
      'GLM-5.3 (Mistral Hosted)',
      'Codestral (Aug 2025)',
      'Ministral 3 (14B)',
      'Ministral 3 (8B)',
      'Ministral 3 (3B)'
    ])
    // Large 4 is API-only, so its blurb must name the lane as well as the nickname.
    expect(mistral?.models[0]?.blurb).toMatch(/Le Chonk.*524K.*your own API key/i)
    expect(mistral?.models.find((m) => m.name === 'Mistral 3.5 Medium')?.blurb).toMatch(
      /Effort.*configurable|configurable.*Effort/i
    )
    expect(mistral?.models.find((m) => m.name === 'GLM-5.2 (Mistral Hosted)')?.blurb).toMatch(
      /Vibe subscription.*no API key/i
    )
    // The 5.3 pair sits directly beside 5.2 under near-identical names, so the
    // card has to say which lane each is on or the two read as the same offer.
    expect(mistral?.models.find((m) => m.name === 'GLM-5.3 (via Mistral)')?.blurb).toMatch(
      /your own API key/i
    )
    expect(mistral?.models.find((m) => m.name === 'GLM-5.3 (Mistral Hosted)')?.blurb).toMatch(
      /Vibe subscription/i
    )

    const ollama = groups.find((g) => g.provider === 'ollama')
    // Signed-in Cloud rows lead, then the newest curated local tags. Each
    // spoofs its upstream brand hue whichever source serves it.
    expect(ollama?.models.map((m) => m.name)).toEqual([
      'Clef & Clef Flash',
      'Tev1 (0.8B & 4B)',
      'Nimble (9B)',
      'DeepSeek V4.1 Flash (Cloud)',
      'GLM 5.2 (Cloud)',
      'MiniMax M3 (Cloud)',
      'Ornith 1.5 (9B & 35B)',
      'Gemma 4 (31B-MLX)',
      'Qwen 3.8 (27B-MLX)',
      'Muse Glimmer (30B-MLX)',
      'Nemotron 3.5 Lightning (30B-MLX)',
      'North Mini Code 1.0',
      'GLM-4.7-Flash',
      'Rnj-1'
    ])
    expect(ollama?.models.map((m) => m.accentProvider)).toEqual([
      'cloudflare',
      'together',
      'bespoke',
      'deepseek',
      'zai',
      'minimax',
      'deep-reinforce',
      'google',
      'qwen',
      'meta',
      'nvidia',
      'cohere',
      'zai',
      'essential'
    ])
    const pi = groups.find((g) => g.provider === 'pi')
    expect(pi?.models.map((m) => m.name)).toEqual([
      // The 2026-10-01/02 OpenRouter routes lead, then Space Bunny Alpha
      // (2026-09-23), then Pareto and Jev (2026-09-17).
      'Pareto 26.10 Preview (OpenRouter)',
      'Ling 3.1 Flash (OpenRouter Free)',
      'Apodex 1.1 Mini (OpenRouter Free)',
      'Space Bunny Alpha (OpenRouter Free)',
      'Pareto (OpenRouter)',
      'Jev 1.13 (OpenRouter)',
      'Fugu Max (OpenRouter)',
      'Fugu Ultra v2 (OpenRouter)',
      'Mercury 2.5 (OpenRouter)',
      'Nex-N2.5-Pro (OpenRouter Free)',
      'Nex-N2.5-Mini (OpenRouter Free)',
      'Qwen 3.8 27B (Cerebras)',
      'North Mini Code (OpenRouter Free)',
      'MiniMax M3 (OpenRouter Free)',
      'Inkling (OpenRouter Free)',
      'Inkling Small (OpenRouter Free)',
      'DeepSeek V4 Flash',
      'GLM-5.2',
      'Qwen3.8 Max',
      'Xiaomi MiMo',
      'Mistral Large 3',
      'Laguna S 2.1',
      'Nemotron 3 Ultra'
    ])
    // Every Pi row wears the hue of the BYOK upstream that serves it — a
    // missing accent would silently fall back to the Pi seat slate.
    expect(pi?.models.map((m) => m.accentProvider)).toEqual([
      // `stealth` is the override for OpenRouter's anonymous namespace. Without
      // it the row falls back to the generic OpenRouter red, which a stealth
      // preview must not wear — OpenRouter is not this model's developer.
      // Ahead of it: the Pareto preview reuses `unbiased`, while inclusionAI
      // and Apodex each wear an override minted on 2026-10-04.
      'unbiased',
      'inclusionai',
      'apodex',
      'stealth',
      // Both 2026-09-17 routes wear their own brand override — see
      // PI_UPSTREAM_BRANDS. Unbiased carries a burnt vermilion (its own red is
      // too close to the palette's vivid ones) and TypeSafe the magenta that
      // matches its pink mark; the two swapped on 2026-09-18.
      'unbiased',
      'typesafe',
      // Sakana is its own brand override — without it both Fugu rows fall back
      // to the generic OpenRouter red, which is a DIFFERENT vendor's accent.
      'sakana',
      'sakana',
      // Mercury reuses the Inception override; both Nex rows wear the new
      // nexagi hue rather than falling back to the generic OpenRouter red.
      'inception',
      'nexagi',
      'nexagi',
      'cerebras',
      'cohere',
      'minimax',
      'thinkingmachines',
      'thinkingmachines',
      'deepseek',
      'zai',
      'qwen',
      'xiaomi',
      'mistral',
      'poolside',
      'nvidia'
    ])
    expect(pi?.models.find((m) => m.name === 'Inkling (OpenRouter Free)')?.blurb).toMatch(
      /Off-to-Max.*logged/i
    )
    expect(pi?.models.find((m) => m.name === 'Inkling Small (OpenRouter Free)')?.blurb).toMatch(
      /avoid sensitive data.*logged free endpoint/i
    )
    expect(pi?.models.find((m) => m.name === 'Mercury 2.5 (OpenRouter)')?.blurb).toMatch(
      /260K.*Off-to-Max.*\$0\.20\/\$0\.75/
    )
    expect(pi?.models.find((m) => m.name === 'Nex-N2.5-Pro (OpenRouter Free)')?.blurb).toMatch(
      /262K.*vision.*Off-to-Max/i
    )
    expect(pi?.models.find((m) => m.name === 'Nex-N2.5-Mini (OpenRouter Free)')?.blurb).toMatch(
      /262K.*text only/i
    )
    // "Always-on" is the claim that matters: this route has no Off, and every
    // other reasoning row in the Pi group does.
    expect(pi?.models.find((m) => m.name === 'Space Bunny Alpha (OpenRouter Free)')?.blurb).toMatch(
      /free stealth preview.*1M context.*vision.*always-on Low-to-Max/i
    )
    // Union Alpha's seven-day window was ended early by the user on
    // 2026-09-18, so the row is off the card entirely rather than reworded.
    expect(pi?.models.find((m) => m.name === 'Union Alpha (OpenRouter Free)')).toBeUndefined()
    expect(pi?.models.find((m) => m.name === 'Fugu Max (OpenRouter)')?.blurb).toMatch(
      /1M context.*Off-to-Max.*\$2\/\$6/
    )
    expect(pi?.models.find((m) => m.name === 'Fugu Ultra v2 (OpenRouter)')?.blurb).toMatch(
      /1M.*\$5\/\$30/
    )
    // New Cerebras routes do not resurrect the retired GLM-4.7 announcement.
    expect(pi?.models.map((m) => m.name)).not.toContain('GLM-4.7 (Cerebras)')
    expect(groups.flatMap((g) => g.models.map((m) => m.accentProvider))).not.toContain('openrouter')

    // Muse Glimmer is an Ollama runtime entry even though Meta also has its own
    // provider surface; do not split either new local model into a new group.
    expect(groups.find((g) => g.provider === 'meta')).toBeUndefined()

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
    expect(iosDemoSource).toContain('"provider":"mistral","label":"Mistral","models"')
    expect(iosDemoSource).toContain('"provider":"pi","label":"Pi","models"')
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
