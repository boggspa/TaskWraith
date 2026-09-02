import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalEmulatorStateAdapterSchemaJson,
  EMULATOR_MAX_MANIFEST_BYTES,
  validateEmulatorStateAdapterManifest
} from '../../shared/emulatorCanvas'
import type { EmulatorAssetBundle } from './EmulatorAssetManifest'
import {
  EMULATOR_PACKAGE_DESCRIPTOR_FILE_NAME,
  type EmulatorPackageManifestFileSystem,
  loadEmulatorPackageManifest,
  TWGB_CORE_SHA256,
  TWGB_PACKAGE_CORE_ID,
  TWGB_PACKAGE_GAME_ID,
  TWGB_ROM_SHA256,
  TWGB_RUNTIME_WASM_SHA256,
  validateEmulatorPackageForBundle,
  validateTwgbHomebrewDemoPackage
} from './EmulatorPackageManifest'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function temporaryBundleRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-emulator-package-'))
  temporaryRoots.push(root)
  return root
}

function adapter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const withoutHash = {
    schemaVersion: 2,
    adapterId: 'twgb-state-window',
    adapterRevision: 'v1',
    schemaSha256: '0'.repeat(64),
    coreId: TWGB_PACKAGE_CORE_ID,
    romSha256: TWGB_ROM_SHA256,
    memoryBytes: 13,
    stateWindow: { source: 'system_ram', startAddress: 0xc100, byteLength: 13 },
    fields: [
      { key: 'x', kind: 'integer', read: { address: 6, encoding: 'u8' }, unit: 'px' },
      { key: 'y', kind: 'integer', read: { address: 7, encoding: 'u8' }, unit: 'px' },
      { key: 'input', kind: 'integer', read: { address: 8, encoding: 'u8' }, unit: 'mask' },
      {
        key: 'frame-counter',
        kind: 'integer',
        read: { address: 9, encoding: 'u32le' },
        unit: 'frames'
      }
    ],
    ...overrides
  }
  const validated = validateEmulatorStateAdapterManifest(withoutHash)
  if (!validated.ok) throw new Error(validated.reason)
  return {
    ...withoutHash,
    schemaSha256: sha256(canonicalEmulatorStateAdapterSchemaJson(validated.value))
  }
}

function descriptor(
  runtimeWasmSha256: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    gameId: TWGB_PACKAGE_GAME_ID,
    coreId: TWGB_PACKAGE_CORE_ID,
    coreSha256: TWGB_CORE_SHA256,
    runtimeWasmSha256,
    romSha256: TWGB_ROM_SHA256,
    stateAdapter: adapter(),
    ...overrides
  }
}

function legacyDescriptor(): Record<string, unknown> {
  const untrustedAdapter = {
    schemaVersion: 1,
    adapterId: 'legacy-fixture-state',
    adapterRevision: 'v1',
    schemaSha256: '0'.repeat(64),
    coreId: TWGB_PACKAGE_CORE_ID,
    romSha256: TWGB_ROM_SHA256,
    memoryBytes: 1,
    fields: [{ key: 'ready', kind: 'integer', read: { address: 0, encoding: 'u8' } }]
  }
  const validated = validateEmulatorStateAdapterManifest(untrustedAdapter)
  if (!validated.ok) throw new Error(validated.reason)
  return {
    schemaVersion: 1,
    gameId: TWGB_PACKAGE_GAME_ID,
    coreId: TWGB_PACKAGE_CORE_ID,
    coreSha256: TWGB_CORE_SHA256,
    romSha256: TWGB_ROM_SHA256,
    stateAdapter: {
      ...untrustedAdapter,
      schemaSha256: sha256(canonicalEmulatorStateAdapterSchemaJson(validated.value))
    }
  }
}

function writeDescriptor(root: string, value: unknown): string {
  const filePath = path.join(root, EMULATOR_PACKAGE_DESCRIPTOR_FILE_NAME)
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
  return filePath
}

function fileSystem(
  overrides: Partial<EmulatorPackageManifestFileSystem> = {}
): EmulatorPackageManifestFileSystem {
  return {
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    readSync: fs.readSync,
    closeSync: fs.closeSync,
    ...overrides
  }
}

function bundle(
  rootPath: string,
  wasmBytes = Buffer.from([0, 97, 115, 109]),
  wasmSha256 = TWGB_RUNTIME_WASM_SHA256
): EmulatorAssetBundle {
  const index = Buffer.from('<!doctype html>')
  return {
    rootPath,
    manifest: {
      schemaVersion: 1,
      gameId: TWGB_PACKAGE_GAME_ID,
      entryPath: 'index.html',
      assets: [
        {
          path: 'index.html',
          sha256: sha256(index),
          byteLength: index.byteLength,
          mimeType: 'text/html'
        },
        {
          path: 'twgb.wasm',
          sha256: wasmSha256,
          byteLength: wasmBytes.byteLength,
          mimeType: 'application/wasm'
        }
      ]
    }
  }
}

describe('emulator package descriptor', () => {
  it('loads a frozen v1 descriptor without reinterpreting it as the fixed v2 package', () => {
    const root = temporaryBundleRoot()
    const runtimeBundle = bundle(root)
    writeDescriptor(root, legacyDescriptor())

    const loaded = loadEmulatorPackageManifest(root)
    expect(loaded).toMatchObject({ schemaVersion: 1, stateAdapter: { schemaVersion: 1 } })
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(validateEmulatorPackageForBundle(loaded, runtimeBundle)).toEqual(loaded)
    expect(() => validateTwgbHomebrewDemoPackage(loaded, runtimeBundle)).toThrow(
      /reviewed game contract/
    )
  })

  it('loads a stable v2 descriptor and binds its schema and WASM hash to the bundle', () => {
    const root = temporaryBundleRoot()
    const runtimeBundle = bundle(root)
    writeDescriptor(root, descriptor(runtimeBundle.manifest.assets[1].sha256))

    const loaded = loadEmulatorPackageManifest(root)
    expect(validateEmulatorPackageForBundle(loaded, runtimeBundle)).toEqual(loaded)
    expect(validateTwgbHomebrewDemoPackage(loaded, runtimeBundle)).toMatchObject({
      schemaVersion: 2,
      coreSha256: TWGB_CORE_SHA256,
      runtimeWasmSha256: runtimeBundle.manifest.assets[1].sha256,
      stateAdapter: {
        schemaVersion: 2,
        stateWindow: { source: 'system_ram', startAddress: 0xc100, byteLength: 13 }
      }
    })
    expect(Object.isFrozen(loaded)).toBe(true)
    expect(Object.isFrozen(loaded.stateAdapter)).toBe(true)
    if (loaded.stateAdapter === null) throw new Error('fixture unexpectedly lacks state adapter')
    expect(Object.isFrozen(loaded.stateAdapter.fields)).toBe(true)
    expect(Object.isFrozen(loaded.stateAdapter.fields[0].read)).toBe(true)
    expect(Reflect.set(loaded.stateAdapter.fields[0].read, 'address', 0)).toBe(false)
  })

  it('rejects an invalid schema hash, a mismatched runtime WASM, and an unexpected TWGB map', () => {
    const root = temporaryBundleRoot()
    const runtimeBundle = bundle(root)
    const runtimeWasmSha256 = runtimeBundle.manifest.assets[1].sha256

    writeDescriptor(
      root,
      descriptor(runtimeWasmSha256, {
        stateAdapter: { ...adapter(), schemaSha256: 'f'.repeat(64) }
      })
    )
    expect(() =>
      validateEmulatorPackageForBundle(loadEmulatorPackageManifest(root), runtimeBundle)
    ).toThrow(/schemaSha256/)

    writeDescriptor(root, descriptor('f'.repeat(64)))
    expect(() =>
      validateEmulatorPackageForBundle(loadEmulatorPackageManifest(root), runtimeBundle)
    ).toThrow(/runtimeWasmSha256/)

    writeDescriptor(
      root,
      descriptor(runtimeWasmSha256, {
        stateAdapter: adapter({
          fields: [{ key: 'x', kind: 'integer', read: { address: 5, encoding: 'u8' }, unit: 'px' }]
        })
      })
    )
    expect(() =>
      validateTwgbHomebrewDemoPackage(loadEmulatorPackageManifest(root), runtimeBundle)
    ).toThrow(/state adapter contract/)
  })

  it('rejects a coordinated descriptor and runtime-manifest WASM hash drift from the fixed pin', () => {
    const root = temporaryBundleRoot()
    const driftedHash = 'e'.repeat(64)
    const driftedBundle = bundle(root, Buffer.from([0, 97, 115, 109]), driftedHash)
    writeDescriptor(root, descriptor(driftedHash))

    const loaded = loadEmulatorPackageManifest(root)
    expect(validateEmulatorPackageForBundle(loaded, driftedBundle)).toEqual(loaded)
    expect(() => validateTwgbHomebrewDemoPackage(loaded, driftedBundle)).toThrow(
      /reviewed game contract/
    )
  })

  it('rejects a non-UTF-8 descriptor before JSON validation', () => {
    const root = temporaryBundleRoot()
    fs.writeFileSync(path.join(root, EMULATOR_PACKAGE_DESCRIPTOR_FILE_NAME), Buffer.from([0xff]))

    expect(() => loadEmulatorPackageManifest(root)).toThrow(/invalid JSON/)
  })

  it('fails closed for descriptor symlinks, oversize files, and truncation', () => {
    const root = temporaryBundleRoot()
    const runtimeBundle = bundle(root)
    const valid = descriptor(runtimeBundle.manifest.assets[1].sha256)
    const descriptorPath = writeDescriptor(root, valid)
    const outside = path.join(root, 'outside.json')
    fs.renameSync(descriptorPath, outside)
    fs.symlinkSync(outside, descriptorPath)
    expect(() => loadEmulatorPackageManifest(root)).toThrow(/regular file/)
    fs.rmSync(descriptorPath)

    fs.writeFileSync(descriptorPath, Buffer.alloc(EMULATOR_MAX_MANIFEST_BYTES + 1, 0x20))
    expect(() => loadEmulatorPackageManifest(root)).toThrow(/byte limit/)

    writeDescriptor(root, valid)
    let firstFstat = true
    expect(() =>
      loadEmulatorPackageManifest(
        root,
        fileSystem({
          fstatSync: (fd) => {
            const stat = fs.fstatSync(fd)
            if (firstFstat) {
              firstFstat = false
              fs.truncateSync(descriptorPath, Math.max(0, stat.size - 1))
            }
            return stat
          }
        })
      )
    ).toThrow(/changed while it was being read/)
  })

  it.skipIf(process.platform === 'win32')(
    'detects a descriptor path swap while it is being read',
    () => {
      // Rename-over-open file replacement is not expressible on win32: the
      // open descriptor holds the name and renameSync fails with EPERM, so the
      // swap mechanism itself throws before the reader can observe it.
      const root = temporaryBundleRoot()
      const runtimeBundle = bundle(root)
      const valid = descriptor(runtimeBundle.manifest.assets[1].sha256)
      const descriptorPath = writeDescriptor(root, valid)
      const replacement = path.join(root, 'replacement.json')
      fs.writeFileSync(replacement, `${JSON.stringify(valid, null, 2)}\n`)
      let firstFstat = true
      expect(() =>
        loadEmulatorPackageManifest(
          root,
          fileSystem({
            fstatSync: (fd) => {
              const stat = fs.fstatSync(fd)
              if (firstFstat) {
                firstFstat = false
                fs.renameSync(replacement, descriptorPath)
              }
              return stat
            }
          })
        )
      ).toThrow(/changed while it was being read/)
    }
  )

  it('rejects a root replacement after the descriptor read', () => {
    const root = temporaryBundleRoot()
    const runtimeBundle = bundle(root)
    writeDescriptor(root, descriptor(runtimeBundle.manifest.assets[1].sha256))
    const replacementRoot = temporaryBundleRoot()
    let rootStatCalls = 0
    expect(() =>
      loadEmulatorPackageManifest(
        root,
        fileSystem({
          lstatSync: (filePath) => {
            if (path.resolve(filePath) === root) {
              rootStatCalls += 1
              if (rootStatCalls === 2) return fs.lstatSync(replacementRoot)
            }
            return fs.lstatSync(filePath)
          }
        })
      )
    ).toThrow(/root changed while it was being read/)
  })
})
