import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  extractReleaseNotes
}: {
  extractReleaseNotes: (changelog: string, version: string) => string
} = require('./prepare-release-notes.cjs')

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
