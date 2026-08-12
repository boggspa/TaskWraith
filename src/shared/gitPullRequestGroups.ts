const TASKWRAITH_COMMIT_GROUP_PATTERN =
  /(?:\r?\n)*<!--\s*taskwraith-commit-group:v1\s+([0-9a-f\s]+?)\s*-->/gi

function normalizedHashes(values: readonly string[]): string[] {
  const hashes = new Set<string>()
  for (const value of values) {
    const hash = value.trim().toLowerCase()
    if (/^[0-9a-f]{40}$/.test(hash)) hashes.add(hash)
  }
  return Array.from(hashes)
}

/** Original checkout commits represented by a TaskWraith-created PR branch. */
export function taskWraithCommitGroupHashes(body: string | undefined): string[] {
  if (!body) return []
  const hashes: string[] = []
  for (const match of body.matchAll(TASKWRAITH_COMMIT_GROUP_PATTERN)) {
    hashes.push(...normalizedHashes((match[1] || '').split(/\s+/)))
  }
  return normalizedHashes(hashes)
}

/** Remove TaskWraith's machine-readable comment from the human body editor. */
export function stripTaskWraithCommitGroup(body: string | undefined): string {
  return (body || '').replace(TASKWRAITH_COMMIT_GROUP_PATTERN, '').trim()
}

/** Preserve a durable, invisible mapping from original hashes to the PR. */
export function withTaskWraithCommitGroup(
  body: string | undefined,
  commitHashes: readonly string[]
): string {
  const visibleBody = stripTaskWraithCommitGroup(body)
  const hashes = normalizedHashes(commitHashes)
  if (hashes.length === 0) return visibleBody
  const marker = `<!-- taskwraith-commit-group:v1 ${hashes.join(' ')} -->`
  return visibleBody ? `${visibleBody}\n\n${marker}` : marker
}
