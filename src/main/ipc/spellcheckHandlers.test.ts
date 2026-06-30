import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { SpellcheckContextSnapshot } from '../SpellcheckContext'
import { registerSpellcheckHandlers, type SpellcheckHandlersDeps } from './spellcheckHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function makeSnapshot(overrides: Partial<SpellcheckContextSnapshot> = {}): SpellcheckContextSnapshot {
  return {
    x: 100,
    y: 200,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the', 'tech'],
    createdAt: Date.now(),
    ...overrides
  }
}

function createDeps() {
  let latestSnapshot: SpellcheckContextSnapshot | null = makeSnapshot()
  const getLatestSpellcheckContext = vi.fn(() => latestSnapshot)
  const spellcheckContextIncludesSuggestion = vi.fn(
    (snapshot: SpellcheckContextSnapshot, suggestion: string) =>
      snapshot.dictionarySuggestions.includes(suggestion)
  )
  const deps = {
    isRecord(value: unknown): value is Record<string, unknown> {
      return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    },
    getLatestSpellcheckContext,
    spellcheckContextMatchesPoint(
      snapshot: SpellcheckContextSnapshot | null | undefined,
      point: unknown
    ): snapshot is SpellcheckContextSnapshot {
      return Boolean(
        snapshot &&
          point &&
          typeof point === 'object' &&
          (point as { x?: number; y?: number }).x === snapshot.x &&
          (point as { x?: number; y?: number }).y === snapshot.y
      )
    },
    spellcheckContextIncludesSuggestion
  } satisfies SpellcheckHandlersDeps

  const sender = {
    id: 123,
    replaceMisspelling: vi.fn(),
    session: {
      addWordToSpellCheckerDictionary: vi.fn(() => true)
    }
  }

  return {
    deps,
    sender,
    setLatestSnapshot(next: SpellcheckContextSnapshot | null) {
      latestSnapshot = next
    }
  }
}

describe('registerSpellcheckHandlers', () => {
  it('registers spellcheck IPC channels', () => {
    registerSpellcheckHandlers(createDeps().deps)

    expect(handlerFor('spellcheck:get-last-context')).toBeTypeOf('function')
    expect(handlerFor('spellcheck:replace-misspelling')).toBeTypeOf('function')
    expect(handlerFor('spellcheck:add-word-to-dictionary')).toBeTypeOf('function')
  })

  it('get-last-context returns the latest snapshot only when the point matches', () => {
    const { deps, sender } = createDeps()
    registerSpellcheckHandlers(deps)

    const snapshot = handlerFor('spellcheck:get-last-context')(
      { sender },
      { x: 100, y: 200 }
    )
    expect(snapshot).toMatchObject({ misspelledWord: 'teh' })

    expect(handlerFor('spellcheck:get-last-context')({ sender }, { x: 1, y: 2 })).toBeNull()
  })

  it('replace-misspelling returns stale-context when the snapshot is missing or input is not a record', () => {
    const { deps, sender, setLatestSnapshot } = createDeps()
    registerSpellcheckHandlers(deps)

    setLatestSnapshot(null)
    expect(
      handlerFor('spellcheck:replace-misspelling')({ sender }, { point: { x: 100, y: 200 } })
    ).toEqual({
      ok: false,
      reason: 'stale-context'
    })

    setLatestSnapshot(makeSnapshot())
    expect(handlerFor('spellcheck:replace-misspelling')({ sender }, null)).toEqual({
      ok: false,
      reason: 'stale-context'
    })
  })

  it('replace-misspelling preserves invalid-suggestion, 80-char slice, and mismatch behavior', () => {
    const { deps, sender } = createDeps()
    registerSpellcheckHandlers(deps)

    expect(
      handlerFor('spellcheck:replace-misspelling')({ sender }, {
        point: { x: 100, y: 200 },
        suggestion: '   '
      })
    ).toEqual({
      ok: false,
      reason: 'invalid-suggestion'
    })
    expect(
      handlerFor('spellcheck:replace-misspelling')({ sender }, {
        point: { x: 100, y: 200 },
        suggestion: 42
      })
    ).toEqual({
      ok: false,
      reason: 'invalid-suggestion'
    })

    const longSuggestion = 'the'.padEnd(120, 'x')
    deps.spellcheckContextIncludesSuggestion.mockImplementationOnce((_snapshot, suggestion) => {
      expect(suggestion.length).toBe(80)
      return false
    })
    expect(
      handlerFor('spellcheck:replace-misspelling')({ sender }, {
        point: { x: 100, y: 200 },
        suggestion: longSuggestion
      })
    ).toEqual({
      ok: false,
      reason: 'suggestion-mismatch'
    })
    expect(sender.replaceMisspelling).not.toHaveBeenCalled()
  })

  it('replace-misspelling calls the live sender on success', () => {
    const { deps, sender } = createDeps()
    registerSpellcheckHandlers(deps)

    expect(
      handlerFor('spellcheck:replace-misspelling')({ sender }, {
        point: { x: 100, y: 200 },
        suggestion: '  the  '
      })
    ).toEqual({ ok: true })
    expect(sender.replaceMisspelling).toHaveBeenCalledWith('the')
  })

  it('add-word-to-dictionary returns stale-context on miss and { ok } on success', () => {
    const { deps, sender, setLatestSnapshot } = createDeps()
    registerSpellcheckHandlers(deps)

    setLatestSnapshot(null)
    expect(
      handlerFor('spellcheck:add-word-to-dictionary')({ sender }, { point: { x: 100, y: 200 } })
    ).toEqual({
      ok: false,
      reason: 'stale-context'
    })

    setLatestSnapshot(makeSnapshot())
    expect(
      handlerFor('spellcheck:add-word-to-dictionary')({ sender }, { point: { x: 100, y: 200 } })
    ).toEqual({
      ok: true
    })
    expect(sender.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('teh')

    sender.session.addWordToSpellCheckerDictionary.mockReturnValueOnce(false)
    expect(
      handlerFor('spellcheck:add-word-to-dictionary')({ sender }, { point: { x: 100, y: 200 } })
    ).toEqual({
      ok: false
    })
  })
})
