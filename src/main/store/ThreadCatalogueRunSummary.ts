import type { ChatRun } from './types'
import { copyThreadCatalogueLastRun } from './ThreadCatalogueChrome'

/** Historical analytics are derived once beside the decoder, not on sidebar reads. */
export function projectThreadCatalogueRunSummary(run: ChatRun) {
  const files = new Set<string>()
  const add = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value)
      if (typeof entry?.path === 'string' && entry.path.trim()) files.add(entry.path.trim())
  }
  for (const key of ['createdFiles', 'modifiedFiles', 'deletedFiles', 'preExistingFiles'])
    add(run.runDiff?.[key])
  for (const entries of Object.values(run.runDiffByPath ?? {})) add(entries)
  const stats: Record<string, unknown> = {}
  if (run.provider === 'ollama' && run.stats && typeof run.stats === 'object') {
    for (const key of ['ollamaMemoryPeakRssGb', 'ollamaMemoryRssGb', 'ollamaMemorySampleCount']) {
      const value = Number(run.stats[key])
      if (Number.isFinite(value) && value > 0) stats[key] = value
    }
    const ram: Record<string, number> = {}
    for (const key of ['peakRssGb', 'rssGb', 'sampleCount']) {
      const value = Number(run.stats.hardware?.ram?.[key])
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
