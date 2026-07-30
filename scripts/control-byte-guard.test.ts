import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

// NOTE FOR FUTURE EDITORS: every fixture in this file builds its control bytes
// from Buffer.from([...]) or an escape sequence. Do NOT paste a raw control
// byte in here to "make the fixture realistic" — this file is itself scanned by
// the guard, and unlike the platform-portability guard there is deliberately no
// fixture-corpus pragma to exempt it. That is the point: the one file that
// tests for invisible bytes must contain none.
const guard = require('./control-byte-guard.cjs') as {
  C0_NAMES: string[]
  MAX_REPORTED_PER_FILE: number
  MIN_EXPECTED_FILES: number
  SCANNED_EXTENSIONS: string[]
  findControlBytes: (
    buffer: Buffer,
    repoPath: string
  ) => Array<{
    file: string
    line: number
    column: number
    byte: number
    name: string
    truncated?: boolean
  }>
  isForbiddenByte: (byte: number) => boolean
  listScannableFiles: () => string[]
  scan: (files: string[]) => unknown[]
  selfTest: () => void
}

describe('control-byte-guard byte classification', () => {
  it('allows exactly the three whitespace controls', () => {
    const allowed = [0x09, 0x0a, 0x0d]
    for (let byte = 0x00; byte <= 0x1f; byte += 1) {
      expect(guard.isForbiddenByte(byte)).toBe(!allowed.includes(byte))
    }
  })

  it('does not reach above the C0 range', () => {
    // DEL and printable ASCII are deliberately out of scope; see the header.
    for (const byte of [0x20, 0x41, 0x7e, 0x7f, 0x80, 0xff]) {
      expect(guard.isForbiddenByte(byte)).toBe(false)
    }
  })
})

describe('control-byte-guard detection', () => {
  it('finds the NUL that motivated the guard', () => {
    // `${a}\0${b}` written with a literal byte instead of an escape.
    const source = Buffer.concat([
      Buffer.from('const key = `${a}', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from('${b}`\n', 'utf8')
    ])
    const findings = guard.findControlBytes(source, 'src/example.ts')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: 'src/example.ts',
      line: 1,
      column: 18,
      byte: 0x00,
      name: 'NUL'
    })
  })

  it('reports nothing for an escape sequence spelling the same character', () => {
    const source = Buffer.from('const key = `${a}\\u0000${b}`\n', 'utf8')
    expect(guard.findControlBytes(source, 'src/example.ts')).toEqual([])
  })

  it('reports nothing for tabs, CRLF, or ordinary UTF-8', () => {
    const source = Buffer.from('\tconst s = "café — ok"\r\n\tconst t = 1\r\n', 'utf8')
    expect(guard.findControlBytes(source, 'src/example.ts')).toEqual([])
  })

  it('counts lines from LF only, so a CR does not desynchronise the report', () => {
    const source = Buffer.concat([
      Buffer.from('one\r\ntwo\r\nthree', 'utf8'),
      Buffer.from([0x1b]),
      Buffer.from('rest\n', 'utf8')
    ])
    const findings = guard.findControlBytes(source, 'src/example.ts')
    expect(findings).toHaveLength(1)
    expect(findings[0].line).toBe(3)
    expect(findings[0].name).toBe('ESC')
    expect(findings[0].column).toBe(6)
  })

  it('names every C0 control it reports', () => {
    for (let byte = 0x00; byte <= 0x1f; byte += 1) {
      if (!guard.isForbiddenByte(byte)) continue
      const findings = guard.findControlBytes(Buffer.from([0x61, byte]), 'src/example.ts')
      expect(findings).toHaveLength(1)
      expect(findings[0].name).toBe(guard.C0_NAMES[byte])
      expect(findings[0].name).toMatch(/^[A-Z]{2,3}[0-9]?$/)
    }
  })

  it('caps per-file output and flags that it stopped listing', () => {
    const bytes: number[] = []
    for (let i = 0; i < guard.MAX_REPORTED_PER_FILE + 5; i += 1) bytes.push(0x61, 0x00)
    const findings = guard.findControlBytes(Buffer.from(bytes), 'src/example.ts')
    expect(findings).toHaveLength(guard.MAX_REPORTED_PER_FILE)
    // The flag rides the last finding so it survives scan()'s flat spread.
    expect(findings[findings.length - 1].truncated).toBe(true)
  })
})

describe('control-byte-guard self-test', () => {
  it('passes against its own fixtures', () => {
    expect(() => guard.selfTest()).not.toThrow()
  })
})

describe('control-byte-guard discovery', () => {
  it('finds a plausible number of files, well above the vacuous-pass floor', () => {
    const files = guard.listScannableFiles()
    expect(files.length).toBeGreaterThanOrEqual(guard.MIN_EXPECTED_FILES)
    // Discovery must include untracked files, so a brand-new file with a stray
    // byte cannot hide from the gate.
    expect(guard.SCANNED_EXTENSIONS).toContain('*.ts')
    expect(new Set(files).size).toBe(files.length)
  })

  it('reports the live tree as clean', () => {
    // The absolute assertion. There is no baseline and no pragma: if this ever
    // fails, a control byte landed in source and must be removed, not accepted.
    expect(guard.scan(guard.listScannableFiles())).toEqual([])
  })
})
