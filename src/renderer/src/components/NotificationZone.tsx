import React, { useCallback, useEffect, useState } from 'react'
import {
  APP_NOTIFICATIONS,
  activeAppNotifications,
  appNotificationDismissKey,
  appNotificationTone,
  type AppNotification,
  type AppNotificationKind
} from '../../../shared/appNotifications'

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

function NotificationCard({
  notification,
  onDismiss
}: {
  notification: AppNotification
  onDismiss: (id: string) => void
}): React.JSX.Element {
  const tone = appNotificationTone(notification.kind)
  return (
    <div className={`notification-card notification-card--${tone}`} role="status">
      <span className="notification-card-icon" aria-hidden>
        {KIND_ICON[notification.kind]}
      </span>
      <p className="notification-card-text">
        <strong>{notification.title}</strong> {notification.body}
      </p>
      {notification.dismissible !== false && (
        <button
          type="button"
          className="notification-card-dismiss"
          onClick={() => onDismiss(notification.id)}
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
  notifications = APP_NOTIFICATIONS
}: {
  notifications?: readonly AppNotification[]
}): React.JSX.Element | null {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readDismissed(notifications))
  const [activeIndex, setActiveIndex] = useState(0)
  const [outgoingIndex, setOutgoingIndex] = useState<number | null>(null)
  const [direction, setDirection] = useState<'next' | 'prev'>('next')

  const active = activeAppNotifications({
    notifications,
    isDismissed: (notification) => dismissedIds.has(notification.id),
    now: Date.now()
  })

  const dismiss = useCallback((id: string): void => {
    try {
      localStorage.setItem(appNotificationDismissKey(id), '1')
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
  }, [])

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

  if (count === 0) return null

  if (count === 1) {
    return (
      <div className="notification-zone">
        <NotificationCard notification={active[0]} onDismiss={dismiss} />
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
    <div className="notification-zone">
      <div className="notification-zone--rotating">
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
        >
          <NotificationCard notification={current} onDismiss={dismiss} />
        </div>
      </div>
      <div className="notification-zone-dots" role="tablist" aria-label="Notifications">
        {active.map((notification, index) => (
          <button
            key={notification.id}
            type="button"
            role="tab"
            className={`notification-zone-dot ${index === safeIndex ? 'is-active' : ''}`}
            aria-selected={index === safeIndex}
            aria-label={`Show notification ${index + 1} of ${count}`}
            onClick={() => goTo(index, index > safeIndex ? 'next' : 'prev')}
          />
        ))}
      </div>
    </div>
  )
}
