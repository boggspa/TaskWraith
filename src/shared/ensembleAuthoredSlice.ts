/**
 * The Ensemble slice a USER authors, separated from the slice MAIN authors.
 *
 * Two different seams need the same answer and must not drift:
 *
 *  - `chatUpdateRenderMerge` defends a just-made panel edit against a delivery
 *    built before it (the revert half of the 2026-09-11 report).
 *  - `ensembleRosterCommit` rebases that edit onto the canonical record when
 *    `ChatService.saveChatInternal` refuses the whole clone on revision skew
 *    (the rejection half — "my model selection keeps being rejected").
 *
 * The split is the load-bearing part. A user-authored key is intent and must
 * survive; a main-authored key is newer on the canonical side and must never be
 * rolled back to whatever the renderer happened to be carrying. Round state,
 * seat session linkage, prompt versions, compaction, token totals and the
 * various control ledgers are all main's.
 */
import type { ChatRecord, EnsembleParticipant } from '../main/store/types'

type EnsembleConfigShape = NonNullable<ChatRecord['ensemble']>

/**
 * Panel-level configuration written by the orchestration row, the roster
 * popover and the roster settings panel.
 *
 * Authority ids belong here rather than with the round bookkeeping: the user
 * assigns Boss / Captain / second-in-command, the authored record already
 * normalized them against its own roster, and keeping canonical's ids beside an
 * authored roster is what leaves an authority pointer naming a removed seat.
 * Round-level authority captured INSIDE `activeRound` stays canonical, which is
 * what "cannot resurrect a stale round" actually protects.
 */
export const ENSEMBLE_PANEL_CONFIGURATION_KEYS = [
  'enabled',
  'activeRosterPresetId',
  'orchestrationMode',
  'concurrentModeEnabled',
  'fanoutPolicy',
  'fanoutIsolation',
  'roundMode',
  'maxContinuationHops',
  'ensembleContextChars',
  'selfReflective',
  'bossmanParticipantId',
  'captainParticipantIds',
  'secondInCommandParticipantId',
  'synthesizerParticipantId',
  'bossmanAutoApprovals'
] as const satisfies readonly (keyof EnsembleConfigShape)[]

/**
 * Per-seat configuration written by the composer pickers and the roster panel.
 * Deliberately excludes main-authored runtime bookkeeping
 * (`linkedProviderSessionId`, `seatGeneration`, prompt versions, compaction
 * summaries, token totals, ACP posture): those are newest on the canonical side
 * and must never be rolled back when only the configuration is being restored.
 */
export const ENSEMBLE_SEAT_CONFIGURATION_KEYS = [
  'provider',
  'enabled',
  'role',
  'instructions',
  'order',
  'model',
  'runtimeProfileId',
  'geminiAuthProfileId',
  'ollamaRunProfile',
  'permissionPresetId',
  'permissionOverrides',
  'stageRole',
  'reasoningEffort',
  'fastModeEnabled',
  'thinkingEnabled',
  'serviceTier',
  'pooledAgentId',
  'pooledAgentIdentity'
] as const satisfies readonly (keyof EnsembleParticipant)[]

export function ensembleSeatConfigurationSignature(participant: EnsembleParticipant): string {
  return JSON.stringify(ENSEMBLE_SEAT_CONFIGURATION_KEYS.map((key) => participant[key] ?? null))
}

export function ensemblePanelConfigurationSignature(ensemble: EnsembleConfigShape): string {
  return JSON.stringify(ENSEMBLE_PANEL_CONFIGURATION_KEYS.map((key) => ensemble[key] ?? null))
}

/**
 * One signature over everything in an Ensemble a USER authors: the panel
 * configuration, the roster's membership and order, and each seat's own
 * configuration.
 *
 * Built from the same two key lists the overlay helpers use, so a field that is
 * user-authored for the merge seam is user-authored here too and the two cannot
 * drift. Excluding main's bookkeeping is the whole point rather than an
 * optimization: this answers "has the USER changed the panel since a given
 * moment", and an orchestrator write landing in between (seat generation,
 * session linkage, prompt versions, token totals) must not be mistaken for the
 * user's hand.
 */
export function ensembleAuthoredConfigurationSignature(
  ensemble: EnsembleConfigShape | null | undefined
): string {
  if (!ensemble) return ''
  const participants = Array.isArray(ensemble.participants) ? ensemble.participants : []
  return JSON.stringify([
    ensemblePanelConfigurationSignature(ensemble),
    participants.map((seat) => [seat.id, ensembleSeatConfigurationSignature(seat)])
  ])
}

/** Base panel config + the authored record's user-authored fields. An absent
 * authored field is restored as absent so a deliberate clear sticks. */
export function overlayEnsemblePanelConfiguration(
  base: EnsembleConfigShape,
  authored: EnsembleConfigShape
): EnsembleConfigShape {
  const next = { ...base } as unknown as Record<string, unknown>
  for (const key of ENSEMBLE_PANEL_CONFIGURATION_KEYS) {
    const value = authored[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next as unknown as EnsembleConfigShape
}

/** Base seat + the authored seat's user-editable configuration. */
export function overlayEnsembleSeatConfiguration(
  base: EnsembleParticipant,
  authored: EnsembleParticipant
): EnsembleParticipant {
  const next = { ...base } as unknown as Record<string, unknown>
  for (const key of ENSEMBLE_SEAT_CONFIGURATION_KEYS) {
    const value = authored[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next as unknown as EnsembleParticipant
}

/** Whether `record` already carries the authored panel slice — membership,
 *  per-seat configuration and panel configuration alike. */
export function carriesEnsembleAuthoredSlice(
  record: Pick<ChatRecord, 'ensemble'>,
  authored: Pick<ChatRecord, 'ensemble'>
): boolean {
  const authoredEnsemble = authored.ensemble
  const recordEnsemble = record.ensemble
  if (!authoredEnsemble) return true
  if (!recordEnsemble) return false
  if (
    ensemblePanelConfigurationSignature(recordEnsemble) !==
    ensemblePanelConfigurationSignature(authoredEnsemble)
  ) {
    return false
  }
  const authoredSeats = authoredEnsemble.participants
  const recordSeats = recordEnsemble.participants
  if (!Array.isArray(authoredSeats) || !Array.isArray(recordSeats)) return false
  if (authoredSeats.length !== recordSeats.length) return false
  return authoredSeats.every(
    (seat, index) =>
      seat.id === recordSeats[index]?.id &&
      ensembleSeatConfigurationSignature(seat) ===
        ensembleSeatConfigurationSignature(recordSeats[index])
  )
}

/**
 * Put the authored Ensemble slice back on top of the canonical record.
 *
 * Membership and per-seat configuration come from the authored record — that is
 * the user's intent, and it is the whole reason the save was issued. Everything
 * else rides on canonical: its transcript, runs, round state and control
 * ledgers are newer, and per surviving seat its own runtime bookkeeping is
 * kept, so a rebased save cannot break a resumed provider session. A seat the
 * canonical record has never seen (a just-added one) is taken whole.
 *
 * Returns null when there is nothing to rebase, so a caller can treat "the
 * refusal did not cost the user anything" as a non-event.
 */
export function rebaseEnsembleAuthoredSlice(
  canonical: ChatRecord,
  authored: ChatRecord
): ChatRecord | null {
  const authoredEnsemble = authored.ensemble
  const canonicalEnsemble = canonical.ensemble
  if (!authoredEnsemble || !canonicalEnsemble) return null
  if (carriesEnsembleAuthoredSlice(canonical, authored)) return null
  const authoredSeats = authoredEnsemble.participants
  if (!Array.isArray(authoredSeats)) return null
  const canonicalSeatsById = new Map(
    (Array.isArray(canonicalEnsemble.participants) ? canonicalEnsemble.participants : []).map(
      (seat) => [seat.id, seat]
    )
  )
  const participants = authoredSeats.map((seat) => {
    const canonicalSeat = canonicalSeatsById.get(seat.id)
    return canonicalSeat ? overlayEnsembleSeatConfiguration(canonicalSeat, seat) : seat
  })
  const panel = overlayEnsemblePanelConfiguration(canonicalEnsemble, authoredEnsemble)
  return {
    ...canonical,
    ensemble: {
      ...panel,
      participants,
      maxParticipants: Math.max(Number(canonicalEnsemble.maxParticipants) || 0, participants.length)
    }
  }
}
