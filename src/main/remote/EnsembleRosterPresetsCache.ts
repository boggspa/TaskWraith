// Ensemble roster presets — host-side projection cache (pure, no electron).
//
// Presets are RENDERER-LOCAL (localStorage, src/renderer/src/lib/
// ensembleRosterPresets.ts); main can't read them directly. The renderer
// (source of truth) pushes its list up via the `ensemble-roster-presets:sync`
// IPC; we cache a projection-shaped copy here so the bridge can broadcast it to
// paired iOS devices (the Roster page). Kept electron-free so the mapper is
// unit-testable.

import type {
  RemoteEnsemblePreset,
  RemoteEnsembleRosterEntry
} from '../RemoteTaskProjection'
import type { ProviderId } from '../store/types'
import { isLiveSelectableProvider } from '../../shared/retiredProviders'

// Preset participants whose provider isn't live-selectable are dropped from the projection
// so the phone never shows an unrunnable member AND a single unavailable,
// retired, or garbage entry can't fail an otherwise-valid apply (ensembleRosterUpdateFn's
// assertProviderId would throw on a malformed string and reject the whole roster).
function safeRosterPermissionPresetId(value: unknown): string | undefined {
  if (
    value === 'read_only' ||
    value === 'plan' ||
    value === 'default' ||
    value === 'workspace_write' ||
    value === 'custom'
  ) {
    return value
  }
  if (value === 'full_access') return 'workspace_write'
  return undefined
}

let cached: RemoteEnsemblePreset[] = []

/** Projection-shaped snapshot of the renderer's roster presets (iOS-facing). */
export function getCachedRemoteEnsemblePresets(): RemoteEnsemblePreset[] {
  return cached
}

/** Replace the cache from a renderer sync payload (untrusted IPC input). */
export function setRemoteEnsemblePresetsFromRaw(raw: unknown): void {
  cached = mapRawPresetsToRemote(raw)
}

/** Map the renderer's `EnsembleRosterPreset[]` (localStorage shape) to the
 * iOS-facing projection shape. Defensive: IPC input is untrusted. Exported for
 * unit tests. */
export function mapRawPresetsToRemote(raw: unknown): RemoteEnsemblePreset[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteEnsemblePreset[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const preset = item as Record<string, unknown>
    if (typeof preset.id !== 'string' || typeof preset.name !== 'string') continue
    const participantsRaw = Array.isArray(preset.participants) ? preset.participants : []
    const participants = participantsRaw
      .map((snapshot, index) => mapSnapshot(preset.id as string, snapshot, index))
      .filter((entry): entry is RemoteEnsembleRosterEntry => entry !== null)
    out.push({
      id: preset.id,
      name: preset.name,
      ...(typeof preset.orchestrationMode === 'string'
        ? { orchestrationMode: preset.orchestrationMode }
        : {}),
      ...(typeof preset.maxParticipants === 'number'
        ? { maxParticipants: preset.maxParticipants }
        : {}),
      ...(typeof preset.updatedAt === 'number' ? { updatedAt: preset.updatedAt } : {}),
      participants
    })
  }
  return out
}

function mapSnapshot(
  presetId: string,
  snapshot: unknown,
  index: number
): RemoteEnsembleRosterEntry | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const entry = snapshot as Record<string, unknown>
  if (typeof entry.provider !== 'string') return null
  if (!isLiveSelectableProvider(entry.provider)) return null
  const brief =
    typeof entry.instructions === 'string' && entry.instructions
      ? entry.instructions.slice(0, 500)
      : undefined
  const permissionPresetId = safeRosterPermissionPresetId(entry.permissionPresetId)
  return {
    // Preset participants are id-less; synthesize a stable per-preset id so the
    // iOS list has identity. Apply (slice B2) replays these as a fresh roster,
    // so the id is display-only.
    id: `${presetId}-p${index + 1}`,
    provider: entry.provider as ProviderId,
    role: typeof entry.role === 'string' && entry.role ? entry.role : (entry.provider as string),
    enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
    order: typeof entry.order === 'number' ? entry.order : index + 1,
    ...(entry.isBossman === true ? { isBossman: true } : {}),
    ...(entry.isSecondInCommand === true ? { isSecondInCommand: true } : {}),
    ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
    ...(brief !== undefined ? { brief } : {}),
    ...(permissionPresetId ? { permissionPresetId } : {}),
    ...(typeof entry.reasoningEffort === 'string'
      ? { reasoningEffort: entry.reasoningEffort }
      : {}),
    ...(typeof entry.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: entry.fastModeEnabled }
      : {}),
    ...(typeof entry.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: entry.thinkingEnabled }
      : {}),
    ...(entry.stageRole === 'scout' ||
    entry.stageRole === 'worker' ||
    entry.stageRole === 'reviewer' ||
    entry.stageRole === 'background'
      ? { stageRole: entry.stageRole }
      : {})
  }
}
