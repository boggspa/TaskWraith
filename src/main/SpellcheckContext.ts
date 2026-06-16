import type { ContextMenuParams } from 'electron'

export interface SpellcheckContextSnapshot {
  x: number
  y: number
  misspelledWord: string
  dictionarySuggestions: string[]
  createdAt: number
}

const MAX_WORD_LENGTH = 80
const MAX_SUGGESTIONS = 8
const MAX_CONTEXT_AGE_MS = 1500
const MAX_COORDINATE_DELTA_PX = 28

function finiteCoordinate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.round(value))
}

function sanitizeSpellcheckText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().slice(0, MAX_WORD_LENGTH)
  return normalized ? normalized : null
}

export function sanitizeSpellcheckContext(
  params: Pick<ContextMenuParams, 'x' | 'y' | 'misspelledWord' | 'dictionarySuggestions'>,
  createdAt = Date.now()
): SpellcheckContextSnapshot | null {
  const misspelledWord = sanitizeSpellcheckText(params.misspelledWord)
  if (!misspelledWord) return null

  const x = finiteCoordinate(params.x)
  const y = finiteCoordinate(params.y)
  if (x === null || y === null) return null

  const dictionarySuggestions = Array.isArray(params.dictionarySuggestions)
    ? params.dictionarySuggestions
        .map((suggestion) => sanitizeSpellcheckText(suggestion))
        .filter((suggestion): suggestion is string => Boolean(suggestion))
        .filter((suggestion, index, suggestions) => suggestions.indexOf(suggestion) === index)
        .slice(0, MAX_SUGGESTIONS)
    : []

  return {
    x,
    y,
    misspelledWord,
    dictionarySuggestions,
    createdAt
  }
}

export function spellcheckContextMatchesPoint(
  snapshot: SpellcheckContextSnapshot | null | undefined,
  point: unknown,
  now = Date.now()
): snapshot is SpellcheckContextSnapshot {
  if (!snapshot || now - snapshot.createdAt > MAX_CONTEXT_AGE_MS) return false
  if (!point || typeof point !== 'object') return false
  const candidate = point as { x?: unknown; y?: unknown }
  const x = finiteCoordinate(candidate.x)
  const y = finiteCoordinate(candidate.y)
  if (x === null || y === null) return false
  return (
    Math.abs(snapshot.x - x) <= MAX_COORDINATE_DELTA_PX &&
    Math.abs(snapshot.y - y) <= MAX_COORDINATE_DELTA_PX
  )
}
