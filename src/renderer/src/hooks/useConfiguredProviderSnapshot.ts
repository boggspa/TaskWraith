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

export const ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT =
  'taskwraith-antigravity-gemini-api-secret-mutated'

export function notifyAntigravityGeminiApiSecretMutation(): void {
  window.dispatchEvent(new Event(ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT))
}

export function antigravityGeminiApiSecretRefreshIdentity(value: unknown): string {
  const status = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const configured = status?.configured === true ? 'configured' : 'unconfigured'
  const updatedAt = typeof status?.updatedAt === 'string' ? status.updatedAt : ''
  return `${configured}:${updatedAt}`
}

/**
 * Reads the configured/unconfigured half of the refresh identity above. The
 * identity is already polled for cache-busting, so this reuses it rather than
 * adding a second poll of the same status channel. Anything unrecognised —
 * including the empty pre-first-poll value and the `'unavailable'` error
 * sentinel — reads as not configured, so admission fails closed.
 */
export function antigravityGeminiApiSecretIdentityIsConfigured(identity: string): boolean {
  return typeof identity === 'string' && identity.startsWith('configured:')
}

export function useAntigravityGeminiApiSecretRefreshIdentity(): string {
  const [identity, setIdentity] = useState('')
  const [mutationGeneration, setMutationGeneration] = useState(0)

  useEffect(() => {
    const handleMutation = (): void => setMutationGeneration((generation) => generation + 1)
    window.addEventListener(ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT, handleMutation)
    return () =>
      window.removeEventListener(ANTIGRAVITY_GEMINI_API_SECRET_MUTATION_EVENT, handleMutation)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const poll = async (): Promise<void> => {
      try {
        const status = await window.api.getAntigravityGeminiApiSecretStatus()
        if (!cancelled) setIdentity(antigravityGeminiApiSecretRefreshIdentity(status))
      } catch {
        if (!cancelled) setIdentity('unavailable')
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 500)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  return `${identity}:mutation-${mutationGeneration}`
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
