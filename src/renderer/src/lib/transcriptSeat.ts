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

import type { ChatRun } from '../../../main/store/types'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import { resolveSeatAuthority } from '../../../shared/seatChange'

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/** The four stage roles the glyph resolver switches on. Anything else came off
 *  persisted JSON and must not reach a component with a closed union. */
function stageRoleOf(value: unknown): SeatChangeSeatState['stageRole'] {
  const stage = trimmed(value)
  return stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
    ? stage
    : undefined
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
  const stageRole = stageRoleOf(metadata.ensembleStageRole)
  // Sibling field rather than part of the snapshot: authority is chat-level,
  // while `ensembleSeatSnapshot` is derived purely from the participant.
  const auth = trimmed(metadata.ensembleSeatAuthority)
  const authority = auth === 'boss' || auth === 'captain' ? auth : undefined

  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(seatNumber ? { seatNumber } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(authority ? { authority } : {}),
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
 * The seat behind a row that records no seat of its own — an `ask_user_question`
 * marker — read off the RUN that asked.
 *
 * Every other decoder here reads the row. A question marker cannot be read that
 * way, and that is structural rather than an oversight: it is written by the
 * question registry (`main/index.ts`) and by `onAgentQuestionRequested`, neither
 * of which is the orchestrator, so neither holds the participant that
 * `ensembleSeatSnapshot` is derived from. What the marker does carry is the
 * `runId` of the turn that asked, and the run records the seat in full.
 *
 * Reading the run also makes every question ALREADY in the transcript name its
 * asker. MEASURED 2026-08-06 across the real chat store: 15 of 15 question
 * markers carry a runId and all 15 resolve to a run, while NOT ONE carries a
 * seat in its own metadata — so a write-time stamp would have fixed nothing that
 * had already happened, exactly the way the fan-out lane card's snapshot gate
 * left 1734 of 1741 rows on the old pills.
 *
 * Still a snapshot, not live config: `ensembleSeatSnapshot` was captured when
 * the turn started, so a seat reconfigured since keeps describing what asked.
 *
 * No authority: a run records no boss/captain field (the fan-out row gets one
 * from the orchestrator's chat-level `laneSeatAuthority`, which is not carried
 * here). Making no claim is the same rule the absent permission preset follows —
 * an unknown is not a default.
 */
export function seatFromChatRun(run: ChatRun | null | undefined): SeatChangeSeatState | null {
  const snapshot = run?.ensembleSeatSnapshot
  if (!snapshot) return null
  const provider = trimmed(snapshot.provider)
  const model = trimmed(snapshot.model)
  // Both required, as above: an empty model renders as a seat with no model
  // rather than as the absent seat it actually is.
  if (!provider || !model) return null

  const role = trimmed(run?.ensembleRole)
  const seatNumber = positiveInt(run?.ensembleOrder)
  const stageRole = stageRoleOf(run?.ensembleStageRole)
  const reasoningEffort = trimmed(snapshot.reasoningEffort)
  const permissionPresetId = trimmed(snapshot.configuredPermissionPresetId)

  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(seatNumber ? { seatNumber } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    // `false` is meaningful — a type check, never truthiness.
    ...(typeof snapshot.thinkingEnabled === 'boolean'
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
 * Row-cache signature contribution for a rendered seat. Every field the element
 * draws has to appear here, or a cached row outlives a change to it — which is
 * a live risk for a question card specifically, because its seat resolves from
 * the run and can land after the row was first cached.
 */
export function agentQuestionSeatKey(seat: SeatChangeSeatState | null | undefined): string {
  if (!seat) return ''
  return [
    seat.provider,
    seat.model,
    seat.role ?? '',
    seat.seatNumber ?? '',
    seat.stageRole ?? '',
    seat.authority ?? '',
    seat.reasoningEffort ?? '',
    seat.thinkingEnabled === undefined ? '' : String(seat.thinkingEnabled),
    seat.permissionPresetId ?? ''
  ].join('|')
}

/** The roster fields the approval decoder reads. A structural subset of
 *  `EnsembleConfig` rather than the type itself: the decoder needs six of its
 *  fields, and a test fixture should not have to satisfy the other forty. */
export interface ApprovalSeatRoster {
  participants?: readonly {
    id: string
    role?: string
    order?: number
    model?: string
    reasoningEffort?: string
    thinkingEnabled?: boolean
    permissionPresetId?: string
    stageRole?: string
  }[]
  bossmanParticipantId?: string | null
  captainParticipantIds?: readonly string[] | null
}

/**
 * The seat behind a PENDING approval request.
 *
 * **This decoder reads LIVE roster config, and it is the only one here that
 * does.** Every other function in this file reads a snapshot on purpose — a
 * lane that ran an hour ago must keep describing the seat it actually ran as.
 * An approval is the opposite case: it is a request being made right now, by a
 * seat that is mid-turn, and the roster IS what it is running as. There is also
 * no snapshot to read — `ensembleApprovalContext` (main/index.ts) bakes
 * participantId / provider / role / stageRole / order into the preview and
 * stops there, so model, reasoning and permission preset have no other source.
 *
 * Identity comes from the ATTRIBUTION, configuration from the roster. That
 * split is deliberate: the attribution is the validated, bounded identity the
 * approval was filed under (and the one `agentApprovalDisplayTitle` strips from
 * the title), so a roster edit landing between request and render must not be
 * able to re-label whose request the user is answering. Provider likewise comes
 * from the approval itself — the request genuinely came from that provider's
 * CLI, whatever the roster now says.
 *
 * Returns null when no model resolves — a participant deleted mid-flight, or
 * one that never had one. The caller keeps its own fallback for that: an
 * identity-shaped strip that names no model is worse than plain pills.
 */
export function seatFromApprovalAttribution(input: {
  provider: string
  attribution: {
    participantId: string
    role: string
    stageRole?: string
    order?: number
  } | null
  roster: ApprovalSeatRoster | null | undefined
}): SeatChangeSeatState | null {
  const { attribution } = input
  if (!attribution) return null
  const provider = trimmed(input.provider)
  const participantId = trimmed(attribution.participantId)
  if (!provider || !participantId) return null

  const participant = (input.roster?.participants || []).find(
    (candidate) => trimmed(candidate.id) === participantId
  )
  const model = trimmed(participant?.model)
  // As everywhere else here: an empty model renders as a seat with no model
  // rather than as the absent seat it actually is.
  if (!model) return null

  const role = trimmed(attribution.role)
  const seatNumber = positiveInt(attribution.order)
  const stageRole = stageRoleOf(attribution.stageRole)
  const reasoningEffort = trimmed(participant?.reasoningEffort)
  const permissionPresetId = trimmed(participant?.permissionPresetId)
  // Chat-level, so it cannot come off the participant — same resolver the
  // orchestrator stamps onto a fan-out row, so a Boss wears its crown in the
  // approval modal exactly as it does in the lane card.
  const authority = resolveSeatAuthority({
    participantId,
    stageRole: stageRole ?? participant?.stageRole,
    bossmanParticipantId: input.roster?.bossmanParticipantId,
    captainParticipantIds: input.roster?.captainParticipantIds
  })

  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(seatNumber ? { seatNumber } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(authority ? { authority } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    // `false` is meaningful — a type check, never truthiness.
    ...(typeof participant?.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
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
  const stage = trimmed(record.stageRole)
  const stageRole =
    stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
      ? stage
      : undefined
  const auth = trimmed(record.authority)
  const authority = auth === 'boss' || auth === 'captain' ? auth : undefined
  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(authority ? { authority } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof record.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: record.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
}
