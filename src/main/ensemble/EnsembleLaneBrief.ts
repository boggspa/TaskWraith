import type { EnsembleParticipant } from '../store/types'
import { providerLabel } from '../EnsemblePrompt'
import {
  pickRawWriteScopesForParticipant,
  stripLeadingAt
} from '../services/EnsembleWriteScopeClaims'

/**
 * Per-lane fan-out briefs.
 *
 * `ensemble_fanout` has always taken ONE `prompt` string and handed the same
 * frozen text to every lane in the wave: `runParallelFanoutPass` builds
 * `basePromptForLane` in its shared-preparation block, above the per-lane loop,
 * and every lane receives it verbatim. So a wave of N lanes gets one brief
 * describing the whole job — a read lane reads prose written for the writer
 * lane, and every lane reads every other lane's instructions.
 *
 * That is the routing half of the 2026-09-07 AntiGravity lane failure. The
 * posture fixes (`7de5f9eb1`, `658ed47ee`) made each lane correctly INFORMED
 * about what it may do; this makes each lane correctly ADDRESSED about what it
 * was asked to do. Both halves were needed: write-shaped instructions reached a
 * read-clamped lane because the brief was broadcast, and the desync then
 * removed the posture sentence that would have contradicted them.
 *
 * `prompt` stays required and stays the fallback, so a Boss that sends no
 * `laneBriefs` gets byte-identical behaviour to before this module existed.
 */

/** A lane brief keyed per target, resolved to participant ids. */
export interface ResolvedLaneBriefs {
  readonly ok: true
  /** Participant id -> that lane's own brief. Absent id means "use the shared prompt". */
  readonly briefByParticipantId: Map<string, string>
}

export interface RejectedLaneBriefs {
  readonly ok: false
  readonly message: string
  readonly error: 'invalid_lane_brief'
}

/**
 * Aliases a Boss may use as a `laneBriefs` key, for error messages.
 *
 * Deliberately the same tuple `writeScopes` validation uses, because the Boss
 * addresses both maps with the same keys in the same tool call. If these ever
 * diverge, a key that grants a write lane could fail to deliver that lane's
 * brief — the exact desync class this module exists to close.
 */
function participantAliases(participant: EnsembleParticipant): string[] {
  return [
    participant.id,
    participant.role,
    participant.provider,
    providerLabel(participant.provider)
  ].filter((alias): alias is string => typeof alias === 'string' && Boolean(alias.trim()))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Resolve a raw `laneBriefs` argument against this wave's targets.
 *
 * Returns an empty map for an omitted argument: no briefs is not an error, it
 * is today's behaviour. A malformed or unaddressable argument IS an error —
 * silently dropping it would put the Boss back where it started, believing each
 * lane got its own slice while every lane got the broadcast.
 */
export function resolveLaneBriefs(
  targets: EnsembleParticipant[],
  rawBriefs: unknown
): ResolvedLaneBriefs | RejectedLaneBriefs {
  if (rawBriefs === undefined || rawBriefs === null) {
    return { ok: true, briefByParticipantId: new Map() }
  }
  if (!isPlainRecord(rawBriefs)) {
    return {
      ok: false,
      message:
        'ensemble_fanout: laneBriefs must be an object keyed by target alias, e.g. {"Worker":"Edit src/router.ts"}. Omit it to send every target the same prompt.',
      error: 'invalid_lane_brief'
    }
  }

  const unknownKey = Object.keys(rawBriefs).find((key) => {
    const normalizedKey = stripLeadingAt(key).toLowerCase()
    if (normalizedKey === '*' || normalizedKey === 'all') return false
    return !targets.some((participant) =>
      participantAliases(participant).some(
        (alias) => stripLeadingAt(alias).toLowerCase() === normalizedKey
      )
    )
  })
  if (unknownKey) {
    const validAliases = targets
      .map((participant) => participantAliases(participant).join(', '))
      .join('; ')
    return {
      ok: false,
      message: `ensemble_fanout: unknown laneBriefs key "${unknownKey}". Valid target aliases: ${validAliases}. Add a matching key to give that lane its own brief, or omit its key to send it the shared prompt.`,
      error: 'invalid_lane_brief'
    }
  }

  const briefByParticipantId = new Map<string, string>()
  for (const participant of targets) {
    // Same resolver `writeScopes` uses, so `*`/`all` catch-alls and @-prefixed
    // role/provider aliases behave identically across both maps.
    const raw = pickRawWriteScopesForParticipant(rawBriefs, participant)
    if (typeof raw !== 'string') continue
    const brief = raw.trim()
    if (!brief) continue
    briefByParticipantId.set(participant.id, brief)
  }
  return { ok: true, briefByParticipantId }
}

/**
 * Wrap one lane's own brief in the authority envelope.
 *
 * Mirrors the shared-prompt envelope in `runParallelFanoutPass` exactly, with
 * one deliberate difference: the closing sentence can truthfully say the brief
 * was written FOR THIS SEAT, because for a keyed lane brief it was. The shared
 * path is left byte-identical — a wave that sends no `laneBriefs` must produce
 * the prompts it produced before this module existed.
 */
export function formatFanoutLaneBrief(input: {
  readonly brief: string
  readonly lanePromptAuthor: string
  readonly promptAuthority: string
  readonly reason?: string
}): string {
  const brief = input.brief.trim()
  if (input.promptAuthority === 'user') return brief
  return `Parallel fan-out lane request (${input.lanePromptAuthor}, lower authority than user/system instructions):\n${brief}${
    input.reason ? `\n\nReason: ${input.reason}` : ''
  }\n\nTreat this as a scoped lane brief: it was written for this seat specifically and the other lanes in this wave were given different briefs, so execute it within your permissions and the active goal even when it sits outside your usual role. Do not take on another lane's slice, and if something genuinely blocks you, report what is missing instead of handing the brief back on role grounds.`
}
