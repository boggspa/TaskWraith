import { useEffect, useState } from 'react'

export function ThreadCatalogueStatus(): React.JSX.Element | null {
  const [status, setStatus] = useState<{
    complete: boolean
    loaded: number
    failed: number
    error: string | null
  } | null>(null)
  useEffect(() => {
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
  }, [])
  if (!status || (status.complete && !status.error && !status.failed)) return null
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        zIndex: 1000,
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--bg-secondary, #252525)',
        color: 'var(--text-primary, #eee)',
        fontSize: 12,
        maxWidth: 420
      }}
    >
      {status.error
        ? 'History is temporarily unavailable. Retrying…'
        : status.failed
          ? `${status.loaded} threads ready. ${status.failed} could not be read; their saved history is retained.`
          : `Loading history… ${status.loaded} threads ready.`}
    </div>
  )
}
