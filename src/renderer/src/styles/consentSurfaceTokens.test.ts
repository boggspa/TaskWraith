import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { AGENT_THEME_TOKENS } from '../../../shared/agentThemeTokens'

/**
 * Consent controls must not lay out against anything an agent can write.
 *
 * `theme_tokens_set` lets an agent change allowlisted appearance tokens. The
 * allowlist already excludes every colour that could make consent UI lie
 * (no text colour, no background, no focus ring, no provider identity hue) and
 * excludes approval-sheet geometry like `header-height`. But `--space-*` stayed
 * writable with a floor of 0, and the pending-approval card's action rows used
 * it for their flex `gap` — so `{"space-sm": 0}` left Accept and Reject
 * edge-to-edge and a click landing a pixel wide of Reject would grant instead
 * of deny.
 *
 * Flex `gap` cannot go negative and both rows `flex-wrap`, so no control could
 * ever be overlapped, hidden, or pushed out of reach; adjacency was the entire
 * exposure. It is fixed with literal `8px` rather than a tighter range bound,
 * because a literal is untouchable by construction — the same reason the
 * allowlist is an allowlist and not a validator.
 *
 * This test exists so the next person who "tidies" those literals back into
 * `var(--space-sm)` gets a failure that explains why they must not. It derives
 * the forbidden set from AGENT_THEME_TOKENS, so a token added to the allowlist
 * later is covered here automatically and cannot silently re-open the hole.
 */

/**
 * Selectors that carry a consent decision the user is being asked to make.
 *
 * Matched STRUCTURALLY rather than by naming the two rules that prompted this,
 * because the two halves of the guard have to age at the same rate: the token
 * set below is derived from AGENT_THEME_TOKENS and so covers allowlist
 * additions automatically, and a hand-listed selector set would quietly fail to
 * cover the next consent surface someone adds. A decision row is a selector
 * that is consent-ish AND is a row of controls — which today also reaches
 * `.creative-approval-modal-actions`, `.approval-grant-bulk-actions` (a
 * confirm/forget pair with the same shape as Accept/Reject),
 * `.approval-ledger-actions` and `.sidebar-footer-approval-actions`, none of
 * which existed in the original finding.
 *
 * Deliberately NOT matched: containers and text (`.composer-permission-card`
 * padding, `.composer-permission-title`, `.agent-approval-preview`). Those only
 * resize a card or a read-only preview, which is cosmetic and worth keeping
 * user-restyleable — the hazard is specifically two consequential controls
 * ending up adjacent.
 */
const CONSENT_SELECTOR_PATTERN = /permission|approval|consent|elevation|grant/i
const CONTROL_ROW_PATTERN = /actions|buttons|controls/i

/**
 * A comment sitting above a rule is captured with it by the crude splitter
 * below. Stripping it serves two purposes: comment prose can neither make a
 * rule match nor hide one, and the failure message names the selector instead
 * of quoting a paragraph of unrelated commentary at whoever has to fix it.
 */
function selectorOf(rawSelector: string): string {
  return rawSelector
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isConsentDecisionRow(rawSelector: string): boolean {
  const selector = selectorOf(rawSelector)
  if (!selector) return false
  return CONSENT_SELECTOR_PATTERN.test(selector) && CONTROL_ROW_PATTERN.test(selector)
}

function collectCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectCssFiles(full, out)
    else if (entry.endsWith('.css')) out.push(full)
  }
  return out
}

describe('consent surfaces vs agent-writable tokens', () => {
  const rendererRoot = resolve(__dirname, '..')
  const writableTokens = AGENT_THEME_TOKENS.map((spec) => spec.token)

  it('has a non-empty writable set, so this test cannot pass vacuously', () => {
    expect(writableTokens.length).toBeGreaterThan(0)
    // The specific token that caused the finding. If it is ever removed from
    // the allowlist this assertion should be updated deliberately, not deleted.
    expect(writableTokens).toContain('space-sm')
  })

  it('finds the consent decision rows at all (guards against a silent rename)', () => {
    const found: string[] = []
    for (const file of collectCssFiles(rendererRoot)) {
      const css = readFileSync(file, 'utf8')
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (isConsentDecisionRow(match[1])) found.push(selectorOf(match[1]))
      }
    }
    // If a rename ever drops this to zero the offence check below would pass
    // vacuously, which is the failure mode this whole file exists to avoid.
    expect(found.length).toBeGreaterThan(0)
    // The row that prompted the guard must still be among them.
    expect(found.some((s) => s.includes('composer-permission-actions'))).toBe(true)
  })

  it('never lays consent controls out against an agent-writable token', () => {
    const offences: string[] = []

    for (const file of collectCssFiles(rendererRoot)) {
      const css = readFileSync(file, 'utf8')
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = selectorOf(match[1])
        const body = match[2]
        if (!isConsentDecisionRow(match[1])) continue

        for (const token of writableTokens) {
          if (!body.includes(`var(--${token})`) && !body.includes(`var(--${token},`)) continue
          const line = css.slice(0, match.index).split('\n').length
          offences.push(`${file.split('/').pop()}:${line} — "${selector}" uses var(--${token})`)
        }
      }
    }

    expect(
      offences,
      `Consent controls must not size or space themselves with agent-writable tokens.\n` +
        `An agent can set these via theme_tokens_set (floor 0), which would put the\n` +
        `Accept and Reject controls edge-to-edge and turn a near-miss click on Reject\n` +
        `into a grant. Use a literal value in these rules.\n\n` +
        offences.join('\n')
    ).toEqual([])
  })
})
