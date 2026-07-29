import { createRequire } from 'module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  classifyWindowsArtifact,
  expectedChannel,
  resolveFeedFiles,
  validateWindowsReleaseDirectory,
  validateWindowsUpdateFeedFile,
  validateWindowsUpdateFeedText
}: {
  classifyWindowsArtifact: (name: string | undefined) => 'arm64' | 'x64' | 'unknown'
  expectedChannel: (version: string) => string
  resolveFeedFiles: (targets: string[], version?: string) => string[]
  validateWindowsReleaseDirectory: (distDir: string, version?: string) => string[]
  validateWindowsUpdateFeedFile: (filePath: string) => {
    ok: boolean
    errors: string[]
  }
  validateWindowsUpdateFeedText: (
    feedText: string,
    options?: { fileName?: string; expectedArch?: string; expectedVersion?: string }
  ) => {
    ok: boolean
    errors: string[]
    artifacts: Array<{ source: string; name: string; arch: string }>
  }
} = require('./validate-win-update-feed.cjs')

describe('validate-win-update-feed script', () => {
  it('accepts an x64 Windows feed with an arch-specific setup artifact', () => {
    const result = validateWindowsUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-win-x64-setup.exe
    sha512: example
    size: 123
path: TaskWraith-1.0.73-win-x64-setup.exe
sha512: example
`,
      { fileName: 'latest-win-x64.yml' }
    )

    expect(result.ok).toBe(true)
    expect(result.artifacts.map((artifact) => artifact.arch)).toEqual(['x64', 'x64'])
  })

  it('fails an ambiguous Windows setup feed', () => {
    const result = validateWindowsUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-setup.exe
path: TaskWraith-1.0.73-setup.exe
sha512: example
`,
      { fileName: 'latest-win-arm64.yml' }
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-win-arm64.yml: TaskWraith-1.0.73-setup.exe has unknown Windows artifact architecture.'
    )
  })

  it('fails a feed that points at the wrong Windows architecture', () => {
    const result = validateWindowsUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-win-x64-setup.exe
path: TaskWraith-1.0.73-win-x64-setup.exe
sha512: example
`,
      { fileName: 'latest-win-arm64.yml' }
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-win-arm64.yml: TaskWraith-1.0.73-win-x64-setup.exe is x64; expected arm64 for this feed.'
    )
  })

  it('requires sha512 and size metadata for file entries', () => {
    const result = validateWindowsUpdateFeedText(
      `
version: 1.0.73
files:
  - url: TaskWraith-1.0.73-win-x64-setup.exe
path: TaskWraith-1.0.73-win-x64-setup.exe
sha512: example
`,
      { fileName: 'latest-win-x64.yml' }
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-win-x64.yml: TaskWraith-1.0.73-win-x64-setup.exe is missing sha512 metadata.'
    )
    expect(result.errors).toContain(
      'latest-win-x64.yml: TaskWraith-1.0.73-win-x64-setup.exe is missing positive size metadata.'
    )
  })

  it('verifies sha512 and size against referenced installer files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-win-feed-'))
    const installerName = 'TaskWraith-1.0.73-win-x64-setup.exe'
    const installerPath = path.join(tempDir, installerName)
    fs.writeFileSync(installerPath, Buffer.from('installer-bytes'))
    const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installerPath)).digest('base64')
    const feedPath = path.join(tempDir, 'latest-win-x64.yml')
    fs.writeFileSync(
      feedPath,
      `
version: 1.0.73
files:
  - url: ${installerName}
    sha512: ${sha512}
    size: ${fs.statSync(installerPath).size}
path: ${installerName}
sha512: ${sha512}
`
    )

    expect(validateWindowsUpdateFeedFile(feedPath)).toMatchObject({ ok: true })

    fs.writeFileSync(installerPath, Buffer.from('changed'))
    const changedResult = validateWindowsUpdateFeedFile(feedPath)
    expect(changedResult.ok).toBe(false)
    expect(changedResult.errors.some((error) => error.includes('sha512 mismatch'))).toBe(true)
    expect(changedResult.errors.some((error) => error.includes('size mismatch'))).toBe(true)
  })

  it('classifies Windows artifact names', () => {
    expect(classifyWindowsArtifact('TaskWraith-1.0.73-win-arm64-setup.exe')).toBe('arm64')
    expect(classifyWindowsArtifact('TaskWraith-1.0.73-win-x64-setup.exe')).toBe('x64')
    expect(classifyWindowsArtifact('TaskWraith-1.0.73-setup.exe')).toBe('unknown')
  })

  it('binds Windows feeds, installers, and channels to the package version', () => {
    const result = validateWindowsUpdateFeedText(
      `
version: 1.9.1
files:
  - url: TaskWraith-1.9.1-win-x64-setup.exe
    sha512: example
    size: 123
path: TaskWraith-1.9.1-win-x64-setup.exe
sha512: example
`,
      {
        fileName: 'latest-win-x64.yml',
        expectedVersion: '1.9.2'
      }
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'latest-win-x64.yml: feed version 1.9.1 does not match package 1.9.2.'
    )

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-win-feed-'))
    for (const fileName of [
      'latest-win-x64.yml',
      'latest-win-arm64.yml',
      'beta-win-x64.yml',
      'beta-win-arm64.yml'
    ]) {
      fs.writeFileSync(path.join(tempDir, fileName), '')
    }
    try {
      expect(resolveFeedFiles([tempDir], '1.9.2').map((file) => path.basename(file))).toEqual([
        'latest-win-x64.yml',
        'latest-win-arm64.yml'
      ])
      expect(expectedChannel('1.9.2-beta.1')).toBe('beta')
      expect(validateWindowsReleaseDirectory(tempDir, '1.9.2')).toEqual(
        expect.arrayContaining([
          expect.stringContaining('TaskWraith-1.9.2-win-x64-setup.exe'),
          expect.stringContaining('TaskWraith-1.9.2-win-arm64-setup.exe')
        ])
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
