import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import {
  cursorGlobalBrokerRegistrationKey,
  type CursorGlobalBrokerRegistryCleanupReceipt,
  type CursorGlobalBrokerRegistryInstallContext,
  type CursorGlobalBrokerRegistryInstallation
} from './CursorGlobalBrokerRegistryLease'
import {
  CURSOR_MCP_SERVER_NAME,
  CURSOR_SCOPED_MCP_SERVER_NAME,
  mergeGlobalCursorMcpServers
} from './CursorMcpBridge'

/**
 * The global Cursor MCP registry is durable user state. This transaction owns
 * only TaskWraith's canonical broker entry and its obsolete scoped alias. It
 * installs with a same-directory fsync+rename and, if commit becomes ambiguous,
 * rolls back only while those owned keys still match the attempted value.
 *
 * Unrelated top-level fields and user/global MCP servers are merged from the
 * latest CAS snapshot on every attempt. Invalid JSON, symlinks, foreign owned
 * names, and observed owned-key drift fail closed for the broker attachment;
 * Cursor itself remains available through the caller's native-only fallback.
 * Portable Node does not expose an atomic compare-and-swap rename: changes
 * observed before replacement are preserved or retried, while the unavoidable
 * final check-to-rename race is reflected in unverified recovery receipts.
 * `restored-verified` is intentionally narrow: it proves original existence,
 * exact bytes, portable mode bits, and device/inode identity were unchanged.
 * Portable Node cannot make that outcome a claim about every extended
 * attribute or about a non-cooperating writer after the observation.
 */

export interface CursorGlobalBrokerTransactionStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface CursorGlobalBrokerTransactionFs {
  lstatSync(path: string): CursorGlobalBrokerTransactionStat
  realpathSync(path: string): string
  readFileSync(path: string, encoding: 'utf8'): string
  mkdirSync(path: string, options: { recursive: boolean; mode?: number }): unknown
  openSync(path: string, flags: string, mode?: number): number
  writeFileSync(file: number, data: string, options: { encoding: 'utf8' }): void
  fchmodSync(file: number, mode: number): void
  fsyncSync(file: number): void
  closeSync(file: number): void
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { force?: boolean }): void
}

export interface CursorGlobalBrokerRegistrationTransactionOptions {
  readonly fs: CursorGlobalBrokerTransactionFs
  readonly registryPath: string
  readonly registryDirectory: string
  /** Defaults to three exact-byte CAS attempts and is capped at ten. */
  readonly maxCasAttempts?: number
  /**
   * POSIX production should retain this default. Windows cannot portably fsync
   * a directory handle through Node, so its caller may disable directory fsync;
   * file fsync, atomic rename, and post-commit verification still apply.
   */
  readonly fsyncDirectory?: boolean
}

export interface CursorGlobalBrokerRegistrationTransaction {
  readonly install: (
    context: CursorGlobalBrokerRegistryInstallContext
  ) => CursorGlobalBrokerRegistryInstallation
  readonly onInstallFailure: (
    error: unknown,
    context: CursorGlobalBrokerRegistryInstallContext
  ) => CursorGlobalBrokerRegistryCleanupReceipt
}

interface RegistrySnapshot {
  readonly existed: boolean
  readonly bytes: string | null
  readonly mode: number | null
  readonly device: number | bigint | null
  readonly inode: number | bigint | null
  readonly root: Record<string, unknown>
}

type RegistryCasExpectation = Pick<
  RegistrySnapshot,
  'existed' | 'bytes' | 'mode' | 'device' | 'inode'
>

interface OwnedEntryState {
  readonly present: boolean
  readonly value?: unknown
}

type OwnedProjection = Readonly<Record<string, OwnedEntryState>>

interface FailureState {
  readonly resourceKey: string
  readonly registrationKey: string
  readonly ownedNames: readonly string[]
  readonly beforeExisted: boolean
  readonly beforeBytes: string | null
  readonly beforeMode: number | null
  readonly beforeDevice: number | bigint | null
  readonly beforeInode: number | bigint | null
  readonly beforeOwned: OwnedProjection
  readonly beforeMcpServersPresent: boolean
  readonly beforeUnrelated: unknown
  readonly desiredOwned: OwnedProjection
}

class CursorGlobalBrokerAtomicMutationError extends Error {
  constructor(
    readonly mutationPhase: 'pre-rename' | 'rename-invoked' | 'post-rename',
    readonly targetMayHaveMutated: boolean,
    readonly temporaryCleanupAmbiguous: boolean,
    readonly originalError: unknown
  ) {
    super(
      `Cursor global broker atomic ${mutationPhase} step failed: ${errorMessage(originalError)}`
    )
    this.name = 'CursorGlobalBrokerAtomicMutationError'
  }
}

const ALLOWED_GLOBAL_OWNED_SERVER_NAMES = new Set([
  CURSOR_MCP_SERVER_NAME,
  CURSOR_SCOPED_MCP_SERVER_NAME
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cleanupFailed(message: string): CursorGlobalBrokerRegistryCleanupReceipt {
  return { outcome: 'cleanup-failed', message }
}

function restoreUnverified(detail: string): CursorGlobalBrokerRegistryCleanupReceipt {
  return { outcome: 'restore-attempted-unverified', detail }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function lstatOptional(
  fs: CursorGlobalBrokerTransactionFs,
  path: string
): CursorGlobalBrokerTransactionStat | null {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function assertAbsoluteRegistryPaths(registryPath: string, registryDirectory: string): void {
  if (!isAbsolute(registryPath) || !isAbsolute(registryDirectory)) {
    throw new Error('Cursor global broker transaction paths must be absolute.')
  }
  if (dirname(registryPath) !== registryDirectory) {
    throw new Error('Cursor global broker registry must be directly inside its declared directory.')
  }
}

function assertNoSymlinkedExistingAncestor(
  fs: CursorGlobalBrokerTransactionFs,
  target: string
): void {
  const absolute = resolve(target)
  const root = parse(absolute).root
  const relativeSegments = absolute
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  let current = root
  for (const segment of relativeSegments) {
    current = join(current, segment)
    const stat = lstatOptional(fs, current)
    if (!stat) return
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing Cursor global MCP write through symlinked ancestor: ${current}`)
    }
  }
}

function assertSafeDirectory(
  fs: CursorGlobalBrokerTransactionFs,
  registryDirectory: string,
  create: boolean
): void {
  assertNoSymlinkedExistingAncestor(fs, registryDirectory)
  let stat = lstatOptional(fs, registryDirectory)
  if (!stat && create) {
    fs.mkdirSync(registryDirectory, { recursive: true, mode: 0o700 })
    stat = lstatOptional(fs, registryDirectory)
  }
  if (!stat) throw new Error(`Cursor global MCP directory does not exist: ${registryDirectory}`)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Refusing Cursor global MCP write through unsafe directory: ${registryDirectory}`
    )
  }
  if (resolve(fs.realpathSync(registryDirectory)) !== resolve(registryDirectory)) {
    throw new Error(
      `Refusing Cursor global MCP write through aliased directory: ${registryDirectory}`
    )
  }
}

function assertSafeRegistryTarget(
  fs: CursorGlobalBrokerTransactionFs,
  registryPath: string
): CursorGlobalBrokerTransactionStat | null {
  const stat = lstatOptional(fs, registryPath)
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`Refusing Cursor global MCP write through unsafe target: ${registryPath}`)
  }
  return stat
}

function asJsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function canonicalDecimalToken(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (!match) throw new Error(`Invalid JSON number token: ${token}`)
  const negative = match[1] === '-'
  const fraction = match[3] ?? ''
  let digits = `${match[2]}${fraction}`.replace(/^0+/, '')
  if (!digits) return '0e0'
  let exponent = BigInt(match[4] ?? '0') - BigInt(fraction.length)
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exponent += 1n
  }
  return `${negative ? '-' : ''}${digits}e${exponent.toString()}`
}

function assertLosslessJsonNumbers(bytes: string): void {
  let inString = false
  let escaped = false
  for (let index = 0; index < bytes.length; index += 1) {
    const character = bytes[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character !== '-' && (character < '0' || character > '9')) continue
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(bytes.slice(index))
    if (!match) continue
    const token = match[0]
    const value = Number(token)
    const serialized = Number.isFinite(value) ? JSON.stringify(value) : null
    if (
      !serialized ||
      Object.is(value, -0) ||
      canonicalDecimalToken(token) !== canonicalDecimalToken(serialized)
    ) {
      throw new Error(
        `Cursor global mcp.json contains a number that cannot be losslessly rewritten: ${token}`
      )
    }
    index += token.length - 1
  }
}

function assertNoDuplicateJsonObjectKeys(bytes: string): void {
  let offset = 0

  const whitespace = (): void => {
    while (offset < bytes.length && /[\t\n\r ]/.test(bytes[offset])) offset += 1
  }
  const parseString = (): string => {
    const start = offset
    offset += 1
    let escaped = false
    while (offset < bytes.length) {
      const character = bytes[offset]
      offset += 1
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '"') return JSON.parse(bytes.slice(start, offset)) as string
    }
    throw new Error('Cursor global mcp.json contains an unterminated JSON string.')
  }
  const parseValue = (depth: number): void => {
    if (depth > 256) {
      throw new Error('Cursor global mcp.json is nested too deeply for a lossless rewrite.')
    }
    whitespace()
    const character = bytes[offset]
    if (character === '"') {
      parseString()
      return
    }
    if (character === '{') {
      parseObject(depth + 1)
      return
    }
    if (character === '[') {
      parseArray(depth + 1)
      return
    }
    const literal = /^(?:true|false|null)/.exec(bytes.slice(offset))
    if (literal) {
      offset += literal[0].length
      return
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(bytes.slice(offset))
    if (!number) throw new Error('Cursor global mcp.json contains an invalid JSON value.')
    offset += number[0].length
  }
  const parseObject = (depth: number): void => {
    offset += 1
    whitespace()
    const keys = new Set<string>()
    if (bytes[offset] === '}') {
      offset += 1
      return
    }
    for (;;) {
      whitespace()
      if (bytes[offset] !== '"') {
        throw new Error('Cursor global mcp.json contains a non-string object key.')
      }
      const key = parseString()
      if (keys.has(key)) {
        throw new Error(`Cursor global mcp.json contains a duplicate object key: ${key}`)
      }
      keys.add(key)
      whitespace()
      if (bytes[offset] !== ':') {
        throw new Error('Cursor global mcp.json contains an object key without a colon.')
      }
      offset += 1
      parseValue(depth)
      whitespace()
      if (bytes[offset] === '}') {
        offset += 1
        return
      }
      if (bytes[offset] !== ',') {
        throw new Error('Cursor global mcp.json contains an invalid object separator.')
      }
      offset += 1
    }
  }
  const parseArray = (depth: number): void => {
    offset += 1
    whitespace()
    if (bytes[offset] === ']') {
      offset += 1
      return
    }
    for (;;) {
      parseValue(depth)
      whitespace()
      if (bytes[offset] === ']') {
        offset += 1
        return
      }
      if (bytes[offset] !== ',') {
        throw new Error('Cursor global mcp.json contains an invalid array separator.')
      }
      offset += 1
    }
  }

  parseValue(0)
  whitespace()
  if (offset !== bytes.length) {
    throw new Error('Cursor global mcp.json contains trailing JSON data.')
  }
}

function readSnapshot(
  fs: CursorGlobalBrokerTransactionFs,
  registryPath: string,
  registryDirectory: string
): RegistrySnapshot {
  assertSafeDirectory(fs, registryDirectory, false)
  const stat = assertSafeRegistryTarget(fs, registryPath)
  if (!stat) {
    return {
      existed: false,
      bytes: null,
      mode: null,
      device: null,
      inode: null,
      root: {}
    }
  }
  const bytes = fs.readFileSync(registryPath, 'utf8')
  const statAfterRead = assertSafeRegistryTarget(fs, registryPath)
  if (
    !statAfterRead ||
    statAfterRead.dev !== stat.dev ||
    statAfterRead.ino !== stat.ino ||
    (Number(statAfterRead.mode) & 0o777) !== (Number(stat.mode) & 0o777)
  ) {
    throw new Error('Cursor global mcp.json changed identity or mode while it was being read.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    throw new Error('Cursor global mcp.json is not valid JSON; refusing to replace user state.')
  }
  assertLosslessJsonNumbers(bytes)
  assertNoDuplicateJsonObjectKeys(bytes)
  const root = asJsonRecord(parsed, 'Cursor global mcp.json root')
  if ('mcpServers' in root) {
    asJsonRecord(root.mcpServers, 'Cursor global mcpServers')
  }
  return {
    existed: true,
    bytes,
    mode: Number(stat.mode) & 0o777,
    device: stat.dev,
    inode: stat.ino,
    root
  }
}

function matchesCasExpectation(
  snapshot: RegistrySnapshot,
  expected: RegistryCasExpectation
): boolean {
  return (
    snapshot.existed === expected.existed &&
    snapshot.bytes === expected.bytes &&
    snapshot.mode === expected.mode &&
    snapshot.device === expected.device &&
    snapshot.inode === expected.inode
  )
}

function mcpServers(root: Record<string, unknown>): Record<string, unknown> {
  if (!('mcpServers' in root)) return {}
  return asJsonRecord(root.mcpServers, 'Cursor global mcpServers')
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value && typeof value === 'object') {
    const result = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      Object.defineProperty(result, key, {
        value: stableJsonValue((value as Record<string, unknown>)[key]),
        enumerable: true
      })
    }
    return result
  }
  return value
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function ownedProjection(
  root: Record<string, unknown>,
  ownedNames: readonly string[]
): OwnedProjection {
  const servers = mcpServers(root)
  const projection = Object.create(null) as Record<string, OwnedEntryState>
  for (const name of ownedNames) {
    const present = Object.prototype.hasOwnProperty.call(servers, name)
    Object.defineProperty(projection, name, {
      value: present ? { present: true, value: servers[name] } : { present: false },
      enumerable: true
    })
  }
  return projection
}

function unrelatedProjection(
  root: Record<string, unknown>,
  ownedNames: readonly string[]
): unknown {
  const topLevel = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(root)) {
    if (key !== 'mcpServers') topLevel[key] = root[key]
  }
  const owned = new Set(ownedNames)
  const otherServers = Object.create(null) as Record<string, unknown>
  for (const [name, entry] of Object.entries(mcpServers(root))) {
    if (!owned.has(name)) otherServers[name] = entry
  }
  return { topLevel, otherServers }
}

function validateOwnedNames(
  brokerEntries: Readonly<Record<string, unknown>>,
  removeServerNames: readonly string[]
): readonly string[] {
  const names = [...new Set([...Object.keys(brokerEntries), ...removeServerNames])].sort()
  if (names.length === 0) {
    throw new Error('Cursor global broker transaction has no TaskWraith-owned entries.')
  }
  for (const name of names) {
    if (!ALLOWED_GLOBAL_OWNED_SERVER_NAMES.has(name)) {
      throw new Error(`Cursor global broker transaction refused non-owned server name: ${name}`)
    }
  }
  return names
}

function desiredRoot(
  root: Record<string, unknown>,
  context: CursorGlobalBrokerRegistryInstallContext
): Record<string, unknown> {
  return mergeGlobalCursorMcpServers(
    root,
    context.descriptor.brokerEntries,
    context.descriptor.removeServerNames
  )
}

function restoreOwnedEntries(
  current: RegistrySnapshot,
  state: FailureState
): Record<string, unknown> {
  const restored: Record<string, unknown> = { ...current.root }
  const servers: Record<string, unknown> = { ...mcpServers(current.root) }
  for (const name of state.ownedNames) {
    const original = state.beforeOwned[name]
    if (original.present) servers[name] = original.value
    else delete servers[name]
  }
  if (Object.keys(servers).length > 0 || state.beforeMcpServersPresent) {
    restored.mcpServers = servers
  } else {
    delete restored.mcpServers
  }
  return restored
}

function writeJsonBytes(root: Record<string, unknown>): string {
  return `${JSON.stringify(root, null, 2)}\n`
}

/**
 * Returns false when exact input bytes drifted before rename. Throws for a real
 * or ambiguous write failure. The caller owns the bounded retry loop.
 */
function atomicReplaceIfBytesMatch(input: {
  fs: CursorGlobalBrokerTransactionFs
  registryPath: string
  registryDirectory: string
  expected: RegistryCasExpectation
  replacementBytes: string
  replacementMode: number
  fsyncDirectory: boolean
}): boolean {
  const { fs, registryPath, registryDirectory } = input
  assertSafeDirectory(fs, registryDirectory, true)
  assertSafeRegistryTarget(fs, registryPath)

  const temporaryPath = join(
    registryDirectory,
    `.${basename(registryPath)}.taskwraith-${process.pid}-${randomUUID()}.tmp`
  )
  let temporaryFd: number | null = null
  let renameInvoked = false
  let renamed = false
  let result = false
  let primaryError: unknown = null
  try {
    temporaryFd = fs.openSync(temporaryPath, 'wx', input.replacementMode)
    fs.writeFileSync(temporaryFd, input.replacementBytes, { encoding: 'utf8' })
    // open(2) applies the process umask even when replacing an existing file.
    // Restore the exact portable permission bits before the durable flush.
    fs.fchmodSync(temporaryFd, input.replacementMode)
    fs.fsyncSync(temporaryFd)
    fs.closeSync(temporaryFd)
    temporaryFd = null

    const latest = readSnapshot(fs, registryPath, registryDirectory)
    if (matchesCasExpectation(latest, input.expected)) {
      assertSafeDirectory(fs, registryDirectory, false)
      assertSafeRegistryTarget(fs, registryPath)
      // renameSync can replace the target and still throw from an injected or
      // wrapped filesystem implementation. Invocation itself is therefore the
      // boundary after which rollback authority is only CAS-conditional.
      renameInvoked = true
      fs.renameSync(temporaryPath, registryPath)
      renamed = true

      if (input.fsyncDirectory) {
        const directoryFd = fs.openSync(registryDirectory, 'r')
        try {
          fs.fsyncSync(directoryFd)
        } finally {
          fs.closeSync(directoryFd)
        }
      }
      result = true
    }
  } catch (error) {
    primaryError = error
  }

  let temporaryCleanupError: unknown = null
  if (temporaryFd !== null) {
    try {
      fs.closeSync(temporaryFd)
    } catch (error) {
      temporaryCleanupError = error
    }
  }
  if (!renamed) {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch (error) {
      temporaryCleanupError ??= error
    }
  }
  if (primaryError || temporaryCleanupError) {
    throw new CursorGlobalBrokerAtomicMutationError(
      renamed ? 'post-rename' : renameInvoked ? 'rename-invoked' : 'pre-rename',
      renameInvoked,
      Boolean(temporaryCleanupError),
      primaryError ?? temporaryCleanupError
    )
  }
  return result
}

function atomicRemoveIfBytesMatch(input: {
  fs: CursorGlobalBrokerTransactionFs
  registryPath: string
  registryDirectory: string
  expected: RegistryCasExpectation
  fsyncDirectory: boolean
}): boolean {
  const latest = readSnapshot(input.fs, input.registryPath, input.registryDirectory)
  if (!latest.existed || !matchesCasExpectation(latest, input.expected)) return false
  assertSafeDirectory(input.fs, input.registryDirectory, false)
  assertSafeRegistryTarget(input.fs, input.registryPath)
  input.fs.rmSync(input.registryPath, { force: false })
  if (input.fsyncDirectory) {
    const directoryFd = input.fs.openSync(input.registryDirectory, 'r')
    try {
      input.fs.fsyncSync(directoryFd)
    } finally {
      input.fs.closeSync(directoryFd)
    }
  }
  return true
}

export function createCursorGlobalBrokerRegistrationTransaction(
  options: CursorGlobalBrokerRegistrationTransactionOptions
): CursorGlobalBrokerRegistrationTransaction {
  assertAbsoluteRegistryPaths(options.registryPath, options.registryDirectory)
  const fsyncDirectory = options.fsyncDirectory ?? process.platform !== 'win32'
  const requestedAttempts = options.maxCasAttempts ?? 3
  if (!Number.isFinite(requestedAttempts)) {
    throw new Error('Cursor global broker CAS attempt count must be finite.')
  }
  const maxCasAttempts = Math.max(1, Math.min(10, Math.trunc(requestedAttempts)))
  let failureState: FailureState | null = null
  let recoveryReceipt: CursorGlobalBrokerRegistryCleanupReceipt | null = null
  let targetMayHaveMutated = false

  const install = (
    context: CursorGlobalBrokerRegistryInstallContext
  ): CursorGlobalBrokerRegistryInstallation => {
    failureState = null
    recoveryReceipt = null
    targetMayHaveMutated = false
    assertSafeDirectory(options.fs, options.registryDirectory, true)
    const expectedResourceKey = join(
      options.fs.realpathSync(options.registryDirectory),
      basename(options.registryPath)
    )
    if (resolve(context.resourceKey) !== resolve(expectedResourceKey)) {
      throw new Error(
        'Cursor global broker transaction resource does not match the lease resource.'
      )
    }
    if (context.registrationKey !== cursorGlobalBrokerRegistrationKey(context.descriptor)) {
      throw new Error(
        'Cursor global broker transaction descriptor does not match the lease registration key.'
      )
    }
    const ownedNames = validateOwnedNames(
      context.descriptor.brokerEntries,
      context.descriptor.removeServerNames
    )

    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      assertSafeDirectory(options.fs, options.registryDirectory, true)
      const before = readSnapshot(options.fs, options.registryPath, options.registryDirectory)
      const desired = desiredRoot(before.root, context)
      const beforeOwned = ownedProjection(before.root, ownedNames)
      const desiredOwned = ownedProjection(desired, ownedNames)
      failureState = {
        resourceKey: resolve(expectedResourceKey),
        registrationKey: context.registrationKey,
        ownedNames,
        beforeExisted: before.existed,
        beforeBytes: before.bytes,
        beforeMode: before.mode,
        beforeDevice: before.device,
        beforeInode: before.inode,
        beforeOwned,
        beforeMcpServersPresent: Object.prototype.hasOwnProperty.call(before.root, 'mcpServers'),
        beforeUnrelated: unrelatedProjection(before.root, ownedNames),
        desiredOwned
      }

      if (jsonEqual(beforeOwned, desiredOwned)) {
        return { onLastRelease: () => ({ outcome: 'retained-persistent' }) }
      }

      let committed: boolean
      try {
        committed = atomicReplaceIfBytesMatch({
          fs: options.fs,
          registryPath: options.registryPath,
          registryDirectory: options.registryDirectory,
          expected: before,
          replacementBytes: writeJsonBytes(desired),
          replacementMode: before.mode ?? 0o600,
          fsyncDirectory
        })
      } catch (error) {
        if (error instanceof CursorGlobalBrokerAtomicMutationError && error.targetMayHaveMutated) {
          targetMayHaveMutated = true
        }
        throw error
      }
      if (!committed) continue
      targetMayHaveMutated = true

      const verified = readSnapshot(options.fs, options.registryPath, options.registryDirectory)
      if (!jsonEqual(ownedProjection(verified.root, ownedNames), desiredOwned)) {
        throw new Error('Cursor global broker commit verification found owned-key drift.')
      }
      if (
        !jsonEqual(
          unrelatedProjection(verified.root, ownedNames),
          unrelatedProjection(before.root, ownedNames)
        )
      ) {
        throw new Error('Cursor global broker commit verification found unrelated registry drift.')
      }
      return { onLastRelease: () => ({ outcome: 'retained-persistent' }) }
    }

    throw new Error(
      `Cursor global broker registry changed during all ${maxCasAttempts} bounded CAS attempts.`
    )
  }

  const onInstallFailure = (
    installError: unknown,
    context: CursorGlobalBrokerRegistryInstallContext
  ): CursorGlobalBrokerRegistryCleanupReceipt => {
    const state = failureState
    if (
      state &&
      (resolve(context.resourceKey) !== state.resourceKey ||
        context.registrationKey !== state.registrationKey ||
        context.registrationKey !== cursorGlobalBrokerRegistrationKey(context.descriptor))
    ) {
      return cleanupFailed(
        'Cursor global broker rollback refused because the failure callback context did not match the attempted installation.'
      )
    }
    if (recoveryReceipt) return recoveryReceipt
    if (
      installError instanceof CursorGlobalBrokerAtomicMutationError &&
      installError.temporaryCleanupAmbiguous
    ) {
      recoveryReceipt = cleanupFailed(
        'Cursor global broker installation failed and cleanup of a same-directory credential-bearing temporary file could not be verified.'
      )
      return recoveryReceipt
    }
    if (!state) {
      recoveryReceipt = cleanupFailed(
        `Cursor global broker install failed before a rollback snapshot could be verified: ${errorMessage(installError)}`
      )
      return recoveryReceipt
    }

    if (!targetMayHaveMutated) {
      try {
        const current = readSnapshot(options.fs, options.registryPath, options.registryDirectory)
        const untouched =
          current.existed === state.beforeExisted &&
          current.bytes === state.beforeBytes &&
          current.mode === state.beforeMode &&
          current.device === state.beforeDevice &&
          current.inode === state.beforeInode
        recoveryReceipt = untouched
          ? { outcome: 'restored-verified' }
          : restoreUnverified(
              'No target rename was invoked, so TaskWraith left concurrent registry changes untouched; the captured bytes, portable mode, or file identity no longer matched the pre-install snapshot.'
            )
      } catch (error) {
        recoveryReceipt = restoreUnverified(
          `No target rename was invoked, but current registry state could not be inspected after the failed installation: ${errorMessage(error)}`
        )
      }
      return recoveryReceipt
    }

    for (let attempt = 0; attempt < maxCasAttempts; attempt += 1) {
      let current: RegistrySnapshot
      try {
        current = readSnapshot(options.fs, options.registryPath, options.registryDirectory)
      } catch (error) {
        recoveryReceipt = cleanupFailed(
          `Cursor global broker rollback could not inspect current registry state: ${errorMessage(error)}`
        )
        return recoveryReceipt
      }
      const currentOwned = ownedProjection(current.root, state.ownedNames)
      if (jsonEqual(currentOwned, state.beforeOwned)) {
        recoveryReceipt =
          current.existed === state.beforeExisted &&
          current.bytes === state.beforeBytes &&
          current.mode === state.beforeMode &&
          current.device === state.beforeDevice &&
          current.inode === state.beforeInode
            ? { outcome: 'restored-verified' }
            : restoreUnverified(
                'TaskWraith-owned broker keys already match their original state, but the captured bytes, portable mode, or file identity changed concurrently.'
              )
        return recoveryReceipt
      }
      if (!jsonEqual(currentOwned, state.desiredOwned)) {
        recoveryReceipt = cleanupFailed(
          'Cursor global broker rollback refused because a TaskWraith-owned key no longer matched the attempted installation.'
        )
        return recoveryReceipt
      }

      const unrelatedBeforeRollback = unrelatedProjection(current.root, state.ownedNames)
      const restored = restoreOwnedEntries(current, state)
      const restoreAbsence =
        !state.beforeExisted &&
        jsonEqual(unrelatedBeforeRollback, state.beforeUnrelated) &&
        current.bytes !== null
      try {
        const committed = restoreAbsence
          ? atomicRemoveIfBytesMatch({
              fs: options.fs,
              registryPath: options.registryPath,
              registryDirectory: options.registryDirectory,
              expected: current,
              fsyncDirectory
            })
          : atomicReplaceIfBytesMatch({
              fs: options.fs,
              registryPath: options.registryPath,
              registryDirectory: options.registryDirectory,
              expected: current,
              replacementBytes: writeJsonBytes(restored),
              replacementMode: state.beforeMode ?? current.mode ?? 0o600,
              fsyncDirectory
            })
        if (!committed) continue
      } catch (error) {
        if (
          error instanceof CursorGlobalBrokerAtomicMutationError &&
          error.temporaryCleanupAmbiguous
        ) {
          recoveryReceipt = cleanupFailed(
            'Cursor global broker rollback failed and temporary-file cleanup could not be verified.'
          )
          return recoveryReceipt
        }
        // A rename may have committed before a later fsync/verification error.
        // Inspect once more before deciding whether recovery actually failed.
        try {
          const ambiguous = readSnapshot(
            options.fs,
            options.registryPath,
            options.registryDirectory
          )
          const ownedRestored =
            restoreAbsence && !ambiguous.existed
              ? true
              : jsonEqual(ownedProjection(ambiguous.root, state.ownedNames), state.beforeOwned)
          if (
            ownedRestored &&
            (restoreAbsence ||
              jsonEqual(
                unrelatedProjection(ambiguous.root, state.ownedNames),
                unrelatedBeforeRollback
              ))
          ) {
            recoveryReceipt = restoreUnverified(
              `Owned broker state appears restored after an ambiguous filesystem commit, but durability or metadata restoration was not proven: ${errorMessage(error)}`
            )
            return recoveryReceipt
          }
        } catch {
          // Fall through to the honest failed receipt below.
        }
        recoveryReceipt = cleanupFailed(
          `Cursor global broker rollback failed or remained ambiguous: ${errorMessage(error)}`
        )
        return recoveryReceipt
      }

      let verified: RegistrySnapshot
      try {
        verified = readSnapshot(options.fs, options.registryPath, options.registryDirectory)
      } catch (error) {
        recoveryReceipt = cleanupFailed(
          `Cursor global broker rollback could not verify registry state: ${errorMessage(error)}`
        )
        return recoveryReceipt
      }
      const ownedVerified =
        restoreAbsence && !verified.existed
          ? true
          : jsonEqual(ownedProjection(verified.root, state.ownedNames), state.beforeOwned)
      if (!ownedVerified) {
        recoveryReceipt = cleanupFailed(
          'Cursor global broker rollback verification found owned-key drift.'
        )
        return recoveryReceipt
      }
      if (
        !restoreAbsence &&
        !jsonEqual(unrelatedProjection(verified.root, state.ownedNames), unrelatedBeforeRollback)
      ) {
        recoveryReceipt = restoreUnverified(
          'Owned broker keys were restored, but concurrent unrelated registry drift prevented full preservation verification.'
        )
        return recoveryReceipt
      }
      recoveryReceipt = restoreUnverified(
        restoreAbsence
          ? 'The originally absent registry was restored and absence was observed, but portable Node filesystem APIs cannot prove a post-check race did not occur.'
          : 'Owned broker keys and unrelated JSON state were observed after rollback, but inode metadata and a non-cooperating post-check writer cannot be proven through portable Node filesystem APIs.'
      )
      return recoveryReceipt
    }

    recoveryReceipt = cleanupFailed(
      `Cursor global broker rollback observed concurrent registry changes during all ${maxCasAttempts} bounded CAS attempts.`
    )
    return recoveryReceipt
  }

  return { install, onInstallFailure }
}
