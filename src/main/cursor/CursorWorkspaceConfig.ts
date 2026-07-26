// Cursor workspace config helpers. The transient workspace `.cursor/cli.json`
// (native-tool allow/deny rules) + `.cursor/mcp.json` (server isolation) writes
// are production-wired by runCursorProvider in index.ts, and
// ensureGlobalCursorBrokerRegistered is the GLOBAL "B"-mode broker registry the
// launch refreshes each run. These helpers are still not a sandbox by
// themselves: native-tool impact is bounded by the contained argv's
// `--sandbox enabled`, and brokered MCP tools are guarded by TaskWraith's
// gateway policy — this module only installs the files.
//
// CR6 — workspace-local Cursor permission config for TaskWraith-owned WRITE mode.
//
// The CR3 spike proved a bare `cursor-agent -p` runs native write+shell
// UNMEDIATED, and that a `.cursor/cli.json` deny-list hard-blocks them. Cursor
// has no `--deny` argv flag (unlike Grok) — permissions are file-based — so
// write-capable runs write a transient workspace-local `.cursor/cli.json` that
// **denies native shell + native writes** (`Shell(**)`, `Write(**)`) while the
// TaskWraith MCP bridge supplies governed write_file / replace / apply_patch
// tools. Edits then flow through TaskWraith's approval ledger and workspace/path
// checks instead of Cursor-native side effects. Restored after the run.
//
// SAFETY: ordinary workspaces never touch global `~/.cursor`. The transient MCP
// registry is isolated to TaskWraith-owned broker entries plus servers explicitly
// supplied from TaskWraith settings; unrelated project/global definitions are not
// carried into a `--approve-mcps` / `--force` run. Existing config bytes are
// restored exactly on completion. Symlinked config directories/files are rejected
// before any transient write. The caller stops the managed run if setup fails.
//
// Write mode also sets up the TaskWraith MCP bridge: a per-run
// `.cursor/mcp.json` registering the full brokered TaskWraith MCP server plus
// matching `Mcp(<server>:<tool>)` allow rules merged into the SAME cli.json write
// (one write, one restore for both files). Default mode is the only mode where
// Cursor executes MCP tools (plan mode rejects them), and TaskWraith write mode
// == default Cursor mode, so the bridge rides exactly the write-mode trigger.

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import {
  globalCursorMcpNeedsUpdate,
  mergeCursorAllowRules,
  mergeCursorMcpConfig,
  mergeGlobalCursorMcpServers
} from './CursorMcpBridge'
import type {
  CursorWorkspaceConfigCleanupReceipt,
  CursorWorkspaceConfigInstallContext,
  CursorWorkspaceConfigInstallation,
  CursorWorkspaceConfigLeaseRequest
} from './CursorWorkspaceConfigLease'

export interface CursorCliConfig {
  permissions: { allow: string[]; deny: string[] }
  [key: string]: unknown
}

/** Opaque native filesystem/shell tools are blocked while the broker is active. */
export const CURSOR_WRITE_MODE_DENY_RULES: readonly string[] = [
  'Shell(**)',
  'Write(**)',
  'Read(**)',
  'Glob(**)',
  'Grep(**)'
]

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function cursorConfigErrorText(error: unknown): string {
  try {
    if (error instanceof Error) {
      try {
        if (typeof error.message === 'string' && error.message.trim()) {
          return error.message.trim()
        }
      } catch {
        // Fall through to guarded coercion.
      }
    }
  } catch {
    // A hostile Proxy can throw from instanceof/getPrototypeOf.
  }
  try {
    const text = String(error).trim()
    return text || 'Unknown Cursor workspace configuration error.'
  } catch {
    return 'Unprintable thrown value.'
  }
}

/**
 * Merge `denyRules` into an existing `.cursor/cli.json` shape (or {}), preserving
 * any existing allow/deny entries + unknown top-level keys, deduping deny rules.
 * Pure.
 */
export function mergeCursorDenyRules(
  existing: unknown,
  denyRules: readonly string[]
): CursorCliConfig {
  const base = asRecord(existing)
  const perms = asRecord(base.permissions)
  const allow = stringArray(perms.allow)
  const deny = stringArray(perms.deny)
  for (const rule of denyRules) {
    if (!deny.includes(rule)) deny.push(rule)
  }
  return { ...base, permissions: { allow, deny } }
}

/** Minimal sync-fs surface (subset of node:fs) — injected for testability. */
export interface CursorConfigStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly nlink: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface CursorConfigFs {
  existsSync(path: string): boolean
  lstatSync(path: string): CursorConfigStat
  fstatSync(file: number): CursorConfigStat
  realpathSync(path: string): string
  readFileSync(path: string | number): Buffer
  readFileSync(path: string | number, encoding: 'utf8'): string
  writeFileSync(path: string | number, data: string, options?: { flag?: string }): void
  openSync(path: string, flags: number, mode?: number): number
  writeSync(
    file: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number
  ftruncateSync(file: number, length: number): void
  fsyncSync(file: number): void
  closeSync(file: number): void
  mkdirSync(path: string, options: { recursive: boolean }): void
  rmSync(path: string, options: { force?: boolean; recursive?: boolean }): void
  /** Needed only by the verified transaction to remove an empty owned dir. */
  rmdirSync?(path: string): void
}

/**
 * Optional MCP bridge setup applied alongside the native-tool deny-list.
 * `allowRules` are always merged into the cli.json write. `mcpConfigPath` +
 * `serverEntry` are OPTIONAL: supply both to install the isolated per-run
 * workspace `.cursor/mcp.json`. Current global-broker mode still supplies both
 * (with an empty settings entry map when appropriate) so project servers cannot
 * join the managed run. Omit both only when no transient MCP registry is needed.
 */
export interface CursorMcpBridgeOptions {
  /** Allow rules to add to cli.json (normally `CURSOR_MCP_ALLOW_RULES`). */
  allowRules: readonly string[]
  /** Absolute path to the workspace `.cursor/mcp.json` when isolation is required. */
  mcpConfigPath?: string
  /** Complete allowlisted `mcpServers` entries for the managed run. */
  serverEntry?: Record<string, unknown>
  /**
   * Preserve only the exact canonical TaskWraith broker registrations while
   * installing `serverEntry`.
   *
   * This is only for a global chat whose normalized workspace is the user's
   * home directory: in that case the apparent workspace config path and the
   * global registry are the same `~/.cursor/mcp.json` file. User/global servers
   * are deliberately hidden for the transient run and restored byte-for-byte
   * afterwards. Ordinary workspace configs must leave this false so a project-
   * local reserved name cannot shadow TaskWraith's canonical global broker.
   */
  preserveExistingMcpServers?: boolean
}

/**
 * "B" mode: durably register the TaskWraith broker entries in the GLOBAL
 * `~/.cursor/mcp.json` so `cursor-agent mcp enable` gives them the persistent
 * "ready" approval a per-run workspace server never gets. PERSISTENT (never
 * restored — the whole point is durability) and user-server preserving.
 * `removeServerNames` is only for obsolete TaskWraith-owned registrations that
 * would otherwise add their tools to Cursor's aggregate model catalogue.
 * Idempotent: only writes when the broker entries or removals changed (the socket
 * token rotates each launch, so this refreshes them — "ready" is keyed on the
 * server NAME, so it survives an args refresh).
 *
 * `globalMcpDir` = the user's `~/.cursor` (created if missing). Returns whether a
 * write happened. Best-effort by design at the caller; throws only on a real fs
 * failure so the caller can surface it.
 */
export function ensureGlobalCursorBrokerRegistered(
  fs: CursorConfigFs,
  globalMcpPath: string,
  globalMcpDir: string,
  brokerEntries: Record<string, unknown>,
  removeServerNames: readonly string[] = []
): boolean {
  assertNotSymlink(fs, globalMcpDir, 'global .cursor directory')
  assertNotSymlink(fs, globalMcpPath, 'global mcp.json')
  const cap = captureFile(fs, globalMcpPath)
  if (!globalCursorMcpNeedsUpdate(cap.parsed, brokerEntries, removeServerNames)) return false
  const merged = mergeGlobalCursorMcpServers(cap.parsed, brokerEntries, removeServerNames)
  if (!fs.existsSync(globalMcpDir)) fs.mkdirSync(globalMcpDir, { recursive: true })
  assertNotSymlink(fs, globalMcpDir, 'global .cursor directory')
  assertNotSymlink(fs, globalMcpPath, 'global mcp.json')
  fs.writeFileSync(globalMcpPath, `${JSON.stringify(merged, null, 2)}\n`)
  return true
}

export function cursorWriteModeSetupFailureMessage(error: unknown): string {
  const reason = cursorConfigErrorText(error)
  return `Legacy Cursor broker-only write-mode setup failed, so that qualification run was stopped. Managed Path-B launches report broker attachment failure separately and may continue with sandboxed native tools. ${reason}`
}

interface CapturedFile {
  existed: boolean
  original: string | null
  parsed: unknown
}

interface CursorConfigIdentity {
  readonly dev: number | bigint
  readonly ino: number | bigint
}

function isMissingCursorConfigPath(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function cursorConfigLstatOptional(fs: CursorConfigFs, path: string): CursorConfigStat | null {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if (isMissingCursorConfigPath(error)) return null
    throw error
  }
}

function cursorConfigIdentity(stat: CursorConfigStat): CursorConfigIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function cursorConfigIdentityMatches(
  stat: CursorConfigStat,
  identity: CursorConfigIdentity
): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino
}

/** Snapshot a JSON config file's prior bytes + parsed value for later restore. */
function captureFile(fs: CursorConfigFs, path: string): CapturedFile {
  const existed = fs.existsSync(path)
  let original: string | null = null
  if (existed) {
    // Setup must fail before mutation if exact restoration cannot be promised.
    original = fs.readFileSync(path, 'utf8')
  }
  let parsed: unknown = null
  if (original) {
    try {
      parsed = JSON.parse(original)
    } catch {
      parsed = null
    }
  }
  return { existed, original, parsed }
}

function assertNotSymlink(fs: CursorConfigFs, path: string, label: string): void {
  let stat: CursorConfigStat
  try {
    // lstat (rather than existsSync) is load-bearing here: existsSync follows a
    // dangling symlink and reports false, after which a write would follow it.
    stat = fs.lstatSync(path)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing Cursor config write through symlinked ${label}: ${path}`)
  }
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

function assertLosslessCursorConfigJsonNumbers(bytes: string, label: string): void {
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
      throw new Error(`${label} contains a number that cannot be losslessly rewritten: ${token}`)
    }
    index += token.length - 1
  }
}

function parseVerifiedCursorConfig(bytes: string, label: string): Record<string, unknown> {
  assertLosslessCursorConfigJsonNumbers(bytes, label)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    throw new Error(`${label} is not valid JSON; refusing to replace user state.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must contain a JSON object; refusing to replace user state.`)
  }
  return parsed as Record<string, unknown>
}

function assertSafeTransientTargets(
  fs: CursorConfigFs,
  dirPath: string,
  configPath: string,
  mcpConfigPath?: string
): void {
  assertNotSymlink(fs, dirPath, '.cursor directory')
  assertNotSymlink(fs, configPath, 'cli.json')
  if (mcpConfigPath) assertNotSymlink(fs, mcpConfigPath, 'mcp.json')
}

/** Restore a captured file: rewrite original bytes if it existed, else remove. */
function restoreFile(fs: CursorConfigFs, path: string, cap: CapturedFile): void {
  try {
    if (cap.existed && cap.original != null) {
      assertNotSymlink(fs, path, 'restore target')
      fs.writeFileSync(path, cap.original)
    } else {
      fs.rmSync(path, { force: true })
    }
  } catch {
    // Best-effort restore; never throws.
  }
}

/**
 * Apply the write-mode deny-list to `configPath` (inside `dirPath` = workspace
 * `.cursor/`), optionally also setting up the MCP bridge (`bridge`). Returns an
 * idempotent `restore()` to call when the run ends: rewrites the original bytes
 * of each touched file if it existed, else removes it (and the `.cursor` dir if
 * we created it). Never throws on restore (best-effort).
 */
export function applyCursorWriteModeConfig(
  fs: CursorConfigFs,
  configPath: string,
  dirPath: string,
  bridge?: CursorMcpBridgeOptions,
  options?: { fullAccess?: boolean; denyRules?: readonly string[] }
): () => void {
  const mcpConfigPath = bridge?.mcpConfigPath
  const serverEntry = bridge?.serverEntry
  const writeMcp = Boolean(mcpConfigPath && serverEntry)
  assertSafeTransientTargets(fs, dirPath, configPath, writeMcp ? mcpConfigPath : undefined)

  const dirExisted = fs.existsSync(dirPath)

  // cli.json: deny native tools per the caller's seat posture + optionally
  // allow the bridge's MCP tools — merged into a single write so there's one
  // file state. The deny-list defaults to the containment-era full set (every
  // opaque native tool routed through the broker). Production Cursor seats now
  // keep native tools callable (bounded by the argv's `--sandbox enabled`), so
  // `runCursorProvider` passes a narrower list: write seats pass [] (native
  // shell/write stay available, sandbox-bounded — the both-stacks directive);
  // read-only seats deny only the native mutators (Shell/Write) so the
  // read-only posture holds on the native stack as well as the broker.
  // Full Workspace Access expands what the signed TaskWraith broker may do in
  // the canonical workspace. It never authorizes Cursor's opaque native tools
  // to open arbitrary host paths under `--force`.
  void options?.fullAccess
  const denyRules = options?.denyRules ?? CURSOR_WRITE_MODE_DENY_RULES
  const cli = captureFile(fs, configPath)
  let cliMerged = mergeCursorDenyRules(cli.parsed, denyRules)
  if (bridge) cliMerged = mergeCursorAllowRules(cliMerged, bridge.allowRules)

  // mcp.json: install the complete isolated server set only when the bridge
  // supplies BOTH a path and an entry. Global-broker mode also uses this path to
  // hide project servers while retaining the canonical global broker when the
  // workspace aliases Home.
  const mcp = writeMcp && mcpConfigPath ? captureFile(fs, mcpConfigPath) : null
  const mcpMerged =
    writeMcp && serverEntry
      ? mergeCursorMcpConfig(mcp?.parsed ?? null, serverEntry, {
          preserveExistingTaskWraithBrokers: bridge?.preserveExistingMcpServers
        })
      : null

  try {
    if (!dirExisted) fs.mkdirSync(dirPath, { recursive: true })
    // Recheck after directory creation and immediately before each write. This
    // does not claim to solve hostile filesystem races, but it ensures existing
    // and setup-time symlinks are never followed.
    assertSafeTransientTargets(fs, dirPath, configPath, writeMcp ? mcpConfigPath : undefined)
    fs.writeFileSync(configPath, `${JSON.stringify(cliMerged, null, 2)}\n`)
    if (mcpConfigPath && mcpMerged) {
      assertSafeTransientTargets(fs, dirPath, configPath, mcpConfigPath)
      fs.writeFileSync(mcpConfigPath, `${JSON.stringify(mcpMerged, null, 2)}\n`)
    }
  } catch (error) {
    restoreFile(fs, configPath, cli)
    if (mcpConfigPath && mcp) restoreFile(fs, mcpConfigPath, mcp)
    if (!dirExisted) {
      try {
        fs.rmSync(dirPath, { force: true, recursive: true })
      } catch {
        // Preserve the setup error; cleanup is best-effort.
      }
    }
    throw error
  }

  let restored = false
  return () => {
    if (restored) return
    restored = true
    restoreFile(fs, configPath, cli)
    if (mcpConfigPath && mcp) restoreFile(fs, mcpConfigPath, mcp)
    // Remove the `.cursor` dir only if WE created it (it's ours to clean).
    if (!dirExisted) {
      try {
        fs.rmSync(dirPath, { force: true, recursive: true })
      } catch {
        // Best-effort; never throws.
      }
    }
  }
}

export interface VerifiedCursorWorkspaceConfigTransaction {
  /** Digest-bound identity of the complete immutable overlay intent. */
  readonly configurationKey: string
  /**
   * One-shot install callback suitable for CursorWorkspaceConfigLease.acquire.
   * Snapshotting happens only when the coordinator admits this transaction.
   */
  readonly install: (
    context: CursorWorkspaceConfigInstallContext
  ) => CursorWorkspaceConfigInstallation
  /** Exact recovery receipt for a rejected install attempt. */
  readonly onInstallFailure: NonNullable<CursorWorkspaceConfigLeaseRequest['onInstallFailure']>
}

export interface VerifiedCursorWorkspaceConfigTransactionOptions {
  readonly fullAccess?: boolean
  readonly denyRules?: readonly string[]
  /**
   * Must be the exact key supplied to the workspace lease. Binding the
   * transaction to it prevents mutable policy intent from sharing a posture
   * lease under a different overlay.
   */
  readonly configurationKey: string
}

interface CursorWorkspaceConfigCasTarget {
  readonly path: string
  readonly label: string
  readonly original: CapturedFile
  readonly originalIdentity: CursorConfigIdentity | null
  readonly overlay: string
  overlayIdentity: CursorConfigIdentity | null
  incompleteOverlay: boolean
  attempted: boolean
}

interface CursorWorkspaceConfigCasAttempt {
  readonly dirPath: string
  readonly dirExisted: boolean
  readonly dirIdentity: CursorConfigIdentity
  readonly targets: CursorWorkspaceConfigCasTarget[]
}

interface ExactFileState {
  readonly exists: boolean
  readonly rawBytes: Buffer | null
  readonly identity: CursorConfigIdentity | null
}

function snapshotJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const bytes = JSON.stringify(value)
  if (typeof bytes !== 'string') {
    throw new Error('Cursor MCP server configuration must be JSON serializable.')
  }
  const parsed = JSON.parse(bytes) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Cursor MCP server configuration must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function stableCursorConfigJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCursorConfigJsonValue)
  if (value && typeof value === 'object') {
    const result = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      Object.defineProperty(result, key, {
        value: stableCursorConfigJsonValue((value as Record<string, unknown>)[key]),
        enumerable: true
      })
    }
    return result
  }
  return value
}

function cursorWorkspaceConfigIntentKey(baseKey: string, intent: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(stableCursorConfigJsonValue(intent)))
    .digest('hex')
  return `${baseKey}:intent-sha256:${digest}`
}

function assertVerifiedCursorWorkspacePaths(
  configPath: string,
  dirPath: string,
  mcpConfigPath?: string
): void {
  if (
    !isAbsolute(configPath) ||
    !isAbsolute(dirPath) ||
    (mcpConfigPath !== undefined && !isAbsolute(mcpConfigPath))
  ) {
    throw new Error('Verified Cursor workspace configuration paths must be absolute.')
  }
  const canonicalDir = resolve(dirPath)
  if (basename(canonicalDir) !== '.cursor') {
    throw new Error('Verified Cursor workspace config directory must be named .cursor.')
  }
  if (
    dirname(resolve(configPath)) !== canonicalDir ||
    basename(resolve(configPath)) !== 'cli.json'
  ) {
    throw new Error('Verified Cursor cli.json must be directly inside its declared .cursor dir.')
  }
  if (mcpConfigPath !== undefined) {
    if (
      dirname(resolve(mcpConfigPath)) !== canonicalDir ||
      basename(resolve(mcpConfigPath)) !== 'mcp.json'
    ) {
      throw new Error('Verified Cursor mcp.json must be directly inside its declared .cursor dir.')
    }
    if (resolve(mcpConfigPath) === resolve(configPath)) {
      throw new Error('Cursor cli.json and mcp.json transaction targets must be distinct.')
    }
  }
}

function assertVerifiedCursorDirectory(
  fs: CursorConfigFs,
  dirPath: string,
  expectedIdentity?: CursorConfigIdentity
): CursorConfigIdentity {
  const stat = cursorConfigLstatOptional(fs, dirPath)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing Cursor config write through unsafe .cursor directory: ${dirPath}`)
  }
  if (expectedIdentity && !cursorConfigIdentityMatches(stat, expectedIdentity)) {
    throw new Error(`Cursor workspace config directory identity changed: ${dirPath}`)
  }
  return cursorConfigIdentity(stat)
}

function assertVerifiedCursorFileStat(
  stat: CursorConfigStat,
  path: string,
  label: string,
  expectedIdentity?: CursorConfigIdentity
): CursorConfigIdentity {
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing Cursor config write through symlinked ${label}: ${path}`)
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing Cursor config write through unsafe ${label}: ${path}`)
  }
  if (stat.nlink > 1) {
    throw new Error(`Refusing Cursor config write through hard-linked ${label}: ${path}`)
  }
  if (expectedIdentity && !cursorConfigIdentityMatches(stat, expectedIdentity)) {
    throw new Error(`Cursor ${label} identity changed: ${path}`)
  }
  return cursorConfigIdentity(stat)
}

function decodeExactCursorConfigUtf8(bytes: Buffer, label: string): string {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not lossless UTF-8; refusing to replace user state.`)
  }
  return text
}

const CURSOR_CONFIG_READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
const CURSOR_CONFIG_WRITE_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW
const CURSOR_CONFIG_CREATE_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NONBLOCK |
  fsConstants.O_NOFOLLOW

function withCursorConfigFile<T>(
  fs: CursorConfigFs,
  path: string,
  flags: number,
  callback: (file: number) => T,
  mode?: number
): T {
  const file = fs.openSync(path, flags, mode)
  try {
    return callback(file)
  } finally {
    fs.closeSync(file)
  }
}

function writeCursorConfigFileDescriptor(fs: CursorConfigFs, file: number, bytes: string): void {
  const data = Buffer.from(bytes, 'utf8')
  fs.ftruncateSync(file, 0)
  let offset = 0
  while (offset < data.byteLength) {
    const written = fs.writeSync(file, data, offset, data.byteLength - offset, offset)
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error('Cursor config file-descriptor write made no forward progress.')
    }
    offset += written
  }
  fs.fsyncSync(file)
}

function captureVerifiedCursorFile(
  fs: CursorConfigFs,
  path: string,
  label: string
): { captured: CapturedFile; identity: CursorConfigIdentity | null } {
  const before = cursorConfigLstatOptional(fs, path)
  if (!before) {
    return {
      captured: { existed: false, original: null, parsed: null },
      identity: null
    }
  }
  const identity = assertVerifiedCursorFileStat(before, path, label)
  const originalBytes = withCursorConfigFile(fs, path, CURSOR_CONFIG_READ_FLAGS, (file) => {
    const opened = fs.fstatSync(file)
    assertVerifiedCursorFileStat(opened, path, label, identity)
    return fs.readFileSync(file)
  })
  const original = decodeExactCursorConfigUtf8(originalBytes, label)
  const parsed = parseVerifiedCursorConfig(original, label)
  const after = cursorConfigLstatOptional(fs, path)
  if (!after) throw new Error(`Cursor ${label} disappeared while it was being captured: ${path}`)
  assertVerifiedCursorFileStat(after, path, label, identity)
  return {
    captured: { existed: true, original, parsed },
    identity
  }
}

function exactFileState(fs: CursorConfigFs, path: string, label: string): ExactFileState {
  const stat = cursorConfigLstatOptional(fs, path)
  if (!stat) return { exists: false, rawBytes: null, identity: null }
  const identity = assertVerifiedCursorFileStat(stat, path, label)
  const rawBytes = withCursorConfigFile(fs, path, CURSOR_CONFIG_READ_FLAGS, (file) => {
    const opened = fs.fstatSync(file)
    assertVerifiedCursorFileStat(opened, path, label, identity)
    return fs.readFileSync(file)
  })
  const after = cursorConfigLstatOptional(fs, path)
  if (!after) throw new Error(`Cursor ${label} disappeared while it was being read: ${path}`)
  assertVerifiedCursorFileStat(after, path, label, identity)
  return { exists: true, rawBytes, identity }
}

function installVerifiedCursorOverlay(
  fs: CursorConfigFs,
  target: CursorWorkspaceConfigCasTarget
): CursorConfigIdentity {
  const flags = target.original.existed ? CURSOR_CONFIG_WRITE_FLAGS : CURSOR_CONFIG_CREATE_FLAGS
  return withCursorConfigFile(
    fs,
    target.path,
    flags,
    (file) => {
      const opened = fs.fstatSync(file)
      const identity = assertVerifiedCursorFileStat(
        opened,
        target.path,
        `${target.label} install target`,
        target.originalIdentity ?? undefined
      )
      if (target.original.existed) {
        const currentBytes = fs.readFileSync(file)
        if (!currentBytes.equals(Buffer.from(target.original.original!, 'utf8'))) {
          throw new Error(
            `Cursor ${target.label} changed after snapshot; refusing to replace user state.`
          )
        }
      }
      const pathStat = cursorConfigLstatOptional(fs, target.path)
      if (
        !pathStat ||
        !cursorConfigIdentityMatches(pathStat, identity) ||
        pathStat.isSymbolicLink()
      ) {
        throw new Error(`Cursor ${target.label} path identity changed before install.`)
      }
      target.overlayIdentity = identity
      try {
        writeCursorConfigFileDescriptor(fs, file, target.overlay)
      } catch (error) {
        target.incompleteOverlay = true
        throw error
      }
      assertVerifiedCursorFileStat(
        fs.fstatSync(file),
        target.path,
        `${target.label} install target`,
        identity
      )
      target.incompleteOverlay = false
      return identity
    },
    0o600
  )
}

function restoreVerifiedCursorExistingFile(
  fs: CursorConfigFs,
  target: CursorWorkspaceConfigCasTarget,
  expectedCurrentBytes: Buffer
): void {
  withCursorConfigFile(fs, target.path, CURSOR_CONFIG_WRITE_FLAGS, (file) => {
    const opened = fs.fstatSync(file)
    const identity = assertVerifiedCursorFileStat(
      opened,
      target.path,
      `${target.label} cleanup target`,
      target.overlayIdentity ?? undefined
    )
    const currentBytes = fs.readFileSync(file)
    if (!currentBytes.equals(expectedCurrentBytes)) {
      throw new Error(`Cursor ${target.label} changed before cleanup mutation.`)
    }
    const pathStat = cursorConfigLstatOptional(fs, target.path)
    if (
      !pathStat ||
      !cursorConfigIdentityMatches(pathStat, identity) ||
      pathStat.isSymbolicLink()
    ) {
      throw new Error(`Cursor ${target.label} path identity changed before cleanup.`)
    }
    writeCursorConfigFileDescriptor(fs, file, target.original.original!)
  })
}

function stateMatchesOriginal(state: ExactFileState, original: CapturedFile): boolean {
  return original.existed
    ? Boolean(state.exists && state.rawBytes?.equals(Buffer.from(original.original!, 'utf8')))
    : !state.exists
}

function stateMatchesOverlay(state: ExactFileState, overlay: string): boolean {
  return Boolean(state.exists && state.rawBytes?.equals(Buffer.from(overlay, 'utf8')))
}

function stateIdentityMatches(
  state: ExactFileState,
  identity: CursorConfigIdentity | null
): boolean {
  if (!identity) return !state.exists
  return Boolean(
    state.identity && state.identity.dev === identity.dev && state.identity.ino === identity.ino
  )
}

function cleanupFailureReceipt(message: string): CursorWorkspaceConfigCleanupReceipt {
  return Object.freeze({
    outcome: 'cleanup-failed',
    message: message.trim() || 'Cursor workspace configuration cleanup failed.'
  })
}

function restoredVerifiedReceipt(): CursorWorkspaceConfigCleanupReceipt {
  return Object.freeze({ outcome: 'restored-verified' })
}

/**
 * Compare-and-restore the exact bytes owned by one transaction.
 *
 * Every file is restored only when it still contains this transaction's exact
 * overlay bytes on the exact admitted inode (or is already back at its captured
 * original state). Detected divergent bytes, deletion, hard links, or identity
 * replacement are preserved and reported. Node exposes no portable filesystem
 * compare-and-swap primitive: same-inode writes can still race in the narrow
 * interval between comparison and mutation, so `restored-verified` means the
 * final captured byte/existence/identity state was observed, not that arbitrary
 * external writers were historically excluded.
 */
function cleanupVerifiedCursorWorkspaceConfigAttempt(
  fs: CursorConfigFs,
  attempt: CursorWorkspaceConfigCasAttempt,
  attemptedOnly: boolean
): CursorWorkspaceConfigCleanupReceipt {
  const targets = attemptedOnly
    ? attempt.targets.filter((target) => target.attempted)
    : attempt.targets
  const issues = new Set<string>()

  try {
    assertVerifiedCursorDirectory(fs, attempt.dirPath, attempt.dirIdentity)
  } catch (error) {
    return cleanupFailureReceipt(
      `Preserved workspace configuration because its directory identity changed: ${cursorConfigErrorText(
        error
      )}`
    )
  }

  for (const target of targets) {
    try {
      assertVerifiedCursorDirectory(fs, attempt.dirPath, attempt.dirIdentity)
      const current = exactFileState(fs, target.path, `${target.label} cleanup target`)
      if (stateMatchesOriginal(current, target.original)) {
        if (target.original.existed && !stateIdentityMatches(current, target.originalIdentity)) {
          issues.add(
            `Preserved identity-replaced external state at ${target.path}; bytes match the original but the file identity changed.`
          )
        }
        continue
      }
      const ownsCompleteOverlay = stateMatchesOverlay(current, target.overlay)
      const ownsIncompleteOverlay = Boolean(
        target.incompleteOverlay &&
        current.exists &&
        current.rawBytes &&
        current.rawBytes.byteLength <= Buffer.byteLength(target.overlay, 'utf8') &&
        Buffer.from(target.overlay, 'utf8')
          .subarray(0, current.rawBytes.byteLength)
          .equals(current.rawBytes) &&
        stateIdentityMatches(current, target.overlayIdentity)
      )
      if (!ownsCompleteOverlay && !ownsIncompleteOverlay) {
        issues.add(
          `Preserved external change at ${target.path}; current bytes no longer match the TaskWraith overlay.`
        )
        continue
      }
      if (!stateIdentityMatches(current, target.overlayIdentity)) {
        issues.add(
          `Preserved external replacement at ${target.path}; overlay bytes match but file identity changed.`
        )
        continue
      }

      // Recheck directory, bytes, and exact inode immediately before mutation.
      assertVerifiedCursorDirectory(fs, attempt.dirPath, attempt.dirIdentity)
      const owned = exactFileState(fs, target.path, `${target.label} cleanup target`)
      const expectedOwnedBytes = current.rawBytes!
      if (
        !owned.rawBytes?.equals(expectedOwnedBytes) ||
        !stateIdentityMatches(owned, target.overlayIdentity)
      ) {
        issues.add(`Preserved a late external change at ${target.path}.`)
        continue
      }
      if (target.original.existed && target.original.original != null) {
        restoreVerifiedCursorExistingFile(fs, target, expectedOwnedBytes)
      } else {
        fs.rmSync(target.path, { force: true })
      }

      const restored = exactFileState(fs, target.path, `${target.label} verification target`)
      if (
        !stateMatchesOriginal(restored, target.original) ||
        (target.original.existed && !stateIdentityMatches(restored, target.originalIdentity))
      ) {
        issues.add(`Could not verify original bytes at ${target.path} after restoration.`)
      }
    } catch (error) {
      issues.add(`Could not restore ${target.path}: ${cursorConfigErrorText(error)}`)
    }
  }

  // A final pass catches a change that lands after one file's immediate
  // verification while another file is being restored.
  for (const target of targets) {
    try {
      assertVerifiedCursorDirectory(fs, attempt.dirPath, attempt.dirIdentity)
      const finalState = exactFileState(fs, target.path, `${target.label} final target`)
      if (
        !stateMatchesOriginal(finalState, target.original) ||
        (target.original.existed && !stateIdentityMatches(finalState, target.originalIdentity))
      ) {
        issues.add(`Final original-state verification failed at ${target.path}.`)
      }
    } catch (error) {
      issues.add(`Final verification failed at ${target.path}: ${cursorConfigErrorText(error)}`)
    }
  }

  if (!attempt.dirExisted && issues.size === 0) {
    try {
      if (fs.existsSync(attempt.dirPath)) {
        assertVerifiedCursorDirectory(fs, attempt.dirPath, attempt.dirIdentity)
        if (!fs.rmdirSync) {
          issues.add(
            `Could not verify removal of owned directory ${attempt.dirPath}: rmdirSync is unavailable.`
          )
        } else {
          // Never recursively delete: an externally-created file makes rmdir
          // fail with ENOTEMPTY and is preserved.
          fs.rmdirSync(attempt.dirPath)
        }
      }
      if (fs.existsSync(attempt.dirPath)) {
        issues.add(`Owned directory ${attempt.dirPath} remains after cleanup.`)
      }
    } catch (error) {
      issues.add(
        `Preserved non-empty or changed directory ${attempt.dirPath}: ${cursorConfigErrorText(error)}`
      )
    }
  }

  return issues.size === 0
    ? restoredVerifiedReceipt()
    : cleanupFailureReceipt([...issues].join(' '))
}

/**
 * Build a verified, one-shot workspace-config transaction for managed Cursor.
 *
 * Unlike applyCursorWriteModeConfig's compatibility restore callback, this
 * transaction:
 *   - verifies the exact overlay bytes after every install write;
 *   - rolls a partial install back before rethrowing;
 *   - restores only bytes it still owns, preserving external concurrent edits;
 *   - verifies the captured final file/existence state; and
 *   - removes an owned `.cursor` directory only when it is empty.
 *
 * The returned callbacks plug directly into CursorWorkspaceConfigLease.acquire.
 */
export function createVerifiedCursorWorkspaceConfigTransaction(
  fs: CursorConfigFs,
  configPath: string,
  dirPath: string,
  bridge?: CursorMcpBridgeOptions,
  options?: VerifiedCursorWorkspaceConfigTransactionOptions
): VerifiedCursorWorkspaceConfigTransaction {
  const expectedConfigurationKey = options?.configurationKey?.trim()
  if (!expectedConfigurationKey) {
    throw new Error('Verified Cursor workspace transaction requires a configuration key.')
  }
  const bridgeSnapshot = bridge
    ? Object.freeze({
        allowRules: Object.freeze([...bridge.allowRules]),
        ...(bridge.mcpConfigPath ? { mcpConfigPath: bridge.mcpConfigPath } : {}),
        ...(bridge.serverEntry ? { serverEntry: snapshotJsonRecord(bridge.serverEntry) } : {}),
        ...(bridge.preserveExistingMcpServers ? { preserveExistingMcpServers: true as const } : {})
      })
    : undefined
  const denyRules = Object.freeze([...(options?.denyRules ?? CURSOR_WRITE_MODE_DENY_RULES)])
  const mcpConfigPath = bridgeSnapshot?.mcpConfigPath
  const serverEntry = bridgeSnapshot?.serverEntry
  const writeMcp = Boolean(mcpConfigPath && serverEntry)
  assertVerifiedCursorWorkspacePaths(configPath, dirPath, mcpConfigPath)
  const configurationKey = cursorWorkspaceConfigIntentKey(expectedConfigurationKey, {
    allowRules: bridgeSnapshot?.allowRules ?? [],
    denyRules,
    mcpEnabled: writeMcp,
    preserveExistingMcpServers: bridgeSnapshot?.preserveExistingMcpServers === true,
    serverEntry: serverEntry ?? null
  })

  let phase: 'ready' | 'installing' | 'installed' | 'install-failed' | 'cleaned' = 'ready'
  let attempt: CursorWorkspaceConfigCasAttempt | null = null
  let createdDirectoryWithoutIdentity = false
  let cleanupReceipt: CursorWorkspaceConfigCleanupReceipt | null = null

  const performCleanup = (attemptedOnly: boolean): CursorWorkspaceConfigCleanupReceipt => {
    if (cleanupReceipt) return cleanupReceipt
    if (!attempt) {
      cleanupReceipt = createdDirectoryWithoutIdentity
        ? cleanupFailureReceipt(
            `TaskWraith created ${dirPath} but could not capture its identity, so safe removal is unproven.`
          )
        : restoredVerifiedReceipt()
      return cleanupReceipt
    }
    try {
      cleanupReceipt = cleanupVerifiedCursorWorkspaceConfigAttempt(fs, attempt, attemptedOnly)
    } catch (error) {
      cleanupReceipt = cleanupFailureReceipt(
        `Cursor workspace cleanup failed unexpectedly: ${cursorConfigErrorText(error)}`
      )
    }
    return cleanupReceipt
  }

  return {
    configurationKey,
    install: (context) => {
      if (phase !== 'ready') {
        throw new Error('Cursor workspace configuration transaction install is one-shot.')
      }
      phase = 'installing'
      try {
        if (!context || context.configurationKey !== configurationKey) {
          throw new Error(
            'Cursor workspace transaction configuration does not match the lease configuration.'
          )
        }
        assertSafeTransientTargets(fs, dirPath, configPath, writeMcp ? mcpConfigPath : undefined)
        const physicalWorkspace = fs.realpathSync(dirname(dirPath))
        if (resolve(context.resourceKey) !== resolve(physicalWorkspace)) {
          throw new Error('Cursor workspace transaction target does not match the lease resource.')
        }

        const existingDirectory = cursorConfigLstatOptional(fs, dirPath)
        const dirExisted = Boolean(existingDirectory)
        if (existingDirectory) {
          assertVerifiedCursorDirectory(fs, dirPath)
        } else {
          // This direct child is created exclusively. Recursive mkdir could
          // adopt a directory created by another process and later misclaim it.
          fs.mkdirSync(dirPath, { recursive: false })
          createdDirectoryWithoutIdentity = true
        }
        const dirIdentity = assertVerifiedCursorDirectory(fs, dirPath)
        attempt = { dirPath, dirExisted, dirIdentity, targets: [] }
        createdDirectoryWithoutIdentity = false

        void options?.fullAccess
        const cliSnapshot = captureVerifiedCursorFile(fs, configPath, 'cli.json')
        let cliMerged = mergeCursorDenyRules(cliSnapshot.captured.parsed, denyRules)
        if (bridgeSnapshot) {
          cliMerged = mergeCursorAllowRules(cliMerged, bridgeSnapshot.allowRules)
        }
        const cliOverlay = `${JSON.stringify(cliMerged, null, 2)}\n`

        const mcpSnapshot =
          writeMcp && mcpConfigPath
            ? captureVerifiedCursorFile(fs, mcpConfigPath, 'mcp.json')
            : null
        const mcpMerged =
          writeMcp && serverEntry
            ? mergeCursorMcpConfig(mcpSnapshot?.captured.parsed ?? null, serverEntry, {
                preserveExistingTaskWraithBrokers: bridgeSnapshot?.preserveExistingMcpServers
              })
            : null
        const targets: CursorWorkspaceConfigCasTarget[] = [
          {
            path: configPath,
            label: 'cli.json',
            original: cliSnapshot.captured,
            originalIdentity: cliSnapshot.identity,
            overlay: cliOverlay,
            overlayIdentity: null,
            incompleteOverlay: false,
            attempted: false
          }
        ]
        if (mcpConfigPath && mcpSnapshot && mcpMerged) {
          targets.push({
            path: mcpConfigPath,
            label: 'mcp.json',
            original: mcpSnapshot.captured,
            originalIdentity: mcpSnapshot.identity,
            overlay: `${JSON.stringify(mcpMerged, null, 2)}\n`,
            overlayIdentity: null,
            incompleteOverlay: false,
            attempted: false
          })
        }
        attempt.targets.push(...targets)
        assertSafeTransientTargets(
          fs,
          dirPath,
          configPath,
          targets.length > 1 ? mcpConfigPath : undefined
        )

        for (const target of targets) {
          assertVerifiedCursorDirectory(fs, dirPath, dirIdentity)
          const beforeWrite = exactFileState(fs, target.path, `${target.label} pre-install target`)
          if (
            !stateMatchesOriginal(beforeWrite, target.original) ||
            (target.original.existed && !stateIdentityMatches(beforeWrite, target.originalIdentity))
          ) {
            throw new Error(
              `Cursor ${target.label} changed after snapshot; refusing to replace user state.`
            )
          }
          target.attempted = true
          target.overlayIdentity = installVerifiedCursorOverlay(fs, target)
          const installed = exactFileState(fs, target.path, `${target.label} install target`)
          if (!stateMatchesOverlay(installed, target.overlay) || !installed.identity) {
            throw new Error(`Cursor workspace overlay verification failed at ${target.path}.`)
          }
          if (!stateIdentityMatches(installed, target.overlayIdentity)) {
            throw new Error(`Cursor workspace overlay identity changed at ${target.path}.`)
          }
        }
        for (const target of targets) {
          assertVerifiedCursorDirectory(fs, dirPath, dirIdentity)
          const installed = exactFileState(fs, target.path, `${target.label} final install target`)
          if (
            !stateMatchesOverlay(installed, target.overlay) ||
            !stateIdentityMatches(installed, target.overlayIdentity)
          ) {
            throw new Error(`Cursor workspace final overlay verification failed at ${target.path}.`)
          }
        }

        phase = 'installed'
        return Object.freeze({
          onLastRelease: () => {
            if (phase === 'cleaned' && cleanupReceipt) return cleanupReceipt
            if (phase !== 'installed') {
              return cleanupFailureReceipt(
                'Cursor workspace last-release cleanup was invoked outside an installed transaction.'
              )
            }
            cleanupReceipt = performCleanup(false)
            phase = 'cleaned'
            return cleanupReceipt
          }
        })
      } catch (error) {
        // Quiesce our partial mutation before the coordinator invokes its
        // install-failure callback and advances another configuration.
        cleanupReceipt = performCleanup(true)
        phase = 'install-failed'
        throw error
      }
    },
    onInstallFailure: () => {
      if (phase !== 'install-failed') {
        return cleanupFailureReceipt(
          'Cursor workspace install-failure recovery was invoked without a failed install.'
        )
      }
      return cleanupReceipt ?? performCleanup(true)
    }
  }
}
