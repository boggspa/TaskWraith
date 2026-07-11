/**
 * App-level notification registry — significant, app/dev-authored notices shown
 * in the reusable notification zone (welcome / new-thread screen + the
 * first-launch onboarding sheet).
 *
 * Node-builtin-free (imported by the renderer; mirrors the discipline of
 * retiredProviders.ts / remoteWorkspaceDefaults.ts) so it can never blank the
 * window. Keep entries SIGNIFICANT — provider deprecation/sunset, a new
 * provider, models added/removed/sunset, or a major shipped feature (e.g. an
 * App Store approval) — not routine changes. Only ONE card shows at a time; the
 * zone rotates through more than one with the welcome heatmap's swipe effect.
 *
 * Carousel layout:
 *   pinned notices (currently just the "New Additions" model-launch card)
 *   up to 2 dynamic highlights rotated daily from CHANGELOG_FEATURE_NOTIFICATION_POOL
 *   (currently empty — repopulate as future shipped features warrant a highlight)
 */

export type AppNotificationKind = 'deprecation' | 'addition' | 'feature' | 'info'

/** Visual tone of a notification card. */
export type AppNotificationTone = 'default' | 'danger'

/** Optional provider accent for model/provider-specific announcement cards. */
export type AppNotificationAccent = 'default' | 'claude' | 'ensemble' | 'cursor' | 'grok'

/** Optional semantic icon override for notices that need a product signpost. */
export type AppNotificationIcon = 'ensemble'

/** One newly-added model under a provider heading in a "New Additions" card. */
export interface AppNotificationModelEntry {
  /** Model display name, e.g. "Sonnet 5". Rendered bold in the provider's hue. */
  name: string
  /** Plain-language blurb (aim for ~120 chars). Rendered in the provider's hue
   *  at normal (non-bold) weight, right after the model name. */
  blurb: string
  /** Optional per-model hue override — the spoofed display-brand provider id
   *  (e.g. 'deep-reinforce', 'liquid') for Ollama-backed models that wear an
   *  upstream brand. Resolves `--provider-<accentProvider>-color`; falls back
   *  to the group's `provider` hue when omitted, so the model name matches its
   *  brand (amber, pink, …) instead of generic Ollama green. */
  accentProvider?: string
}

/** One provider heading + its newly-added models in a "New Additions" card. */
export interface AppNotificationProviderGroup {
  /** Provider id, used to resolve the hue (`--provider-<id>-color`). Kept as a
   *  plain string (not `ProviderId`) so this file stays import-free. */
  provider: string
  /** Provider display label, e.g. "Claude". Rendered bold in the provider's hue. */
  label: string
  models: AppNotificationModelEntry[]
}

export interface AppNotification {
  /** Stable slug — also the dismiss-key suffix. Never reuse an id for new
   *  content (a returning id would resurrect a dismissed notice). */
  id: string
  kind: AppNotificationKind
  /** Short bold lede, e.g. "Local models are available." */
  title: string
  /** One or two sentences of plain copy. Also serves as the accessible/
   *  fallback description when `groups` is present but a consumer doesn't yet
   *  render it (e.g. a not-yet-updated client). */
  body: string
  /** Provider-accented glass/card treatment. Omit for the theme default. */
  accent?: AppNotificationAccent
  /** Semantic icon override. Omit to use the kind icon. */
  icon?: AppNotificationIcon
  /** Default true. A non-dismissible notice stays while it is otherwise active. */
  dismissible?: boolean
  /** Epoch ms after which the notice is no longer shown. Omit = never expires. */
  expiresAt?: number
  /** A pre-existing localStorage dismiss key to also honour, so users who
   *  already dismissed an earlier bespoke banner don't see it again. */
  legacyDismissKey?: string
  /** Structured "New Additions" content: provider headings, each with its own
   *  newly-added models. When present, renderers show this grouped list
   *  instead of the plain `body` paragraph. */
  groups?: AppNotificationProviderGroup[]
}

/** Max changelog-derived cards in the carousel at once (after pinned notices). */
export const CHANGELOG_FEATURE_NOTIFICATION_MAX_ACTIVE = 2

const MS_PER_DAY = 86_400_000

/**
 * Card tone for a kind. Only deprecation/sunset notices are RED; every other
 * kind uses the theme-default card (contrast-aware text + shiny accent rim).
 */
export function appNotificationTone(kind: AppNotificationKind): AppNotificationTone {
  return kind === 'deprecation' ? 'danger' : 'default'
}

export function appNotificationAccent(notification: AppNotification): AppNotificationAccent {
  return notification.accent ?? 'default'
}

/** localStorage key a dismissed notice is recorded under (value '1'). */
export function appNotificationDismissKey(id: string): string {
  return `taskwraith.appNotification.${id}.dismissed`
}

/**
 * The notices active right now: not expired and (unless non-dismissible) not
 * dismissed, in registry order. Pure — `isDismissed` and `now` are injected so
 * the filter is unit-testable without localStorage or a clock.
 */
export function activeAppNotifications(args: {
  isDismissed: (notification: AppNotification) => boolean
  now: number
  notifications?: readonly AppNotification[]
}): AppNotification[] {
  const list = args.notifications ?? resolveAppNotifications(args.now)
  return list.filter((notification) => {
    if (typeof notification.expiresAt === 'number' && notification.expiresAt <= args.now) {
      return false
    }
    if (notification.dismissible !== false && args.isDismissed(notification)) {
      return false
    }
    return true
  })
}

/** Stable id for the current "New Additions" card — bump the date suffix (and
 *  never reuse this exact id) when the lineup below changes, so a user who
 *  already dismissed the old lineup sees the refreshed one. */
export const NEW_ADDITIONS_NOTIFICATION_ID = 'new-additions-2026-07-10'

/** Always-on carousel notices. Currently just the "New Additions" model-launch
 *  card — replace/extend this list the next time a significant provider or
 *  model change warrants a pinned notice. */
export const PINNED_APP_NOTIFICATIONS: readonly AppNotification[] = [
  {
    id: NEW_ADDITIONS_NOTIFICATION_ID,
    kind: 'addition',
    title: 'New Additions',
    body: 'Claude Sonnet 5 and Fable 5, the GPT-5.6 Luna/Terra/Sol trio, Cursor Grok 4.5, Grok 4.5 Fast, and four new local Ollama models are all available now.',
    dismissible: true,
    groups: [
      {
        provider: 'claude',
        label: 'Claude',
        models: [
          {
            name: 'Sonnet 5',
            blurb:
              "Anthropic's fast coding model — adaptive thinking, 1M context, 85.2% SWE-bench Verified."
          },
          {
            name: 'Fable 5',
            blurb:
              "Anthropic's frontier tier above Opus — 1M context, 128K max output, and adaptive thinking."
          }
        ]
      },
      {
        provider: 'codex',
        label: 'Codex',
        // Official GA metadata (2026-07-09): 1M+ raw context on all three,
        // Max on all three, and the Ultra tier on Sol + Terra.
        models: [
          {
            name: 'GPT-5.6-Luna',
            blurb: 'Fast and affordable agentic coding — with the Max reasoning tier.'
          },
          {
            name: 'GPT-5.6-Terra',
            blurb: 'Balanced agentic coding for everyday work — Max and Ultra reasoning tiers.'
          },
          {
            name: 'GPT-5.6-Sol',
            blurb: 'Latest frontier agentic coding model — Max and Ultra reasoning tiers.'
          }
        ]
      },
      {
        provider: 'cursor',
        label: 'Cursor',
        models: [
          {
            name: 'Cursor Grok 4.5',
            blurb:
              "Cursor's first-party model pool — 500K context, Low/Medium/High reasoning, and a Fast toggle."
          }
        ]
      },
      {
        provider: 'grok',
        label: 'Grok',
        models: [
          {
            name: 'Grok 4.5 Fast',
            blurb:
              "xAI's 500K-context coding model behind Grok Build, with Low/Medium/High reasoning."
          }
        ]
      },
      {
        provider: 'ollama',
        label: 'Ollama',
        models: [
          {
            name: 'Deep Reinforce - Ornith 9B + Ornith 35B',
            blurb: 'Open-source 262K-context coding models — local inference.',
            accentProvider: 'deep-reinforce'
          },
          {
            name: 'Liquid - LFM 2.5 8B-A1B',
            blurb: 'A 131K-context local tool/thinking model for agentic coding — local inference.',
            accentProvider: 'liquid'
          },
          {
            name: 'Poolside - Laguna XS 2.1 33B-A3B Q8',
            blurb:
              'A 262K-context local coding model with tool use and thinking — local inference.',
            accentProvider: 'poolside'
          }
        ]
      }
    ]
  }
]

/**
 * Curated highlights from recent CHANGELOG entries. Up to
 * CHANGELOG_FEATURE_NOTIFICATION_MAX_ACTIVE are surfaced at a time; the slice
 * rotates daily so repeat visits see different shipped features without
 * growing the carousel without bound. Currently empty — repopulate as future
 * shipped features warrant a rotating highlight.
 */
export const CHANGELOG_FEATURE_NOTIFICATION_POOL: readonly AppNotification[] = []

/** Pick up to `maxCount` changelog highlights, rotating the window daily. */
export function selectChangelogFeatureNotifications(
  pool: readonly AppNotification[] = CHANGELOG_FEATURE_NOTIFICATION_POOL,
  now: number,
  maxCount: number = CHANGELOG_FEATURE_NOTIFICATION_MAX_ACTIVE
): AppNotification[] {
  const eligible = pool.filter(
    (notification) => typeof notification.expiresAt !== 'number' || notification.expiresAt > now
  )
  if (eligible.length === 0 || maxCount <= 0) return []
  if (eligible.length <= maxCount) return [...eligible]
  const dayIndex = Math.floor(now / MS_PER_DAY)
  const start = dayIndex % eligible.length
  const picked: AppNotification[] = []
  for (let offset = 0; offset < maxCount; offset += 1) {
    picked.push(eligible[(start + offset) % eligible.length])
  }
  return picked
}

/** Full carousel registry at `now` — pinned notices first, then dynamic changelog picks. */
export function resolveAppNotifications(now: number = Date.now()): readonly AppNotification[] {
  return [
    ...PINNED_APP_NOTIFICATIONS,
    ...selectChangelogFeatureNotifications(CHANGELOG_FEATURE_NOTIFICATION_POOL, now)
  ]
}

/** Snapshot at module load — prefer resolveAppNotifications(now) for live rotation. */
export const APP_NOTIFICATIONS: readonly AppNotification[] = resolveAppNotifications(0)
