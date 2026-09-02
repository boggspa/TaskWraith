import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEmulatorAssetRegistry,
  EMULATOR_ASSET_MIME_BYTE_CAPS,
  emulatorAssetRoot,
  emulatorEntryUrl,
  loadEmulatorAssetBundle,
  MAX_EMULATOR_ASSET_BYTES,
  MAX_EMULATOR_MANIFEST_BYTES,
  parseEmulatorAssetUrl,
  resolveEmulatorAsset,
  sha256Hex,
  validateEmulatorAssetManifest
} from './EmulatorAssetManifest'

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-twemu-'))
  roots.push(value)
  return value
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function bundle(
  input: {
    index?: Buffer
    runtime?: Buffer
    declaredIndexLength?: number
    declaredIndexHash?: string
  } = {}
) {
  const bundleRoot = root()
  const index = input.index ?? Buffer.from('<!doctype html><title>Homebrew</title>')
  const runtime = input.runtime ?? Buffer.from('export const boot = true')
  fs.writeFileSync(path.join(bundleRoot, 'index.html'), index)
  fs.writeFileSync(path.join(bundleRoot, 'runtime.js'), runtime)
  return {
    rootPath: bundleRoot,
    manifest: {
      schemaVersion: 1 as const,
      gameId: 'homebrew-demo' as const,
      entryPath: 'index.html' as const,
      assets: [
        {
          path: 'index.html',
          sha256: input.declaredIndexHash ?? hash(index),
          byteLength: input.declaredIndexLength ?? index.byteLength,
          mimeType: 'text/html' as const
        },
        {
          path: 'runtime.js',
          sha256: hash(runtime),
          byteLength: runtime.byteLength,
          mimeType: 'application/javascript' as const
        }
      ]
    }
  }
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe('EmulatorAssetManifest', () => {
  it('accepts only a fixed known game and a bounded manifest-listed entry page', () => {
    const value = bundle().manifest
    expect(validateEmulatorAssetManifest(value)).toEqual({ ok: true, manifest: value })
    expect(validateEmulatorAssetManifest({ ...value, gameId: 'user-rom' })).toMatchObject({
      ok: false
    })
    expect(
      validateEmulatorAssetManifest({
        ...value,
        assets: [
          {
            ...value.assets[0],
            path: '../secret',
            byteLength: value.assets[0].byteLength
          }
        ]
      })
    ).toMatchObject({ ok: false })
    expect(
      validateEmulatorAssetManifest({
        ...value,
        assets: [{ ...value.assets[0], byteLength: MAX_EMULATOR_ASSET_BYTES + 1 }]
      })
    ).toMatchObject({ ok: false })
    expect(
      validateEmulatorAssetManifest({
        ...value,
        assets: [
          {
            ...value.assets[0],
            byteLength: EMULATOR_ASSET_MIME_BYTE_CAPS['text/html'] + 1
          }
        ]
      })
    ).toMatchObject({ ok: false })
    expect(
      validateEmulatorAssetManifest({
        ...value,
        assets: [{ ...value.assets[0], mimeType: 'application/wasm' }]
      })
    ).toMatchObject({ ok: false })
  })

  it('loads only a bounded regular manifest file', () => {
    const fixture = bundle()
    fs.writeFileSync(
      path.join(fixture.rootPath, 'manifest.json'),
      JSON.stringify(fixture.manifest),
      'utf8'
    )
    expect(loadEmulatorAssetBundle(fixture.rootPath)).toEqual(fixture)

    fs.writeFileSync(
      path.join(fixture.rootPath, 'manifest.json'),
      Buffer.alloc(MAX_EMULATOR_MANIFEST_BYTES + 1, 0x20)
    )
    expect(() => loadEmulatorAssetBundle(fixture.rootPath)).toThrow(/regular file/)
  })

  it('resolves only exact public manifest assets, then verifies byte length and hash', () => {
    const fixture = bundle()
    const registry = createEmulatorAssetRegistry([fixture])
    const resolved = resolveEmulatorAsset(registry, emulatorEntryUrl('homebrew-demo'))
    expect(resolved).toMatchObject({
      gameId: 'homebrew-demo',
      assetPath: 'index.html',
      mimeType: 'text/html'
    })
    expect(resolved?.bytes.toString()).toContain('Homebrew')
    expect(resolved?.bytes.byteLength).toBe(fixture.manifest.assets[0].byteLength)
    expect(sha256Hex(resolved?.bytes ?? Buffer.alloc(0))).toBe(fixture.manifest.assets[0].sha256)

    const mismatchedLength = bundle({
      declaredIndexLength: fixture.manifest.assets[0].byteLength + 1
    })
    expect(
      resolveEmulatorAsset(
        createEmulatorAssetRegistry([mismatchedLength]),
        emulatorEntryUrl('homebrew-demo')
      )
    ).toBeNull()

    const mismatchedHash = bundle({ declaredIndexHash: '0'.repeat(64) })
    expect(
      resolveEmulatorAsset(
        createEmulatorAssetRegistry([mismatchedHash]),
        emulatorEntryUrl('homebrew-demo')
      )
    ).toBeNull()
  })

  it('has no traversal, remote, query, or unlisted-resource fallback', () => {
    const fixture = bundle()
    const registry = createEmulatorAssetRegistry([fixture])
    for (const value of [
      'https://example.test/index.html',
      'twemu://other/homebrew-demo/index.html',
      'twemu://app/homebrew-demo/../index.html',
      'twemu://app/homebrew-demo/%2Fetc%2Fpasswd',
      'twemu://app/homebrew-demo/index.html?cache=1',
      'twemu://app/homebrew-demo/not-listed.wasm'
    ]) {
      expect(resolveEmulatorAsset(registry, value), value).toBeNull()
    }
    expect(parseEmulatorAssetUrl(emulatorEntryUrl('homebrew-demo'))).toEqual({
      gameId: 'homebrew-demo',
      assetPath: 'index.html'
    })
  })

  it('resolves dev and packaged public resource roots without claiming that either exists', () => {
    // emulatorAssetRoot joins onto path.resolve of its inputs, so expectations
    // are built with the same path APIs rather than POSIX string literals.
    expect(
      emulatorAssetRoot({
        appPath: '/repo',
        resourcesPath: '/Applications/TaskWraith.app/Contents/Resources',
        isPackaged: false
      })
    ).toBe(path.resolve('/repo', 'resources', 'emulator'))
    expect(
      emulatorAssetRoot({
        appPath: '/repo',
        resourcesPath: '/Applications/TaskWraith.app/Contents/Resources',
        isPackaged: true
      })
    ).toBe(path.resolve('/Applications/TaskWraith.app/Contents/Resources', 'emulator'))
  })
})
