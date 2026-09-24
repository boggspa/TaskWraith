/**
 * Disk-only emulator package descriptor loader.
 *
 * `manifest.json` names only browser-served files. This descriptor instead
 * binds a fixed package's core, ROM, browser WASM, and bounded state adapter
 * before main creates an emulator driver. It is deliberately never added to
 * the twemu asset manifest.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  canonicalEmulatorStateAdapterSchemaJson,
  EMULATOR_MAX_MANIFEST_BYTES,
  EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2,
  EMULATOR_STATE_ADAPTER_SCHEMA_V2,
  validateEmulatorPackageManifest,
  type EmulatorPackageManifest,
  type EmulatorPackageManifestV1,
  type EmulatorPackageManifestV2,
  type EmulatorStateAdapterManifestV1,
  type EmulatorStateAdapterManifestV2
} from '../../shared/emulatorCanvas'
import type { EmulatorAssetBundle } from './EmulatorAssetManifest'

export const EMULATOR_PACKAGE_DESCRIPTOR_FILE_NAME = 'emulator-package.json'
export const EMULATOR_RUNTIME_WASM_PATH = 'twgb.wasm'
export const TWGB_PACKAGE_GAME_ID = 'homebrew-demo'
export const TWGB_PACKAGE_CORE_ID = 'sameboy-libretro'
export const TWGB_CORE_SHA256 = 'd22bc58f152733c8731c17348a1b1ff1f99384fd146784a8f58793419be46611'
export const TWGB_ROM_SHA256 = '2175c6b758fdd76e4e878ccf10ee04f50135be74226f548df78dff4fea5806c7'
export const TWGB_RUNTIME_WASM_SHA256 =
  'b39d5364ad374d365ae1e3b5ef142b990a5a159713a2a26be379ae9c86dededf'
export const TWGB_STATE_WINDOW = Object.freeze({
  source: 'system_ram' as const,
  startAddress: 0xc100,
  byteLength: 13
})

/** Narrow file-system seam for deterministic descriptor race tests. */
export interface EmulatorPackageManifestFileSystem {
  readonly lstatSync: (filePath: string) => fs.Stats
  readonly openSync: (filePath: string, flags: number) => number
  readonly fstatSync: (fd: number) => fs.Stats
  readonly readSync: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ) => number
  readonly closeSync: (fd: number) => void
}

const NODE_FILE_SYSTEM: EmulatorPackageManifestFileSystem = {
  lstatSync: fs.lstatSync,
  openSync: fs.openSync,
  fstatSync: fs.fstatSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync
}

function sameFile(before: fs.Stats, after: fs.Stats): boolean {
  return before.isFile() && after.isFile() && before.dev === after.dev && before.ino === after.ino
}

function sameDirectory(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.isDirectory() &&
    after.isDirectory() &&
    before.dev === after.dev &&
    before.ino === after.ino
  )
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function freezeAdapter(adapter: EmulatorStateAdapterManifestV2): EmulatorStateAdapterManifestV2 {
  const fields = adapter.fields.map((field) =>
    Object.freeze({
      ...field,
      read: Object.freeze({ ...field.read }),
      ...(field.enumValues ? { enumValues: Object.freeze({ ...field.enumValues }) } : {})
    })
  )
  return Object.freeze({
    ...adapter,
    fields: Object.freeze(fields),
    stateWindow: Object.freeze({ ...adapter.stateWindow })
  })
}

function freezeLegacyAdapter(
  adapter: EmulatorStateAdapterManifestV1
): EmulatorStateAdapterManifestV1 {
  const fields = adapter.fields.map((field) =>
    Object.freeze({
      ...field,
      read: Object.freeze({ ...field.read }),
      ...(field.enumValues ? { enumValues: Object.freeze({ ...field.enumValues }) } : {})
    })
  )
  return Object.freeze({ ...adapter, fields: Object.freeze(fields) })
}

function freezeDescriptor(descriptor: EmulatorPackageManifest): EmulatorPackageManifest {
  if (descriptor.schemaVersion === EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2) {
    if (descriptor.stateAdapter === null) return Object.freeze({ ...descriptor })
    return Object.freeze({
      ...descriptor,
      stateAdapter: freezeAdapter(descriptor.stateAdapter)
    }) as EmulatorPackageManifestV2
  }
  if (descriptor.stateAdapter === null) return Object.freeze({ ...descriptor })
  return Object.freeze({
    ...descriptor,
    stateAdapter: freezeLegacyAdapter(descriptor.stateAdapter)
  }) as EmulatorPackageManifestV1
}

function readBoundedRegularFile(
  filePath: string,
  label: string,
  fileSystem: EmulatorPackageManifestFileSystem
): Buffer {
  const before = fileSystem.lstatSync(filePath)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > EMULATOR_MAX_MANIFEST_BYTES
  ) {
    throw new Error(`${label} must be a regular file within the descriptor byte limit.`)
  }

  let fd: number | null = null
  try {
    fd = fileSystem.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fileSystem.fstatSync(fd)
    if (!sameFile(before, opened) || opened.size !== before.size) {
      throw new Error(`${label} changed while it was being opened.`)
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const bytesRead = fileSystem.readSync(fd, bytes, offset, bytes.byteLength - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = fileSystem.fstatSync(fd)
    const pathAfter = fileSystem.lstatSync(filePath)
    if (
      offset !== bytes.byteLength ||
      !sameFile(opened, after) ||
      !sameFile(opened, pathAfter) ||
      after.size !== bytes.byteLength ||
      pathAfter.size !== bytes.byteLength
    ) {
      throw new Error(`${label} changed while it was being read.`)
    }
    return bytes
  } finally {
    if (fd !== null) fileSystem.closeSync(fd)
  }
}

function validateTwgbMappedFields(adapter: EmulatorStateAdapterManifestV2): void {
  const expected = [
    { key: 'x', address: 6, encoding: 'u8', unit: 'px' },
    { key: 'y', address: 7, encoding: 'u8', unit: 'px' },
    { key: 'input', address: 8, encoding: 'u8', unit: 'mask' },
    { key: 'frame-counter', address: 9, encoding: 'u32le', unit: 'frames' }
  ] as const
  if (
    adapter.adapterId !== 'twgb-state-window' ||
    adapter.adapterRevision !== 'v1' ||
    adapter.memoryBytes !== TWGB_STATE_WINDOW.byteLength ||
    adapter.stateWindow.source !== TWGB_STATE_WINDOW.source ||
    adapter.stateWindow.startAddress !== TWGB_STATE_WINDOW.startAddress ||
    adapter.stateWindow.byteLength !== TWGB_STATE_WINDOW.byteLength ||
    adapter.fields.length !== expected.length
  ) {
    throw new Error('TWGB package descriptor has an unexpected state adapter contract.')
  }
  for (const [index, expectedField] of expected.entries()) {
    const field = adapter.fields[index]
    if (
      field.key !== expectedField.key ||
      field.kind !== 'integer' ||
      field.unit !== expectedField.unit ||
      field.read.address !== expectedField.address ||
      field.read.encoding !== expectedField.encoding ||
      field.read.bit !== undefined ||
      field.read.scale !== undefined ||
      field.read.offset !== undefined
    ) {
      throw new Error(`TWGB package descriptor has an unexpected mapped field at index ${index}.`)
    }
  }
}

/**
 * Verify package metadata against the reviewed browser asset manifest.
 *
 * The shared validator checks wire shape and package↔adapter core/ROM pairing.
 * This main-only boundary also recomputes the adapter schema hash and binds the
 * v2 runtime WASM declaration to the exact browser-served asset.
 */
export function validateEmulatorPackageForBundle(
  rawDescriptor: unknown,
  bundle: EmulatorAssetBundle
): EmulatorPackageManifest {
  const validated = validateEmulatorPackageManifest(rawDescriptor)
  if (!validated.ok) throw new Error(validated.reason)
  const descriptor = freezeDescriptor(validated.value)
  if (descriptor.gameId !== bundle.manifest.gameId) {
    throw new Error('Emulator package descriptor gameId does not match its runtime manifest.')
  }
  if (descriptor.stateAdapter) {
    const canonical = canonicalEmulatorStateAdapterSchemaJson(descriptor.stateAdapter)
    if (sha256Hex(Buffer.from(canonical, 'utf8')) !== descriptor.stateAdapter.schemaSha256) {
      throw new Error('Emulator package descriptor state adapter schemaSha256 does not match.')
    }
  }
  if (descriptor.schemaVersion !== EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2) return descriptor

  const wasm = bundle.manifest.assets.find((asset) => asset.path === EMULATOR_RUNTIME_WASM_PATH)
  if (!wasm || wasm.mimeType !== 'application/wasm') {
    throw new Error('Emulator package descriptor runtime manifest does not list twgb.wasm.')
  }
  if (descriptor.runtimeWasmSha256 !== wasm.sha256) {
    throw new Error('Emulator package descriptor runtimeWasmSha256 does not match twgb.wasm.')
  }
  return descriptor
}

/**
 * Load and validate a descriptor from a reviewed bundle root without following
 * a descriptor symlink or accepting a path replacement during the read.
 */
export function loadEmulatorPackageManifest(
  rootPath: string,
  fileSystem: EmulatorPackageManifestFileSystem = NODE_FILE_SYSTEM
): EmulatorPackageManifest {
  const root = path.resolve(rootPath)
  const rootBefore = fileSystem.lstatSync(root)
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error('Emulator package descriptor root must be a real directory.')
  }
  const filePath = path.join(root, EMULATOR_PACKAGE_DESCRIPTOR_FILE_NAME)
  const bytes = readBoundedRegularFile(filePath, 'Emulator package descriptor', fileSystem)
  const rootAfter = fileSystem.lstatSync(root)
  if (!sameDirectory(rootBefore, rootAfter) || rootAfter.isSymbolicLink()) {
    throw new Error('Emulator package descriptor root changed while it was being read.')
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    throw new Error(
      `Emulator package descriptor is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const validated = validateEmulatorPackageManifest(raw)
  if (!validated.ok) throw new Error(validated.reason)
  return freezeDescriptor(validated.value)
}

/** Verify the fixed first-party package before a driver can be constructed. */
export function validateTwgbHomebrewDemoPackage(
  descriptor: EmulatorPackageManifest,
  bundle: EmulatorAssetBundle
): EmulatorPackageManifestV2 {
  const bound = validateEmulatorPackageForBundle(descriptor, bundle)
  if (
    bound.schemaVersion !== EMULATOR_PACKAGE_MANIFEST_SCHEMA_V2 ||
    bound.gameId !== TWGB_PACKAGE_GAME_ID ||
    bound.coreId !== TWGB_PACKAGE_CORE_ID ||
    bound.coreSha256 !== TWGB_CORE_SHA256 ||
    bound.runtimeWasmSha256 !== TWGB_RUNTIME_WASM_SHA256 ||
    bound.romSha256 !== TWGB_ROM_SHA256 ||
    bound.stateAdapter === null ||
    bound.stateAdapter.schemaVersion !== EMULATOR_STATE_ADAPTER_SCHEMA_V2
  ) {
    throw new Error('Packaged TWGB emulator descriptor does not match the reviewed game contract.')
  }
  validateTwgbMappedFields(bound.stateAdapter)
  return bound
}
