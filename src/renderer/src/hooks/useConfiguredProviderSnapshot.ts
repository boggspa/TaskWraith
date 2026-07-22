import { useEffect, useState } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { isLiveSelectableProvider } from '../../../shared/retiredProviders'

export interface ConfiguredProviderSnapshot {
  ready: boolean
  providerIds: ProviderId[]
}

export function sanitizeConfiguredProviderSnapshot(value: unknown): ConfiguredProviderSnapshot {
  const snapshot = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const providerIds = Array.from(
    new Set(
      (Array.isArray(snapshot?.providerIds) ? snapshot.providerIds : []).filter(
        isLiveSelectableProvider
      )
    )
  )
  return { ready: snapshot?.ready === true, providerIds }
}

/**
 * Reads the main process's post-paint provider-discovery cache. This hook never
 * starts provider probes: it only polls the already-running discovery pass
 * until its current settings generation completes.
 */
export function useConfiguredProviderSnapshot(): ConfiguredProviderSnapshot {
  const [snapshot, setSnapshot] = useState<ConfiguredProviderSnapshot>({
    ready: false,
    providerIds: []
  })

  useEffect(() => {
    if (typeof window.api.getConfiguredProviderSnapshot !== 'function') return
    let cancelled = false
    let retryTimer: number | null = null
    let attemptsRemaining = 40

    const refresh = async (): Promise<void> => {
      let ready = false
      try {
        const next = sanitizeConfiguredProviderSnapshot(
          await window.api.getConfiguredProviderSnapshot()
        )
        if (cancelled) return
        ready = next.ready
        setSnapshot(next)
      } catch {
        // The pending fallback keeps the current provider visible; no picker
        // interaction ever starts or waits for provider discovery.
      }
      attemptsRemaining -= 1
      if (!cancelled && !ready && attemptsRemaining > 0) {
        retryTimer = window.setTimeout(() => void refresh(), 250)
      }
    }

    void refresh()
    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [])

  return snapshot
}
