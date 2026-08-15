/**
 * composerSurfaceRequest — the one-way channel a slash command uses to open a
 * composer surface that owns its own popover state.
 *
 * The icon row under the composer (`.composer-telemetry-cluster`) is a set of
 * self-contained buttons: each holds a private `open` useState and positions
 * its own portal. A slash command's `run()` closure is built at the App level
 * and cannot reach into that state, so `/plan`, `/blackboard`, `/canvas`,
 * `/schedule` and a bare `/multiview` publish a REQUEST instead — a
 * `{ surface, nonce }` pair the owning component observes.
 *
 * The nonce is what makes it a request rather than a mode: two consecutive
 * `/plan` invocations differ, so the effect re-fires even though the surface id
 * is unchanged. Consumers must therefore key their effect on the nonce, never
 * on the surface id alone.
 *
 * ONLY the main composer receives a live request object. Multiview panes and
 * the linked-chat composer are handed `null` and redirect through
 * `preserveSlashDraftForFocusedFlow` instead — a shared App-level signal would
 * otherwise fan out to every mounted `<Composer>` and open the popover in all
 * of them at once, which is exactly the per-pane misattribution
 * `SlashCommandRunContext` exists to prevent.
 */

export const COMPOSER_SURFACE_IDS = [
  'terminal',
  'plan',
  'blackboard',
  'canvas',
  'multiview',
  'schedule'
] as const

export type ComposerSurfaceId = (typeof COMPOSER_SURFACE_IDS)[number]

export interface ComposerSurfaceRequest {
  surface: ComposerSurfaceId
  /** Strictly increasing; distinguishes a repeat request for the same surface. */
  nonce: number
}

/**
 * Advance a request. Pass the previous request (or null on the first call) and
 * the surface to open. The nonce keeps climbing across surfaces so a consumer
 * can never mistake "someone else's surface was requested" for "mine was
 * requested again".
 */
export function nextComposerSurfaceRequest(
  previous: ComposerSurfaceRequest | null | undefined,
  surface: ComposerSurfaceId
): ComposerSurfaceRequest {
  return { surface, nonce: (previous?.nonce ?? 0) + 1 }
}

/**
 * The value a surface should pass to its own `openSignal` prop: the request's
 * nonce when the request names that surface, and 0 otherwise.
 *
 * 0 is the inert value — it is never a legitimate nonce (they start at 1), so a
 * consumer can guard with a plain falsy check and will not open on mount.
 */
export function composerSurfaceOpenSignal(
  request: ComposerSurfaceRequest | null | undefined,
  surface: ComposerSurfaceId
): number {
  if (!request || request.surface !== surface) return 0
  return request.nonce > 0 ? request.nonce : 0
}
