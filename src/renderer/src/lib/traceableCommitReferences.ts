import type { GitUnpushedCommit } from '../../../shared/gitUnpushedCommits'

export interface TraceableCommitIndex {
  complete: boolean
  byHash: ReadonlyMap<string, GitUnpushedCommit>
  sortedHashes: readonly string[]
}

export function buildTraceableCommitIndex(
  commits: readonly GitUnpushedCommit[],
  complete: boolean
): TraceableCommitIndex {
  const byHash = new Map<string, GitUnpushedCommit>()
  for (const commit of commits) byHash.set(commit.hash.toLowerCase(), commit)
  return {
    complete,
    byHash,
    sortedHashes: Array.from(byHash.keys()).sort()
  }
}

function lowerBound(values: readonly string[], target: string): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (values[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}

export function resolveTraceableCommitReference(
  index: TraceableCommitIndex,
  candidate: string
): GitUnpushedCommit | null {
  const normalized = candidate.trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/u.test(normalized)) return null
  if (normalized.length === 40) return index.byHash.get(normalized) ?? null
  if (!index.complete) return null

  const matchIndex = lowerBound(index.sortedHashes, normalized)
  const hash = index.sortedHashes[matchIndex]
  if (!hash?.startsWith(normalized)) return null
  if (index.sortedHashes[matchIndex + 1]?.startsWith(normalized)) return null
  return index.byHash.get(hash) ?? null
}
