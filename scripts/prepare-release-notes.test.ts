import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  extractReleaseNotes,
  runCli
}: {
  extractReleaseNotes: (changelog: string, version: string) => string
  runCli: (argv?: string[], repoRoot?: string) => number
} = require('./prepare-release-notes.cjs')

function makeNotesFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-release-notes-'))
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'taskwraith', version: '1.9.9' })
  )
  fs.writeFileSync(
    path.join(repoRoot, 'CHANGELOG.md'),
    '# Changelog\n\n## 1.9.9 - 2026-10-08\n\n### Final beta\n\n- Bridge release.\n\n## 0.1.0 - 2026-10-08\n\n### Public debut\n\n- Release identity.\n'
  )
  fs.writeFileSync(
    path.join(repoRoot, 'electron-builder.yml'),
    [
      'appId: com.chrisizatt.taskwraith',
      'extraMetadata:',
      '  taskwraithDistributionIdentity: beta',
      '  taskwraithUpdateFeedChannel: latest',
      ''
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(repoRoot, 'electron-builder.debut.yml'),
    ['extends: electron-builder.yml', 'extraMetadata:', '  version: 0.1.0', ''].join('\n')
  )
  // The debut resolution enforces the frozen handoff contract; the fixture
  // root is 1.9.9, matching its pinned source.
  fs.mkdirSync(path.join(repoRoot, 'resources'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'resources', 'identity-handoff.json'),
    JSON.stringify({
      schemaVersion: 1,
      prepared: false,
      source: { version: '1.9.9' },
      target: { version: '0.1.0' }
    })
  )
  return repoRoot
}

describe('release notes preparation', () => {
  it('extracts only the exact version section with one canonical trailing newline', () => {
    const changelog = `# Changelog

## 1.9.2 - 2026-07-30

### Added

- Release gate.

## 1.9.1 - 2026-07-29

- Previous.
`
    expect(extractReleaseNotes(changelog, '1.9.2')).toBe('### Added\n\n- Release gate.\n')
  })

  it('rejects substring matches and empty release sections', () => {
    expect(() => extractReleaseNotes('## 11.9.20 - 2026-07-30\n\n- Wrong.\n', '1.9.2')).toThrow(
      'no release section for 1.9.2'
    )
    expect(() =>
      extractReleaseNotes('## 1.9.2 - 2026-07-30\n\n## 1.9.1 - 2026-07-29\n\n- Old.\n', '1.9.2')
    ).toThrow('release section for 1.9.2 is empty')
  })
})

describe('release notes preparation across distributions', () => {
  it('writes the root release notes by default', () => {
    const repoRoot = makeNotesFixture()

    expect(runCli([], repoRoot)).toBe(0)
    const notes = fs.readFileSync(path.join(repoRoot, 'dist', 'RELEASE_NOTES-1.9.9.md'), 'utf8')
    expect(notes).toBe('### Final beta\n\n- Bridge release.\n')
  })

  it('writes the debut notes from the same frozen root with --distribution=debut', () => {
    const repoRoot = makeNotesFixture()

    expect(runCli(['--distribution=debut'], repoRoot)).toBe(0)
    const notes = fs.readFileSync(path.join(repoRoot, 'dist', 'RELEASE_NOTES-0.1.0.md'), 'utf8')
    expect(notes).toBe('### Public debut\n\n- Release identity.\n')
  })

  it('accepts an explicit debut version and honors a custom output path', () => {
    const repoRoot = makeNotesFixture()

    expect(runCli(['--distribution=debut', '0.1.0', 'notes.md'], repoRoot)).toBe(0)
    expect(fs.readFileSync(path.join(repoRoot, 'notes.md'), 'utf8')).toBe(
      '### Public debut\n\n- Release identity.\n'
    )
  })

  it('rejects versions outside the selected distribution', () => {
    const repoRoot = makeNotesFixture()

    expect(() => runCli(['0.1.0'], repoRoot)).toThrow(
      /Requested release notes 0\.1\.0 do not match beta distribution version 1\.9\.9/
    )
    expect(() => runCli(['--distribution=debut', '0.1.1'], repoRoot)).toThrow(
      /Requested release notes 0\.1\.1 do not match debut distribution version 0\.1\.0/
    )
  })
})
