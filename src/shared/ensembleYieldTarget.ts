/**
 * Yield-target display resolution.
 *
 * Lives in shared because BOTH processes render the same phrase: main builds
 * the persisted `displayName` ("DSeekWork yielding to Builder", which the iOS
 * mirror, exports and chat search text all read), and the renderer paints the
 * tinted `@Builder` chip on the activity row. A renderer value-import from
 * main is the cross-process edge `guard:architecture` forbids, so the rule
 * they must agree on lives here.
 *
 * The problem it solves: `ensemble_yield`'s `target` is free text the model
 * chose, and models do not consistently choose the role. They yield to
 * `ensemble-participant-4` (the opaque roster id — the held-fan-out handoff
 * result hands them `eligibleManagerParticipantIds`, and any structured field
 * a model reads is a field it will echo back), to a bare provider, or to a
 * compound `Provider / Role`. Routing already resolves every one of those, so
 * the handoff works; only the label was wrong, printing the raw string at the
 * user. Resolving here means a target reads as a person no matter which form
 * the model reached for.
 */

/** Structural subset of `EnsembleParticipant` — kept structural so shared
 * never imports a main-process type. */
export interface YieldTargetCandidate {
  id?: string
  role?: string
  provider?: string
}

/**
 * Address forms a single target string could be carrying. Agents emit
 * compound values like `Kimi / Captain K` (provider + role), `@Captain K`
 * (mention form), or a bare role, so the leading `@` is stripped and common
 * separators split so each side is tried independently.
 */
function yieldTargetTokens(target: string): string[] {
  const stripped = target.replace(/^@+/, '').trim().toLowerCase()
  if (!stripped) return []
  return [
    stripped,
    ...stripped
      .split(/[/,|]+/)
      .map((token) => token.trim())
      .filter(Boolean)
  ]
}

function matchesYieldTarget(candidate: YieldTargetCandidate, tokens: readonly string[]): boolean {
  const role = (candidate.role || '').toLowerCase()
  const provider = (candidate.provider || '').toLowerCase()
  const id = (candidate.id || '').toLowerCase()
  return tokens.some((token) => token === role || token === provider || token === id)
}

/**
 * The one roster seat a yield target names, or undefined.
 *
 * Deliberately returns nothing when the target is AMBIGUOUS (two seats on the
 * same provider, both matched by a bare `@codex`). Routing picks a winner by
 * its own rules; naming one of them here would put a specific role in front of
 * the user that the handoff may not have gone to. Staying silent leaves the
 * raw target on screen, which is honest about what the model actually said.
 */
export function resolveYieldTargetParticipant<T extends YieldTargetCandidate>(
  target: string | undefined,
  participants: readonly T[] | undefined
): T | undefined {
  if (!target || !participants || participants.length === 0) return undefined
  const tokens = yieldTargetTokens(target)
  if (tokens.length === 0) return undefined
  const matched = participants.filter((participant) => matchesYieldTarget(participant, tokens))
  return matched.length === 1 ? matched[0] : undefined
}

/**
 * How a yield target should READ: the resolved seat's role, its provider when
 * the seat has no role yet, and otherwise the model's own words untouched.
 * Never invents a label for a target that does not resolve.
 */
export function yieldTargetDisplayLabel(
  target: string | undefined,
  participants: readonly YieldTargetCandidate[] | undefined
): string {
  const raw = (target || '').trim()
  const matched = resolveYieldTargetParticipant(raw, participants)
  if (!matched) return raw
  return (matched.role || '').trim() || (matched.provider || '').trim() || raw
}
