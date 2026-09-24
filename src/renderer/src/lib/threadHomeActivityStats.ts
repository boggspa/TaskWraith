import type { ChatRecord, ChatRun, DiffFileSummary } from '../../../main/store/types'
import { getLiveToolFileDiffSummaries } from './LiveFileDiffSummary'
import { selectCompletionRunIds, selectRunEvidenceMessages } from './RunWorkspaceDiff'
import { buildLiveToolFileSummarySignature } from './liveToolFileSummarySignature'
import { collectCloseoutCommits } from './taskWraithCloseoutMessage'

export interface ThreadHomeRunStats {
  filesChanged: number
  additions: number
  deletions: number
  hasLineStats: boolean
  commits: number
}

interface ThreadHomeRunStatsCacheEntry {
  runKey: string
  workspacePath: string
  evidenceSignature: string
  exactSignature: string
  value: ThreadHomeRunStats | null
}

const TERMINAL_RUN_STATUSES = new Set([
  'cancelled',
  'canceled',
  'completed',
  'done',
  'error',
  'failed',
  'failure',
  'requires_action',
  'success',
  'succeeded',
  'success_with_warnings'
])
const THREAD_HOME_RUN_STATS_CACHE_LIMIT = 24
const statsCache = new Map<string, ThreadHomeRunStatsCacheEntry>()

function runIsOpen(run: ChatRun): boolean {
  return !run.endedAt && !TERMINAL_RUN_STATUSES.has((run.status || '').toLowerCase())
}

function activeRunIds(chat: ChatRecord): Set<string> {
  const runs = chat.runs || []
  const activeRound = chat.chatKind === 'ensemble' ? chat.ensemble?.activeRound : null
  if (activeRound?.status === 'running') {
    const currentRoundRun = [...runs]
      .reverse()
      .find((run) => run.ensembleRoundId === activeRound.roundId)
    return selectCompletionRunIds(
      chat,
      currentRoundRun || { runId: '', ensembleRoundId: activeRound.roundId }
    )
  }

  const currentRun = [...runs].reverse().find(runIsOpen)
  return currentRun ? selectCompletionRunIds(chat, currentRun) : new Set<string>()
}

function normalizedSummaryPath(path: string, workspacePath?: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  const workspace = workspacePath?.trim().replace(/\\/g, '/').replace(/\/$/, '')
  return workspace && normalized.startsWith(`${workspace}/`)
    ? normalized.slice(workspace.length + 1)
    : normalized
}

function exactRunSummaries(run: ChatRun): DiffFileSummary[] {
  const primary = run.runDiff
    ? [...run.runDiff.createdFiles, ...run.runDiff.modifiedFiles, ...run.runDiff.deletedFiles]
    : []
  const additional = Object.entries(run.runDiffByPath || {}).flatMap(
    ([workspacePath, summaries]) =>
      Array.isArray(summaries)
        ? summaries.map((summary) => ({
            ...summary,
            path: `${workspacePath.replace(/[\\/]$/, '')}/${summary.path.replace(/^[\\/]/, '')}`
          }))
        : []
  )
  return [...primary, ...additional].filter((summary) => summary && !summary.isNoise)
}

function preferExactSummaries(
  live: DiffFileSummary[],
  exact: DiffFileSummary[],
  workspacePath?: string
): DiffFileSummary[] {
  const byPath = new Map(
    live.map((summary) => [normalizedSummaryPath(summary.path, workspacePath), summary])
  )
  for (const summary of exact) {
    byPath.set(normalizedSummaryPath(summary.path, workspacePath), summary)
  }
  return [...byPath.values()]
}

function runIsTerminal(run: ChatRun): boolean {
  return Boolean(run.endedAt) || TERMINAL_RUN_STATUSES.has((run.status || '').toLowerCase())
}

function summarySignature(summaries: readonly DiffFileSummary[]): string {
  let hash = 0x811c9dc5
  let length = 0
  for (const summary of summaries) {
    const value = `${summary.path}\u0001${summary.status}\u0001${summary.additions ?? ''}\u0001${summary.deletions ?? ''}`
    length += value.length
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
    }
  }
  return `${summaries.length}.${length}.${(hash >>> 0).toString(36)}`
}

function mergeSummaries(
  live: DiffFileSummary[],
  fallback: DiffFileSummary[],
  workspacePath?: string
): DiffFileSummary[] {
  const merged = new Map<string, DiffFileSummary>()
  const add = (summary: DiffFileSummary): void => {
    const key = normalizedSummaryPath(summary.path, workspacePath)
    if (!key) return
    const current = merged.get(key)
    if (!current) {
      merged.set(key, summary)
      return
    }
    const additions =
      current.additions === undefined && summary.additions === undefined
        ? undefined
        : (current.additions || 0) + (summary.additions || 0)
    const deletions =
      current.deletions === undefined && summary.deletions === undefined
        ? undefined
        : (current.deletions || 0) + (summary.deletions || 0)
    merged.set(key, { ...current, additions, deletions })
  }
  live.forEach(add)
  fallback.forEach(add)
  return [...merged.values()]
}

function remember(chatId: string, entry: ThreadHomeRunStatsCacheEntry): ThreadHomeRunStats | null {
  statsCache.delete(chatId)
  statsCache.set(chatId, entry)
  if (statsCache.size > THREAD_HOME_RUN_STATS_CACHE_LIMIT) {
    const oldest = statsCache.keys().next().value
    if (oldest) statsCache.delete(oldest)
  }
  return entry.value
}

/** Compact, receipt-backed activity for the run or Ensemble round live now. */
export function threadHomeRunStats(chat: ChatRecord): ThreadHomeRunStats | null {
  const runIds = activeRunIds(chat)
  if (runIds.size === 0) {
    statsCache.delete(chat.appChatId)
    return null
  }

  const runKey = [...runIds].sort().join(',')
  const workspacePath = chat.workspacePath || ''
  const evidence = selectRunEvidenceMessages(chat.messages, {
    runIds,
    runs: chat.runs
  })
  const evidenceSignature = buildLiveToolFileSummarySignature(evidence)
  const hasLegacyEvidence = evidence.some((message) => !message.runId)
  const exactByRunId = new Map<string, DiffFileSummary[]>()
  if (!hasLegacyEvidence) {
    for (const run of chat.runs || []) {
      if (!runIds.has(run.runId) || !runIsTerminal(run)) continue
      const summaries = exactRunSummaries(run)
      if (summaries.length === 0) continue
      exactByRunId.set(run.runId, summaries)
    }
  }
  const exact = [...exactByRunId.values()].flat()
  const exactSignature = summarySignature(exact)
  const cached = statsCache.get(chat.appChatId)
  if (
    cached?.runKey === runKey &&
    cached.workspacePath === workspacePath &&
    cached.evidenceSignature === evidenceSignature &&
    cached.exactSignature === exactSignature
  ) {
    return cached.value
  }

  const evidenceByRunId = new Map<string, typeof evidence>()
  const legacyEvidence: typeof evidence = []
  for (const message of evidence) {
    if (!message.runId) {
      legacyEvidence.push(message)
      continue
    }
    const messages = evidenceByRunId.get(message.runId) || []
    messages.push(message)
    evidenceByRunId.set(message.runId, messages)
  }
  const perRunSummaries: DiffFileSummary[] = []
  for (const runId of runIds) {
    const live = getLiveToolFileDiffSummaries(
      evidenceByRunId.get(runId) || [],
      workspacePath
    ).filter((summary) => !summary.isNoise)
    const exactForRun = exactByRunId.get(runId)
    perRunSummaries.push(
      ...(exactForRun ? preferExactSummaries(live, exactForRun, workspacePath) : live)
    )
  }
  if (legacyEvidence.length > 0) {
    perRunSummaries.push(
      ...getLiveToolFileDiffSummaries(legacyEvidence, workspacePath).filter(
        (summary) => !summary.isNoise
      )
    )
  }
  const summaries = mergeSummaries([], perRunSummaries, workspacePath)
  const hasLineStats =
    summaries.length > 0 &&
    summaries.every((summary) => summary.additions !== undefined || summary.deletions !== undefined)
  const commits = collectCloseoutCommits(evidence, () => true, { chat }).length
  const value: ThreadHomeRunStats | null =
    summaries.length > 0 || commits > 0
      ? {
          filesChanged: summaries.length,
          additions: summaries.reduce((total, summary) => total + (summary.additions || 0), 0),
          deletions: summaries.reduce((total, summary) => total + (summary.deletions || 0), 0),
          hasLineStats,
          commits
        }
      : null

  return remember(chat.appChatId, {
    runKey,
    workspacePath,
    evidenceSignature,
    exactSignature,
    value
  })
}
