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
 *   1–2 pinned notices (local models + AntiGravity policy)
 *   up to 2 dynamic highlights rotated daily from CHANGELOG_FEATURE_NOTIFICATION_POOL
 */

export type AppNotificationKind = 'deprecation' | 'addition' | 'feature' | 'info'

/** Visual tone of a notification card. */
export type AppNotificationTone = 'default' | 'danger'

export interface AppNotification {
  /** Stable slug — also the dismiss-key suffix. Never reuse an id for new
   *  content (a returning id would resurrect a dismissed notice). */
  id: string
  kind: AppNotificationKind
  /** Short bold lede, e.g. "Local models are available." */
  title: string
  /** One or two sentences of plain copy. */
  body: string
  /** Default true. A non-dismissible notice stays while it is otherwise active. */
  dismissible?: boolean
  /** Epoch ms after which the notice is no longer shown. Omit = never expires. */
  expiresAt?: number
  /** A pre-existing localStorage dismiss key to also honour, so users who
   *  already dismissed an earlier bespoke banner don't see it again. */
  legacyDismissKey?: string
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

/** Always-on carousel notices — new local models + AntiGravity policy. */
export const PINNED_APP_NOTIFICATIONS: readonly AppNotification[] = [
  {
    id: 'ollama-local-models-2026-06-30',
    kind: 'addition',
    title: 'New local Ollama models are available.',
    body: 'Ollama now includes Ornith 1.0 (9B Param) and Ornith 1.0 (35B Param), 256K-context open-source models for agentic coding, plus Liquid LFM 2.5 (8B-1A), a 131K-context tool/thinking model — all in the model picker and setup commands.',
    dismissible: true
  },
  {
    id: 'antigravity-not-planned-2026-06-26',
    kind: 'info',
    title: 'AntiGravity will not be added.',
    body: 'TaskWraith will not integrate Google AntiGravity as a Gemini replacement because it would require unsupported credential use and would not fit TaskWraith’s provider model.',
    dismissible: true
  }
]

/**
 * Curated highlights from recent CHANGELOG entries. Up to
 * CHANGELOG_FEATURE_NOTIFICATION_MAX_ACTIVE are surfaced at a time; the slice
 * rotates daily so repeat visits see different shipped features without
 * growing the carousel without bound.
 */
export const CHANGELOG_FEATURE_NOTIFICATION_POOL: readonly AppNotification[] = [
  {
    id: 'changelog-scheduled-queue-2026-06-28',
    kind: 'feature',
    title: 'Scheduled sends are visible now.',
    body: 'Use the composer Schedule clock to queue a prompt for later; scheduled rows stay editable, show a live countdown, and dispatch when due.'
  },
  {
    id: 'changelog-model-usage-matrix-2026-06-28',
    kind: 'feature',
    title: 'Model usage by workspace is here.',
    body: 'Settings → Model Usage now breaks down provider/model spend and diffs per workspace, alongside the existing aggregate table.'
  },
  {
    id: 'changelog-chat-search-2026-06-28',
    kind: 'feature',
    title: 'Search and jump inside long threads.',
    body: 'Current-chat search plus transcript gutter controls help you move between user prompts without scrolling entire conversations.'
  },
  {
    id: 'changelog-tailscale-relay-2026-06-28',
    kind: 'feature',
    title: 'Tailscale relay setup is easier on iOS.',
    body: 'The iOS bridge now surfaces this Mac’s detected wss:// relay door with Use this, Copy, and Test actions for cellular pairing.'
  }
]

/** Pick up to `maxCount` changelog highlights, rotating the window daily. */
export function selectChangelogFeatureNotifications(
  pool: readonly AppNotification[] = CHANGELOG_FEATURE_NOTIFICATION_POOL,
  now: number,
  maxCount: number = CHANGELOG_FEATURE_NOTIFICATION_MAX_ACTIVE
): AppNotification[] {
  const eligible = pool.filter(
    (notification) =>
      typeof notification.expiresAt !== 'number' || notification.expiresAt > now
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
