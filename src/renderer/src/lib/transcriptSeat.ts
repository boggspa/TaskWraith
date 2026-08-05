/**
 * Build a `SeatChangeSeatState` from transcript-row metadata.
 *
 * Three surfaces in the transcript answer the same question — "which
 * participant produced this?" — and until now each answered it with its own
 * chip vocabulary: the peer thread-message card had only a decorative
 * identicon, the sub-thread return card had a bare provider label, and the
 * fan-out lane card had `segmented-control-action` pills. This is the shared
 * decoder that lets all of them render the one seat element instead.
 *
 * Reads a SNAPSHOT captured when the row was written, never live config. A lane
 * that ran an hour ago must keep describing the seat it actually ran as, even
 * if that participant has since been reconfigured — the same rule the close-out
 * table and the peer-message capture already follow.
 */

import type { SeatChangeSeatState } from '../../../shared/seatChange'

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/**
 * The seat behind an ensemble transcript row.
 *
 * `ensembleSeatSnapshot` is the authority for provider/model/reasoning and —
 * crucially — the permission preset, which the flat `ensembleProvider` /
 * `ensembleModel` fields do not carry. Without it the permission chip would
 * silently render the default tier for a lane that ran read-only.
 *
 * Unlike the peer-message card, `seatNumber` IS carried here: a fan-out lane
 * belongs to the reader's OWN roster, so "#3" names a seat they can see. (It is
 * meaningless for a peer sender, whose roster the reader is not in.)
 */
export function seatFromEnsembleMetadata(
  metadata: Record<string, unknown> | undefined | null
): SeatChangeSeatState | null {
  if (!metadata) return null
  const snapshot =
    metadata.ensembleSeatSnapshot && typeof metadata.ensembleSeatSnapshot === 'object'
      ? (metadata.ensembleSeatSnapshot as Record<string, unknown>)
      : null

  const provider = trimmed(snapshot?.provider) || trimmed(metadata.ensembleProvider)
  const model = trimmed(snapshot?.model) || trimmed(metadata.ensembleModel)
  // Both are required: the strip renders an empty span for a missing model,
  // which reads as a seat with no model rather than as an absent seat.
  if (!provider || !model) return null

  const role = trimmed(metadata.ensembleRole)
  const reasoningEffort = trimmed(snapshot?.reasoningEffort)
  const permissionPresetId = trimmed(snapshot?.configuredPermissionPresetId)
  const seatNumber = positiveInt(metadata.ensembleOrder)
  const stage = trimmed(metadata.ensembleStageRole)
  const stageRole =
    stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
      ? stage
      : undefined

  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(seatNumber ? { seatNumber } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    // A separate input from `reasoningEffort` producing the same chip suffix;
    // `false` is meaningful, so this is a type check rather than truthiness.
    ...(typeof snapshot?.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: snapshot.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
}

/**
 * The role as the seat element composes it internally — `#3 Reviewer`.
 *
 * `SeatStateChips` deliberately renders no role: a host showing a single seat
 * generally wants the role in its own heading, and the two hosts that do want
 * it want it in different places. So the composition lives here rather than as
 * a `showRole` flag on the shared component, which would have to answer a
 * different question for each caller.
 */
export function composedSeatRole(seat: SeatChangeSeatState | null | undefined): string {
  if (!seat) return ''
  const role = trimmed(seat.role)
  if (!role) return ''
  return seat.seatNumber ? `#${seat.seatNumber} ${role}` : role
}

/**
 * The seat behind a sub-thread / side-chat return row.
 *
 * Unlike the ensemble decoder there is no flat fallback: a child result has no
 * `ensembleModel`-style field to fall back to, and the whole point of the
 * capture is that the row records what the child ran as rather than what it is
 * configured as now. No captured seat means the card shows its provider label
 * instead, which is honest about knowing less.
 *
 * `seatNumber` is never present: a sub-thread is not a roster seat, so there is
 * no ordinal that would mean anything to the reader.
 */
export function seatFromSubThreadMetadata(
  metadata: Record<string, unknown> | undefined | null
): SeatChangeSeatState | null {
  const raw = metadata?.subThreadSeat
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const provider = trimmed(record.provider)
  const model = trimmed(record.model)
  if (!provider || !model) return null
  const role = trimmed(record.role)
  const reasoningEffort = trimmed(record.reasoningEffort)
  const permissionPresetId = trimmed(record.permissionPresetId)
  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof record.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: record.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
}
