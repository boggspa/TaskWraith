import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  firstChangelogRelease,
  normalizeTag,
  resolveTag,
  validateReleaseMetadata
}: {
  firstChangelogRelease: (text: string) => { version: string; date?: string } | null
  normalizeTag: (value: string) => string
  resolveTag: (argv: string[], env: Record<string, string | undefined>) => string
  validateReleaseMetadata: (input: {
    tag: string
    packageJson: { version?: string }
    packageLock: { version?: string; packages?: Record<string, { version?: string }> }
    changelogText: string
  }) => string[]
} = require('./verify-release-tag.cjs')

function validMetadata(version = '1.9.2') {
  return {
    tag: `v${version}`,
    packageJson: { version },
    packageLock: { version, packages: { '': { version } } },
    changelogText: `# Changelog\n\n## ${version} - 2026-07-30\n\nRelease notes.\n`
  }
}

describe('verify-release-tag', () => {
  it('accepts matching stable tag, package, lock, and dated changelog metadata', () => {
    expect(validateReleaseMetadata(validMetadata())).toEqual([])
  })

  it('normalizes GitHub tag refs and resolves an explicit tag first', () => {
    expect(normalizeTag('refs/tags/v1.9.2')).toBe('v1.9.2')
    expect(
      resolveTag(['--tag=v1.9.3'], {
        GITHUB_REF_NAME: 'v1.9.2',
        GITHUB_REF: 'refs/tags/v1.9.1'
      })
    ).toBe('v1.9.3')
  })

  it('rejects tag, lockfile, and top changelog drift', () => {
    const errors = validateReleaseMetadata({
      ...validMetadata(),
      tag: 'v1.9.1',
      packageLock: { version: '1.9.1', packages: { '': { version: '1.9.0' } } },
      changelogText: '# Changelog\n\n## 1.9.1 - 2026-07-29\n'
    })

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('does not match package.json version v1.9.2'),
        expect.stringContaining('package-lock.json version 1.9.1'),
        expect.stringContaining('root package version 1.9.0'),
        expect.stringContaining('top CHANGELOG.md release 1.9.1')
      ])
    )
  })

  it('requires a date for a stable changelog heading', () => {
    const metadata = validMetadata()
    metadata.changelogText = '# Changelog\n\n## 1.9.2\n'

    expect(validateReleaseMetadata(metadata)).toContain(
      'stable CHANGELOG.md release 1.9.2 is missing a date'
    )
  })

  it('accepts beta prerelease tags with exact prepared changelog notes', () => {
    const metadata = validMetadata('1.9.2-beta.1')

    expect(validateReleaseMetadata(metadata)).toEqual([])
  })

  it('rejects beta prereleases without the release notes required by publication', () => {
    const metadata = validMetadata('1.9.2-beta.1')
    metadata.changelogText = '# Changelog\n'

    expect(validateReleaseMetadata(metadata)).toContain(
      'CHANGELOG.md has no release section for 1.9.2-beta.1'
    )
  })

  it('rejects prerelease labels that runtime update channels cannot consume', () => {
    const metadata = validMetadata('1.9.2-rc.1')
    metadata.changelogText = '# Changelog\n'

    expect(validateReleaseMetadata(metadata)).toContain(
      'unsupported prerelease channel rc; TaskWraith release feeds support beta only'
    )
  })

  it('reads the first release heading as the changelog release', () => {
    expect(
      firstChangelogRelease(
        '# Changelog\n\nIntro.\n\n## 1.9.2 - 2026-07-30\n\n## 1.9.1 - 2026-07-29\n'
      )
    ).toEqual({ version: '1.9.2', date: '2026-07-30' })
  })
})
