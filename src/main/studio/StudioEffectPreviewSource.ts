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
  | 'invalid_payload'
  | 'unexpected_field'
  | 'identity_mismatch'
  | 'import_failed'

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
 * Swift's `Int()` / `Float()` are STRICTER than JavaScript's `parseInt()` /
 * `Number()`. `Int("2junk")` and `Int("0x10")` are nil in Swift, while
 * `parseInt("2junk")` is 2 and `Number("0x1")` is 1. Accepting those here would
 * persist a "validated" preview the Companion then refuses — a durable document
 * the product cannot load.
 *
 * These patterns are a deliberate SUBSET of what both parsers accept, which
 * makes the host marginally stricter than Swift (it refuses exotic hex-float
 * literals like `0x1p3`). That asymmetry is the safe direction: refusing an
 * exotic file at the boundary costs one clear rejection code, whereas accepting
 * one wedges a document the Companion will not load.
 */
const SWIFT_INT_TOKEN = /^[+-]?[0-9]+$/
const SWIFT_DECIMAL_TOKEN = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/
/**
 * Swift's `Float()` DOES accept these, so they must parse here too and then be
 * refused by the finiteness check — exactly as the Companion refuses them with
 * `valueOutOfRange`. Filtering them out as unparseable instead would make the
 * non-finite branch unreachable and report the wrong reason.
 */
const SWIFT_NONFINITE_TOKEN = /^[+-]?(inf(inity)?|nan)$/i

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
        .filter((token) => SWIFT_INT_TOKEN.test(token))
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
      .filter((token) => SWIFT_DECIMAL_TOKEN.test(token) || SWIFT_NONFINITE_TOKEN.test(token))
      .map((token) =>
        SWIFT_NONFINITE_TOKEN.test(token) ? Number.POSITIVE_INFINITY : Number(token)
      )
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

/** The exact wire/document keys. Anything else is refused, never ignored. */
const STUDIO_EFFECT_PREVIEW_KEYS = ['cubeByteLength', 'cubeText', 'effectId', 'schemaVersion']

/**
 * The single validation authority for an inline preview, wherever it arrives
 * from: a freshly read file, a journal replay, or a snapshot on disk.
 *
 * Adversarial review found the durable path was NOT enforcing what the loader
 * proved. A lowercase 64-hex id belonging to DIFFERENT bytes was accepted and
 * journaled, the cube was never re-parsed, and the cap was 2 MiB instead of the
 * ratified 1 MiB. Everything that can place a preview into the document now
 * comes through here, so those three can no longer diverge.
 *
 * It returns a FRESH four-key object, which is what stops a hand-edited
 * snapshot carrying an extra `path` key from reaching the document or the wire:
 * the extra key is refused outright, and even a passing payload is rebuilt.
 */
export function assertValidStudioEffectPreview(candidate: unknown): StudioEffectPreview {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    reject('invalid_payload', 'effect preview must be an object')
  }
  const record = candidate as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== STUDIO_EFFECT_PREVIEW_KEYS.length) {
    reject(
      'unexpected_field',
      `effect preview must carry exactly ${STUDIO_EFFECT_PREVIEW_KEYS.join(', ')}`
    )
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== STUDIO_EFFECT_PREVIEW_KEYS[index]) {
      reject('unexpected_field', `effect preview carries an unexpected field: ${keys[index]}`)
    }
  }
  if (record.schemaVersion !== STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION) {
    reject(
      'invalid_payload',
      `effect preview requires schemaVersion ${STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION}`
    )
  }
  const cubeText = record.cubeText
  if (typeof cubeText !== 'string' || cubeText.length === 0) {
    reject('invalid_payload', 'cubeText must be a non-empty string')
  }
  const actualByteLength = Buffer.byteLength(cubeText, 'utf8')
  if (actualByteLength > STUDIO_EFFECT_PREVIEW_MAX_BYTES) {
    reject('too_large', `effect preview exceeds ${STUDIO_EFFECT_PREVIEW_MAX_BYTES} bytes`)
  }
  if (record.cubeByteLength !== actualByteLength) {
    reject(
      'invalid_payload',
      `cubeByteLength ${String(record.cubeByteLength)} does not match the ${actualByteLength} byte payload`
    )
  }
  const expectedId = createHash('sha256').update(cubeText, 'utf8').digest('hex')
  if (record.effectId !== expectedId) {
    // The load-bearing one: a lowercase 64-hex id of DIFFERENT bytes used to
    // pass. Identity is recomputed, never merely pattern-matched.
    reject('identity_mismatch', 'effectId is not the SHA-256 of cubeText')
  }
  assertParsableCube(cubeText)

  return {
    schemaVersion: STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION,
    effectId: expectedId,
    cubeByteLength: actualByteLength,
    cubeText
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

  // Deliberately routed through the same authority the durable path uses, so
  // the file boundary and the replay boundary cannot drift apart again.
  return assertValidStudioEffectPreview({
    schemaVersion: STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION,
    effectId: createHash('sha256').update(cubeText, 'utf8').digest('hex'),
    cubeByteLength: Buffer.byteLength(cubeText, 'utf8'),
    cubeText
  })
}

/**
 * Separates the content identity from the operator's filename inside the owned
 * root. Two underscores cannot appear in a 64-hex effectId, so the split point
 * is unambiguous.
 */
const EFFECT_PREVIEW_NAME_SEPARATOR = '__'
const IMPORTED_NAME_MAX_LENGTH = 64

/**
 * Reduce an operator filename to a safe single path component. `basename` has
 * already removed any directory, and this additionally refuses anything outside
 * a conservative allowlist so a crafted name cannot alter the path shape.
 */
function sanitiseImportedName(displayName: string): string {
  const base = displayName.replace(/\.cube$/i, '')
  // Spaces are deliberately preserved: `basename` has already removed any
  // directory, so a space cannot alter the path shape, and rewriting it would
  // make the restored label differ from the file the operator actually chose.
  const safe = base
    .replace(/[^A-Za-z0-9 ._-]/g, '_')
    .slice(0, IMPORTED_NAME_MAX_LENGTH)
    .replace(/^[\s.]+|\s+$/g, '')
  return `${safe.length > 0 ? safe : 'lut'}.cube`
}

/** Every imported file in `root` whose content identity is exactly `effectId`. */
function findImportedCubes(root: string, effectId: string): string[] {
  const prefix = `${effectId}${EFFECT_PREVIEW_NAME_SEPARATOR}`
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.toLowerCase().endsWith('.cube'))
    .map((entry) => nodePath.join(root, entry))
}

/**
 * Recover the operator-facing label for a durable effectId after a restart.
 * Returns null when the imported file is gone — the preview itself still works,
 * because the cube text lives in the document, so this degrades the label only.
 */
export function resolveImportedEffectPreviewName(root: string, effectId: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(effectId)) return null
  const matches = findImportedCubes(root, effectId).sort()
  const first = matches[0]
  if (!first) return null
  return nodePath.basename(first).slice(effectId.length + EFFECT_PREVIEW_NAME_SEPARATOR.length)
}

/** The result of importing one operator-selected `.cube` into the owned root. */
export interface StudioEffectPreviewImport {
  /**
   * Absolute path INSIDE `destinationRoot`. Safe to hand to
   * loadStudioEffectPreview, whose jail then re-validates it for real.
   */
  path: string
  preview: StudioEffectPreview
  /**
   * The operator's own filename, for UI state ONLY. It is never persisted into
   * the document, the journal or the wire — the durable payload has no path
   * field by construction.
   */
  displayName: string
}

/**
 * Copy one operator-selected `.cube` into the Studio-owned effect-preview root.
 *
 * WHY THIS EXISTS: `loadStudioEffectPreview` only accepts paths inside an owned
 * root, and no operator's LUT starts life there. This is the single hop that
 * takes a file the operator explicitly chose and places a validated copy inside
 * the jail, so the jail stays a REAL boundary instead of being widened to
 * wherever the file happened to live.
 *
 * WHY THE SOURCE PATH IS NOT JAILED: it originates from `dialog.showOpenDialog`
 * in the main process and nowhere else. The renderer cannot supply a path — the
 * Load IPC deliberately takes no argument — so the threat the jail defends
 * against (a caller naming an arbitrary file for the host to read) cannot occur
 * here. Every OTHER protection still applies, and applies BEFORE the copy: the
 * bytes are read through the same descriptor-bound reader, decoded through the
 * same bounded UTF-8 decoder, and validated by the same authority. An oversized,
 * symlinked, non-regular, non-UTF-8 or malformed file is refused without ever
 * being written into the owned root.
 */
export function importStudioEffectPreview(options: {
  sourcePath: string
  destinationRoot: string
}): StudioEffectPreviewImport {
  const requested = options.sourcePath
  if (typeof requested !== 'string' || !requested || !nodePath.isAbsolute(requested)) {
    reject('path_not_absolute', 'effect preview path must be absolute')
  }
  if (nodePath.extname(requested).toLowerCase() !== '.cube') {
    reject('not_a_cube_file', 'effect preview must be a .cube file')
  }

  // Bounded, descriptor-bound, and validated BEFORE anything is written.
  const bytes = readDescriptorBound(requested)
  const cubeText = decodeBoundedText(bytes)
  const preview = assertValidStudioEffectPreview({
    schemaVersion: STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION,
    effectId: createHash('sha256').update(cubeText, 'utf8').digest('hex'),
    cubeByteLength: Buffer.byteLength(cubeText, 'utf8'),
    cubeText
  })

  // Content-addressed, but carrying a sanitised copy of the operator's filename
  // so the active-LUT label survives a restart. The durable document holds only
  // the effectId, so without this the UI could only show a hash after relaunch.
  const displayName = nodePath.basename(requested)
  const destination = nodePath.join(
    options.destinationRoot,
    `${preview.effectId}${EFFECT_PREVIEW_NAME_SEPARATOR}${sanitiseImportedName(displayName)}`
  )
  const temporary = nodePath.join(
    options.destinationRoot,
    `.${preview.effectId}.${process.pid}.tmp`
  )
  try {
    fs.mkdirSync(options.destinationRoot, { recursive: true })
    // Write-then-rename so a crash mid-copy can never leave a truncated `.cube`
    // that the loader would later read as authoritative.
    fs.writeFileSync(temporary, cubeText, { encoding: 'utf8', mode: 0o600 })
    // Drop any earlier import of these EXACT bytes under a different filename,
    // so recovering the label by effectId stays unambiguous.
    for (const stale of findImportedCubes(options.destinationRoot, preview.effectId)) {
      if (stale === destination) continue
      try {
        fs.unlinkSync(stale)
      } catch {
        // A surviving duplicate is cosmetic, not corrupting.
      }
    }
    fs.renameSync(temporary, destination)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // Best-effort cleanup; the original failure is what matters.
    }
    reject('import_failed', `effect preview could not be imported: ${String(error)}`)
  }

  return { path: destination, preview, displayName }
}
