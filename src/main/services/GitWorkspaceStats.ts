export const GIT_WORKSPACE_HISTORY_SAMPLE_LIMIT = 100_000

export interface GitWorkspaceStats {
  repoRoot: string
  observedAt: string
  coherent: boolean
  coherenceReason?: string
  totalCommits: number | null
  localBranchCount: number | null
  attachedWorktreeCount: number | null
  trackedLines: number | null
  activeDays: number | null
  historySpanDays: number | null
  commitsPerActiveDay: number | null
  historyTruncated: boolean
  latestCommit?: {
    hash: string
    authoredOn: string
    subject: string
  }
  latestTag?: string
  commitsSinceLatestTag: number | null
}

export interface GitWorkspaceHistorySummary {
  activeDays: number | null
  historySpanDays: number | null
  commitsPerActiveDay: number | null
  historyTruncated: boolean
}

export function parseNonNegativeGitCount(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) return null
  const count = Number(normalized)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

export function summarizeGitCommitActivity(input: {
  stdout: string
  totalCommits: number | null
  observedAt: string
  sampleLimit?: number
}): GitWorkspaceHistorySummary {
  const sampleLimit = Math.max(
    1,
    Math.trunc(input.sampleLimit ?? GIT_WORKSPACE_HISTORY_SAMPLE_LIMIT)
  )
  const dates = input.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
  const historyTruncated =
    dates.length > sampleLimit || (input.totalCommits !== null && input.totalCommits > sampleLimit)
  const sampledDates = dates.slice(0, sampleLimit)
  const activeDays = new Set(sampledDates).size

  if (input.totalCommits === 0) {
    return {
      activeDays: 0,
      historySpanDays: 0,
      commitsPerActiveDay: 0,
      historyTruncated: false
    }
  }
  if (sampledDates.length === 0) {
    return {
      activeDays: null,
      historySpanDays: null,
      commitsPerActiveDay: null,
      historyTruncated
    }
  }

  const oldestSampledDate = sampledDates[sampledDates.length - 1]
  const newestSampledDate = sampledDates[0]
  // Git emits commit days in the committer's local calendar while observedAt is
  // UTC, so right after local midnight (or with future-timezone committers) the
  // newest commit day can post-date the observation day. Span to whichever end
  // is later; the YYYY-MM-DD shape makes the string compare safe.
  const observedDate = input.observedAt.slice(0, 10)
  const spanEndDate = newestSampledDate > observedDate ? newestSampledDate : observedDate
  const historySpanDays = historyTruncated
    ? null
    : inclusiveCalendarDaySpan(oldestSampledDate, spanEndDate)
  const commitsPerActiveDay =
    historyTruncated || input.totalCommits === null || activeDays === 0
      ? null
      : input.totalCommits / activeDays

  return {
    activeDays,
    historySpanDays,
    commitsPerActiveDay,
    historyTruncated
  }
}

/**
 * `git grep -I -c -z -e '' -- .` emits `path\0count\n` for every tracked
 * text file with at least one line. Empty text files contribute zero and are
 * intentionally absent; binary files are excluded by `-I`.
 */
export function parseGitGrepTrackedLines(stdout: string): number | null {
  let total = 0
  let matched = false
  const counts = /\0(\d+)(?:\r?\n|$)/g
  for (const match of stdout.matchAll(counts)) {
    const count = Number(match[1])
    if (!Number.isSafeInteger(count) || count < 0) return null
    total += count
    if (!Number.isSafeInteger(total)) return null
    matched = true
  }
  return matched || stdout.length === 0 ? total : null
}

function inclusiveCalendarDaySpan(first: string, last: string): number | null {
  const firstMs = Date.parse(`${first}T00:00:00.000Z`)
  const lastMs = Date.parse(`${last}T00:00:00.000Z`)
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs < firstMs) return null
  return Math.floor((lastMs - firstMs) / 86_400_000) + 1
}
