import { useCallback, useEffect, useState } from 'react'

import type { StartupAuthorityRecoveryState } from '../../../shared/startupAuthority'

export interface UseStartupAuthorityState {
  state: StartupAuthorityRecoveryState | null
  retry: () => Promise<void>
  retrying: boolean
}

/**
 * Subscribes to workspace-lock startup-authority health.
 *
 * A degraded boot leaves the app looking healthy while workspace mutation,
 * provider admission, run recovery and scheduling are all fail-closed, so the
 * renderer has to know about it rather than discovering it on the first failed
 * edit.
 */
export function useStartupAuthorityState(): UseStartupAuthorityState {
  const [state, setState] = useState<StartupAuthorityRecoveryState | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    let active = true
    void window.api
      ?.getStartupAuthorityState?.()
      .then((next) => {
        if (active && next) setState(next)
      })
      .catch(() => {
        // An older main process without the channel simply reports nothing.
      })
    const unsubscribe = window.api?.onStartupAuthorityState?.((next) => {
      if (active) setState(next)
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const retry = useCallback(async () => {
    if (!window.api?.retryStartupAuthority) return
    setRetrying(true)
    try {
      const next = await window.api.retryStartupAuthority()
      if (next) setState(next)
    } catch {
      // The supervisor keeps its own state; a failed retry is reported through
      // the broadcast, not by throwing at the button.
    } finally {
      setRetrying(false)
    }
  }, [])

  return { state, retry, retrying }
}
