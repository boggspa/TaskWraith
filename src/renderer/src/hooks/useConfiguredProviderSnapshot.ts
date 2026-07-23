import { useEffect, useLayoutEffect, useState } from 'react'
import type { ProviderId } from '../../../main/store/types'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isLiveSelectableProvider
} from '../../../shared/retiredProviders'

export interface ConfiguredProviderModel {
  id: string
  label: string
}

export interface ConfiguredProviderSnapshot {
  ready: boolean
  providerIds: ProviderId[]
  modelsByProvider?: Partial<Record<ProviderId, ConfiguredProviderModel[]>>
}

export function sanitizeConfiguredProviderSnapshot(value: unknown): ConfiguredProviderSnapshot {
  const snapshot = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const rawModels =
    snapshot?.modelsByProvider && typeof snapshot.modelsByProvider === 'object'
      ? (snapshot.modelsByProvider as Record<string, unknown>)[ANTIGRAVITY_PROVIDER_ID]
      : null
  const antigravityModelsById = new Map<string, ConfiguredProviderModel>()
  for (const entry of Array.isArray(rawModels) ? rawModels : []) {
    if (antigravityModelsById.size >= 128) break
    const model = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    const label = typeof model?.label === 'string' ? model.label.trim() : ''
    if (id && id.length <= 512 && !antigravityModelsById.has(id)) {
      antigravityModelsById.set(id, { id, label: label || id })
    }
  }
  const antigravityModels = Array.from(antigravityModelsById.values())
  const providerIds = Array.from(
    new Set(
      (Array.isArray(snapshot?.providerIds) ? snapshot.providerIds : []).filter(
        (provider): provider is ProviderId =>
          isLiveSelectableProvider(provider) ||
          (provider === ANTIGRAVITY_PROVIDER_ID && antigravityModels.length > 0)
      )
    )
  )
  return {
    ready: snapshot?.ready === true,
    providerIds,
    ...(providerIds.includes(ANTIGRAVITY_PROVIDER_ID) && antigravityModels.length > 0
      ? { modelsByProvider: { [ANTIGRAVITY_PROVIDER_ID]: antigravityModels } }
      : {})
  }
}

/**
 * Reads the main process's post-paint provider-discovery cache. This hook never
 * starts provider probes: it only polls the already-running discovery pass
 * until its current settings generation completes.
 */
export function useConfiguredProviderSnapshot(refreshKey = ''): ConfiguredProviderSnapshot {
  const [snapshot, setSnapshot] = useState<ConfiguredProviderSnapshot>({
    ready: false,
    providerIds: []
  })

  // Clear a prior settings generation before paint. In particular, enabling
  // AntiGravity again must not briefly reuse models cached before a fresh
  // authenticated `agy models` probe finishes.
  useLayoutEffect(() => {
    setSnapshot({ ready: false, providerIds: [] })
  }, [refreshKey])

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
  }, [refreshKey])

  return snapshot
}
