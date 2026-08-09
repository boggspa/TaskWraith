import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderId } from '../../../main/store/types'
import {
  ANTIGRAVITY_PROVIDER_ID,
  isLiveSelectableProvider
} from '../../../shared/retiredProviders'
import { HOST_WARNING_PROVIDER_SOURCE_NOT_READY } from '../../../shared/hostProtocol'
import { useHostProjectionStore } from '../components/HostProjectionProvider'
import { useHostProjection } from './useHostProjection'
import type { HostProjectionState } from '../lib/host/HostProjectionStore'
import type { HostProjectedProvider } from '../lib/host/hostSnapshotProjection'

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

/**
 * Renderer dispatch-lane admission: the canonical live set plus an admitted
 * AntiGravity. `antigravity` is deliberately outside
 * `LIVE_SELECTABLE_PROVIDER_IDS`, so the App send/run/grant handlers must gate
 * on THIS union — mirroring main's `assertLiveProviderId` — not on the bare
 * live-set predicate. Gating dispatch on the bare set while the picker offered
 * the provider made every AntiGravity model selectable but physically unable
 * to send: the renderer rejected before IPC ever fired.
 */
export function isDispatchableProviderForRun(
  provider: string | null | undefined,
  antigravityAdmitted: boolean
): boolean {
  return (
    isLiveSelectableProvider(provider) ||
    (provider === ANTIGRAVITY_PROVIDER_ID && antigravityAdmitted === true)
  )
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

const PENDING_CONFIGURED_PROVIDER_SNAPSHOT: ConfiguredProviderSnapshot = {
  ready: false,
  providerIds: []
}

/** Pre-Wave-5c envelope: poll Host until discovery settles or the budget ends. */
export const CONFIGURED_PROVIDER_SETTLE_ATTEMPTS = 40
export const CONFIGURED_PROVIDER_SETTLE_INTERVAL_MS = 250

/**
 * Host Arc Wave 5c Phase 1 — pure map from Desktop Host projection state to
 * the configured-provider snapshot leaf consumers already understand.
 *
 * Honesty (same rules as `describeHostProviders` / Waves 5d–5e):
 * - Host not live, projection missing, or an unanchored cache → not ready
 *   (never a confident empty ready panel).
 * - A delta-applied cache with explicit live-baseline continuity is coherent
 *   enough for this presentation-only catalogue. Its freshness stays cached,
 *   and authoritative run admission remains in main.
 * - `provider_source_not_ready` warning code → not ready (empty array is not
 *   a measured zero until the source settles).
 * - Live + ready + empty rows → ready with empty ids (genuine measured none).
 * - Wire `available` means admitted/configured, not runtime-healthy; only
 *   available rows contribute provider ids and models.
 *
 * Exported so honesty pins do not need a DOM (renderer tests have no jsdom).
 */
export function configuredProviderSnapshotFromHostProjection(
  state: HostProjectionState
): ConfiguredProviderSnapshot {
  const projection = state.projection
  if (
    !projection ||
    state.status !== 'live' ||
    (projection.freshness !== 'live' && state.liveBaselineContinuity !== true)
  ) {
    return PENDING_CONFIGURED_PROVIDER_SNAPSHOT
  }

  if ((projection.warningCodes ?? []).includes(HOST_WARNING_PROVIDER_SOURCE_NOT_READY)) {
    return PENDING_CONFIGURED_PROVIDER_SNAPSHOT
  }

  const providerIds: string[] = []
  const seen = new Set<string>()
  const modelsByProvider: Partial<Record<string, ConfiguredProviderModel[]>> = {}

  for (const row of projection.providers as readonly HostProjectedProvider[]) {
    // Wire available === admitted in the configured snapshot (Wave 5e).
    if (!row || row.available !== true) continue
    const providerId = typeof row.providerId === 'string' ? row.providerId.trim() : ''
    if (!providerId) continue
    if (!seen.has(providerId)) {
      seen.add(providerId)
      providerIds.push(providerId)
    }
    const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : ''
    if (!modelId) continue
    const label =
      typeof row.modelLabel === 'string' && row.modelLabel.trim()
        ? row.modelLabel.trim()
        : modelId
    const list = modelsByProvider[providerId] ?? []
    if (!list.some((model) => model.id === modelId)) {
      list.push({ id: modelId, label })
      modelsByProvider[providerId] = list
    }
  }

  return sanitizeConfiguredProviderSnapshot({
    ready: true,
    providerIds,
    ...(Object.keys(modelsByProvider).length > 0 ? { modelsByProvider } : {})
  })
}

/**
 * Host Arc Wave 5c Phase 1 — configured provider roster from Host projection.
 *
 * Authority is the Host `providers` family (already projected by Host from the
 * main-process discovery cache). This hook does not call
 * `window.api.getConfiguredProviderSnapshot` and does not invent a second
 * socket: it reads the app-scope `HostProjectionStore` via context.
 *
 * When Host is idle/loading/unavailable, its cache lacks live-baseline
 * continuity, or the provider source is not ready, returns
 * `{ ready: false, providerIds: [] }` so consumers keep cold-start / unknown
 * behaviour (no fabricated recommended panel, no confident empty ready).
 * Coherent delta caches retain the catalogue while the Host connection is
 * live, preventing periodic provider groups from withdrawing between full
 * snapshots. AntiGravity secret mutations still force a pending empty until
 * the next Host refresh settles, so stale models never flash.
 *
 * Wave 5c replaced the old IPC settle poll with a one-shot Host refresh. Live
 * providers still paint from `LIVE_SELECTABLE_PROVIDER_IDS`, but AntiGravity
 * only appears once Host admits it with models. If the first pull lands while
 * discovery reports `provider_source_not_ready`, a missing follow-up ask freezes
 * AG out for the session. Restore the pre-5c bounded settle envelope against
 * Host so discovery completion can surface without a secret-mutation refreshKey.
 */
export function useConfiguredProviderSnapshot(refreshKey = ''): ConfiguredProviderSnapshot {
  const store = useHostProjectionStore()
  const state = useHostProjection(store)
  const prevRefreshKey = useRef(refreshKey)
  const [blockedForRefreshKey, setBlockedForRefreshKey] = useState(false)

  // Clear a prior settings generation before paint. In particular, enabling
  // AntiGravity again must not briefly reuse models cached before a fresh
  // Host projection refresh finishes.
  useLayoutEffect(() => {
    if (prevRefreshKey.current === refreshKey) return
    prevRefreshKey.current = refreshKey
    setBlockedForRefreshKey(true)
  }, [refreshKey])

  useEffect(() => {
    if (!blockedForRefreshKey) return
    if (!store) {
      setBlockedForRefreshKey(false)
      return
    }
    let cancelled = false
    void store
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setBlockedForRefreshKey(false)
      })
    return () => {
      cancelled = true
    }
  }, [store, blockedForRefreshKey, refreshKey])

  const mapped = blockedForRefreshKey
    ? PENDING_CONFIGURED_PROVIDER_SNAPSHOT
    : configuredProviderSnapshotFromHostProjection(state)

  // Bounded settle while Host (or provider discovery) is not ready. Concurrent
  // with the mount refresh is fine: HostProjectionStore coalesces in-flight
  // pulls, and later attempts re-ask after discovery can complete.
  useEffect(() => {
    if (!store || blockedForRefreshKey || mapped.ready) return
    let cancelled = false
    let retryTimer: number | null = null
    let attemptsRemaining = CONFIGURED_PROVIDER_SETTLE_ATTEMPTS

    const settle = async (): Promise<void> => {
      try {
        await store.refresh()
      } catch {
        // Store records the failure; keep asking until the budget ends.
      }
      if (cancelled) return
      attemptsRemaining -= 1
      // Read the store directly: React may not have re-rendered yet, and we
      // must not schedule another timer once discovery has already settled.
      const next = configuredProviderSnapshotFromHostProjection(store.getState())
      if (next.ready || attemptsRemaining <= 0) return
      retryTimer = window.setTimeout(() => {
        if (!cancelled) void settle()
      }, CONFIGURED_PROVIDER_SETTLE_INTERVAL_MS)
    }

    void settle()
    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
    }
  }, [store, blockedForRefreshKey, mapped.ready, refreshKey])

  return mapped
}
