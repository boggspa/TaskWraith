/*
 * RecallCitationGuard — honesty control for cross-thread retrospection.
 *
 * When an agent answers a recall question it must quote the citation token
 * each `tw_recall_read*` served, in the canonical ⟦recall:…⟧ form. This pure
 * module formats those tokens, extracts them back out of the assistant's text,
 * and verifies each quoted token was actually issued THIS turn — annotating any
 * it cannot confirm with a VISIBLE "unverified" marker rather than silently
 * dropping it.
 *
 * Scope: this is an HONESTY control, NOT a confidentiality control. It cannot
 * catch a claim the agent makes with no citation at all, nor a real token
 * pasted onto a mischaracterized fact; it catches fabricated/stale tokens and
 * gives the user a legible signal. Pure — no Electron, no IO — so it unit-tests
 * in isolation and is safe to import from anywhere.
 */

export const RECALL_CITATION_OPEN = '⟦recall:'
export const RECALL_CITATION_CLOSE = '⟧'

/** Wrap an inner token in the canonical quotable form the agent must paste. */
export function formatRecallCitation(token: string): string {
  return `${RECALL_CITATION_OPEN}${token}${RECALL_CITATION_CLOSE}`
}

const CITATION_RE = /⟦recall:([^⟧]+)⟧/g

/** The unique inner tokens quoted in `text` (whitespace-trimmed, deduped). */
export function extractRecallCitations(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(CITATION_RE)) {
    const token = match[1].trim()
    if (token && !token.includes('—')) found.add(token)
  }
  return [...found]
}

/** Per-turn ledger of the citation tokens the recall tools actually served. */
export interface RecallCitationLedger {
  /** Record an inner token as served this turn and return its canonical form. */
  issue: (token: string) => string
  /** The inner tokens issued this turn. */
  issued: ReadonlySet<string>
}

export function createRecallCitationLedger(): RecallCitationLedger {
  const issued = new Set<string>()
  return {
    issue: (token: string) => {
      issued.add(token)
      return formatRecallCitation(token)
    },
    issued
  }
}

export interface RecallCitationVerification {
  citedTokens: string[]
  unservedTokens: string[]
  /** True when at least one quoted token was genuinely served this turn. */
  hadServedCitation: boolean
  /** `text` with every UNSERVED citation marked visibly (never silently stripped). */
  annotatedText: string
}

/**
 * Verify the citations quoted in `text` against the tokens served this turn.
 * Unserved (fabricated/stale) citations are annotated in place with a visible
 * "unverified" marker so the user sees exactly which claims could not be
 * confirmed.
 */
export function verifyRecallCitations(
  text: string,
  served: ReadonlySet<string>
): RecallCitationVerification {
  const cited = extractRecallCitations(text)
  const unserved = cited.filter((token) => !served.has(token))
  let annotatedText = text
  for (const token of unserved) {
    annotatedText = annotatedText
      .split(formatRecallCitation(token))
      .join(`${RECALL_CITATION_OPEN}${token} — unverified${RECALL_CITATION_CLOSE}`)
  }
  return {
    citedTokens: cited,
    unservedTokens: unserved,
    hadServedCitation: cited.some((token) => served.has(token)),
    annotatedText
  }
}

/**
 * System-prompt rule injected when the recall tools are available, so the agent
 * grounds every cross-thread answer in records it actually read and cites them.
 * Pairs with the mechanical verification above (no-read ⇒ no-claim).
 */
export const RECALL_GROUNDING_SYSTEM_RULE =
  'Cross-thread recall: when you answer a question about how another thread, run, or provider went, ground every claim ONLY in records you read THIS turn via tw_recall_read / tw_recall_read_events, and quote the citation token each returned, verbatim, in the form ⟦recall:…⟧. If tw_recall_find returned "none", or you did not actually read the run, say you could not find or verify it — never describe progress you did not read.'
