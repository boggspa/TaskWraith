/**
 * @portability-fixtures
 *
 * This file is a FIXTURE CORPUS: every rule's positive case must literally
 * contain the pattern that rule detects, so without the file-level pragma the
 * guard flags its own test seven times. The pragma is reserved for this shape
 * of file — deliberate platform assertions in real tests use the per-block
 * `@portability-ok` annotation instead.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Rule = {
  id: string
  summary: string
  why: string
  remedy: string
  test: (line: string) => boolean
  fixture: string
}

type Finding = { rule: string; file: string; line: number; text: string }

const { RULES, MIN_EXPECTED_TEST_FILES, findViolationsInSource, listTestFiles, selfTest } =
  require('./platform-portability-guard.cjs') as {
    RULES: Rule[]
    MIN_EXPECTED_TEST_FILES: number
    findViolationsInSource: (source: string, repoPath: string) => Finding[]
    listTestFiles: () => string[]
    selfTest: () => void
  }

const idsFor = (source: string): string[] =>
  findViolationsInSource(source, 'fixture.test.ts').map((finding) => finding.rule)

describe('platform-portability-guard rules', () => {
  it('every rule matches its own fixture', () => {
    // Guards the guard: an edit that breaks a regex would otherwise turn the
    // rule into a permanent silent pass.
    expect(() => selfTest()).not.toThrow()
  })

  it('every rule carries the operator context needed to act on a failure', () => {
    for (const rule of RULES) {
      expect(rule.id, 'rule id').toMatch(/^[a-z][a-z0-9-]*$/)
      expect(rule.summary.length, `${rule.id} summary`).toBeGreaterThan(10)
      expect(rule.why.length, `${rule.id} why`).toBeGreaterThan(20)
      expect(rule.remedy.length, `${rule.id} remedy`).toBeGreaterThan(20)
    }
  })

  it('rule ids are unique', () => {
    const ids = RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('detection', () => {
  it('flags a POSIX mode assertion against the real filesystem', () => {
    expect(idsFor('expect(fs.statSync(p).mode & 0o777).toBe(0o600)')).toContain('real-fs-mode')
  })

  it('ignores a mode field on an in-memory filesystem double', () => {
    // The decisive false-positive case: ~230 lines in this repo read a domain
    // field named `mode`, or a fake filesystem's entry, and are portable.
    expect(idsFor('expect(fakeFs.entries.get(p)?.mode).toBe(0o700)')).toEqual([])
    expect(idsFor("expect(loaded?.mode).toBe('quick')")).toEqual([])
  })

  it('flags a POSIX shebang written into a fixture', () => {
    expect(idsFor("writeFileSync(target, '#!/bin/sh\\nexit 0\\n')")).toContain('posix-shebang')
  })

  it('flags an expectation against an absolute POSIX system path', () => {
    expect(idsFor("expect(cmd).toBe('/usr/bin/tailscale')")).toContain(
      'system-path-literal-expectation'
    )
  })

  it('ignores fixture roots that are inputs to doubles', () => {
    expect(idsFor("expect(root).toBe('/repo/workspace')")).toEqual([])
    expect(idsFor("expect(dir).toBe('/tmp/staging')")).toEqual([])
  })

  it('flags an assertion that an inode DIFFERS after a recreate', () => {
    expect(idsFor('expect(fs.statSync(p).ino).not.toBe(originalInode)')).toContain('inode-identity')
  })

  it('ignores an inode EQUALITY assertion, which is portable everywhere', () => {
    // An in-place write through an open fd never changes the inode, on any
    // filesystem. Only the difference assertion is exposed to ext4's eager
    // reuse of freed inodes.
    expect(idsFor('expect(mutated.ino).toBe(original.ino)')).toEqual([])
    expect(
      idsFor('expect({ dev: a.dev, ino: a.ino }).toEqual({ dev: b.dev, ino: b.ino })')
    ).toEqual([])
  })

  it('flags a binary buffer compared structurally', () => {
    expect(idsFor('expect(logoBuffer).toEqual(expectedBuffer)')).toContain(
      'buffer-structural-equality'
    )
  })

  it('ignores a filename array whose identifier merely looks binary', () => {
    expect(idsFor("expect(designPngs).toEqual(['provider-glyph-ensemble.png'])")).toEqual([])
  })

  it('flags an assertion that OS credential encryption is available', () => {
    expect(idsFor('expect(safeStorage.isEncryptionAvailable()).toBe(true)')).toContain(
      'encryption-availability'
    )
  })

  it('flags an absolute interpreter path passed to a process call', () => {
    expect(idsFor("spawnSync('/bin/sh', args)")).toContain('executable-path-literal')
  })
})

describe('suppression', () => {
  it('respects a process.platform guard in the enclosing block', () => {
    const source = [
      "if (process.platform !== 'win32') {",
      '  expect(fs.statSync(p).mode & 0o777).toBe(0o600)',
      '}'
    ].join('\n')
    expect(idsFor(source)).toEqual([])
  })

  it('respects an explicit @portability-ok annotation', () => {
    const source = [
      '// @portability-ok: asserts the POSIX branch only, skipped elsewhere',
      'expect(fs.statSync(p).mode & 0o777).toBe(0o600)'
    ].join('\n')
    expect(idsFor(source)).toEqual([])
  })

  it('does not let a guard far above the line suppress it', () => {
    const source = [
      "if (process.platform !== 'win32') { /* unrelated, long ago */ }",
      ...Array.from({ length: 20 }, () => '// filler'),
      'expect(fs.statSync(p).mode & 0o777).toBe(0o600)'
    ].join('\n')
    expect(idsFor(source)).toContain('real-fs-mode')
  })

  it('ignores commented-out code', () => {
    expect(idsFor("// expect(cmd).toBe('/usr/bin/tailscale')")).toEqual([])
  })

  it('skips an entire file marked as a fixture corpus', () => {
    // Without this, the guard flags its own companion test seven times, since
    // each rule's positive case must literally contain the pattern it detects.
    const source = [
      '/** @portability-fixtures */',
      "expect(cmd).toBe('/usr/bin/tailscale')",
      'expect(fs.statSync(p).ino).not.toBe(orig)'
    ].join('\n')
    expect(idsFor(source)).toEqual([])
  })
})

describe('vacuous-pass protection', () => {
  it('discovers a plausible number of test files', () => {
    // A 1,380-path argument list silently exceeded the shell limit during this
    // guard's development and reported zero hits for patterns with hundreds of
    // real matches. Discovery failure must never read as a clean tree.
    const files = listTestFiles()
    expect(files.length).toBeGreaterThanOrEqual(MIN_EXPECTED_TEST_FILES)
    expect(files.every((file) => /\.(test|spec)\.tsx?$/.test(file))).toBe(true)
  })
})
