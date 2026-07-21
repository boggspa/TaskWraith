import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type {
  ScheduledOccurrenceAuthorityRoot,
  ScheduledOccurrenceLaunchProvider
} from '../ScheduledOccurrenceAuthorityRootStore'

/**
 * Shared derivation primitives for scheduled-occurrence seal evidence.
 *
 * Every digest produced through this module must be derived from the same
 * live source dispatch consumes (a real file, a real resolved argv, a real
 * config object). Producers must never substitute placeholder digests: a
 * value that cannot be derived honestly must throw SealEvidenceError so the
 * caller fails the occurrence closed instead of sealing fabricated authority.
 */

/** Explicit, diagnosable evidence-derivation failure. */
export class SealEvidenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SealEvidenceError'
  }
}

export type CanonicalEvidenceValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalEvidenceValue[]
  | { readonly [key: string]: CanonicalEvidenceValue }

/**
 * Strict canonical JSON. Object keys sort lexicographically at every depth,
 * `undefined` object members are dropped (same meaning as absence), and
 * non-finite numbers, sparse arrays, exotic prototypes, accessors, symbol
 * keys and cycles are rejected. The encoding is injective over accepted
 * values so two different evidence objects can never share one digest.
 */
export function canonicalEvidenceEncode(value: unknown): string {
  return encodeCanonical(value, new Set())
}

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SealEvidenceError('Evidence numbers must be finite.')
    return Object.is(value, -0) ? '-0' : JSON.stringify(value)
  }
  if (typeof value !== 'object') {
    throw new SealEvidenceError(`Unsupported evidence value type: ${typeof value}`)
  }
  if (ancestors.has(value)) throw new SealEvidenceError('Evidence values cannot be cyclic.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new SealEvidenceError('Evidence arrays must use the standard Array prototype.')
      }
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new SealEvidenceError('Evidence arrays must be dense without extra properties.')
      }
      const encoded: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const entry = value[index]
        if (entry === undefined) {
          throw new SealEvidenceError('Evidence arrays cannot contain undefined.')
        }
        encoded.push(encodeCanonical(entry, ancestors))
      }
      return `[${encoded.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SealEvidenceError('Evidence objects must be plain data objects.')
    }
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== 'string') {
        throw new SealEvidenceError('Evidence objects cannot contain symbol keys.')
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new SealEvidenceError('Evidence objects must contain only enumerable data.')
      }
    }
    for (const key of Object.keys(record).sort(compareText)) {
      const entry = record[key]
      if (entry === undefined) continue
      parts.push(`${JSON.stringify(key)}:${encodeCanonical(entry, ancestors)}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function sha256HexOfUtf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256HexOfCanonicalJson(value: unknown): string {
  return sha256HexOfUtf8(canonicalEvidenceEncode(value))
}

/** Keyed HMAC of a canonical evidence value under the per-provider domain. */
export function providerLaunchHmacOfCanonicalJson(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  provider: ScheduledOccurrenceLaunchProvider,
  value: unknown
): string {
  return authorityRoot.providerLaunchHmac(
    provider,
    Buffer.from(canonicalEvidenceEncode(value), 'utf8')
  )
}

export interface SealEvidenceFileDigest {
  /** Fully resolved (symlink-free) canonical absolute path. */
  readonly realPath: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly sha256: string
}

interface CachedFileDigest {
  readonly sizeBytes: number
  readonly mtimeMs: number
  readonly sha256: string
}

/**
 * Streaming SHA-256 of on-disk artifacts with an (realPath, size, mtime)
 * keyed cache so large provider binaries are not re-hashed on every
 * occurrence. A cache hit is an honest derivation shortcut, not a stored
 * assertion: any size or mtime change re-hashes the bytes.
 */
export class SealEvidenceFileHasher {
  private readonly cache = new Map<string, CachedFileDigest>()

  async digestFile(path: string): Promise<SealEvidenceFileDigest> {
    const real = await resolveRealFilePath(path)
    const info = await stat(real)
    if (!info.isFile()) {
      throw new SealEvidenceError(`Seal evidence path is not a regular file: ${real}`)
    }
    const cached = this.cache.get(real)
    if (cached && cached.sizeBytes === info.size && cached.mtimeMs === info.mtimeMs) {
      return { realPath: real, sizeBytes: info.size, mtimeMs: info.mtimeMs, sha256: cached.sha256 }
    }
    const sha256 = await streamSha256(real)
    // Re-stat after hashing: if the file changed while we streamed it, the
    // digest may describe neither the before nor the after image. Refuse to
    // cache or return a torn read.
    const after = await stat(real)
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new SealEvidenceError(`Seal evidence file changed while hashing: ${real}`)
    }
    this.cache.set(real, { sizeBytes: info.size, mtimeMs: info.mtimeMs, sha256 })
    return { realPath: real, sizeBytes: info.size, mtimeMs: info.mtimeMs, sha256 }
  }
}

async function resolveRealFilePath(path: string): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SealEvidenceError('Seal evidence file path is required.')
  }
  let real: string
  try {
    real = await realpath(path)
  } catch (error) {
    throw new SealEvidenceError(`Seal evidence path could not be resolved: ${path}`, {
      cause: error
    })
  }
  if (!isAbsolute(real) || resolve(real) !== real) {
    throw new SealEvidenceError(`Seal evidence path is not canonical: ${real}`)
  }
  return real
}

async function streamSha256(realPath: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(realPath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (error) =>
      rejectPromise(
        new SealEvidenceError(`Seal evidence file could not be hashed: ${realPath}`, {
          cause: error
        })
      )
    )
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * Canonical argv-template digest. Callers replace prompt bytes and
 * per-occurrence route identifiers (run ids, socket paths, ports, temp
 * files) with the stable placeholder tokens below BEFORE digesting, so one
 * template digest covers every occurrence of the same launch shape.
 */
export const SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER = '{taskwraith:prompt}'
export const SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER = '{taskwraith:route}'

export function launchArgsTemplateSha256(argvTemplate: readonly string[]): string {
  if (!Array.isArray(argvTemplate) || argvTemplate.some((entry) => typeof entry !== 'string')) {
    throw new SealEvidenceError('Launch argv template must be an array of strings.')
  }
  return sha256HexOfCanonicalJson({ schemaVersion: 1, argv: argvTemplate })
}

/**
 * Replace values of token-like flags (`--token X`, `--api-key=X`, …) with the
 * route placeholder so secret or per-occurrence values never enter an
 * unkeyed template digest, while the structural flag shape stays bound.
 */
export function placeholdTokenFlagValues(args: readonly string[]): string[] {
  const output: string[] = []
  let placeholdNext = false
  for (const arg of args) {
    if (placeholdNext) {
      output.push(SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER)
      placeholdNext = false
      continue
    }
    if (/^--?(token|bearer|secret|auth|key|password)[a-z-]*$/i.test(arg)) {
      output.push(arg)
      placeholdNext = true
      continue
    }
    const flagValueMatch = /^(--?(?:token|bearer|secret|auth|key|password)[a-z-]*)=(.*)$/i.exec(
      arg
    )
    if (flagValueMatch) {
      output.push(`${flagValueMatch[1]}=${SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER}`)
      continue
    }
    output.push(arg)
  }
  return output
}

/** Replace every value in a string record with the route placeholder. */
export function placeholdRecordValues(
  record: Readonly<Record<string, string>>
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const key of Object.keys(record)) {
    output[key] = SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
  }
  return output
}

export interface InterpreterRuntimeAttestation {
  readonly attestation: CanonicalEvidenceValue
  readonly sha256: string
}

const SHEBANG_PROBE_BYTES = 512

/**
 * Attest the runtime that will actually interpret the executable. Native
 * binaries attest as such; `#!` scripts attest the exact shebang line plus
 * the resolved interpreter file digest. `#!/usr/bin/env <name>` resolves
 * <name> against the SAME PATH the spawn environment will use, because that
 * is the interpreter the kernel-exec/env chain will pick at launch.
 */
export async function interpreterRuntimeAttestationSha256(
  executableRealPath: string,
  spawnEnvPath: string | undefined,
  hasher: SealEvidenceFileHasher
): Promise<InterpreterRuntimeAttestation> {
  const shebang = await readShebangLine(executableRealPath)
  if (shebang === null) {
    const attestation = { schemaVersion: 1, kind: 'native-executable' } as const
    return { attestation, sha256: sha256HexOfCanonicalJson(attestation) }
  }
  const parsed = parseShebang(shebang)
  let interpreterPath = parsed.interpreter
  let envResolvedName: string | null = null
  if (isEnvShebang(parsed.interpreter)) {
    const name = parsed.argument
    if (!name) {
      throw new SealEvidenceError(
        `Shebang env interpreter has no target in ${executableRealPath}`
      )
    }
    envResolvedName = name
    interpreterPath = resolveFromPathEnvironment(name, spawnEnvPath, executableRealPath)
  }
  const interpreterDigest = await hasher.digestFile(interpreterPath)
  const attestation = {
    schemaVersion: 1,
    kind: 'shebang-script',
    shebangLine: shebang,
    envResolvedName,
    interpreterRealPath: interpreterDigest.realPath,
    interpreterSha256: interpreterDigest.sha256
  } as const
  return { attestation, sha256: sha256HexOfCanonicalJson(attestation) }
}

async function readShebangLine(executableRealPath: string): Promise<string | null> {
  let handle
  try {
    handle = await open(executableRealPath, 'r')
  } catch (error) {
    throw new SealEvidenceError(
      `Seal evidence executable could not be opened: ${executableRealPath}`,
      { cause: error }
    )
  }
  try {
    const buffer = Buffer.alloc(SHEBANG_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SHEBANG_PROBE_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    if (bytesRead < 2 || head[0] !== 0x23 || head[1] !== 0x21) return null
    const newline = head.indexOf(0x0a)
    const lineBytes = newline === -1 ? head : head.subarray(0, newline)
    return lineBytes.toString('utf8').replace(/\r$/, '')
  } finally {
    await handle.close()
  }
}

function parseShebang(line: string): { interpreter: string; argument: string | null } {
  const body = line.slice(2).trim()
  if (!body) throw new SealEvidenceError('Shebang line has no interpreter.')
  const spaceIndex = body.indexOf(' ')
  if (spaceIndex === -1) return { interpreter: body, argument: null }
  const interpreter = body.slice(0, spaceIndex)
  const argument = body.slice(spaceIndex + 1).trim()
  return { interpreter, argument: argument.length > 0 ? argument : null }
}

function isEnvShebang(interpreter: string): boolean {
  return parse(interpreter).base === 'env'
}

function resolveFromPathEnvironment(
  name: string,
  spawnEnvPath: string | undefined,
  executableRealPath: string
): string {
  if (name.includes('/')) return name
  const searchPath = typeof spawnEnvPath === 'string' ? spawnEnvPath : ''
  const directories = searchPath.split(delimiter).filter((entry) => entry.length > 0)
  for (const directory of directories) {
    const candidate = join(directory, name)
    // First existing regular file wins, mirroring execvp PATH semantics; the
    // caller digests the returned path and fails loudly if it is unusable.
    if (fileExistsSync(candidate)) return candidate
  }
  throw new SealEvidenceError(
    `Shebang interpreter '${name}' for ${executableRealPath} is not resolvable from the spawn PATH.`
  )
}

function fileExistsSync(candidate: string): boolean {
  if (!existsSync(candidate)) return false
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Locate the package.json governing an installed CLI entry file by walking
 * toward the filesystem root. Used to bind runtimeBundleSha256 for wrapper
 * or script CLIs whose executable file alone does not pin the package.
 */
export async function nearestPackageManifestPath(startFile: string): Promise<string | null> {
  let directory = dirname(startFile)
  for (let depth = 0; depth < 64; depth += 1) {
    const candidate = join(directory, 'package.json')
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Keep walking.
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return null
}

const SECRET_KEY_PATTERN =
  /token|secret|password|passwd|credential|authorization|cookie|bearer|api[-_]?key|refresh|private[-_]?key|session[-_]?id|(^|[-_])auth([-_]|$)/i

/**
 * Deep-copy a configuration object with every secret-shaped string value
 * replaced by a keyed HMAC reference. The digest of the redacted object
 * changes when a secret rotates (the HMAC changes) without ever binding the
 * secret bytes into an unkeyed digest.
 */
export function redactConfigurationSecrets(
  value: unknown,
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  provider: ScheduledOccurrenceLaunchProvider
): CanonicalEvidenceValue {
  return redactNode(value, authorityRoot, provider, false, new Set())
}

function redactNode(
  value: unknown,
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  provider: ScheduledOccurrenceLaunchProvider,
  secretContext: boolean,
  ancestors: Set<object>
): CanonicalEvidenceValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SealEvidenceError('Configuration evidence numbers must be finite.')
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'string') {
    if (!secretContext) return value
    return {
      __taskwraithRedactedSecretHmac: authorityRoot.providerLaunchHmac(
        provider,
        Buffer.from(value, 'utf8')
      )
    }
  }
  if (typeof value !== 'object') {
    throw new SealEvidenceError(`Unsupported configuration value type: ${typeof value}`)
  }
  if (ancestors.has(value)) throw new SealEvidenceError('Configuration values cannot be cyclic.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        redactNode(
          entry === undefined ? null : entry,
          authorityRoot,
          provider,
          secretContext,
          ancestors
        )
      )
    }
    const record = value as Record<string, unknown>
    const output: Record<string, CanonicalEvidenceValue> = {}
    for (const key of Object.keys(record).sort(compareText)) {
      const entry = record[key]
      if (entry === undefined) continue
      output[key] = redactNode(
        entry,
        authorityRoot,
        provider,
        secretContext || SECRET_KEY_PATTERN.test(key),
        ancestors
      )
    }
    return output
  } finally {
    ancestors.delete(value)
  }
}
