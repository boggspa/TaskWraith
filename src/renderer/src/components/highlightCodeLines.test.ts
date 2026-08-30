import { beforeEach, describe, expect, it } from 'vitest'
import {
  editorHighlightStyleRules,
  getHighlightParseCountForTest,
  highlightCodeToLineSpans,
  languageFromPath,
  resetHighlightCodeLinesCacheForTest
} from './highlightCodeLines'

function classForColor(rules: string, color: string): string | null {
  const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = rules.match(
    new RegExp(`\\.([\\w\\u0370-\\u03ff]+)\\s*\\{[^}]*color:\\s*${escaped}`)
  )
  return match?.[1] ?? null
}

describe('languageFromPath', () => {
  it('maps common editor extensions onto the CodeMirror language packs', () => {
    expect(languageFromPath('src/app.tsx')).toBe('tsx')
    expect(languageFromPath('src/lib/foo.ts')).toBe('typescript')
    expect(languageFromPath('Resources/Characters/npc.json')).toBe('json')
    expect(languageFromPath('script.py')).toBe('python')
    expect(languageFromPath('README')).toBe('')
  })
})

describe('highlightCodeToLineSpans', () => {
  beforeEach(() => {
    resetHighlightCodeLinesCacheForTest()
  })

  it('emits theme-token classes for a small TypeScript snippet', () => {
    const rules = editorHighlightStyleRules()
    expect(rules).toContain('var(--cm-keyword)')
    expect(rules).toContain('var(--cm-string)')

    const keywordClass = classForColor(rules, 'var(--cm-keyword)')
    const stringClass = classForColor(rules, 'var(--cm-string)')
    expect(keywordClass).toBeTruthy()
    expect(stringClass).toBeTruthy()

    const lines = highlightCodeToLineSpans('const value = "ok"', 'typescript')
    expect(lines).toHaveLength(1)
    const texts = lines[0].map((span) => span.text).join('')
    expect(texts).toBe('const value = "ok"')
    expect(lines[0].some((span) => span.className === keywordClass && span.text === 'const')).toBe(
      true
    )
    expect(
      lines[0].some((span) => span.className === stringClass && span.text.includes('ok'))
    ).toBe(true)
  })

  it('splits highlighted tokens onto separate lines', () => {
    const lines = highlightCodeToLineSpans('const a = 1\nconst b = 2', 'javascript')
    expect(lines.length).toBe(2)
    expect(lines[0].map((span) => span.text).join('')).toContain('const a')
    expect(lines[1].map((span) => span.text).join('')).toContain('const b')
  })

  it('falls back to plain text when the language pack is unknown', () => {
    const lines = highlightCodeToLineSpans('plain source', 'not-a-real-lang')
    expect(lines).toEqual([[{ text: 'plain source' }]])
  })

  it('parses once across repeated identical content', () => {
    highlightCodeToLineSpans('const value = 1', 'javascript')
    highlightCodeToLineSpans('const value = 1', 'javascript')
    expect(getHighlightParseCountForTest()).toBe(1)
  })
})
