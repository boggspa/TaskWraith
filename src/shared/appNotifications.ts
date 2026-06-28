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
  const list = args.notifications ?? APP_NOTIFICATIONS
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

export const APP_NOTIFICATIONS: readonly AppNotification[] = [
  {
    id: 'ollama-ornith-models-2026-06-28',
    kind: 'addition',
    title: 'Ornith local models are available.',
    body: 'Ollama now includes Ornith 1.0 (9B Param) and Ornith 1.0 (35B Param), both 256K-context open-source models for agentic coding, in the model picker and setup commands.',
    dismissible: true
  },
  {
    id: 'scheduled-composer-queue-2026-06-28',
    kind: 'feature',
    title: 'Scheduled sends are visible now.',
    body: 'Use the composer Schedule clock to queue a prompt for later; scheduled rows stay editable, show a live countdown, and dispatch when due.',
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
