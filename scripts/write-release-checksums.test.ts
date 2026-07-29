import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  writeReleaseChecksums
}: {
  writeReleaseChecksums: (outputPath: string, assetPaths: string[]) => string[]
} = require('./write-release-checksums.cjs')

describe('versioned release checksums', () => {
  it('covers every uploaded asset exactly once and excludes the manifest itself', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-checksums-'))
    const assets = [
      path.join(root, 'TaskWraith-1.9.2.AppImage'),
      path.join(root, 'TaskWraith-1.9.2-universal-mac.dmg'),
      path.join(root, 'sbom-linux.cdx.json')
    ]
    for (const [index, asset] of assets.entries()) {
      fs.writeFileSync(asset, `asset-${index}`)
    }
    const output = path.join(root, 'SHA256SUMS-1.9.2.txt')

    try {
      const lines = writeReleaseChecksums(output, assets)
      expect(lines).toHaveLength(assets.length)
      for (const asset of assets) {
        const expected = `${crypto
          .createHash('sha256')
          .update(fs.readFileSync(asset))
          .digest('hex')}  ${path.basename(asset)}`
        expect(lines.filter((line) => line === expected)).toHaveLength(1)
      }
      expect(fs.readFileSync(output, 'utf8').match(/SHA256SUMS/g)).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate names, missing assets, and self-inclusion', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-checksums-'))
    const first = path.join(root, 'one', 'asset.bin')
    const second = path.join(root, 'two', 'asset.bin')
    const output = path.join(root, 'SHA256SUMS-1.9.2.txt')
    fs.mkdirSync(path.dirname(first), { recursive: true })
    fs.mkdirSync(path.dirname(second), { recursive: true })
    fs.writeFileSync(first, 'one')
    fs.writeFileSync(second, 'two')
    try {
      expect(() => writeReleaseChecksums(output, [first, second])).toThrow(
        'Duplicate release checksum asset name'
      )
      expect(() => writeReleaseChecksums(output, [path.join(root, 'missing')])).toThrow(
        'missing or not a file'
      )
      fs.writeFileSync(output, 'old')
      expect(() => writeReleaseChecksums(output, [output])).toThrow('must not include itself')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
