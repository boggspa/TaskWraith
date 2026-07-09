import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  activeAppNotifications,
  resolveAppNotifications,
  appNotificationDismissKey,
  appNotificationAccent,
  appNotificationTone,
  type AppNotification,
  type AppNotificationKind,
  type AppNotificationProviderGroup
} from '../../../shared/appNotifications'
import { ProviderGlyph } from './icons/ProviderGlyph'

/**
 * Reusable notification zone — the app/dev "notification area" on the welcome /
 * new-thread screen and the first-launch sheet. Renders at most ONE card at a
 * time; when more than one notice is active it rotates through them with the
 * same swipe/wipe transition the welcome heatmaps use (auto every 90s, plus
 * clickable dots). Deprecation/sunset notices are red; everything else is a
 * theme-default card with a shiny accent rim. Renders nothing (zero DOM) when
 * there are no active notices, so it never disturbs the surrounding layout.
 *
 * Dismissal persists in localStorage (renderer-only), shared across both
 * surfaces — matching the bespoke banner it replaces.
 */

const SWIPE_MS = 320
const ROTATE_MS = 90_000
/** Recompute active notices on this cadence so `expiresAt` entries drop in-session. */
export const NOTIFICATION_ACTIVE_REFRESH_MS = 60_000
const DRAG_THRESHOLD_PX = 48
const DRAG_AXIS_RATIO = 1.15
const DISMISSED_EVENT = 'taskwraith:app-notification-dismissed'

const KIND_ICON: Record<AppNotificationKind, string> = {
  deprecation: 'ⓘ',
  addition: '✦',
  feature: '★',
  info: 'ⓘ'
}

function readDismissed(notifications: readonly AppNotification[]): Set<string> {
  const dismissed = new Set<string>()
  for (const notification of notifications) {
    try {
      if (localStorage.getItem(appNotificationDismissKey(notification.id)) === '1') {
        dismissed.add(notification.id)
      } else if (
        notification.legacyDismissKey &&
        localStorage.getItem(notification.legacyDismissKey) === '1'
      ) {
        dismissed.add(notification.id)
      }
    } catch {
      // Storage unavailable (private mode etc.) — treat as not dismissed.
    }
  }
  return dismissed
}

function isInteractiveSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest('button, a, input, textarea, select, [role="button"], [data-swipe-ignore="true"]')
  )
}

export function notificationDirectionForDrag(
  deltaX: number,
  deltaY: number,
  thresholdPx = DRAG_THRESHOLD_PX
): 'next' | 'prev' | null {
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)
  if (absX < thresholdPx || absX < absY * DRAG_AXIS_RATIO) return null
  return deltaX < 0 ? 'prev' : 'next'
}

interface NotificationDragState {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
}

function NotificationGroups({
  groups
}: {
  groups: readonly AppNotificationProviderGroup[]
}): React.JSX.Element {
  return (
    <div className="notification-newadditions-groups">
      {groups.map((group) => (
        <div key={group.provider} className="notification-newadditions-group">
          <div className={`notification-newadditions-provider provider-${group.provider}`}>
            {group.label}
          </div>
          <ul className="notification-newadditions-models">
            {group.models.map((model) => (
              <li key={model.name} className="notification-newadditions-model-row">
                <span className={`notification-newadditions-model provider-${group.provider}`}>
                  {model.name}
                </span>{' '}
                <span className={`notification-newadditions-blurb provider-${group.provider}`}>
                  - {model.blurb}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function NotificationCard({
  notification,
  onDismiss
}: {
  notification: AppNotification
  onDismiss: (id: string) => void
}): React.JSX.Element {
  const tone = appNotificationTone(notification.kind)
  const accent = appNotificationAccent(notification)
  const groups = notification.groups
  return (
    <div
      className={`notification-card notification-card--${tone} notification-card--accent-${accent}`}
      role="status"
    >
      <span className="notification-card-icon" aria-hidden>
        {notification.icon === 'ensemble' ? (
          <ProviderGlyph provider="ensemble" />
        ) : (
          KIND_ICON[notification.kind]
        )}
      </span>
      {groups && groups.length > 0 ? (
        <div className="notification-card-text">
          <strong>{notification.title}</strong>
          <NotificationGroups groups={groups} />
        </div>
      ) : (
        <p className="notification-card-text">
          <strong>{notification.title}</strong> {notification.body}
        </p>
      )}
      {notification.dismissible !== false && (
        <button
          type="button"
          className="notification-card-dismiss"
          data-swipe-ignore="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onDismiss(notification.id)
          }}
          aria-label={`Dismiss notification: ${notification.title}`}
          title="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  )
}

export function NotificationZone({
  notifications,
  /** Inject for tests; production ticks every minute so timed notices expire. */
  now: nowOverride
}: {
  notifications?: readonly AppNotification[]
  now?: number
}): React.JSX.Element | null {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() =>
    readDismissed(notifications ?? resolveAppNotifications(nowOverride ?? Date.now()))
  )
  const [activeIndex, setActiveIndex] = useState(0)
  const [outgoingIndex, setOutgoingIndex] = useState<number | null>(null)
  const [direction, setDirection] = useState<'next' | 'prev'>('next')
  const [isDragging, setIsDragging] = useState(false)
  const [now, setNow] = useState(() => nowOverride ?? Date.now())
  const dragStateRef = useRef<NotificationDragState | null>(null)

  const resolvedNotifications = useMemo(
    () => notifications ?? resolveAppNotifications(now),
    [notifications, now]
  )

  useEffect(() => {
    if (nowOverride !== undefined) {
      setNow(nowOverride)
      return
    }
    const id = window.setInterval(() => setNow(Date.now()), NOTIFICATION_ACTIVE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [nowOverride])

  const refreshDismissed = useCallback((): void => {
    setDismissedIds(readDismissed(resolvedNotifications))
  }, [resolvedNotifications])

  useEffect(() => {
    refreshDismissed()
  }, [refreshDismissed])

  useEffect(() => {
    const legacyDismissKeys = new Set(
      resolvedNotifications
        .map((notification) => notification.legacyDismissKey)
        .filter((key): key is string => Boolean(key))
    )
    const handleDismissed = (event: Event): void => {
      const id = event instanceof CustomEvent ? event.detail?.id : null
      if (typeof id !== 'string') {
        refreshDismissed()
        return
      }
      setDismissedIds((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        return next
      })
      setOutgoingIndex(null)
      setActiveIndex(0)
      setIsDragging(false)
      dragStateRef.current = null
    }
    const handleStorage = (event: StorageEvent): void => {
      if (!event.key) return
      if (
        event.key.startsWith('taskwraith.appNotification.') ||
        legacyDismissKeys.has(event.key)
      ) {
        refreshDismissed()
      }
    }
    window.addEventListener(DISMISSED_EVENT, handleDismissed)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(DISMISSED_EVENT, handleDismissed)
      window.removeEventListener('storage', handleStorage)
    }
  }, [resolvedNotifications, refreshDismissed])

  const active = activeAppNotifications({
    notifications: resolvedNotifications,
    isDismissed: (notification) => dismissedIds.has(notification.id),
    now
  })

  const dismiss = useCallback(
    (id: string): void => {
      const notification = resolvedNotifications.find((candidate) => candidate.id === id)
      try {
        localStorage.setItem(appNotificationDismissKey(id), '1')
        if (notification?.legacyDismissKey) {
          localStorage.setItem(notification.legacyDismissKey, '1')
        }
      } catch {
        // Cosmetic notice — acceptable if dismissal can't persist.
      }
      setDismissedIds((prev) => {
        const next = new Set(prev)
        next.add(id)
        return next
      })
      // The active list just shrank — collapse any in-flight swipe and re-anchor.
      setOutgoingIndex(null)
      setActiveIndex(0)
      setIsDragging(false)
      dragStateRef.current = null
      window.dispatchEvent(new CustomEvent(DISMISSED_EVENT, { detail: { id } }))
    },
    [resolvedNotifications]
  )

  const goTo = useCallback(
    (target: number, dir: 'next' | 'prev'): void => {
      setActiveIndex((current) => {
        if (target === current) return current
        setDirection(dir)
        setOutgoingIndex(current)
        return target
      })
    },
    []
  )

  const count = active.length
  const goRelative = useCallback(
    (delta: 1 | -1): void => {
      if (count <= 1) return
      const nextIndex = (Math.min(activeIndex, count - 1) + delta + count) % count
      goTo(nextIndex, delta > 0 ? 'next' : 'prev')
    },
    [activeIndex, count, goTo]
  )

  // Auto-rotate every 90s while more than one notice is active. activeIndex is
  // in the dep array (like the welcome heatmap) so a manual jump resets the timer.
  useEffect(() => {
    if (count <= 1) return
    const id = window.setInterval(() => {
      goTo((activeIndex + 1) % count, 'next')
    }, ROTATE_MS)
    return () => window.clearInterval(id)
  }, [count, activeIndex, goTo])

  // Clear the outgoing pane once its swipe-out animation has finished.
  useEffect(() => {
    if (outgoingIndex === null) return
    const id = window.setTimeout(() => setOutgoingIndex(null), SWIPE_MS)
    return () => window.clearTimeout(id)
  }, [outgoingIndex])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (count <= 1) return
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (isInteractiveSwipeTarget(event.target)) return
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY
      }
      setIsDragging(false)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Best-effort only: pointer capture may be unavailable in older WebViews.
      }
    },
    [count]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragStateRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      drag.lastX = event.clientX
      drag.lastY = event.clientY
      if (
        !isDragging &&
        notificationDirectionForDrag(drag.lastX - drag.startX, drag.lastY - drag.startY, 12)
      ) {
        setIsDragging(true)
      }
    },
    [isDragging]
  )

  const clearPointerDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || drag.pointerId !== event.pointerId) return null
    dragStateRef.current = null
    setIsDragging(false)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Pointer capture release is best-effort for the same reason as capture.
    }
    return drag
  }, [])

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = clearPointerDrag(event)
      if (!drag) return
      const nextDirection = notificationDirectionForDrag(
        drag.lastX - drag.startX,
        drag.lastY - drag.startY
      )
      if (!nextDirection) return
      event.preventDefault()
      goRelative(nextDirection === 'next' ? 1 : -1)
    },
    [clearPointerDrag, goRelative]
  )

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      clearPointerDrag(event)
    },
    [clearPointerDrag]
  )

  // Re-anchor if the active list shrank out from under activeIndex without a
  // dismiss (e.g. a timed notice expired). safeIndex already clamps the render;
  // this keeps activeIndex itself valid so the rotation tick can't no-op.
  useEffect(() => {
    if (activeIndex > count - 1) setActiveIndex(0)
  }, [count, activeIndex])

  if (count === 0) return null

  if (count === 1) {
    return (
      <div className="notification-zone">
        <div aria-live="polite" aria-atomic="true">
          <NotificationCard notification={active[0]} onDismiss={dismiss} />
        </div>
      </div>
    )
  }

  const safeIndex = Math.min(activeIndex, count - 1)
  const current = active[safeIndex]
  const outgoing =
    outgoingIndex !== null && outgoingIndex !== safeIndex && outgoingIndex < count
      ? active[outgoingIndex]
      : null

  return (
    <div
      className={`notification-zone is-swipe-enabled${isDragging ? ' is-dragging' : ''}`}
    >
      <div
        className="notification-zone--rotating"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <button
          type="button"
          className="notification-zone-nav notification-zone-nav--prev"
          data-swipe-ignore="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            goRelative(-1)
          }}
          aria-label="Show previous notification"
          title="Previous notification"
        >
          ‹
        </button>
        {outgoing && (
          <div
            className={`notification-zone-pane is-outgoing ${
              direction === 'next' ? 'to-right' : 'to-left'
            }`}
            aria-hidden
          >
            <NotificationCard notification={outgoing} onDismiss={dismiss} />
          </div>
        )}
        <div
          className={`notification-zone-pane ${
            outgoing
              ? `is-incoming ${direction === 'next' ? 'from-left' : 'from-right'}`
              : 'is-active'
          }`}
          aria-live="polite"
          aria-atomic="true"
          aria-label={`Notification ${safeIndex + 1} of ${count}`}
        >
          <NotificationCard notification={current} onDismiss={dismiss} />
        </div>
        <button
          type="button"
          className="notification-zone-nav notification-zone-nav--next"
          data-swipe-ignore="true"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            goRelative(1)
          }}
          aria-label="Show next notification"
          title="Next notification"
        >
          ›
        </button>
      </div>
      <div className="notification-zone-dots" role="group" aria-label="Notifications">
        {active.map((notification, index) => (
          <button
            key={notification.id}
            type="button"
            className={`notification-zone-dot ${index === safeIndex ? 'is-active' : ''}`}
            data-swipe-ignore="true"
            aria-current={index === safeIndex ? 'true' : undefined}
            aria-label={`Show notification ${index + 1} of ${count}`}
            onClick={() => goTo(index, index > safeIndex ? 'next' : 'prev')}
          />
        ))}
      </div>
    </div>
  )
}
