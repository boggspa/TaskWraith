/**
 * Host Arc Step 5b — composition-root adapter: configured-provider snapshot
 * → HostProductionProviderListPort.
 *
 * WHY THIS EXISTS. `HostProductionSuppliers` is import-isolated from AppStore /
 * provider modules and only accepts a thin `getProviders()` port. The real
 * admission source lives at the composition root (`getConfiguredProviderSnapshot`
 * in index.ts). This module owns the mapping so index.ts stays wiring-only:
 * one property, no domain assembly.
 *
 * BOUNDARIES:
 * - zero AppStore / BridgeActionExecutor / electron imports;
 * - zero mutation of LIVE_SELECTABLE / retirement / admission membership;
 * - constructs allowlisted HostProviderModelProjection fields only;
 * - `note` is drawn from a fixed admission vocabulary — never a pass-through
 *   of source text, URLs, headers, or credentials.
 *
 * HONESTY:
 * - snapshot not ready → empty list (fail closed; Desktop paints "None reported");
 * - missing / throwing deps → empty list;
 * - never invents availability for an id the snapshot did not name.
 */

import type { HostProviderModelProjection } from '../../shared/hostProtocol'
import {
  taskWraithProviderLabel,
  taskWraithProviderShortCode
} from '../../shared/taskWraithProviderPresentation'
import type { HostProductionProviderListPort } from './HostProductionSuppliers'

/** Fixed admission notes only — never credentials or free-form source text. */
export const HOST_PROVIDER_ADMISSION_NOTES = {
  configured: 'configured',
  conditional: 'conditional-offer'
} as const

export type HostProviderAdmissionNote =
  (typeof HOST_PROVIDER_ADMISSION_NOTES)[keyof typeof HOST_PROVIDER_ADMISSION_NOTES]

/** Bounded model row from the configured-provider snapshot (ids + labels only). */
export interface HostConfiguredProviderModelRow {
  readonly id: string
  readonly label: string
}

/**
 * The snapshot shape the composition root already publishes via
 * `getConfiguredProviderSnapshot`. Deliberately narrower than any settings /
 * detector type so this module never pulls store symbols.
 */
export interface HostConfiguredProviderSnapshot {
  readonly ready: boolean
  readonly providerIds: readonly string[]
  readonly modelsByProvider?: Readonly<
    Record<string, ReadonlyArray<HostConfiguredProviderModelRow>>
  >
}

export interface HostProductionProviderAdmissionDeps {
  getConfiguredSnapshot: () => HostConfiguredProviderSnapshot
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function admissionNoteFor(providerId: string): HostProviderAdmissionNote {
  // AntiGravity is the only conditional-offer lane today. Do not widen
  // membership here — just label the known wall honestly.
  return providerId === 'antigravity'
    ? HOST_PROVIDER_ADMISSION_NOTES.conditional
    : HOST_PROVIDER_ADMISSION_NOTES.configured
}

function projectProviderRow(input: {
  providerId: string
  modelId?: string
  modelLabel?: string
}): HostProviderModelProjection {
  const displayProvider = taskWraithProviderLabel(input.providerId)
  const row: HostProviderModelProjection = {
    providerId: input.providerId,
    displayProvider,
    shortCode: taskWraithProviderShortCode(input.providerId, displayProvider),
    available: true,
    hueKey: input.providerId,
    note: admissionNoteFor(input.providerId)
  }
  if (input.modelId !== undefined) row.modelId = input.modelId
  if (input.modelLabel !== undefined) row.modelLabel = input.modelLabel
  return row
}

/**
 * Map a configured-provider snapshot into wire rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionProviderAdmission}.
 */
export function mapConfiguredProviderSnapshotToHostProviders(
  snapshot: HostConfiguredProviderSnapshot
): HostProviderModelProjection[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  if (snapshot.ready !== true) return []

  const ids = Array.isArray(snapshot.providerIds) ? snapshot.providerIds : []
  const modelsByProvider =
    snapshot.modelsByProvider && typeof snapshot.modelsByProvider === 'object'
      ? snapshot.modelsByProvider
      : undefined

  const rows: HostProviderModelProjection[] = []
  for (const rawId of ids) {
    if (!isNonEmptyString(rawId)) continue
    const providerId = rawId.trim()
    const models = modelsByProvider?.[providerId]
    if (Array.isArray(models) && models.length > 0) {
      for (const model of models) {
        if (!model || !isNonEmptyString(model.id)) continue
        rows.push(
          projectProviderRow({
            providerId,
            modelId: model.id.trim(),
            ...(isNonEmptyString(model.label) ? { modelLabel: model.label.trim() } : {})
          })
        )
      }
      continue
    }
    rows.push(projectProviderRow({ providerId }))
  }
  return rows
}

/**
 * Build the `providers` port for `createHostProductionBootstrap` /
 * `createHostProductionSuppliers`.
 */
export function createHostProductionProviderAdmission(
  deps: HostProductionProviderAdmissionDeps
): HostProductionProviderListPort {
  return {
    getProviders(): HostProviderModelProjection[] {
      try {
        if (!deps || typeof deps.getConfiguredSnapshot !== 'function') return []
        return mapConfiguredProviderSnapshotToHostProviders(deps.getConfiguredSnapshot())
      } catch {
        return []
      }
    }
  }
}
