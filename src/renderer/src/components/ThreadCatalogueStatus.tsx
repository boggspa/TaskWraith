import { useEffect, useState } from 'react'
import {
  threadCatalogueStatusIsDegraded,
  threadCataloguePreflightBanner,
  type ThreadCatalogueStatusSnapshot
} from '../lib/threadCataloguePreflightBanner'

interface ThreadCatalogueStatusProps {
  /**
   * Startup has revealed the app beneath the boot mask. Required, not
   * defaulted: a call site that forgets it would silently restore the
   * never-ending overlay this component exists to bound.
   */
  bootRevealed: boolean
}

export function ThreadCatalogueStatus({
  bootRevealed
}: ThreadCatalogueStatusProps): React.JSX.Element | null {
  const [status, setStatus] = useState<ThreadCatalogueStatusSnapshot | null>(null)
  useEffect(() => {
    // Reveal ends the poll for the life of the window: nothing downstream reads
    // this status once the bubble can no longer be shown.
    if (bootRevealed) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const next = await window.api.getHistoryIndexStatus()
        if (!cancelled) setStatus(next)
      } catch {
        if (!cancelled)
          setStatus({
            complete: false,
            loaded: 0,
            failed: 0,
            error: 'History is temporarily unavailable.'
          })
      } finally {
        if (!cancelled)
          timer = setTimeout(() => {
            void refresh()
          }, 1500)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [bootRevealed])
  useEffect(() => {
    // Losing the overlay must not lose the signal. A mirror still degraded at
    // reveal means the sidebar list and the sidebar search are both serving an
    // arbitrary partial subset, which reads as missing threads rather than as a
    // failure; leave one line in the renderer log so it stays diagnosable.
    // Runs exactly once: the poll above is torn down in the same commit, so
    // `status` never moves again after reveal.
    if (!bootRevealed) return
    if (threadCatalogueStatusIsDegraded(status))
      console.warn('[thread-catalogue] history still degraded when the app was revealed', status)
  }, [bootRevealed, status])
  const line = threadCataloguePreflightBanner({ bootRevealed, status })
  if (!line) return null
  return (
    <div role="status" className="app-boot-history-note">
      {line}
    </div>
  )
}
