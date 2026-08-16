/**
 * Consequential-action predicate for web actuation (design §7, slice S12).
 *
 * WHY THIS EXISTS. Under Accept Edits and above, `canvas_click` is authorized
 * for the run without a per-action decision. Since 1.9.5 the Canvas Browser is
 * any-origin and carries a durable TaskWraith profile, so the page an agent is
 * clicking may well be one the user is signed in to. Nothing stood between a
 * mis-targeted agent and an irreversible control on that page. The design gated
 * any-origin web (Tier 2) on credential protection AND consequential
 * confirmation both being live; only the first shipped.
 *
 * WHAT IT IS. A speed bump against AGENT JUDGMENT ERRORS — the dominant
 * residual in this feature (design §10.7). The sandbox addresses errors of aim;
 * this addresses the far more common error of picking the wrong right-looking
 * control.
 *
 * WHAT IT IS NOT — do not let this drift into a stronger claim. The label comes
 * from the page, and a page can name its buttons whatever it likes, so a
 * hostile origin evades this trivially. The native path says the same of its
 * own keywords (design §12b: "Consequential keywords are an advisory dialog
 * hint only, not an authorization boundary"), and it is true here for the same
 * reason. This raises the floor for honest pages; it does not lower the ceiling
 * for dishonest ones. The real boundaries remain the permission tier, the
 * surface-scoped grant, and secret-field refusal.
 *
 * SCOPE OF v1 — deliberately narrow. Only irreversible and financial verbs are
 * listed. Generic form verbs ("submit", "continue", "OK", "save") and ordinary
 * comms verbs ("send", "post") are OMITTED ON PURPOSE: they fire on nearly
 * every page, and a confirmation the user sees constantly is one they learn to
 * click through, which is worse than no confirmation at all. Widen this list
 * only with evidence about how often the new term actually fires.
 */

/**
 * Irreversible / destructive intent. Ordered loosely by how unambiguous the
 * term is; every entry is matched on word boundaries against a normalized
 * label, so "undelete" and "delete" do not collide.
 */
const DESTRUCTIVE_TERMS: readonly string[] = Object.freeze([
  'delete',
  'permanently remove',
  'remove permanently',
  'erase',
  'wipe',
  'destroy',
  'deactivate',
  'terminate',
  'revoke',
  'close account',
  'delete account',
  'cancel subscription',
  'reset all',
  'factory reset'
])

/** Money movement. A wrong click here is not recoverable by re-running. */
const FINANCIAL_TERMS: readonly string[] = Object.freeze([
  'buy',
  'purchase',
  'place order',
  'confirm order',
  'checkout',
  'check out',
  'pay now',
  'confirm payment',
  'make payment',
  'transfer funds',
  'withdraw',
  'donate',
  'subscribe'
])

export type CanvasConsequentialCategory = 'destructive' | 'financial'

export interface CanvasConsequentialAssessment {
  readonly consequential: boolean
  readonly category?: CanvasConsequentialCategory
  /** The matched term, for the dialog's value-free summary. Never page text. */
  readonly matchedTerm?: string
}

/**
 * Normalize a page-supplied label for matching: collapse whitespace, strip
 * anything that is not a letter, digit or space, and lowercase. This keeps
 * "Delete Account", "DELETE ACCOUNT!", and "delete-account" equivalent
 * without letting punctuation-splitting hide a term.
 */
export function normalizeTargetLabel(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Longest term first, so the summary the human reads names the most specific
 * match: "delete account" rather than the "delete" that also matches it.
 */
function bySpecificity(terms: readonly string[]): readonly string[] {
  return Object.freeze([...terms].sort((a, b) => b.length - a.length))
}

const DESTRUCTIVE_BY_SPECIFICITY = bySpecificity(DESTRUCTIVE_TERMS)
const FINANCIAL_BY_SPECIFICITY = bySpecificity(FINANCIAL_TERMS)

function matchTerm(label: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    // Word-boundary match on a space-normalized label, so "undelete" does not
    // match "delete" and "paying" does not match "pay now".
    const pattern = new RegExp(`(^| )${term}( |$)`, 'u')
    if (pattern.test(label)) return term
  }
  return null
}

/**
 * Assess one resolved target's accessible label. Pure and page-text-free in its
 * output: only the matched TERM travels onward, never the page's own string, so
 * a confirmation dialog cannot be used to render attacker-chosen prose.
 */
export function assessConsequentialTarget(
  rawLabel: string | null | undefined
): CanvasConsequentialAssessment {
  const label = normalizeTargetLabel(rawLabel)
  if (!label) return { consequential: false }

  const destructive = matchTerm(label, DESTRUCTIVE_BY_SPECIFICITY)
  if (destructive) {
    return { consequential: true, category: 'destructive', matchedTerm: destructive }
  }
  const financial = matchTerm(label, FINANCIAL_BY_SPECIFICITY)
  if (financial) {
    return { consequential: true, category: 'financial', matchedTerm: financial }
  }
  return { consequential: false }
}

/**
 * Value-free summary for the confirmation dialog. Deliberately built from the
 * matched term and category rather than the page's label: the page controls its
 * own text, and this string is shown to the human as TaskWraith's own words.
 */
export function consequentialSummary(assessment: CanvasConsequentialAssessment): string {
  if (!assessment.consequential || !assessment.matchedTerm) return 'a page control'
  return assessment.category === 'financial'
    ? `a payment control (“${assessment.matchedTerm}”)`
    : `a destructive control (“${assessment.matchedTerm}”)`
}
