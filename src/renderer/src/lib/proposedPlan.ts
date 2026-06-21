// Proposed-plan parsing — the structured "plan mode" plan an agent presents for
// the user to approve before implementation. Sibling to planModeChoice.ts (which
// scrapes a multiple-choice question); this one captures the plan body so the
// renderer can show a collapsible plan card + an approve / edit / dismiss /
// custom-response modal (the Codex-style plan affordance).
//
// Two capture paths, in priority order:
//   1. An explicit <proposed_plan>…</proposed_plan> block. Codex emits this; a
//      later plan-mode prompt nudge will make every provider wrap its plan the
//      same way, which is why the block wins even outside plan mode.
//   2. Fallback: while the run is in plan mode, a *substantive* assistant turn
//      IS the plan. The `planMode` gate keeps an ordinary turn (or a one-line
//      acknowledgement) from ever becoming a plan card.

export type ProposedPlanState = {
  /** Id of the assistant message the plan card anchors to. */
  messageId: string
  title: string
  body: string
}

const PROPOSED_PLAN_BLOCK = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i

/** First markdown heading (or first list/para line), trimmed — the card title. */
export const derivePlanTitle = (body: string): string => {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
    const text = (heading ? heading[1] : line.replace(/^[-*+]\s+/, '')).trim()
    if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text
  }
  return 'Proposed plan'
}

/**
 * A turn is "substantive enough" to be a plan when it has real structure — a
 * heading, a couple of list items, or a few hundred chars — not a one-liner.
 * Fenced code is stripped first so a code dump alone doesn't qualify.
 */
const looksSubstantive = (body: string): boolean => {
  const stripped = body.replace(/```[\s\S]*?```/g, '').trim()
  if (stripped.length >= 220) return true
  if (/^#{1,6}\s+/m.test(stripped)) return true
  const bulletLines = stripped.split('\n').filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line))
  return bulletLines.length >= 2
}

/**
 * Extract a proposed plan from an assistant turn. `planMode` gates the
 * heuristic fallback (path 2) so a normal turn never becomes a plan card; the
 * explicit <proposed_plan> block (path 1) is honoured regardless. Returns null
 * when there's no plan to surface.
 */
export const parseProposedPlan = (
  text: string,
  planMode: boolean
): { title: string; body: string } | null => {
  if (!text) return null
  const blockMatch = text.match(PROPOSED_PLAN_BLOCK)
  if (blockMatch) {
    const body = blockMatch[1].trim()
    if (!body) return null
    return { title: derivePlanTitle(body), body }
  }
  if (!planMode) return null
  const body = text.trim()
  if (!body || !looksSubstantive(body)) return null
  return { title: derivePlanTitle(body), body }
}

/** Strip a <proposed_plan> block out of a message's display text (the card
 *  renders the plan, so the raw block shouldn't also show as prose). Leaves
 *  non-block messages untouched. */
export const stripProposedPlanBlock = (text: string): string => {
  if (!PROPOSED_PLAN_BLOCK.test(text)) return text
  return text.replace(PROPOSED_PLAN_BLOCK, '').trim()
}
