/**
 * Host-owned, bounded ingestion of an external `.cube` LUT for effect preview.
 *
 * This is the ONLY place an operator-supplied filesystem path is touched. It is
 * deliberately narrow: it does not render, it does not grade, and it does not
 * hand a path to anyone. It reads one authorized file, validates it against
 * exactly the rules the Companion's own parser enforces (StudioColorGrade.swift
 * `StudioColorLut.parseCube` and `init(size:entries:)`), and returns an inline
 * payload carrying no path at all.
 *
 * WHY THE PATH NEVER LEAVES: the returned descriptor has no path field, so a
 * path cannot reach the document, the journal or the wire. The Companion is
 * therefore never asked to open an arbitrary file — it receives bounded text it
 * re-verifies by byte length and content hash.
 *
 * WHY IT IS SYNCHRONOUS: validation is descriptor-bound. The file is stat'd,
 * opened once, re-stat'd through that descriptor and read through that same
 * descriptor. An `await` between those steps would reopen the check-to-use
 * window this is written to close.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'

export const STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION = 1
/** A 64-cube of ASCII triples is ~5 MB; 1 MiB comfortably holds any real export. */
export const STUDIO_EFFECT_PREVIEW_MAX_BYTES = 1024 * 1024
/** Mirrors StudioColorLut.maximumSize — a 256-cube would be 64 MB of texture. */
export const STUDIO_EFFECT_PREVIEW_MAX_CUBE_SIZE = 64
export const STUDIO_EFFECT_PREVIEW_MIN_CUBE_SIZE = 2

export type StudioEffectPreviewRejection =
  | 'path_not_absolute'
  | 'path_outside_allowed_roots'
  | 'no_allowed_roots'
  | 'not_a_cube_file'
  | 'symlink_refused'
  | 'not_a_regular_file'
  | 'file_identity_changed'
  | 'empty_file'
  | 'too_large'
  | 'read_failed'
  | 'not_utf8'
  | 'control_characters'
  | 'missing_lut_3d_size'
  | 'duplicate_lut_3d_size'
  | 'one_dimensional_lut'
  | 'unsupported_lut_size'
  | 'malformed_entry'
  | 'non_finite_value'
  | 'entry_count_mismatch'

export class StudioEffectPreviewError extends Error {
  readonly code: StudioEffectPreviewRejection
  constructor(code: StudioEffectPreviewRejection, message: string) {
    super(message)
    this.name = 'StudioEffectPreviewError'
    this.code = code
  }
}

/** The durable, wire-safe preview. Deliberately carries NO filesystem path. */
export interface StudioEffectPreview {
  schemaVersion: typeof STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION
  /** Lowercase SHA-256 hex of the UTF-8 cube text; the stable content identity. */
  effectId: string
  cubeByteLength: number
  cubeText: string
}

function reject(code: StudioEffectPreviewRejection, message: string): never {
  throw new StudioEffectPreviewError(code, message)
}

/**
 * Require the candidate to live inside one of the configured roots. Roots are
 * realpath'd so a symlinked root still authorizes, but the candidate itself is
 * never realpath'd (see loadStudioEffectPreview).
 */
function assertInsideAllowedRoots(candidate: string, allowedMediaRoots: readonly string[]): void {
  if (allowedMediaRoots.length === 0) {
    reject('no_allowed_roots', 'effect preview is unavailable: no allowed media roots configured')
  }
  for (const root of allowedMediaRoots) {
    let resolvedRoot: string
    try {
      resolvedRoot = fs.realpathSync.native(root)
    } catch {
      continue
    }
    if (candidate === resolvedRoot) return
    const prefix = resolvedRoot.endsWith(nodePath.sep) ? resolvedRoot : resolvedRoot + nodePath.sep
    if (candidate.startsWith(prefix)) return
  }
  reject('path_outside_allowed_roots', 'effect preview path is outside the allowed media roots')
}

/**
 * Read through one descriptor and prove the bytes came from the exact file we
 * validated. A path swapped between the stat and the read changes the
 * device/inode pair, which is refused rather than silently accepted.
 */
function readDescriptorBound(path: string): Buffer {
  let beforeStat: fs.Stats
  try {
    beforeStat = fs.lstatSync(path)
  } catch (error) {
    reject('read_failed', `effect preview file could not be inspected: ${String(error)}`)
  }
  if (beforeStat.isSymbolicLink()) {
    reject('symlink_refused', 'effect preview path must not be a symbolic link')
  }
  if (!beforeStat.isFile()) {
    reject('not_a_regular_file', 'effect preview path must be a regular file')
  }
  if (beforeStat.size === 0) reject('empty_file', 'effect preview file is empty')
  if (beforeStat.size > STUDIO_EFFECT_PREVIEW_MAX_BYTES) {
    reject('too_large', `effect preview file exceeds ${STUDIO_EFFECT_PREVIEW_MAX_BYTES} bytes`)
  }

  let descriptor: number
  try {
    descriptor = fs.openSync(path, 'r')
  } catch (error) {
    reject('read_failed', `effect preview file could not be opened: ${String(error)}`)
  }
  try {
    const openedStat = fs.fstatSync(descriptor)
    if (
      !openedStat.isFile() ||
      openedStat.ino !== beforeStat.ino ||
      openedStat.dev !== beforeStat.dev ||
      openedStat.size !== beforeStat.size
    ) {
      reject('file_identity_changed', 'effect preview file changed between validation and read')
    }
    const buffer = Buffer.alloc(openedStat.size)
    let filled = 0
    while (filled < buffer.length) {
      const read = fs.readSync(descriptor, buffer, filled, buffer.length - filled, filled)
      if (read <= 0) reject('read_failed', 'effect preview file ended before its reported size')
      filled += read
    }
    return buffer
  } finally {
    try {
      fs.closeSync(descriptor)
    } catch {
      // Closing is best-effort; the payload is already fully materialised.
    }
  }
}

function decodeBoundedText(buffer: Buffer): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    reject('not_utf8', 'effect preview file is not valid UTF-8')
  }
  // A leading BOM needs no rejection: TextDecoder removes it here, and what
  // travels to the Companion is this DECODED text, hashed as decoded. The
  // Companion therefore never sees a BOM even when the operator's file has one,
  // so a real export that carries one is accepted rather than refused. Note the
  // consequence: cubeByteLength measures the transmitted payload, not the file.
  // A BOM anywhere else is still caught, because it makes its line fail the
  // exact-three-numbers check below.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const isOrdinaryTextControl = code === 0x09 || code === 0x0a || code === 0x0d
    if ((code < 0x20 && !isOrdinaryTextControl) || code === 0x7f) {
      reject('control_characters', `effect preview file has a control character at index ${index}`)
    }
  }
  return text
}

/**
 * Structural validation mirroring StudioColorLut.parseCube, including its
 * tolerances: blank lines, `#` comments, TITLE and DOMAIN_ metadata are skipped
 * rather than refused, because real exports carry them.
 *
 * It parses only to VALIDATE; entries are counted and discarded. The Companion
 * parses the same text itself under the same rules.
 */
function assertParsableCube(text: string): void {
  let size: number | null = null
  let entryCount = 0

  const lines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('TITLE') || line.startsWith('DOMAIN_')) continue
    if (line.startsWith('LUT_1D_SIZE')) {
      reject('one_dimensional_lut', 'one-dimensional LUTs are not supported')
    }
    if (line.startsWith('LUT_3D_SIZE')) {
      if (size !== null) {
        reject('duplicate_lut_3d_size', `second LUT_3D_SIZE at line ${index + 1}`)
      }
      // Swift takes the first Int-parsable token, so a trailing comment token
      // is tolerated there and must be tolerated here too.
      const declared = line
        .split(' ')
        .map((token) => Number.parseInt(token, 10))
        .find((value) => Number.isInteger(value))
      if (declared === undefined) {
        reject('malformed_entry', `malformed LUT_3D_SIZE at line ${index + 1}`)
      }
      if (
        declared < STUDIO_EFFECT_PREVIEW_MIN_CUBE_SIZE ||
        declared > STUDIO_EFFECT_PREVIEW_MAX_CUBE_SIZE
      ) {
        reject('unsupported_lut_size', `LUT_3D_SIZE ${declared} is outside 2...64`)
      }
      size = declared
      continue
    }

    // Swift compactMaps Float over the tokens, so unparseable tokens are DROPPED
    // and the count check is what rejects them. Matching that exactly matters:
    // rejecting on "any non-numeric token" would be stricter than the Companion
    // and would refuse files it accepts.
    const numbers = line
      .split(/[ \t]+/)
      .filter(Boolean)
      .map((token) => Number(token))
      .filter((value) => !Number.isNaN(value))
    if (numbers.length !== 3) {
      reject('malformed_entry', `malformed entry at line ${index + 1}`)
    }
    if (!numbers.every((value) => Number.isFinite(value))) {
      reject('non_finite_value', `non-finite value at line ${index + 1}`)
    }
    entryCount += 1
  }

  if (size === null) reject('missing_lut_3d_size', 'effect preview declares no LUT_3D_SIZE')
  const expected = size * size * size
  if (entryCount !== expected) {
    reject('entry_count_mismatch', `expected ${expected} entries, found ${entryCount}`)
  }
}

/**
 * Validate one operator-supplied `.cube` and return the bounded inline preview.
 * Throws StudioEffectPreviewError with an exact code on every refusal; there is
 * no partial success and no fallback to a previously accepted preview.
 */
export function loadStudioEffectPreview(options: {
  path: string
  allowedMediaRoots: readonly string[]
}): StudioEffectPreview {
  const requested = options.path
  if (typeof requested !== 'string' || !requested || !nodePath.isAbsolute(requested)) {
    reject('path_not_absolute', 'effect preview path must be absolute')
  }
  if (nodePath.extname(requested).toLowerCase() !== '.cube') {
    reject('not_a_cube_file', 'effect preview must be a .cube file')
  }

  // Canonicalise the PARENT only. Realpath on the file itself would follow a
  // symlink we intend to refuse outright, turning an escape into a silent
  // success against whatever the link points at.
  let canonicalParent: string
  try {
    canonicalParent = fs.realpathSync.native(nodePath.dirname(requested))
  } catch (error) {
    reject('read_failed', `effect preview directory could not be resolved: ${String(error)}`)
  }
  const canonical = nodePath.join(canonicalParent, nodePath.basename(requested))
  assertInsideAllowedRoots(canonical, options.allowedMediaRoots)

  const bytes = readDescriptorBound(canonical)
  const cubeText = decodeBoundedText(bytes)
  assertParsableCube(cubeText)

  return {
    schemaVersion: STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION,
    effectId: createHash('sha256').update(cubeText, 'utf8').digest('hex'),
    cubeByteLength: Buffer.byteLength(cubeText, 'utf8'),
    cubeText
  }
}
