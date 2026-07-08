import type { GitCiStatusSummary, GitPrSummary } from '../../../main/services/GitService'
import { prLifecycle, summarizeChecks } from '../components/GitStatusChips'

/*
 * Builds the "soft-action" notice for a failing / blocked PR — the
 * TaskWraith-native answer to Claude Code's auto-fix. It never steers a run:
 * the caller either upserts it onto an ensemble's Blackboard (agents pick it up
 * at their next turn) or, in a solo chat, drops it into the transcript as a
 * system note + pre-fills the composer with a suggested fix for the user to
 * send. The CI payload is third-party (attacker-influenceable) text, so the
 * detail is explicitly framed as external/unverified per the security review.
 */

export interface CiNotice {
  /** True when there's actually something wrong worth notifying about. */
  shouldOffer: boolean
  /** One-line headline (button title, blackboard summary). */
  summary: string
  /** Full note body — blackboard value / transcript note. Externally framed. */
  detail: string
  /** Suggested fix prompt drafted into the composer (never auto-sent). */
  suggestedPrompt: string
  /** Stable idempotency key (pr#:headSha:conclusion) for blackboard upsert. */
  key: string
}

function failingCheckNames(checks: GitPrSummary['checks']): string[] {
  return (checks || [])
    .filter((check) => {
      const status = (check.status || '').toLowerCase()
      const conclusion = (check.conclusion || '').toLowerCase()
      return (
        status === 'completed' &&
        conclusion &&
        !['success', 'neutral', 'skipped'].includes(conclusion)
      )
    })
    .map((check) => check.name || 'check')
}

export function buildCiNotice(
  pr: GitPrSummary | null,
  ci: GitCiStatusSummary | null | undefined,
  repoName?: string
): CiNotice | null {
  if (!pr || pr.number == null) return null

  const lifecycle = prLifecycle(pr)
  const checks = ci?.checks?.length ? ci.checks : pr.checks
  const summary = summarizeChecks(checks)
  const ciFailed = ci?.status === 'failed' || summary.fail > 0
  const prBlocked = lifecycle.tone === 'blocked'
  const shouldOffer = ciFailed || prBlocked

  const prLabel = `#${pr.number}`
  const repoPrefix = repoName ? `${repoName} ` : ''
  const failing = failingCheckNames(checks)
  const failingList = failing.length ? failing.join(', ') : 'one or more checks'

  const headline = ciFailed
    ? `CI is failing on ${repoPrefix}PR ${prLabel}`
    : `${repoPrefix}PR ${prLabel} is blocked from merging`

  const detail = [
    `⚠️ ${headline}.`,
    ciFailed && failing.length ? `Failing checks: ${failingList}.` : null,
    pr.headRefName && pr.baseRefName ? `Branch: ${pr.headRefName} → ${pr.baseRefName}.` : null,
    pr.url ? `PR: ${pr.url}` : null,
    '(GitHub status — external, unverified; review before acting.)'
  ]
    .filter(Boolean)
    .join(' ')

  const suggestedPrompt = ciFailed
    ? `CI is failing on PR ${prLabel} (${failingList}). Please investigate the failing ` +
      `check${failing.length === 1 ? '' : 's'}, reproduce the failure locally, and push a fix.`
    : `PR ${prLabel} is blocked from merging. Please check the merge state / required ` +
      `reviews and resolve what's blocking it.`

  const conclusionTag = ci?.status ?? (summary.fail > 0 ? 'failed' : 'unknown')
  const key = `ci-status:${pr.number}:${pr.headRefOid ?? ''}:${conclusionTag}`

  return { shouldOffer, summary: headline, detail, suggestedPrompt, key }
}
