import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  expectedChannel,
  resolveFeedFiles,
  validateLinuxReleaseDirectory,
  validateLinuxUpdateFeedFile,
  validateLinuxUpdateFeedText
}: {
  expectedChannel: (version: string) => string
  resolveFeedFiles: (targets: string[], version: string) => string[]
  validateLinuxReleaseDirectory: (distDir: string, version: string) => string[]
  validateLinuxUpdateFeedFile: (
    filePath: string,
    expectedVersion: string
  ) => { ok: boolean; errors: string[] }
  validateLinuxUpdateFeedText: (
    text: string,
    options?: { fileName?: string; expectedVersion?: string }
  ) => {
    ok: boolean
    errors: string[]
    artifacts: Array<{ source: string; name: string }>
  }
} = require('./validate-linux-update-feed.cjs')

describe('validate-linux-update-feed', () => {
  it('accepts a matching AppImage feed with updater metadata', () => {
    const result = validateLinuxUpdateFeedText(
      `
version: 1.9.2
files:
  - url: TaskWraith-1.9.2.AppImage
    sha512: example
    size: 123
path: TaskWraith-1.9.2.AppImage
sha512: example
`,
      { fileName: 'latest-linux.yml', expectedVersion: '1.9.2' }
    )

    expect(result.ok).toBe(true)
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      'TaskWraith-1.9.2.AppImage',
      'TaskWraith-1.9.2.AppImage'
    ])
  })

  it('rejects feed version drift and incomplete metadata', () => {
    const result = validateLinuxUpdateFeedText(
      `
version: 1.9.1
files:
  - url: TaskWraith-1.9.2.AppImage
path: TaskWraith-1.9.2.AppImage
sha512: example
`,
      { fileName: 'latest-linux.yml', expectedVersion: '1.9.2' }
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'latest-linux.yml: feed version 1.9.1 does not match package 1.9.2.',
        'latest-linux.yml: TaskWraith-1.9.2.AppImage is missing sha512 metadata.',
        'latest-linux.yml: TaskWraith-1.9.2.AppImage is missing positive size metadata.'
      ])
    )
  })

  it('verifies referenced AppImage digest and size on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-feed-'))
    const artifactName = 'TaskWraith-1.9.2.AppImage'
    const artifactPath = path.join(dir, artifactName)
    const contents = Buffer.from('appimage')
    fs.writeFileSync(artifactPath, contents)
    const digest = crypto.createHash('sha512').update(contents).digest('base64')
    const feedPath = path.join(dir, 'latest-linux.yml')
    fs.writeFileSync(
      feedPath,
      `version: 1.9.2
files:
  - url: ${artifactName}
    sha512: ${digest}
    size: ${contents.length}
path: ${artifactName}
sha512: ${digest}
`
    )

    try {
      expect(validateLinuxUpdateFeedFile(feedPath, '1.9.2')).toMatchObject({ ok: true })
      fs.writeFileSync(artifactPath, 'changed-size')
      const result = validateLinuxUpdateFeedFile(feedPath, '1.9.2')
      expect(result.ok).toBe(false)
      expect(result.errors.some((error) => error.includes('sha512 mismatch'))).toBe(true)
      expect(result.errors.some((error) => error.includes('size mismatch'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('selects the package-version channel and ignores the wrong channel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-feed-'))
    fs.writeFileSync(path.join(dir, 'latest-linux.yml'), '')
    fs.writeFileSync(path.join(dir, 'beta-linux.yml'), '')
    try {
      expect(resolveFeedFiles([dir], '1.9.2').map((file) => path.basename(file))).toEqual([
        'latest-linux.yml'
      ])
      expect(resolveFeedFiles([dir], '1.9.2-beta.1').map((file) => path.basename(file))).toEqual([
        'beta-linux.yml'
      ])
      expect(expectedChannel('1.9.2')).toBe('latest')
      expect(expectedChannel('1.9.2-beta.1')).toBe('beta')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requires versioned AppImage and deb release artifacts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-feed-'))
    try {
      expect(validateLinuxReleaseDirectory(dir, '1.9.2')).toHaveLength(2)
      fs.writeFileSync(path.join(dir, 'TaskWraith-1.9.2.AppImage'), '')
      fs.writeFileSync(path.join(dir, 'taskwraith_1.9.2_amd64.deb'), '')
      expect(validateLinuxReleaseDirectory(dir, '1.9.2')).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not accept a longer version that merely contains the expected version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-feed-'))
    try {
      fs.writeFileSync(path.join(dir, 'TaskWraith-1.9.2.AppImage'), '')
      fs.writeFileSync(path.join(dir, 'taskwraith_11.9.20_amd64.deb'), '')
      expect(validateLinuxReleaseDirectory(dir, '1.9.2')).toEqual([
        expect.stringContaining('missing exact taskwraith_1.9.2_amd64.deb')
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
