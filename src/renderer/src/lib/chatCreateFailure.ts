/**
 * Chat creation is dispatched fire-and-forget from several renderer surfaces —
 * the sidebar "+ New" menu types `onNewChat` as `=> void` and discards what it
 * returns — so a rejected create used to vanish completely and reach the user
 * as a menu item that simply did nothing, with no error anywhere.
 *
 * `guardChatCreate` keeps those call sites fire-and-forget while making the
 * failure impossible to lose: the rejection is always handled (never an
 * unhandled rejection) and always names the surface that failed.
 */

/** Reports a create failure. Swapped in tests; console in the app. */
export type ChatCreateFailureReporter = (surface: string, error: unknown) => void

const defaultReporter: ChatCreateFailureReporter = (surface, error) => {
  console.error(`[new-chat] ${surface} could not create a chat:`, error)
}

/**
 * Attach failure reporting to a fire-and-forget chat create.
 *
 * `result` is whatever the create call returned — a promise, or nothing at all
 * for a surface whose prop type discards it. A non-promise is a no-op, so a
 * synchronous surface costs nothing.
 */
export function guardChatCreate(
  surface: string,
  result: unknown,
  reporter: ChatCreateFailureReporter = defaultReporter
): void {
  if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') return
  void Promise.resolve(result).catch((error) => {
    reporter(surface, error)
  })
}
