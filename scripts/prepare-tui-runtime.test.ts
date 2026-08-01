import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertArchiveChecksum,
  copyNodeDistributionLicense,
  ensureVerifiedArchive,
  officialDistName,
  parseShasums256,
  requireHttpsUrl
}: {
  assertArchiveChecksum: (filePath: string, expectedSha256: string, label?: string) => string
  copyNodeDistributionLicense: (
    extractRoot: string,
    distributionName: string,
    destLicense: string
  ) => void
  ensureVerifiedArchive: (input: {
    archiveUrl: string
    cachePath: string
    distName: string
    expectedSha256: string
    download?: (url: string, destination: string) => Promise<void>
  }) => Promise<string>
  officialDistName: (target: { platform: string; arch: string }, version: string) => string
  parseShasums256: (text: string) => Map<string, string>
  requireHttpsUrl: (value: string, base?: string) => string
} = require('./prepare-tui-runtime.cjs')

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function tempArchive(contents: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tui-runtime-'))
  const filePath = path.join(dir, 'node-test.tar.gz')
  fs.writeFileSync(filePath, contents)
  return { dir, filePath }
}

describe('prepare-tui-runtime', () => {
  it('parses exact official checksum entries', () => {
    const first = 'a'.repeat(64)
    const second = 'B'.repeat(64)
    const checksums = parseShasums256(
      `${first}  node-v22.23.2-linux-x64.tar.gz\n${second}  node-v22.23.2-win-x64.zip\n`
    )

    expect(checksums.get('node-v22.23.2-linux-x64.tar.gz')).toBe(first)
    expect(checksums.get('node-v22.23.2-win-x64.zip')).toBe(second.toLowerCase())
  })

  it('rejects malformed and duplicate checksum entries', () => {
    expect(() => parseShasums256('not-a-checksum\n')).toThrow('Malformed SHASUMS256.txt line 1')
    const digest = 'a'.repeat(64)
    expect(() => parseShasums256(`${digest}  node.tar.gz\n${digest}  node.tar.gz\n`)).toThrow(
      'Duplicate SHASUMS256.txt entry for node.tar.gz'
    )
  })

  it('authenticates a valid cache without downloading it again', async () => {
    const contents = Buffer.alloc(1_000_001, 7)
    const { dir, filePath } = tempArchive(contents)
    let downloads = 0
    try {
      await expect(
        ensureVerifiedArchive({
          archiveUrl: 'https://nodejs.org/dist/v22.23.2/node-test.tar.gz',
          cachePath: filePath,
          distName: 'node-test.tar.gz',
          expectedSha256: sha256(contents),
          download: async () => {
            downloads += 1
          }
        })
      ).resolves.toBe(sha256(contents))
      expect(downloads).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deletes a corrupt cache and accepts only a verified replacement', async () => {
    const corrupt = Buffer.alloc(1_000_001, 1)
    const replacement = Buffer.alloc(1_000_001, 2)
    const { dir, filePath } = tempArchive(corrupt)
    let downloads = 0
    try {
      await expect(
        ensureVerifiedArchive({
          archiveUrl: 'https://nodejs.org/dist/v22.23.2/node-test.tar.gz',
          cachePath: filePath,
          distName: 'node-test.tar.gz',
          expectedSha256: sha256(replacement),
          download: async (_url, destination) => {
            downloads += 1
            fs.writeFileSync(destination, replacement)
          }
        })
      ).resolves.toBe(sha256(replacement))
      expect(downloads).toBe(1)
      expect(fs.readFileSync(filePath)).toEqual(replacement)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('removes a corrupt fresh download and fails closed', async () => {
    const expected = Buffer.alloc(1_000_001, 3)
    const corrupt = Buffer.alloc(1_000_001, 4)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tui-runtime-'))
    const filePath = path.join(dir, 'node-test.tar.gz')
    try {
      await expect(
        ensureVerifiedArchive({
          archiveUrl: 'https://nodejs.org/dist/v22.23.2/node-test.tar.gz',
          cachePath: filePath,
          distName: 'node-test.tar.gz',
          expectedSha256: sha256(expected),
          download: async (_url, destination) => {
            fs.writeFileSync(destination, corrupt)
          }
        })
      ).rejects.toThrow('Official SHA-256 mismatch')
      expect(fs.existsSync(filePath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects invalid expected digests and non-HTTPS sources', () => {
    const { dir, filePath } = tempArchive(Buffer.from('archive'))
    try {
      expect(() => assertArchiveChecksum(filePath, 'not-a-digest')).toThrow(
        'Invalid expected SHA-256'
      )
      expect(() => requireHttpsUrl('http://nodejs.org/dist/node.tar.gz')).toThrow(
        'Refusing non-HTTPS'
      )
      expect(requireHttpsUrl('../next', 'https://nodejs.org/dist/v22.23.2/redirect')).toBe(
        'https://nodejs.org/dist/next'
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies the verified distribution license and rejects missing or tampered notices', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-node-license-'))
    const distributionName = 'node-v22.23.2-linux-x64'
    const distributionRoot = path.join(root, distributionName)
    const destination = path.join(root, 'packaged', 'LICENSE')
    fs.mkdirSync(distributionRoot, { recursive: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const validLicense = `Node.js is licensed for use as follows:\n\n${'notice '.repeat(
      150
    )}\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n`

    try {
      fs.writeFileSync(path.join(distributionRoot, 'LICENSE'), validLicense)
      copyNodeDistributionLicense(root, distributionName, destination)
      expect(fs.readFileSync(destination, 'utf8')).toBe(validLicense)

      fs.writeFileSync(path.join(distributionRoot, 'LICENSE'), 'tampered')
      expect(() => copyNodeDistributionLicense(root, distributionName, destination)).toThrow(
        'invalid'
      )

      fs.rmSync(path.join(distributionRoot, 'LICENSE'))
      expect(() => copyNodeDistributionLicense(root, distributionName, destination)).toThrow(
        'missing'
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('names both official Windows runtime archives and wires dual-target release scripts', () => {
    expect(officialDistName({ platform: 'win32', arch: 'x64' }, '22.23.2')).toBe(
      'node-v22.23.2-win-x64.zip'
    )
    expect(officialDistName({ platform: 'win32', arch: 'arm64' }, '22.23.2')).toBe(
      'node-v22.23.2-win-arm64.zip'
    )

    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    )
    expect(packageJson.scripts['prepare:tui-runtime:win']).toContain(
      '--targets=win32-x64,win32-arm64'
    )
    expect(packageJson.scripts['build:win:compile']).toContain('prepare:tui-runtime:win')
    expect(packageJson.scripts['build:win:unpack']).toContain('prepare:tui-runtime:win')
  })
})
