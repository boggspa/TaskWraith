import { createRequire } from 'module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  classifyMacArtifact,
  expectedChannel,
  resolveFeedFiles,
  validateMacReleaseDirectory,
  validateMacUpdateFeedFile,
  validateMacUpdateFeedText
}: {
  classifyMacArtifact: (name: string | undefined) => 'universal' | 'arm64' | 'x64' | 'unknown'
  expectedChannel: (version: string, channelOverride?: string) => string
  resolveFeedFiles: (targets: string[], version?: string, channelOverride?: string) => string[]
  validateMacReleaseDirectory: (
    distDir: string,
    version: string,
    channelOverride?: string
  ) => string[]
  validateMacUpdateFeedFile: (filePath: string) => {
    ok: boolean
    errors: string[]
  }
  validateMacUpdateFeedText: (
    feedText: string,
    options?: { fileName?: string; expectedVersion?: string; expectedChannel?: string }
  ) => {
    ok: boolean
    errors: string[]
    artifacts: Array<{ source: string; name: string; arch: string }>
  }
} = require('./validate-mac-update-feed.cjs')

describe('validate-mac-update-feed script', () => {
  it('accepts a shared mac feed with universal zip and dmg artifacts', () => {
    const result = validateMacUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-universal-mac.zip
    sha512: example
    size: 123
  - url: TaskWraith-1.0.73-universal-mac.dmg
    sha512: example
    size: 456
path: TaskWraith-1.0.73-universal-mac.zip
sha512: example
`,
      { fileName: 'latest-mac.yml' }
    )

    expect(result.ok).toBe(true)
    expect(result.artifacts.map((artifact) => artifact.arch)).toEqual([
      'universal',
      'universal',
      'universal'
    ])
  })

  it('fails an arm64-only shared mac feed', () => {
    const result = validateMacUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-arm64-mac.zip
    sha512: example
    size: 123
  - url: TaskWraith-1.0.73.dmg
    sha512: example
    size: 456
path: TaskWraith-1.0.73-arm64-mac.zip
sha512: example
`,
      { fileName: 'latest-mac.yml' }
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-mac.yml: TaskWraith-1.0.73-arm64-mac.zip is arm64; shared mac feeds must publish universal artifacts.'
    )
    expect(result.errors).toContain(
      'latest-mac.yml: TaskWraith-1.0.73.dmg is unknown; shared mac feeds must publish universal artifacts.'
    )
  })

  it('requires sha512 and size metadata for file entries', () => {
    const result = validateMacUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-universal-mac.zip
path: TaskWraith-1.0.73-universal-mac.zip
`,
      { fileName: 'latest-mac.yml' }
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-mac.yml: TaskWraith-1.0.73-universal-mac.zip is missing sha512 metadata.'
    )
    expect(result.errors).toContain(
      'latest-mac.yml: TaskWraith-1.0.73-universal-mac.zip is missing positive size metadata.'
    )
  })

  it('verifies sha512 and size against referenced artifact files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-feed-'))
    const zipName = 'TaskWraith-1.0.73-universal-mac.zip'
    const dmgName = 'TaskWraith-1.0.73-universal-mac.dmg'
    const zipPath = path.join(tempDir, zipName)
    const dmgPath = path.join(tempDir, dmgName)
    fs.writeFileSync(zipPath, Buffer.from('updater-zip-bytes'))
    fs.writeFileSync(dmgPath, Buffer.from('installer-dmg-bytes'))
    const zipSha512 = crypto.createHash('sha512').update(fs.readFileSync(zipPath)).digest('base64')
    const dmgSha512 = crypto.createHash('sha512').update(fs.readFileSync(dmgPath)).digest('base64')
    const feedPath = path.join(tempDir, 'latest-mac.yml')
    fs.writeFileSync(
      feedPath,
      `
version: 1.0.73
files:
  - url: ${zipName}
    sha512: ${zipSha512}
    size: ${fs.statSync(zipPath).size}
  - url: ${dmgName}
    sha512: ${dmgSha512}
    size: ${fs.statSync(dmgPath).size}
path: ${zipName}
sha512: ${zipSha512}
`
    )

    expect(validateMacUpdateFeedFile(feedPath)).toMatchObject({ ok: true })

    fs.writeFileSync(zipPath, Buffer.from('tampered'))
    const changedResult = validateMacUpdateFeedFile(feedPath)
    expect(changedResult.ok).toBe(false)
    expect(changedResult.errors.some((error) => error.includes('sha512 mismatch'))).toBe(true)
    expect(changedResult.errors.some((error) => error.includes('size mismatch'))).toBe(true)
  })

  it('fails when a referenced artifact is missing from disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-feed-'))
    const zipName = 'TaskWraith-1.0.73-universal-mac.zip'
    const dmgName = 'TaskWraith-1.0.73-universal-mac.dmg'
    const dmgPath = path.join(tempDir, dmgName)
    fs.writeFileSync(dmgPath, 'dmg')
    const feedPath = path.join(tempDir, 'latest-mac.yml')
    fs.writeFileSync(
      feedPath,
      `
version: 1.0.73
files:
  - url: ${zipName}
    sha512: example
    size: 123
  - url: ${dmgName}
    sha512: ${crypto.createHash('sha512').update(fs.readFileSync(dmgPath)).digest('base64')}
    size: ${fs.statSync(dmgPath).size}
path: ${zipName}
sha512: example
`
    )

    const result = validateMacUpdateFeedFile(feedPath)
    expect(result.ok).toBe(false)
    expect(
      result.errors.some((error) => error.includes(`missing referenced artifact ${zipName}`))
    ).toBe(true)
  })

  it('classifies conventional shared mac zip names as universal', () => {
    expect(classifyMacArtifact('TaskWraith-1.0.73-mac.zip')).toBe('universal')
  })

  it('binds the feed version and channel to the package version', () => {
    const result = validateMacUpdateFeedText(
      `
version: 1.9.1
files:
  - url: TaskWraith-1.9.1-universal-mac.zip
    sha512: example
    size: 123
  - url: TaskWraith-1.9.1-universal-mac.dmg
    sha512: example
    size: 456
path: TaskWraith-1.9.1-universal-mac.zip
sha512: example
`,
      { fileName: 'latest-mac.yml', expectedVersion: '1.9.2' }
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-mac.yml: feed version 1.9.1 does not match package 1.9.2.'
    )

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-feed-'))
    fs.writeFileSync(path.join(tempDir, 'latest-mac.yml'), '')
    fs.writeFileSync(path.join(tempDir, 'beta-mac.yml'), '')
    try {
      expect(resolveFeedFiles([tempDir], '1.9.2').map((file) => path.basename(file))).toEqual([
        'latest-mac.yml'
      ])
      expect(
        resolveFeedFiles([tempDir], '1.9.2-beta.1').map((file) => path.basename(file))
      ).toEqual(['beta-mac.yml'])
      expect(expectedChannel('1.9.2-beta.1')).toBe('beta')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('validates the public identity against its isolated release feed', () => {
    const result = validateMacUpdateFeedText(
      `
version: 0.1.0
files:
  - url: TaskWraith-0.1.0-universal-mac.zip
    sha512: zip
    size: 123
  - url: TaskWraith-0.1.0-universal-mac.dmg
    sha512: dmg
    size: 456
path: TaskWraith-0.1.0-universal-mac.zip
sha512: zip
`,
      { fileName: 'release-mac.yml', expectedVersion: '0.1.0', expectedChannel: 'release' }
    )
    expect(result.ok).toBe(true)
    expect(expectedChannel('0.1.0', 'release')).toBe('release')
  })

  it('requires the exact ZIP blockmap and rejects stale DMG blockmaps', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-feed-'))
    for (const name of [
      'TaskWraith-1.9.2-universal-mac.dmg',
      'TaskWraith-1.9.2-universal-mac.zip',
      'TaskWraith-1.9.2-universal-mac.zip.blockmap',
      'latest-mac.yml'
    ]) {
      fs.writeFileSync(path.join(tempDir, name), '')
    }
    try {
      expect(validateMacReleaseDirectory(tempDir, '1.9.2')).toEqual([])
      fs.writeFileSync(path.join(tempDir, 'TaskWraith-1.9.2-universal-mac.dmg.blockmap'), '')
      expect(validateMacReleaseDirectory(tempDir, '1.9.2')).toEqual([
        expect.stringContaining('stale pre-staple DMG blockmap must not ship')
      ])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('requires exactly one ZIP and one DMG files entry with top-level ZIP metadata', () => {
    const zipOnly = validateMacUpdateFeedText(
      `
version: 1.9.2
files:
  - url: TaskWraith-1.9.2-universal-mac.zip
    sha512: zip
    size: 123
path: TaskWraith-1.9.2-universal-mac.zip
sha512: zip
`,
      { fileName: 'latest-mac.yml', expectedVersion: '1.9.2' }
    )
    expect(zipOnly.ok).toBe(false)
    expect(zipOnly.errors).toContain(
      'latest-mac.yml: files list is missing exact artifact TaskWraith-1.9.2-universal-mac.dmg.'
    )

    const duplicateAndConflicting = validateMacUpdateFeedText(
      `
version: 1.9.2
files:
  - url: TaskWraith-1.9.2-universal-mac.zip
    sha512: zip-files
    size: 123
  - url: TaskWraith-1.9.2-universal-mac.dmg
    sha512: dmg-one
    size: 456
  - url: TaskWraith-1.9.2-universal-mac.dmg
    sha512: dmg-two
    size: 457
path: TaskWraith-1.9.2-universal-mac.zip
sha512: zip-top-level
`,
      { fileName: 'latest-mac.yml', expectedVersion: '1.9.2' }
    )
    expect(duplicateAndConflicting.ok).toBe(false)
    expect(duplicateAndConflicting.errors).toContain(
      'latest-mac.yml: files list contains duplicate entries for TaskWraith-1.9.2-universal-mac.dmg; expected exactly one.'
    )
    expect(duplicateAndConflicting.errors).toContain(
      'latest-mac.yml: top-level sha512 must match the exact ZIP files entry.'
    )
  })
})
