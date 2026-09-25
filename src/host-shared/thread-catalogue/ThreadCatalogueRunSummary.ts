import { copyThreadCatalogueLastRun } from './ThreadCatalogueChrome'

/**
 * The run fields the summary reads beyond the bounded copy. Desktop's
 * `ChatRun` and the Host's committed runs both satisfy it, so the decoder and
 * the Host's thread record effect model derive one summary.
 */
export interface ThreadCatalogueRunSummarySource {
  readonly provider?: unknown
  readonly runDiff?: unknown
  readonly runDiffByPath?: unknown
  readonly stats?: unknown
}

type RunSummaryStats = Record<string, unknown> & {
  hardware?: { ram?: Record<string, unknown> }
}

/** Historical analytics are derived once beside the decoder, not on sidebar reads. */
export function projectThreadCatalogueRunSummary(run: ThreadCatalogueRunSummarySource) {
  const files = new Set<string>()
  const add = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value)
      if (typeof entry?.path === 'string' && entry.path.trim()) files.add(entry.path.trim())
  }
  const runDiff = run.runDiff as Record<string, unknown> | null | undefined
  for (const key of ['createdFiles', 'modifiedFiles', 'deletedFiles', 'preExistingFiles'])
    add(runDiff?.[key])
  for (const entries of Object.values((run.runDiffByPath ?? {}) as Record<string, unknown>))
    add(entries)
  const stats: Record<string, unknown> = {}
  if (run.provider === 'ollama' && run.stats && typeof run.stats === 'object') {
    const runStats = run.stats as RunSummaryStats
    for (const key of ['ollamaMemoryPeakRssGb', 'ollamaMemoryRssGb', 'ollamaMemorySampleCount']) {
      const value = Number(runStats[key])
      if (Number.isFinite(value) && value > 0) stats[key] = value
    }
    const ram: Record<string, number> = {}
    for (const key of ['peakRssGb', 'rssGb', 'sampleCount']) {
      const value = Number(runStats.hardware?.ram?.[key])
      if (Number.isFinite(value) && value > 0) ram[key] = value
    }
    if (Object.keys(ram).length) stats.hardware = { ram }
  }
  return {
    ...copyThreadCatalogueLastRun(run),
    diffFileCount: files.size,
    ...(Object.keys(stats).length ? { stats } : {})
  }
}

const TERMINAL_RUN_STATUSES = [
  'completed',
  'success',
  'succeeded',
  'failed',
  'error',
  'cancelled',
  'canceled'
]

/**
 * The catalogue's order facts for an indexed object with a string `runId`,
 * read from the object itself (for a run, its stored summary). A run is
 * active unless its status is terminal or its end parses; it is as recent as
 * its end, else its start, else 0. `run_summary_order` stores active as 1 or
 * 0 and a non-finite recency as 0.
 */
export function threadCatalogueRunOrder(
  record: Readonly<Record<string, unknown>>
): { catalogueActive: boolean; catalogueRecency: number } | undefined {
  if (typeof record.runId !== 'string') return undefined
  const ended = Date.parse(String(record.endedAt ?? ''))
  const started = Date.parse(String(record.startedAt ?? ''))
  return {
    catalogueActive:
      !TERMINAL_RUN_STATUSES.includes(String(record.status ?? '').toLowerCase()) &&
      !Number.isFinite(ended),
    catalogueRecency: Number.isFinite(ended) ? ended : Number.isFinite(started) ? started : 0
  }
}
