import { ipcMain } from 'electron'
import type { SpellcheckContextSnapshot } from '../SpellcheckContext'

interface SpellcheckSender {
  id: number
  replaceMisspelling: (replacement: string) => void
  session: {
    addWordToSpellCheckerDictionary: (word: string) => boolean
  }
}

interface SpellcheckEventLike {
  sender: SpellcheckSender
}

export interface SpellcheckHandlersDeps {
  isRecord: (value: unknown) => value is Record<string, unknown>
  getLatestSpellcheckContext: (webContentsId: number) => SpellcheckContextSnapshot | null
  spellcheckContextMatchesPoint: (
    snapshot: SpellcheckContextSnapshot | null | undefined,
    point: unknown,
    now?: number
  ) => snapshot is SpellcheckContextSnapshot
  spellcheckContextIncludesSuggestion: (
    snapshot: SpellcheckContextSnapshot,
    suggestion: string
  ) => boolean
}

function currentSpellcheckContextForAction(
  deps: SpellcheckHandlersDeps,
  webContentsId: number,
  input: unknown
): SpellcheckContextSnapshot | null {
  if (!deps.isRecord(input)) return null
  const point = deps.isRecord(input.point) ? input.point : null
  const snapshot = deps.getLatestSpellcheckContext(webContentsId)
  return deps.spellcheckContextMatchesPoint(snapshot, point) ? snapshot : null
}

export function registerSpellcheckHandlers(deps: SpellcheckHandlersDeps): void {
  ipcMain.handle('spellcheck:get-last-context', (event: SpellcheckEventLike, point: unknown) => {
    const snapshot = deps.getLatestSpellcheckContext(event.sender.id)
    return deps.spellcheckContextMatchesPoint(snapshot, point) ? snapshot : null
  })

  ipcMain.handle('spellcheck:replace-misspelling', (event: SpellcheckEventLike, input: unknown) => {
    const snapshot = currentSpellcheckContextForAction(deps, event.sender.id, input)
    if (!snapshot || !deps.isRecord(input)) {
      return { ok: false, reason: 'stale-context' as const }
    }
    const rawSuggestion = typeof input.suggestion === 'string' ? input.suggestion.trim() : ''
    if (!rawSuggestion) {
      return { ok: false, reason: 'invalid-suggestion' as const }
    }
    const replacement = rawSuggestion.slice(0, 80)
    if (!deps.spellcheckContextIncludesSuggestion(snapshot, replacement)) {
      return { ok: false, reason: 'suggestion-mismatch' as const }
    }
    event.sender.replaceMisspelling(replacement)
    return { ok: true as const }
  })

  ipcMain.handle('spellcheck:add-word-to-dictionary', (event: SpellcheckEventLike, input: unknown) => {
    const snapshot = currentSpellcheckContextForAction(deps, event.sender.id, input)
    if (!snapshot) {
      return { ok: false, reason: 'stale-context' as const }
    }
    const ok = event.sender.session.addWordToSpellCheckerDictionary(snapshot.misspelledWord)
    return { ok }
  })
}
