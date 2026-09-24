/**
 * Immutable packaged-emulator asset manifest and resolver.
 *
 * The future runnable emulator receives one reviewed bundle root per fixed
 * `CanvasEmulatorGameId`. These are public bytes shipped with TaskWraith—not a
 * capability for user ROMs, private assets, or emulator state. This module has
 * no network, Electron, or arbitrary-path input: a `twemu://app/...` request
 * resolves only when its game, relative path, MIME type, byte length, and
 * SHA-256 all match a supplied manifest.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isCanvasEmulatorGameId, type CanvasEmulatorGameId } from '../canvas/canvasTypes'

export const TWEMU_SCHEME = 'twemu'
export const TWEMU_HOST = 'app'
export const EMULATOR_MANIFEST_FILE_NAME = 'manifest.json'
export const EMULATOR_ENTRY_PATH = 'index.html'
export const MAX_EMULATOR_MANIFEST_BYTES = 64 * 1024
export const MAX_EMULATOR_ASSET_BYTES = 32 * 1024 * 1024

export const EMULATOR_ASSET_MIME_TYPES = [
  'text/html',
  'text/css',
  'application/javascript',
  'application/wasm',
  'application/octet-stream'
] as const

export type EmulatorAssetMimeType = (typeof EMULATOR_ASSET_MIME_TYPES)[number]

/** MIME-specific ceilings prevent one listed asset from exhausting main memory. */
export const EMULATOR_ASSET_MIME_BYTE_CAPS: Readonly<Record<EmulatorAssetMimeType, number>> = {
  'text/html': 512 * 1024,
  'text/css': 256 * 1024,
  'application/javascript': 2 * 1024 * 1024,
  'application/wasm': MAX_EMULATOR_ASSET_BYTES,
  'application/octet-stream': 8 * 1024 * 1024
}

export interface EmulatorAssetManifestEntry {
  readonly path: string
  readonly sha256: string
  readonly byteLength: number
  readonly mimeType: EmulatorAssetMimeType
}

export interface EmulatorAssetManifest {
  readonly schemaVersion: 1
  readonly gameId: CanvasEmulatorGameId
  readonly entryPath: typeof EMULATOR_ENTRY_PATH
  readonly assets: readonly EmulatorAssetManifestEntry[]
}

export interface EmulatorAssetBundle {
  readonly rootPath: string
  readonly manifest: EmulatorAssetManifest
}

export interface EmulatorAssetRegistry {
  bundleFor(gameId: CanvasEmulatorGameId): EmulatorAssetBundle | null
}

export interface EmulatorAssetRequest {
  readonly gameId: CanvasEmulatorGameId
  readonly assetPath: string
}

export interface ResolvedEmulatorAsset extends EmulatorAssetRequest {
  readonly bytes: Buffer
  readonly mimeType: EmulatorAssetMimeType
}

const SHA256_HEX = /^[a-f0-9]{64}$/
const ASSET_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MIME_SET: ReadonlySet<string> = new Set(EMULATOR_ASSET_MIME_TYPES)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function sameFile(before: fs.Stats, opened: fs.Stats): boolean {
  return (
    before.isFile() && opened.isFile() && before.dev === opened.dev && before.ino === opened.ino
  )
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  )
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A strict POSIX bundle-relative path; never a filesystem path or URL. */
export function isSafeEmulatorAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 240) {
    return false
  }
  if (
    value.includes('\\') ||
    value.includes('\u0000') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return false
  }
  const segments = value.split('/')
  return segments.length > 0 && segments.every((segment) => ASSET_SEGMENT.test(segment))
}

export function emulatorAssetUrl(
  gameId: CanvasEmulatorGameId,
  assetPath = EMULATOR_ENTRY_PATH
): string {
  if (!isSafeEmulatorAssetPath(assetPath)) {
    throw new Error('Emulator asset path must be a safe manifest-relative path.')
  }
  const encodedPath = assetPath.split('/').map(encodeURIComponent).join('/')
  return `${TWEMU_SCHEME}://${TWEMU_HOST}/${encodeURIComponent(gameId)}/${encodedPath}`
}

/** The immutable page URL CanvasEmulatorDriver asks its trusted runtime bridge to load. */
export function emulatorEntryUrl(gameId: CanvasEmulatorGameId): string {
  return emulatorAssetUrl(gameId, EMULATOR_ENTRY_PATH)
}

export function validateEmulatorAssetManifest(
  value: unknown
): { ok: true; manifest: EmulatorAssetManifest } | { ok: false; reason: string } {
  const input = asRecord(value)
  if (!input || input.schemaVersion !== 1) {
    return { ok: false, reason: 'Emulator asset manifest must use schemaVersion 1.' }
  }
  if (!isCanvasEmulatorGameId(input.gameId)) {
    return { ok: false, reason: 'Emulator asset manifest has an unsupported game id.' }
  }
  if (input.entryPath !== EMULATOR_ENTRY_PATH) {
    return {
      ok: false,
      reason: `Emulator asset manifest entryPath must be ${EMULATOR_ENTRY_PATH}.`
    }
  }
  if (!Array.isArray(input.assets) || input.assets.length === 0 || input.assets.length > 32) {
    return { ok: false, reason: 'Emulator asset manifest must list one to 32 assets.' }
  }

  const seen = new Set<string>()
  const assets: EmulatorAssetManifestEntry[] = []
  for (const rawEntry of input.assets) {
    const entry = asRecord(rawEntry)
    const assetPath = entry?.path
    const sha256 = entry?.sha256
    const byteLength = entry?.byteLength
    const mimeType = entry?.mimeType
    if (!isSafeEmulatorAssetPath(assetPath) || seen.has(assetPath)) {
      return { ok: false, reason: 'Emulator asset manifest has an unsafe or duplicate asset path.' }
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      return { ok: false, reason: 'Emulator asset manifest has an invalid asset SHA-256.' }
    }
    if (typeof mimeType !== 'string' || !MIME_SET.has(mimeType)) {
      return { ok: false, reason: 'Emulator asset manifest has an unsupported MIME type.' }
    }
    if (
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      byteLength > MAX_EMULATOR_ASSET_BYTES ||
      byteLength > EMULATOR_ASSET_MIME_BYTE_CAPS[mimeType as EmulatorAssetMimeType]
    ) {
      return { ok: false, reason: 'Emulator asset manifest has an invalid asset byte length.' }
    }
    seen.add(assetPath)
    assets.push({
      path: assetPath,
      sha256,
      byteLength,
      mimeType: mimeType as EmulatorAssetMimeType
    })
  }
  if (!seen.has(EMULATOR_ENTRY_PATH)) {
    return { ok: false, reason: 'Emulator asset manifest does not list its entry page.' }
  }
  if (assets.find((asset) => asset.path === EMULATOR_ENTRY_PATH)?.mimeType !== 'text/html') {
    return { ok: false, reason: 'Emulator asset manifest entry page must use text/html.' }
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      gameId: input.gameId,
      entryPath: EMULATOR_ENTRY_PATH,
      assets
    }
  }
}

/**
 * Load one reviewed bundle from disk. Production wiring lands separately; this
 * pure main-process helper lets package and protocol tests use a temporary root.
 */
export function loadEmulatorAssetBundle(rootPath: string): EmulatorAssetBundle {
  const root = path.resolve(rootPath)
  const manifestPath = path.join(root, EMULATOR_MANIFEST_FILE_NAME)
  const manifestStat = fs.lstatSync(manifestPath)
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size <= 0 ||
    manifestStat.size > MAX_EMULATOR_MANIFEST_BYTES
  ) {
    throw new Error('Emulator asset manifest must be a regular file.')
  }
  let fd: number | null = null
  let bytes: Buffer | null = null
  try {
    fd = fs.openSync(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(fd)
    if (!sameFile(manifestStat, opened) || opened.size > MAX_EMULATOR_MANIFEST_BYTES) {
      throw new Error('Emulator asset manifest changed while it was being opened.')
    }
    bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    if (
      !sameFile(opened, after) ||
      after.size !== bytes.byteLength ||
      bytes.byteLength > MAX_EMULATOR_MANIFEST_BYTES
    ) {
      throw new Error('Emulator asset manifest changed while it was being read.')
    }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
  if (!bytes) throw new Error('Emulator asset manifest could not be read.')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new Error(
      `Emulator asset manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const validation = validateEmulatorAssetManifest(parsed)
  if (!validation.ok) throw new Error(validation.reason)
  return { rootPath: root, manifest: validation.manifest }
}

/** Build a fixed registry; duplicate game ids or malformed bundles fail at startup. */
export function createEmulatorAssetRegistry(
  bundles: readonly EmulatorAssetBundle[]
): EmulatorAssetRegistry {
  const byGame = new Map<CanvasEmulatorGameId, EmulatorAssetBundle>()
  for (const bundle of bundles) {
    const validation = validateEmulatorAssetManifest(bundle.manifest)
    if (!validation.ok) throw new Error(validation.reason)
    if (byGame.has(validation.manifest.gameId)) {
      throw new Error(
        `Emulator asset registry has a duplicate game id: ${validation.manifest.gameId}.`
      )
    }
    if (typeof bundle.rootPath !== 'string' || !path.isAbsolute(bundle.rootPath)) {
      throw new Error('Emulator asset bundle root must be an absolute path.')
    }
    byGame.set(validation.manifest.gameId, {
      rootPath: path.resolve(bundle.rootPath),
      manifest: validation.manifest
    })
  }
  return { bundleFor: (gameId) => byGame.get(gameId) ?? null }
}

/** Resolve the fixed emulator root in dev or from electron-builder extraResources. */
export function emulatorAssetRoot(input: {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
}): string {
  return input.isPackaged
    ? path.join(path.resolve(input.resourcesPath), 'emulator')
    : path.join(path.resolve(input.appPath), 'resources', 'emulator')
}

/** Parse only exact `twemu://app/<known-game>/<manifest-listed-path>` URLs. */
export function parseEmulatorAssetUrl(value: string): EmulatorAssetRequest | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== `${TWEMU_SCHEME}:` ||
      url.hostname !== TWEMU_HOST ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }
    const encodedSegments = url.pathname.slice(1).split('/')
    if (encodedSegments.length < 2 || encodedSegments.some((segment) => !segment)) return null
    const segments = encodedSegments.map((segment) => decodeURIComponent(segment))
    if (segments.some((segment) => segment.includes('/') || segment.includes('\\'))) return null
    const [rawGameId, ...assetSegments] = segments
    if (!isCanvasEmulatorGameId(rawGameId)) return null
    const assetPath = assetSegments.join('/')
    return isSafeEmulatorAssetPath(assetPath) ? { gameId: rawGameId, assetPath } : null
  } catch {
    return null
  }
}

/**
 * Read one listed asset from its immutable bundle and verify the declared hash.
 * Every failure intentionally becomes null so the protocol can return one opaque
 * 404 for malformed, unauthorized, missing, replaced, or tampered assets.
 */
export function resolveEmulatorAsset(
  registry: EmulatorAssetRegistry,
  requestUrl: string
): ResolvedEmulatorAsset | null {
  const request = parseEmulatorAssetUrl(requestUrl)
  if (!request) return null
  const bundle = registry.bundleFor(request.gameId)
  if (!bundle || !path.isAbsolute(bundle.rootPath)) return null
  const validation = validateEmulatorAssetManifest(bundle.manifest)
  if (!validation.ok || validation.manifest.gameId !== request.gameId) return null
  const asset = validation.manifest.assets.find((entry) => entry.path === request.assetPath)
  if (!asset) return null

  let fd: number | null = null
  try {
    const root = fs.realpathSync(bundle.rootPath)
    if (!fs.statSync(root).isDirectory()) return null
    const candidate = path.resolve(root, asset.path)
    if (!isPathInside(root, candidate)) return null
    const before = fs.lstatSync(candidate)
    if (!before.isFile() || before.isSymbolicLink()) return null
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = fs.fstatSync(fd)
    if (!sameFile(before, opened) || opened.size !== asset.byteLength) return null
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    if (
      !sameFile(opened, after) ||
      after.size !== asset.byteLength ||
      bytes.byteLength !== asset.byteLength ||
      sha256Hex(bytes) !== asset.sha256
    ) {
      return null
    }
    return { ...request, bytes, mimeType: asset.mimeType }
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}
