import type { EnsembleParticipant } from '../store/types'
import { providerLabel } from '../EnsemblePrompt'
import { stripLeadingAt } from '../services/EnsembleWriteScopeClaims'

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
 * Aliases a Boss may use as a `laneBriefs` key, MOST SPECIFIC FIRST.
 *
 * The alias SET is deliberately the same tuple `writeScopes` validation uses,
 * because the Boss addresses both maps with the same keys in the same tool
 * call — a key that grants a write lane must never fail to name that lane here.
 *
 * The ORDER is this module's own, and it is load-bearing. `writeScopes`
 * resolves by iterating the caller's object and taking the first key that hits
 * the alias set, so precedence there is JSON key-insertion order. Applied to
 * briefs that is a cross-contamination bug rather than a quirk:
 *
 *   targets: work1(Worker, antigravity), work2(Worker2, antigravity)
 *   {"antigravity": "recon only", "work2": "edit src/router.ts"}
 *
 * gave BOTH lanes "recon only" and silently dropped work2's own brief, because
 * the broad provider key was written first. Two lanes on one provider is the
 * ordinary fan-out shape — the incident itself had a Work1 lane — so this is
 * exactly the contamination this module exists to remove. Resolving by
 * specificity instead makes the result independent of key order.
 */
function participantAliasesBySpecificity(participant: EnsembleParticipant): string[] {
  return [
    participant.id,
    participant.role,
    participant.provider,
    providerLabel(participant.provider)
  ].filter((alias): alias is string => typeof alias === 'string' && Boolean(alias.trim()))
}

/**
 * The brief addressed to this participant by the most specific matching key.
 *
 * Exact id beats role, role beats provider, and any of them beats the `*`/`all`
 * catch-all — so `{"*": "...", "work1": "..."}` and `{"work1": "...", "*": "..."}`
 * resolve identically.
 */
function pickBriefForParticipant(
  briefs: Record<string, unknown>,
  participant: EnsembleParticipant
): unknown {
  const normalized = new Map<string, unknown>()
  for (const [key, value] of Object.entries(briefs)) {
    const normalizedKey = stripLeadingAt(key).toLowerCase()
    // First writer wins only WITHIN one specificity tier, which is the only
    // place the caller's own ordering can still decide anything.
    if (!normalized.has(normalizedKey)) normalized.set(normalizedKey, value)
  }
  for (const alias of participantAliasesBySpecificity(participant)) {
    const hit = normalized.get(stripLeadingAt(alias).toLowerCase())
    if (hit !== undefined) return hit
  }
  for (const catchAll of ['*', 'all']) {
    const hit = normalized.get(catchAll)
    if (hit !== undefined) return hit
  }
  return undefined
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
  // The tool schema advertises a JSON-encoded map as a compatibility transport,
  // exactly as `writeScopes` does, because some providers flatten object
  // arguments to strings in transit. Honour it rather than failing the whole
  // fan-out on a shape the schema told the caller was acceptable.
  let parsedBriefs: unknown = rawBriefs
  if (typeof rawBriefs === 'string') {
    const trimmedRaw = rawBriefs.trim()
    if (!trimmedRaw) return { ok: true, briefByParticipantId: new Map() }
    try {
      parsedBriefs = JSON.parse(trimmedRaw)
    } catch {
      return {
        ok: false,
        message:
          'ensemble_fanout: laneBriefs was a string but not valid JSON. Send an object keyed by target alias, e.g. {"Worker":"Edit src/router.ts"}, or omit it to send every target the same prompt.',
        error: 'invalid_lane_brief'
      }
    }
  }
  if (!isPlainRecord(parsedBriefs)) {
    return {
      ok: false,
      message:
        'ensemble_fanout: laneBriefs must be an object keyed by target alias, e.g. {"Worker":"Edit src/router.ts"}. Omit it to send every target the same prompt.',
      error: 'invalid_lane_brief'
    }
  }
  const briefs = parsedBriefs

  const unknownKey = Object.keys(briefs).find((key) => {
    const normalizedKey = stripLeadingAt(key).toLowerCase()
    if (normalizedKey === '*' || normalizedKey === 'all') return false
    return !targets.some((participant) =>
      participantAliasesBySpecificity(participant).some(
        (alias) => stripLeadingAt(alias).toLowerCase() === normalizedKey
      )
    )
  })
  if (unknownKey) {
    const validAliases = targets
      .map((participant) => participantAliasesBySpecificity(participant).join(', '))
      .join('; ')
    return {
      ok: false,
      message: `ensemble_fanout: unknown laneBriefs key "${unknownKey}". Valid target aliases: ${validAliases}. Add a matching key to give that lane its own brief, or omit its key to send it the shared prompt.`,
      error: 'invalid_lane_brief'
    }
  }

  const briefByParticipantId = new Map<string, string>()
  for (const participant of targets) {
    const raw = pickBriefForParticipant(briefs, participant)
    if (raw === undefined) continue
    // A matched key whose value cannot be used as a brief is a caller error,
    // not a fallback. `{"Worker": ["step 1", "step 2"]}` is a very plausible
    // model spelling, and silently dropping it hands that lane the broadcast
    // while the Boss believes it sent a slice — the precise failure this module
    // exists to prevent. `writeScopes` hard-errors on the same shape.
    if (typeof raw !== 'string') {
      return {
        ok: false,
        message: `ensemble_fanout: laneBriefs value for "${participant.role || participant.id}" must be a string, received ${Array.isArray(raw) ? 'an array' : typeof raw}. Send one brief per target, e.g. {"Worker":"Edit src/router.ts"}.`,
        error: 'invalid_lane_brief'
      }
    }
    // An empty brief is treated as "no brief", matching how `writeScopes`
    // treats an empty key: the lane falls back to the shared prompt rather
    // than being dispatched with no task at all.
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
