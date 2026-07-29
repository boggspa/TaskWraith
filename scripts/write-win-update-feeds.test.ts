import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  writeWindowsUpdateFeeds
}: {
  writeWindowsUpdateFeeds: (options: {
    repoRoot: string
    distDir: string
  }) => Array<{ arch: string; artifactName: string; feedNames: string[] }>
} = require('./write-win-update-feeds.cjs')
const {
  validateWindowsUpdateFeedFile
}: {
  validateWindowsUpdateFeedFile: (
    filePath: string,
    expectedVersion: string
  ) => { ok: boolean; errors: string[] }
} = require('./validate-win-update-feed.cjs')

function fixture(version: string) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-win-writer-'))
  const distDir = path.join(repoRoot, 'dist')
  fs.mkdirSync(distDir)
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ version }))
  for (const arch of ['x64', 'arm64']) {
    const installer = path.join(distDir, `TaskWraith-${version}-win-${arch}-setup.exe`)
    fs.writeFileSync(installer, `installer-${arch}-${version}`)
    fs.writeFileSync(`${installer}.blockmap`, `blockmap-${arch}`)
  }
  return { repoRoot, distDir }
}

describe('write-win-update-feeds', () => {
  it.each([
    ['1.9.2', 'latest'],
    ['1.9.2-beta.1', 'beta']
  ])('writes exact %s x64/arm64 feeds on the %s channel', (version, channel) => {
    const { repoRoot, distDir } = fixture(version)
    try {
      const results = writeWindowsUpdateFeeds({ repoRoot, distDir })
      expect(results.map((result) => result.arch)).toEqual(['x64', 'arm64'])
      for (const arch of ['x64', 'arm64']) {
        const installerName = `TaskWraith-${version}-win-${arch}-setup.exe`
        const installerPath = path.join(distDir, installerName)
        const feedPath = path.join(distDir, `${channel}-win-${arch}.yml`)
        const digest = crypto
          .createHash('sha512')
          .update(fs.readFileSync(installerPath))
          .digest('base64')
        const feed = fs.readFileSync(feedPath, 'utf8')
        expect(feed).toContain(`version: ${version}`)
        expect(feed).toContain(`url: ${installerName}`)
        expect(feed).toContain(`sha512: ${digest}`)
        expect(feed).toContain(`size: ${fs.statSync(installerPath).size}`)
        expect(validateWindowsUpdateFeedFile(feedPath, version)).toMatchObject({ ok: true })
      }
      expect(
        fs.existsSync(path.join(distDir, `${channel === 'latest' ? 'beta' : 'latest'}-win-x64.yml`))
      ).toBe(false)
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('rejects a near-match instead of falling back from the exact installer version', () => {
    const { repoRoot, distDir } = fixture('1.9.2')
    fs.rmSync(path.join(distDir, 'TaskWraith-1.9.2-win-x64-setup.exe'))
    fs.writeFileSync(path.join(distDir, 'TaskWraith-11.9.20-win-x64-setup.exe'), 'wrong')
    try {
      expect(() => writeWindowsUpdateFeeds({ repoRoot, distDir })).toThrow(
        'Missing expected Windows x64 setup installer'
      )
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('requires the exact installer blockmap', () => {
    const { repoRoot, distDir } = fixture('1.9.2')
    fs.rmSync(path.join(distDir, 'TaskWraith-1.9.2-win-arm64-setup.exe.blockmap'))
    try {
      expect(() => writeWindowsUpdateFeeds({ repoRoot, distDir })).toThrow(
        'Missing blockmap for TaskWraith-1.9.2-win-arm64-setup.exe'
      )
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
