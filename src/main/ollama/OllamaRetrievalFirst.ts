/**
 * Retrieval-first is RETIRED. This set is intentionally empty.
 *
 * The gate hard-blocked `read_file` before an explore call, and edits before a
 * read, for whichever families were listed here. Three things were wrong with
 * it, and they are why it is off rather than merely trimmed:
 *
 *   1. It was a REFUSAL, not a nudge. A blocked call costs the model a turn and
 *      teaches it nothing, and small models frequently looped against it —
 *      which is the opposite of the protection it was meant to provide.
 *   2. Family name is a poor proxy for capability. The same family ships 3B and
 *      30B variants, and membership was matched by normalized SUBSTRING, so
 *      `granite4_1_3b` and `granite4_1_30b` differ by a single character.
 *   3. It was invisible. Renaming a test's stand-in model to a listed family
 *      silently switched the gate on, and the symptom surfaced as "tool repair
 *      is broken" rather than "a gate blocked you".
 *
 * Capability is the user's call: they pick the model and the permission tier,
 * and an under-powered model on an epic task shows its own pitfalls. The
 * read-before-edit habit is still ENCOURAGED in the model profile prompts,
 * where it belongs — as advice the model can weigh, not a wall.
 *
 * Re-adding a family here re-arms the gate for it, so do that only with
 * measured evidence that a specific model is better off walled in.
 */
export const RETRIEVAL_FIRST_FAMILIES = new Set<string>([])

export const EXEMPT_READ_PATHS = new Set([
  'readme.md',
  'readme',
  'license',
  'license.md',
  'changelog.md',
  'package.json',
  'cargo.toml',
  'go.mod'
])

export function ollamaEnforcesRetrievalFirst(modelId?: string | null): boolean {
  const raw = String(modelId || '')
    .trim()
    .toLowerCase()
  // Normalize both the modelId and family names for matching: replace underscores and hyphens
  const normalizedRaw = raw.replace(/[-_.:]/g, '')
  for (const family of RETRIEVAL_FIRST_FAMILIES) {
    const normalizedFamily = family.toLowerCase().replace(/[-_.:]/g, '')
    if (normalizedRaw.includes(normalizedFamily)) return true
  }
  return false
}

function basenamePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  return (parts[parts.length - 1] || normalized).toLowerCase()
}

export function ollamaReadFileExemptFromRetrievalFirst(pathValue: string): boolean {
  const base = basenamePath(pathValue).toLowerCase()
  return EXEMPT_READ_PATHS.has(base)
}

export function ollamaSuggestedSearchQueryForRead(pathValue: string): string {
  const base = basenamePath(pathValue).replace(/\.[^.]+$/, '')
  return base || pathValue
}

export function ollamaRetrievalFirstBlockedMessage(pathValue: string): string {
  const query = ollamaSuggestedSearchQueryForRead(pathValue)
  return [
    'Retrieval-first policy: run workspace_search or list_directory before read_file on unfamiliar paths.',
    `Suggested next step: workspace_search({"query":"${query}","path":".","maxResults":25,"contextLines":1})`,
    'Then read only the highest-ranked file you actually need.'
  ].join(' ')
}
