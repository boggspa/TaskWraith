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
export const NEW_ADDITIONS_NOTIFICATION_ID = 'new-additions-2026-08-23'

/** Always-on carousel notices. Currently just the "New Additions" model-launch
 *  card — replace/extend this list the next time a significant provider or
 *  model change warrants a pinned notice. */
export const PINNED_APP_NOTIFICATIONS: readonly AppNotification[] = [
  {
    id: NEW_ADDITIONS_NOTIFICATION_ID,
    kind: 'addition',
    title: 'New Additions',
    // Fallback / a11y only — renderers with `groups` show the structured list.
    body: 'AntiGravity Gemini 3.7 Flash, Sonnet 4.6, Opus 4.6, and GPT-OSS-120B, Grok 4.6 in Grok and Cursor, Devstral Small and Mistral 3.5 Medium, Muse Spark 1.2, Pi BYOK models via DeepSeek, Z.ai, Qwen, Mistral, and others, and local Ollama Gemma 4 (31B-MLX) / Qwen 3.8 / Muse Glimmer / Nemotron 3.5 Lightning / North Mini Code / GLM-4.7-Flash / Rnj-1, plus the new Mistral lineup: Mistral 3, Mistral 3.1, Mistral Medium (Latest), Mistral Large 3, Mistral Small 4, Devstral 2, Leanstral 1.5 (Labs), GLM-5.2 via Mistral, Codestral (Aug 2025), and Ministral 3.'
    dismissible: true,
    groups: [
      {
        provider: 'antigravity',
        label: 'AntiGravity',
        models: [
          {
            name: 'Gemini 3.7 Flash',
            blurb:
              'The newest Flash family, with Low, Medium, and High reasoning in the official agy CLI.'
          },
          {
            name: 'Sonnet 4.6',
            blurb: 'A top-tier model with better long-form reasoning and coding context.'
          },
          {
            name: 'Opus 4.6',
            blurb: 'A premium reasoning model tuned for nuanced instruction following.'
          },
          {
            name: 'GPT-OSS-120B',
            blurb: 'OpenAI 120B OSS model with broad capability and strong tool use.'
          }
        ]
      },
      {
        provider: 'grok',
        label: 'Grok',
        models: [
          {
            name: 'Grok 4.6 Fast',
            blurb: 'The new 500K default with Low through Extra High reasoning in Grok Build.'
          }
        ]
      },
      {
        provider: 'cursor',
        label: 'Cursor',
        models: [
          {
            name: 'Grok 4.6',
            blurb:
              'A 256K Cursor model with Low through Extra High reasoning and Standard/Fast modes.'
          }
        ]
      },
      {
        provider: 'muse',
        label: 'Muse',
        models: [
          {
            name: 'Muse Spark 1.2',
            blurb: 'Muse Code CLI over Meta Model API — 1M context at $1.25/$4.25 per Mtok.'
          }
        ]
      },
      {
        provider: 'mistral',
        label: 'Mistral',
        models: [
          {
            name: 'Devstral Small',
            blurb:
              'New configurable Effort options for a faster, lower-cost default or deeper reasoning.'
          },
          {
            name: 'Mistral 3.5 Medium',
            blurb:
              'Configurable Effort tuning now available, balancing latency and reasoning depth.'
          },
          {
            name: 'Mistral Large 3',
            blurb: 'A flagship-sized 262K context model tuned for deeper planning and coding tasks.'
          },
          {
            name: 'Mistral Medium (Latest)',
            blurb: 'Current Mistral Medium flagship with stronger context and balanced latency.'
          },
          {
            name: 'Mistral Medium 3.1',
            blurb: 'Mistral Medium 3.1 extends the medium family with a refreshed default profile.'
          },
          {
            name: 'Mistral Medium 3',
            blurb: 'Legacy Mistral Medium 3 keeps strong performance in a lighter-cost package.'
          },
          {
            name: 'Mistral Small 4',
            blurb:
              'Mistral Small 4 expands tool and reasoning coverage while staying cost-efficient.'
          },
          {
            name: 'Devstral 2',
            blurb:
              'A faster default path with broader instruction coverage and lower per-token cost.'
          },
          {
            name: 'Leanstral 1.5 (Labs)',
            blurb: 'Leanstral 1.5 (Labs) is a research-focused experimental reasoning update.'
          },
          {
            name: 'GLM-5.2 (via Mistral)',
            blurb: 'GLM-5.2 (via Mistral) introduces a 1M context lane for heavier prompts.'
          },
          {
            name: 'Codestral (Aug 2025)',
            blurb:
              'Codestral (Aug 2025) is a Mistral codespace model with updated quality and tuning.'
          },
          {
            name: 'Ministral 3 (14B)',
            blurb:
              'Ministral 3 (14B) balances throughput and coding depth on the same family stack.'
          },
          {
            name: 'Ministral 3 (8B)',
            blurb: 'Ministral 3 (8B) keeps the same family strengths in a smaller profile.'
          },
          {
            name: 'Ministral 3 (3B)',
            blurb: 'Ministral 3 (3B) is the compact variant for lighter tasks and lower cost.'
          }
        ]
      },
      {
        // Curated local tags wear their upstream brand hue via accentProvider
        // (shared/ollamaBrandTable). The Ollama heading stays Ollama green.
        provider: 'ollama',
        label: 'Ollama',
        models: [
          {
            name: 'Gemma 4 (31B-MLX)',
            blurb: 'Google Gemma 4 31B-MLX through Ollama, with 262K context and tooling support.',
            accentProvider: 'google'
          },
          {
            name: 'Qwen 3.8 (27B-MLX)',
            blurb:
              "Alibaba's 27B MLX multimodal agent with tools, thinking, and 262K context (Ollama 0.32.12+).",
            accentProvider: 'qwen'
          },
          {
            name: 'Muse Glimmer (30B-MLX)',
            blurb:
              "Meta's 30B multimodal agent model with vision, tools, thinking, and failure recovery (131K).",
            accentProvider: 'meta'
          },
          {
            name: 'Nemotron 3.5 Lightning (30B-MLX)',
            blurb:
              "NVIDIA's 30B-A3B always-on agent model with tools, thinking, and a 262K context window.",
            accentProvider: 'nvidia'
          },
          {
            name: 'North Mini Code 1.0',
            blurb: "Cohere's 500K agentic coder with tools and thinking — local, no cloud account.",
            accentProvider: 'cohere'
          },
          {
            name: 'GLM-4.7-Flash',
            blurb: 'Z.ai 30B-A3B local reasoner with tools and thinking (~203K).',
            accentProvider: 'zai'
          },
          {
            name: 'Rnj-1',
            blurb: "Essential AI's 8B agentic coding model with native tools.",
            accentProvider: 'essential'
          }
        ]
      },
      {
        // Curated Pi BYOK models wear their upstream brand hue via accentProvider
        // (shared/piBrandTable). The Pi heading stays Pi slate.
        provider: 'pi',
        label: 'Pi',
        models: [
          {
            name: 'DeepSeek V4 Flash',
            blurb: 'DeepSeek V4 Flash via Pi — with reasoning tiers and strong coding performance.',
            accentProvider: 'deepseek'
          },
          {
            name: 'GLM-5.2',
            blurb: 'Z.ai GLM-5.2 via Pi — 1M context with broad capability and strong reasoning.',
            accentProvider: 'zai'
          },
          {
            name: 'Qwen3.8 Max Preview',
            blurb: 'Qwen3.8 Max Preview via Pi — cutting-edge multimodal reasoning from Alibaba.',
            accentProvider: 'qwen'
          },
          {
            name: 'Mistral Large 3',
            blurb: 'Mistral Large 3 via Pi — 262K context for deep planning and complex tasks.',
            accentProvider: 'mistral'
          },
          {
            name: 'GLM-4.7 (Cerebras)',
            blurb: 'GLM-4.7 served via Cerebras on Pi — fast inference with a 262K context window.',
            accentProvider: 'cerebras'
          },
          {
            name: 'Laguna S 2.1',
            blurb: 'Poolside Laguna S 2.1 via Pi — a high-performance reasoning model from Poolside.',
            accentProvider: 'poolside'
          },
          {
            name: 'Nemotron 3 Ultra',
            blurb: 'NVIDIA Nemotron 3 Ultra via Pi — a massive 550B parameter model for enterprise tasks.',
            accentProvider: 'nvidia'
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
