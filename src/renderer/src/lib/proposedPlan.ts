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
  /** Optional validated relative path to the saved plan artifact (main-side). */
  artifactPath?: string
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
 * A turn is "substantive enough" to be a plan when it has real plan-shaped
 * STRUCTURE — multiple sections/steps, or a single section that actually
 * carries a body — not a one-liner and not a lone recap heading. Fenced code is
 * stripped first so a code dump alone doesn't qualify.
 *
 * This is a strict TIGHTENING of the old rule (which treated ANY single heading
 * as an instant plan, over-triggering on "## Summary" / "## Done" recap
 * headings): every input that qualifies here also qualified before, but a lone
 * heading with no real body no longer does — so it can only ever surface fewer
 * plan cards, never more.
 */
const looksSubstantive = (body: string): boolean => {
  const stripped = body.replace(/```[\s\S]*?```/g, '').trim()
  if (!stripped) return false
  const lines = stripped.split('\n')
  const headingCount = lines.filter((line) => /^\s*#{1,6}\s+/.test(line)).length
  const stepCount = lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(line)).length
  // ≥2 section headings is intentional plan structure on its own — symmetric
  // with the ≥2-step rule below, and unchanged from before (multiple headings
  // already qualified under "any heading").
  if (headingCount >= 2) return true
  // A SINGLE heading qualifies only when it carries real content: at least one
  // step under it, or a non-heading body that clears the substance floor. This
  // is the over-trigger the tightening closes — a bare "## Summary" / "## Done"
  // recap heading is not a plan.
  if (headingCount === 1) {
    if (stepCount >= 1) return true
    const bodyBeyondHeading = stripped.replace(/^\s*#{1,6}\s+.*$/gm, '').trim()
    return bodyBeyondHeading.length >= 40
  }
  // No heading: length alone over-triggers on ordinary plan-mode narration
  // ("I explored the code, here's what I found…"), so require real length AND
  // ≥2 explicit steps. (Unchanged.)
  if (stripped.length < 40) return false
  return stepCount >= 2
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
// Separate /g regex for the strip — the shared PROPOSED_PLAN_BLOCK is reused by
// stateless .test()/.match() and must NOT carry the global flag's lastIndex.
const PROPOSED_PLAN_BLOCK_GLOBAL = /<proposed_plan>[\s\S]*?<\/proposed_plan>/gi

export const stripProposedPlanBlock = (text: string): string => {
  if (!PROPOSED_PLAN_BLOCK.test(text)) return text
  return text.replace(PROPOSED_PLAN_BLOCK_GLOBAL, '').trim()
}

export const isValidRelativePlanArtifactPath = (pathValue: string): boolean => {
  if (!pathValue) return false
  const trimmed = pathValue.trim()
  if (!trimmed) return false
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false
  if (trimmed.includes('://')) return false
  if (trimmed.startsWith('..') || trimmed.endsWith('/..') || trimmed.endsWith('\\..')) return false
  const segments = trimmed.split(/[\\/]+/).filter(Boolean)
  if (segments.includes('..')) return false
  return true
}
