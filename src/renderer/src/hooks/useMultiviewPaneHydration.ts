import {
  ChatSurfaceHydrationCoordinator,
  type ChatSurfaceHydrationBindings,
  useChatSurfaceHydration
} from './useChatSurfaceHydration'

/**
 * A pane is a durable owner of a thread, not a viewport onto the app-global
 * current thread. This coordinator keeps visible pane threads resident and
 * hydrates each id independently. Focus never participates in the lifecycle.
 */
export type MultiviewPaneHydrationBindings<TChat> = ChatSurfaceHydrationBindings<TChat>

/** @deprecated Prefer the surface-neutral coordinator for new chat surfaces. */
export class MultiviewPaneHydrationCoordinator<
  TChat
> extends ChatSurfaceHydrationCoordinator<TChat> {}

/**
 * React bridge for one App instance. Bindings are read through a ref so App
 * callback identity churn cannot tear down pane ownership or restart reads.
 */
export function useMultiviewPaneHydration<TChat>(
  chatIds: readonly (string | null | undefined)[],
  bindings: MultiviewPaneHydrationBindings<TChat>
): void {
  useChatSurfaceHydration(chatIds, bindings)
}
