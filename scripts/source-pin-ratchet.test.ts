import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { countIn } = require('./source-pin-ratchet.cjs') as {
  countIn: (source: string) => number
}

/** A file only pins SOURCE when it reads one, so every fixture reads one. */
const reading = (body: string): string =>
  `const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')\n${body}`

describe('byte-exact source-pin detector', () => {
  it('counts an escaped newline inside a quoted expected string', () => {
    expect(countIn(reading(`expect(source).toContain('a\\n      b')`))).toBe(1)
    expect(countIn(reading(`expect(source).toContain("a\\n      b")`))).toBe(1)
  })

  it('counts a template literal that spans lines', () => {
    expect(countIn(reading('expect(source).toContain(`a\n  b`)'))).toBe(1)
  })

  it('counts every pin in a file, not just the first', () => {
    expect(
      countIn(
        reading(
          `expect(source).toContain('a\\n b')\nexpect(source).toContain('c\\n d')\nexpect(source).toContain('e\\n f')`
        )
      )
    ).toBe(3)
  })

  // Collapsing whitespace makes a match MORE likely, so a negative converted
  // that way can start failing where it passed. They are equally brittle and
  // equally counted, but they must be migrated deliberately.
  it('counts a negative pin too', () => {
    expect(countIn(reading(`expect(source).not.toContain('a\\n      b')`))).toBe(1)
  })

  it('does not count a single-line pin', () => {
    expect(countIn(reading(`expect(source).toContain('mode: steer')`))).toBe(0)
  })

  it('does not count a squashed comparison, which is the fixed form', () => {
    expect(
      countIn(reading(`expect(source.replace(/\\s+/g, '')).toContain('a b'.replace(/\\s+/g, ''))`))
    ).toBe(0)
  })

  // The count is about SOURCE pins. A multi-line expectation over a value the
  // test computed is ordinary assertion and must not be dragged in.
  it('ignores a file that never reads a source file', () => {
    expect(countIn(`expect(rendered).toContain('a\\n  b')`)).toBe(0)
    expect(countIn('expect(rendered).toContain(`a\n  b`)')).toBe(0)
  })

  it('reports zero for an empty file', () => {
    expect(countIn('')).toBe(0)
  })
})
