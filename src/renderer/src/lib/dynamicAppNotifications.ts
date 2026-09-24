import type { AppNotification } from '../../../shared/appNotifications'

/**
 * Session-scoped notices that app state publishes into the NotificationZone
 * beside the static registry in shared/appNotifications.ts. Today's producer
 * is the execution-graph diagnostics snapshot (App.tsx); the zone subscribes
 * through useSyncExternalStore and merges these ahead of the registry cards.
 *
 * Kept as a module store rather than props because the zone is mounted deep
 * inside Composer and FirstLaunchSheet, neither of which should learn about
 * every producer. Notices are data plus one optional handler: the registry
 * type stays serializable for the remote first-launch projection.
 */
export interface DynamicAppNotification extends AppNotification {
  /** Invoked with the pressed action's id (one of `actions`). */
  onAction?: (actionId: string) => void
}

let current: readonly DynamicAppNotification[] = Object.freeze([])
const listeners = new Set<() => void>()

/** Replace the published set. Publishing an empty set over an empty set is a no-op. */
export function publishDynamicAppNotifications(next: readonly DynamicAppNotification[]): void {
  if (next === current) return
  if (next.length === 0 && current.length === 0) return
  current = Object.freeze([...next])
  for (const listener of listeners) listener()
}

/** Stable between publishes, as useSyncExternalStore requires of a snapshot. */
export function readDynamicAppNotifications(): readonly DynamicAppNotification[] {
  return current
}

export function subscribeDynamicAppNotifications(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget every published notice and listener. */
export function resetDynamicAppNotificationsForTests(): void {
  current = Object.freeze([])
  listeners.clear()
}
