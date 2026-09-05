import { useEffect, useState, type ReactNode } from 'react'

const ageTickListeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    ageTickListeners.forEach((listener) => listener())
  }, 60000)
}
export function subscribeAgeTick(listener: () => void): () => void {
  ageTickListeners.add(listener)
  return () => {
    ageTickListeners.delete(listener)
  }
}

export function ChatAgeLabel({ timestamp }: { timestamp: number }): ReactNode {
  const [label, setLabel] = useState(() =>
    Number.isFinite(timestamp) ? formatChatAge(timestamp, Date.now()) : ''
  )

  useEffect(() => {
    if (!Number.isFinite(timestamp)) {
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) setLabel((prev) => (prev === '' ? prev : ''))
      })
      return () => {
        cancelled = true
      }
    }
    const compute = () => formatChatAge(timestamp, Date.now())
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLabel((prev) => {
        const next = compute()
        return prev === next ? prev : next
      })
    })
    const unsubscribe = subscribeAgeTick(() => {
      setLabel((prev) => {
        const next = compute()
        return prev === next ? prev : next
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [timestamp])

  if (!label) return null
  return (
    <span className="sidebar-chat-age" title={formatChatAgeTitle(timestamp)}>
      {label}
    </span>
  )
}

export function formatChatAge(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp)) return ''
  const elapsedMs = Math.max(0, now - timestamp)
  const elapsedMinutes = Math.floor(elapsedMs / 60000)
  if (elapsedMinutes < 1) return 'now'
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return `${elapsedDays}d`

  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  // `[]` defers to the runtime's default locale (matches
  // `formatChatAgeTitle` below) instead of hard-coding en-GB.
  return date.toLocaleDateString(
    [],
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: '2-digit' }
  )
}

export function formatChatAgeTitle(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
