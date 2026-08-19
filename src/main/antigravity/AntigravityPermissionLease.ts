import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  agyMcpConfigNeedsUpdate,
  buildAgyMcpConfigDocument,
  parseAgyMcpConfigDocument,
  serializeAgyMcpConfigDocument,
  type AgyMcpServerRegistration
} from './AntigravityMcpConfig'

const RECEIPT_SCHEMA_VERSION = 1
const MAX_SETTINGS_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
/**
 * The exact read-only command observed in the official agy failure ledger:
 * agy issues it for its own trajectory bookkeeping outside the terminal
 * sandbox, so the grant stays this one read-only invocation, never a broader
 * unsandboxed target.
 */
const AGY_WORKSPACE_STATUS_COMMAND = 'git status --porcelain'

/**
 * Always-installed projection of TaskWraith's universal read-only shell fast
 * path (ApprovalOrchestration `readonly_shell` / `inspection_shell`: pure
 * `git status`/`git diff`/`git log` and the inspection heads run prompt-free
 * under EVERY posture, read_only and plan included). Official agy has no
 * per-command approval bridge — headless print mode auto-denies any command
 * without a matching allow rule and the turn dies with no output — so these
 * rules are the only way the signed posture's own fast path can reach an agy
 * run.
 *
 * agy matches command rules by binary+subcommand prefix ("'git' matches
 * 'git add', 'git commit'", agy 1.1.10), so one projected prefix admits every
 * flag completion; flag-level screening is inexpressible here. Two bounds keep
 * the projection inside the fast path it mirrors:
 *  - `command(...)` targets run INSIDE agy's terminal sandbox — narrower
 *    containment than the host shell the classifiers already bless; and
 *  - only heads whose every completion the classifiers accept unconditionally
 *    are projected. The per-token/per-flag screened heads (`rg` `--pre`,
 *    `env`-with-args, and the ShellCommandTierPolicy screened set — `sort`,
 *    `uniq`, `tree`, `file`, `hostname`, `date`, `sed`) are deliberately absent
 *    because a prefix rule cannot carry their screens. A test pins the subset
 *    relation and mechanically rejects flag-conditional heads.
 */
const AGY_READ_ONLY_GIT_COMMAND_PREFIXES = ['git status', 'git log', 'git diff'] as const

const AGY_INSPECTION_COMMAND_HEADS = [
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'du',
  'df',
  'cut',
  'comm',
  'diff',
  'cmp',
  'nl',
  'strings',
  'which',
  'whoami',
  'uname',
  'id',
  'groups',
  'basename',
  'dirname',
  'readlink',
  'realpath',
  'printenv',
  'shasum',
  'cksum',
  'echo',
  'grep',
  'egrep',
  'fgrep'
] as const

export const AGY_READ_ONLY_SHELL_PROJECTION_RULES: readonly string[] = Object.freeze([
  ...AGY_READ_ONLY_GIT_COMMAND_PREFIXES.map((prefix) => `command(${prefix})`),
  `unsandboxed(${AGY_WORKSPACE_STATUS_COMMAND})`,
  ...AGY_INSPECTION_COMMAND_HEADS.map((head) => `command(${head})`)
])

type JsonObject = Record<string, unknown>

interface AntigravityPermissionLeaseReceipt {
  readonly schemaVersion: 1
  readonly leaseId: string
  readonly settingsPath: string
  readonly installedAt: string
  readonly originalExists: boolean
  readonly originalContentBase64: string
  readonly originalSha256: string
  readonly installedSha256: string
  readonly addedAllowRules: string[]
  readonly installedScalars: Partial<Record<'toolPermission' | 'artifactReviewPolicy', string>>
}

export interface AntigravityPermissionLeaseRequest {
  readonly settingsPath: string
  readonly workspacePath: string
  readonly allowShell: boolean
  readonly allowWrite: boolean
  /**
   * Optional PreToolUse hook-bridge overlay, installed as one namespaced key
   * in the workspace customization root's `hooks.json` and removed with the
   * lease. A stale overlay after a crash is fail-safe by construction: its
   * bridge port is dead, the hook command's `|| printf {}` yields
   * no-decision, and the next acquire for the workspace recovers it.
   */
  readonly hookOverlay?: {
    readonly hooksPath: string
    readonly hookName: string
    readonly namedHook: JsonObject
  }
  /**
   * Optional TaskWraith MCP registration for agy's GLOBAL server map
   * (`<gemini-root>/config/mcp_config.json`). agy has no per-run
   * `--mcp-config-file` equivalent, so the only way to keep a registration out
   * of the user's own agy sessions is to install it for the run and restore
   * the original document on release, exactly as the settings lease does.
   *
   * Installing is best-effort by design: a config this lease cannot parse
   * belongs to someone else, so the run proceeds with no TaskWraith tools
   * rather than failing or clobbering it.
   */
  readonly mcpOverlay?: {
    readonly configPath: string
    readonly registration: AgyMcpServerRegistration
  }
  readonly signal?: AbortSignal
}

export interface AntigravityPermissionLease {
  readonly leaseId: string
  readonly settingsPath: string
  /** True only when agy will actually see TaskWraith's MCP server this run.
   * The prompt layer must not promise tools this is false for. */
  readonly mcpRegistered: boolean
  release(): Promise<void>
}

export class AntigravityPermissionLeaseAbortedError extends Error {
  constructor() {
    super('AntiGravity permission setup was cancelled before launch.')
    this.name = 'AntigravityPermissionLeaseAbortedError'
  }
}

function throwIfPermissionLeaseAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AntigravityPermissionLeaseAbortedError()
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseSettings(content: string, label: string): JsonObject {
  if (Buffer.byteLength(content, 'utf8') > MAX_SETTINGS_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_SETTINGS_BYTES}-byte safety limit.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content || '{}')
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object.`)
  return parsed
}

function cloneObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

async function readOptionalRegularFile(
  path: string,
  maxBytes = MAX_SETTINGS_BYTES
): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`${path} must be a single-link regular file.`)
    }
    if (stat.size > maxBytes) {
      throw new Error(`${path} exceeds the ${maxBytes}-byte safety limit.`)
    }
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(path: string, content: string, signal?: AbortSignal): Promise<void> {
  throwIfPermissionLeaseAborted(signal)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  throwIfPermissionLeaseAborted(signal)
  try {
    await chmod(directory, 0o700)
  } catch {
    // POSIX modes are best-effort on filesystems that do not expose them.
  }
  throwIfPermissionLeaseAborted(signal)
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      ...(signal ? { signal } : {})
    })
    throwIfPermissionLeaseAborted(signal)
    await rename(tempPath, path)
    throwIfPermissionLeaseAborted(signal)
    try {
      await chmod(path, 0o600)
    } catch {
      // The atomic replacement is already authoritative.
    }
  } finally {
    await unlink(tempPath).catch(() => undefined)
  }
}

function receiptPathFor(settingsPath: string): string {
  return join(dirname(settingsPath), '.taskwraith-permission-lease.json')
}

function workspaceRules(input: AntigravityPermissionLeaseRequest): string[] {
  const workspacePath = resolve(input.workspacePath)
  if (!isAbsolute(workspacePath) || /[\r\n)]/.test(workspacePath)) {
    throw new Error('AntiGravity permission setup requires a safe absolute workspace path.')
  }
  // agy 1.1.10 rejects path globs while constructing its terminal sandbox.
  // A directory rule is the supported recursive workspace boundary; adding
  // `/**` makes the entire launch fail before a tool can run.
  const rules = [`read_file(${workspacePath})`, ...AGY_READ_ONLY_SHELL_PROJECTION_RULES]
  if (input.allowWrite) {
    rules.push(`write_file(${workspacePath})`)
  }
  // A live hook overlay is the per-call TaskWraith approval authority. agy's
  // settings layer can only pre-deny; it cannot consume the hook's Allow. Open
  // sandboxed commands while that fail-closed bridge is installed so Ask/Plan
  // approvals are executable instead of being auto-denied a second time.
  if (input.allowShell || input.hookOverlay) {
    rules.push('command(*)')
  }
  // Live-measured 2026-08-19: with the TaskWraith server registered AND
  // discovered, headless agy still auto-denied `call_mcp_tool` because no
  // allow rule admitted MCP — the seat could see the gateway surface and not
  // call one tool of it. `mcp(*)` is the only rule spelling the shipped
  // binary carries, so scoping happens at the PreToolUse hook instead: it
  // routes TaskWraith-server calls to the broker's own server-side gate,
  // approval-gates foreign servers, and denies unattributable calls. The rule
  // therefore installs only when BOTH the registration and that arbitrating
  // hook ride this lease — a registration alone must not open agy-native MCP.
  if (input.mcpOverlay && input.hookOverlay) {
    rules.push('mcp(*)')
  }
  return rules
}

function buildInstalledSettings(
  original: JsonObject,
  input: AntigravityPermissionLeaseRequest
): {
  readonly settings: JsonObject
  readonly addedAllowRules: string[]
  readonly installedScalars: AntigravityPermissionLeaseReceipt['installedScalars']
} {
  const settings = cloneObject(original)
  const permissionsValue = settings.permissions
  if (permissionsValue !== undefined && !isRecord(permissionsValue)) {
    throw new Error('AntiGravity settings permissions must be a JSON object.')
  }
  const permissions = isRecord(permissionsValue) ? cloneObject(permissionsValue) : {}
  const allowValue = permissions.allow
  if (allowValue !== undefined && !Array.isArray(allowValue)) {
    throw new Error('AntiGravity settings permissions.allow must be an array.')
  }
  const originalAllow = Array.isArray(allowValue)
    ? allowValue.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (Array.isArray(allowValue) && originalAllow.length !== allowValue.length) {
    throw new Error('AntiGravity settings permissions.allow may contain only strings.')
  }
  const requestedRules = workspaceRules(input)
  const addedAllowRules = requestedRules.filter((rule) => !originalAllow.includes(rule))
  permissions.allow = [...originalAllow, ...addedAllowRules]
  settings.permissions = permissions

  const installedScalars: AntigravityPermissionLeaseReceipt['installedScalars'] = {}
  if (input.allowShell || input.hookOverlay) {
    settings.toolPermission = 'proceed-in-sandbox'
    installedScalars.toolPermission = 'proceed-in-sandbox'
  }
  if (input.allowWrite) {
    settings.artifactReviewPolicy = 'always-proceed'
    installedScalars.artifactReviewPolicy = 'always-proceed'
  }
  return { settings, addedAllowRules, installedScalars }
}

async function readReceipt(receiptPath: string): Promise<AntigravityPermissionLeaseReceipt | null> {
  const content = await readOptionalRegularFile(receiptPath, MAX_RECEIPT_BYTES)
  if (content === null) return null
  const parsed = parseSettings(content, 'AntiGravity TaskWraith permission receipt')
  if (
    parsed.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof parsed.leaseId !== 'string' ||
    typeof parsed.settingsPath !== 'string' ||
    typeof parsed.installedAt !== 'string' ||
    typeof parsed.originalExists !== 'boolean' ||
    typeof parsed.originalContentBase64 !== 'string' ||
    typeof parsed.originalSha256 !== 'string' ||
    typeof parsed.installedSha256 !== 'string' ||
    !Array.isArray(parsed.addedAllowRules) ||
    !parsed.addedAllowRules.every((rule) => typeof rule === 'string') ||
    !isRecord(parsed.installedScalars)
  ) {
    throw new Error('AntiGravity TaskWraith permission receipt is malformed.')
  }
  return parsed as unknown as AntigravityPermissionLeaseReceipt
}

function restoreChangedSettings(
  current: JsonObject,
  original: JsonObject,
  receipt: AntigravityPermissionLeaseReceipt
): JsonObject {
  const restored = cloneObject(current)
  const currentPermissions = isRecord(restored.permissions)
    ? cloneObject(restored.permissions)
    : undefined
  const originalPermissions = isRecord(original.permissions) ? original.permissions : undefined
  if (currentPermissions) {
    const currentAllow = Array.isArray(currentPermissions.allow)
      ? currentPermissions.allow.filter((entry): entry is string => typeof entry === 'string')
      : []
    const originalAllow = Array.isArray(originalPermissions?.allow)
      ? originalPermissions.allow.filter((entry): entry is string => typeof entry === 'string')
      : []
    const remainingAllow = currentAllow.filter(
      (rule) => !receipt.addedAllowRules.includes(rule) || originalAllow.includes(rule)
    )
    currentPermissions.allow = remainingAllow
    if (remainingAllow.length === 0 && !Array.isArray(originalPermissions?.allow)) {
      delete currentPermissions.allow
    }
    if (Object.keys(currentPermissions).length === 0 && !originalPermissions) {
      delete restored.permissions
    } else {
      restored.permissions = currentPermissions
    }
  }

  for (const key of ['toolPermission', 'artifactReviewPolicy'] as const) {
    const installedValue = receipt.installedScalars[key]
    if (installedValue === undefined || restored[key] !== installedValue) continue
    if (Object.prototype.hasOwnProperty.call(original, key)) restored[key] = original[key]
    else delete restored[key]
  }
  return restored
}

async function cleanReceipt(
  settingsPath: string,
  receiptPath: string,
  receipt: AntigravityPermissionLeaseReceipt
): Promise<void> {
  if (resolve(receipt.settingsPath) !== resolve(settingsPath)) {
    throw new Error('AntiGravity permission receipt belongs to a different settings path.')
  }
  const originalContent = Buffer.from(receipt.originalContentBase64, 'base64').toString('utf8')
  if (sha256(originalContent) !== receipt.originalSha256) {
    throw new Error('AntiGravity permission receipt original-content hash does not match.')
  }
  const currentContent = await readOptionalRegularFile(settingsPath)
  if (currentContent === null) {
    await unlink(receiptPath)
    return
  }
  const currentHash = sha256(currentContent)
  if (currentHash === receipt.originalSha256) {
    await unlink(receiptPath)
    return
  }
  if (currentHash === receipt.installedSha256) {
    if (receipt.originalExists) await writeAtomic(settingsPath, originalContent)
    else await unlink(settingsPath)
    await unlink(receiptPath)
    return
  }

  const current = parseSettings(currentContent, 'Changed AntiGravity settings')
  const original = parseSettings(originalContent || '{}', 'Original AntiGravity settings')
  const restored = restoreChangedSettings(current, original, receipt)
  await writeAtomic(settingsPath, `${JSON.stringify(restored, null, 2)}\n`)
  await unlink(receiptPath)
}

export async function recoverInterruptedAntigravityPermissionLease(
  settingsPath: string
): Promise<boolean> {
  const receiptPath = receiptPathFor(settingsPath)
  const receipt = await readReceipt(receiptPath)
  if (!receipt) return false
  await cleanReceipt(settingsPath, receiptPath, receipt)
  return true
}

// ── Hook overlay (workspace hooks.json) ────────────────────────────────────
// Same discipline as the settings lease: durable receipt beside the file,
// byte-exact restore when untouched, three-way merge that removes only the
// TaskWraith-namespaced hook key when the user edited hooks.json mid-run.

interface AntigravityHookLeaseReceipt {
  readonly schemaVersion: 1
  readonly hooksPath: string
  readonly hookName: string
  readonly originalExists: boolean
  readonly originalContentBase64: string
  readonly originalSha256: string
  readonly installedSha256: string
}

function hookReceiptPathFor(hooksPath: string): string {
  return join(dirname(hooksPath), '.taskwraith-hook-lease.json')
}

async function readHookReceipt(receiptPath: string): Promise<AntigravityHookLeaseReceipt | null> {
  const content = await readOptionalRegularFile(receiptPath, MAX_RECEIPT_BYTES)
  if (content === null) return null
  const parsed = parseSettings(content, 'AntiGravity TaskWraith hook receipt')
  if (
    parsed.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof parsed.hooksPath !== 'string' ||
    typeof parsed.hookName !== 'string' ||
    typeof parsed.originalExists !== 'boolean' ||
    typeof parsed.originalContentBase64 !== 'string' ||
    typeof parsed.originalSha256 !== 'string' ||
    typeof parsed.installedSha256 !== 'string'
  ) {
    throw new Error('AntiGravity TaskWraith hook receipt is malformed.')
  }
  return parsed as unknown as AntigravityHookLeaseReceipt
}

async function cleanHookReceipt(
  hooksPath: string,
  receiptPath: string,
  receipt: AntigravityHookLeaseReceipt
): Promise<void> {
  if (resolve(receipt.hooksPath) !== resolve(hooksPath)) {
    throw new Error('AntiGravity hook receipt belongs to a different hooks path.')
  }
  const originalContent = Buffer.from(receipt.originalContentBase64, 'base64').toString('utf8')
  if (sha256(originalContent) !== receipt.originalSha256) {
    throw new Error('AntiGravity hook receipt original-content hash does not match.')
  }
  const currentContent = await readOptionalRegularFile(hooksPath)
  if (currentContent === null || sha256(currentContent) === receipt.originalSha256) {
    await unlink(receiptPath)
    return
  }
  if (sha256(currentContent) === receipt.installedSha256) {
    if (receipt.originalExists) await writeAtomic(hooksPath, originalContent)
    else await unlink(hooksPath)
    await unlink(receiptPath)
    return
  }
  // User (or another tool) edited hooks.json during the run: remove only the
  // TaskWraith-namespaced key and keep everything else exactly as found.
  const current = parseSettings(currentContent, 'Changed AntiGravity hooks configuration')
  delete current[receipt.hookName]
  await writeAtomic(hooksPath, `${JSON.stringify(current, null, 2)}\n`)
  await unlink(receiptPath)
}

export async function recoverInterruptedAntigravityHookLease(hooksPath: string): Promise<boolean> {
  const receiptPath = hookReceiptPathFor(hooksPath)
  const receipt = await readHookReceipt(receiptPath)
  if (!receipt) return false
  await cleanHookReceipt(hooksPath, receiptPath, receipt)
  return true
}

interface AntigravityMcpLeaseReceipt {
  readonly schemaVersion: 1
  readonly configPath: string
  readonly originalExists: boolean
  readonly originalContentBase64: string
  readonly originalSha256: string
  readonly installedSha256: string
}

function mcpReceiptPathFor(configPath: string): string {
  return join(dirname(configPath), '.taskwraith-mcp-lease.json')
}

async function readMcpReceipt(receiptPath: string): Promise<AntigravityMcpLeaseReceipt | null> {
  const content = await readOptionalRegularFile(receiptPath, MAX_RECEIPT_BYTES)
  if (content === null) return null
  const parsed = parseSettings(content, 'AntiGravity TaskWraith MCP receipt')
  if (
    parsed.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof parsed.configPath !== 'string' ||
    typeof parsed.originalExists !== 'boolean' ||
    typeof parsed.originalContentBase64 !== 'string' ||
    typeof parsed.originalSha256 !== 'string' ||
    typeof parsed.installedSha256 !== 'string'
  ) {
    throw new Error('AntiGravity TaskWraith MCP receipt is malformed.')
  }
  return parsed as unknown as AntigravityMcpLeaseReceipt
}

async function cleanMcpReceipt(
  configPath: string,
  receiptPath: string,
  receipt: AntigravityMcpLeaseReceipt
): Promise<void> {
  if (resolve(receipt.configPath) !== resolve(configPath)) {
    throw new Error('AntiGravity MCP receipt belongs to a different config path.')
  }
  const originalContent = Buffer.from(receipt.originalContentBase64, 'base64').toString('utf8')
  if (sha256(originalContent) !== receipt.originalSha256) {
    throw new Error('AntiGravity MCP receipt original-content hash does not match.')
  }
  const currentContent = await readOptionalRegularFile(configPath)
  if (currentContent === null || sha256(currentContent) === receipt.originalSha256) {
    await unlink(receiptPath)
    return
  }
  if (sha256(currentContent) === receipt.installedSha256) {
    // agy creates this file byte-empty at migration, so "no original" restores
    // to an empty file rather than removing a path agy expects to exist.
    if (receipt.originalExists) await writeAtomic(configPath, originalContent)
    else await writeAtomic(configPath, '')
    await unlink(receiptPath)
    return
  }
  // The user (or agy's own TUI writer) changed the document mid-run. Withdraw
  // only TaskWraith's registration and leave every other server untouched; a
  // document we can no longer parse is left exactly as found.
  const parsed = parseAgyMcpConfigDocument(currentContent)
  if (parsed.status === 'ok') {
    const withdrawn = buildAgyMcpConfigDocument({ existing: parsed.document })
    await writeAtomic(configPath, serializeAgyMcpConfigDocument(withdrawn))
  }
  await unlink(receiptPath)
}

export async function recoverInterruptedAntigravityMcpLease(configPath: string): Promise<boolean> {
  const receiptPath = mcpReceiptPathFor(configPath)
  const receipt = await readMcpReceipt(receiptPath)
  if (!receipt) return false
  await cleanMcpReceipt(configPath, receiptPath, receipt)
  return true
}

/**
 * Install TaskWraith's MCP registration for one run.
 *
 * Returns `registered: false` rather than throwing when the existing document
 * cannot be parsed: that file is the user's, and a run without TaskWraith
 * tools is strictly better than a clobbered config or a refused launch. When
 * the projected document already matches what is on disk the registration is
 * honoured with NO receipt, so release leaves a user-owned registration alone.
 */
async function installMcpOverlay(
  overlay: NonNullable<AntigravityPermissionLeaseRequest['mcpOverlay']>,
  signal?: AbortSignal
): Promise<{ registered: boolean; release?: () => Promise<void> }> {
  const configPath = resolve(overlay.configPath)
  throwIfPermissionLeaseAborted(signal)
  await recoverInterruptedAntigravityMcpLease(configPath)
  throwIfPermissionLeaseAborted(signal)
  let existingOriginalContent: string | null = null
  try {
    existingOriginalContent = await readOptionalRegularFile(configPath)
  } catch {
    return { registered: false }
  }
  const parsed = parseAgyMcpConfigDocument(existingOriginalContent)
  if (parsed.status === 'unreadable') return { registered: false }
  const projected = buildAgyMcpConfigDocument({
    existing: parsed.status === 'ok' ? parsed.document : null,
    taskWraith: overlay.registration
  })
  if (!agyMcpConfigNeedsUpdate(parsed, projected)) return { registered: true }

  const originalContent = existingOriginalContent ?? ''
  const installedContent = serializeAgyMcpConfigDocument(projected)
  const receipt: AntigravityMcpLeaseReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    configPath,
    originalExists: existingOriginalContent !== null,
    originalContentBase64: Buffer.from(originalContent, 'utf8').toString('base64'),
    originalSha256: sha256(originalContent),
    installedSha256: sha256(installedContent)
  }
  const receiptPath = mcpReceiptPathFor(configPath)
  try {
    await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, signal)
    await writeAtomic(configPath, installedContent, signal)
    throwIfPermissionLeaseAborted(signal)
  } catch (error) {
    await cleanMcpReceipt(configPath, receiptPath, receipt).catch(() => undefined)
    throw error
  }
  return {
    registered: true,
    release: () => cleanMcpReceipt(configPath, receiptPath, receipt)
  }
}

async function installHookOverlay(
  overlay: NonNullable<AntigravityPermissionLeaseRequest['hookOverlay']>,
  signal?: AbortSignal
): Promise<AntigravityHookLeaseReceipt> {
  const hooksPath = resolve(overlay.hooksPath)
  if (!overlay.hookName || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(overlay.hookName)) {
    throw new Error('AntiGravity hook overlay requires a namespaced hook name.')
  }
  throwIfPermissionLeaseAborted(signal)
  await recoverInterruptedAntigravityHookLease(hooksPath)
  throwIfPermissionLeaseAborted(signal)
  const existingOriginalContent = await readOptionalRegularFile(hooksPath)
  const originalContent = existingOriginalContent ?? ''
  const original = parseSettings(originalContent || '{}', 'AntiGravity hooks configuration')
  const installed = cloneObject(original)
  installed[overlay.hookName] = cloneObject(overlay.namedHook)
  const installedContent = `${JSON.stringify(installed, null, 2)}\n`
  const receipt: AntigravityHookLeaseReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    hooksPath,
    hookName: overlay.hookName,
    originalExists: existingOriginalContent !== null,
    originalContentBase64: Buffer.from(originalContent, 'utf8').toString('base64'),
    originalSha256: sha256(originalContent),
    installedSha256: sha256(installedContent)
  }
  const receiptPath = hookReceiptPathFor(hooksPath)
  try {
    await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, signal)
    await writeAtomic(hooksPath, installedContent, signal)
    throwIfPermissionLeaseAborted(signal)
  } catch (error) {
    await cleanHookReceipt(hooksPath, receiptPath, receipt).catch(() => undefined)
    throw error
  }
  return receipt
}

async function installPermissionLease(
  input: AntigravityPermissionLeaseRequest
): Promise<AntigravityPermissionLeaseReceipt> {
  const settingsPath = resolve(input.settingsPath)
  throwIfPermissionLeaseAborted(input.signal)
  await recoverInterruptedAntigravityPermissionLease(settingsPath)
  throwIfPermissionLeaseAborted(input.signal)
  const existingOriginalContent = await readOptionalRegularFile(settingsPath)
  const originalContent = existingOriginalContent ?? ''
  const original = parseSettings(originalContent || '{}', 'AntiGravity settings')
  const installed = buildInstalledSettings(original, input)
  const installedContent = `${JSON.stringify(installed.settings, null, 2)}\n`
  const receipt: AntigravityPermissionLeaseReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    leaseId: randomUUID(),
    settingsPath,
    installedAt: new Date().toISOString(),
    originalExists: existingOriginalContent !== null,
    originalContentBase64: Buffer.from(originalContent, 'utf8').toString('base64'),
    originalSha256: sha256(originalContent),
    installedSha256: sha256(installedContent),
    addedAllowRules: installed.addedAllowRules,
    installedScalars: installed.installedScalars
  }
  const receiptPath = receiptPathFor(settingsPath)
  try {
    await writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, input.signal)
    await writeAtomic(settingsPath, installedContent, input.signal)
    throwIfPermissionLeaseAborted(input.signal)
  } catch (error) {
    await cleanReceipt(settingsPath, receiptPath, receipt).catch(() => undefined)
    throw error
  }
  return receipt
}

// ── Concurrent grant registries — the run-length FIFO is deliberately GONE ──
// (2026-08-19, direct user directive.) Whether parallel agy lanes are safe is
// the user's call, made in the composer (isolation / parallel dispatch); this
// module must never make one run wait for another run to finish. What remains
// is only the bookkeeping that keeps concurrent holders of agy's shared config
// files from corrupting each other:
//   - per-FILE micro-transactions: millisecond op chains around each
//     install/extend/shrink/restore write — atomicity of the bookkeeping,
//     never serialization of runs;
//   - refcounts: the first holder installs and captures the user's original
//     bytes, joiners union in whatever rules are missing, an early release
//     shrinks the document to what the survivors still need, and the LAST
//     holder restores the original;
//   - crash recovery runs only on the first-holder path, so a second acquire
//     can never roll back a sibling's live grant;
//   - the per-workspace hook file carries ONE live entry: the first holder's
//     token while it runs, handed to a survivor's token when the owner
//     releases early (an unknown token at the bridge is a fail-closed deny,
//     so a dead token must never be left installed). Cross-lane consequences
//     of sharing one workspace's hook are part of the user's parallelism
//     decision, not gated here.

interface SettingsHolderNeeds {
  readonly rules: readonly string[]
  readonly toolPermission: boolean
  readonly artifactReviewPolicy: boolean
}

interface SettingsGrantState {
  receipt: AntigravityPermissionLeaseReceipt
  readonly originalAllow: readonly string[]
  readonly holders: Map<string, SettingsHolderNeeds>
  /** Every rule this coordinator ever added to the live document, in first-
   * appearance order. The receipt keeps the FULL history so the last-out
   * three-way merge can strip anything of ours that an interrupted shrink
   * left behind. */
  readonly addedRuleHistory: string[]
  lastInstalledSha: string
}

interface HookGrantState {
  receipt: AntigravityHookLeaseReceipt
  readonly hooksPath: string
  readonly hookName: string
  readonly holders: Map<string, JsonObject>
  order: string[]
  activeLeaseId: string
  lastInstalledSha: string
}

interface McpGrantState {
  readonly holders: Set<string>
  readonly registered: boolean
  readonly release?: () => Promise<void>
}

function settingsHolderNeeds(input: AntigravityPermissionLeaseRequest): SettingsHolderNeeds {
  return {
    rules: workspaceRules(input),
    toolPermission: Boolean(input.allowShell || input.hookOverlay),
    artifactReviewPolicy: input.allowWrite
  }
}

function originalAllowOf(receipt: AntigravityPermissionLeaseReceipt): string[] {
  const original = parseSettings(
    Buffer.from(receipt.originalContentBase64, 'base64').toString('utf8') || '{}',
    'Original AntiGravity settings'
  )
  const permissions = isRecord(original.permissions) ? original.permissions : undefined
  return Array.isArray(permissions?.allow)
    ? permissions.allow.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export class AntigravityPermissionLeaseCoordinator {
  private readonly settingsGrants = new Map<string, SettingsGrantState>()
  private readonly hookGrants = new Map<string, HookGrantState>()
  private readonly mcpGrants = new Map<string, McpGrantState>()
  /** Per-file bookkeeping chains. These serialize the WRITES around one path
   * for the milliseconds they take — they never hold across a run. */
  private readonly fileOps = new Map<string, Promise<unknown>>()

  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.fileOps.get(key) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.fileOps.set(
      key,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async joinSettings(
    settingsPath: string,
    leaseId: string,
    input: AntigravityPermissionLeaseRequest
  ): Promise<void> {
    const needs = settingsHolderNeeds(input)
    const state = this.settingsGrants.get(settingsPath)
    if (!state) {
      // First holder: crash recovery is safe here precisely because no
      // in-process holder is live for this path. Pass `input` through intact —
      // installPermissionLease resolves the path itself, and callers may hand
      // us getter-backed signal properties that a spread would flatten.
      const receipt = await installPermissionLease(input)
      this.settingsGrants.set(settingsPath, {
        receipt,
        originalAllow: originalAllowOf(receipt),
        holders: new Map([[leaseId, needs]]),
        addedRuleHistory: [...receipt.addedAllowRules],
        lastInstalledSha: receipt.installedSha256
      })
      return
    }
    state.holders.set(leaseId, needs)
    await this.extendSettingsDocument(settingsPath, state, input.signal)
  }

  /** Bring the live document up to the union of every holder's needs. */
  private async extendSettingsDocument(
    settingsPath: string,
    state: SettingsGrantState,
    signal?: AbortSignal
  ): Promise<void> {
    const currentContent = await readOptionalRegularFile(settingsPath)
    const document = parseSettings(currentContent ?? '{}', 'Installed AntiGravity settings')
    const permissionsValue = document.permissions
    if (permissionsValue !== undefined && !isRecord(permissionsValue)) {
      throw new Error('AntiGravity settings permissions must be a JSON object.')
    }
    const permissions = isRecord(permissionsValue) ? cloneObject(permissionsValue) : {}
    const allowValue = permissions.allow
    if (allowValue !== undefined && !Array.isArray(allowValue)) {
      throw new Error('AntiGravity settings permissions.allow must be an array.')
    }
    const allow = Array.isArray(allowValue)
      ? allowValue.filter((entry): entry is string => typeof entry === 'string')
      : []
    if (Array.isArray(allowValue) && allow.length !== allowValue.length) {
      throw new Error('AntiGravity settings permissions.allow may contain only strings.')
    }

    let changed = false
    let needTool = false
    let needArtifact = false
    const newHistory: string[] = []
    for (const holder of state.holders.values()) {
      needTool ||= holder.toolPermission
      needArtifact ||= holder.artifactReviewPolicy
      for (const rule of holder.rules) {
        if (!allow.includes(rule)) {
          allow.push(rule)
          changed = true
          if (!state.originalAllow.includes(rule) && !state.addedRuleHistory.includes(rule)) {
            newHistory.push(rule)
          }
        }
      }
    }
    const installedScalars = { ...state.receipt.installedScalars }
    if (needTool && document.toolPermission !== 'proceed-in-sandbox') {
      document.toolPermission = 'proceed-in-sandbox'
      installedScalars.toolPermission = 'proceed-in-sandbox'
      changed = true
    }
    if (needArtifact && document.artifactReviewPolicy !== 'always-proceed') {
      document.artifactReviewPolicy = 'always-proceed'
      installedScalars.artifactReviewPolicy = 'always-proceed'
      changed = true
    }
    if (!changed) return

    permissions.allow = allow
    document.permissions = permissions
    const content = `${JSON.stringify(document, null, 2)}\n`
    state.addedRuleHistory.push(...newHistory)
    const nextReceipt: AntigravityPermissionLeaseReceipt = {
      ...state.receipt,
      addedAllowRules: state.addedRuleHistory.filter(
        (rule) => !state.originalAllow.includes(rule)
      ),
      installedSha256: sha256(content),
      installedScalars
    }
    await writeAtomic(
      receiptPathFor(settingsPath),
      `${JSON.stringify(nextReceipt, null, 2)}\n`,
      signal
    )
    await writeAtomic(settingsPath, content, signal)
    state.receipt = nextReceipt
    state.lastInstalledSha = nextReceipt.installedSha256
  }

  private async leaveSettings(settingsPath: string, leaseId: string): Promise<void> {
    const state = this.settingsGrants.get(settingsPath)
    if (!state || !state.holders.has(leaseId)) return
    state.holders.delete(leaseId)
    if (state.holders.size === 0) {
      this.settingsGrants.delete(settingsPath)
      await cleanReceipt(settingsPath, receiptPathFor(settingsPath), state.receipt)
      return
    }
    // Shrink to what the survivors still need. If the document was edited out
    // from under us (user or agy's own writer), leave it alone — the receipt
    // keeps the full added-rule history, so the last-out merge still strips
    // everything of ours.
    const currentContent = await readOptionalRegularFile(settingsPath)
    if (currentContent === null || sha256(currentContent) !== state.lastInstalledSha) return
    const document = parseSettings(currentContent, 'Installed AntiGravity settings')
    const needed = new Set<string>()
    let needTool = false
    let needArtifact = false
    for (const holder of state.holders.values()) {
      for (const rule of holder.rules) needed.add(rule)
      needTool ||= holder.toolPermission
      needArtifact ||= holder.artifactReviewPolicy
    }
    let changed = false
    const permissions = isRecord(document.permissions) ? cloneObject(document.permissions) : {}
    if (Array.isArray(permissions.allow)) {
      const allow = permissions.allow.filter((entry): entry is string => typeof entry === 'string')
      const kept = allow.filter(
        (rule) => needed.has(rule) || state.originalAllow.includes(rule)
      )
      if (kept.length !== allow.length) {
        permissions.allow = kept
        document.permissions = permissions
        changed = true
      }
    }
    for (const [key, requiredValue, stillNeeded] of [
      ['toolPermission', 'proceed-in-sandbox', needTool],
      ['artifactReviewPolicy', 'always-proceed', needArtifact]
    ] as const) {
      const installedValue = state.receipt.installedScalars[key]
      if (stillNeeded || installedValue === undefined) continue
      if (document[key] !== installedValue || installedValue !== requiredValue) continue
      const original = parseSettings(
        Buffer.from(state.receipt.originalContentBase64, 'base64').toString('utf8') || '{}',
        'Original AntiGravity settings'
      )
      if (Object.prototype.hasOwnProperty.call(original, key)) document[key] = original[key]
      else delete document[key]
      changed = true
    }
    if (!changed) return
    const content = `${JSON.stringify(document, null, 2)}\n`
    const nextReceipt: AntigravityPermissionLeaseReceipt = {
      ...state.receipt,
      installedSha256: sha256(content)
    }
    await writeAtomic(receiptPathFor(settingsPath), `${JSON.stringify(nextReceipt, null, 2)}\n`)
    await writeAtomic(settingsPath, content)
    state.receipt = nextReceipt
    state.lastInstalledSha = nextReceipt.installedSha256
  }

  private async joinHook(
    hooksKey: string,
    leaseId: string,
    overlay: NonNullable<AntigravityPermissionLeaseRequest['hookOverlay']>,
    signal?: AbortSignal
  ): Promise<void> {
    const state = this.hookGrants.get(hooksKey)
    if (!state) {
      const receipt = await installHookOverlay(overlay, signal)
      this.hookGrants.set(hooksKey, {
        receipt,
        hooksPath: hooksKey,
        hookName: overlay.hookName,
        holders: new Map([[leaseId, cloneObject(overlay.namedHook)]]),
        order: [leaseId],
        activeLeaseId: leaseId,
        lastInstalledSha: receipt.installedSha256
      })
      return
    }
    if (state.hookName !== overlay.hookName) {
      throw new Error('The agy hook lease supports one named hook per hooks file.')
    }
    state.holders.set(leaseId, cloneObject(overlay.namedHook))
    state.order.push(leaseId)
  }

  private async leaveHook(hooksKey: string, leaseId: string): Promise<void> {
    const state = this.hookGrants.get(hooksKey)
    if (!state || !state.holders.has(leaseId)) return
    state.holders.delete(leaseId)
    state.order = state.order.filter((id) => id !== leaseId)
    if (state.holders.size === 0) {
      this.hookGrants.delete(hooksKey)
      await cleanHookReceipt(state.hooksPath, hookReceiptPathFor(state.hooksPath), state.receipt)
      return
    }
    if (state.activeLeaseId !== leaseId) return
    // The token owner left while survivors run: hand the entry to the eldest
    // survivor, whose bridge registration is still alive.
    const survivorId = state.order[0]
    const survivorHook = state.holders.get(survivorId)
    if (!survivorHook) return
    const currentContent = await readOptionalRegularFile(state.hooksPath)
    const untouched =
      currentContent !== null && sha256(currentContent) === state.lastInstalledSha
    const base = untouched
      ? parseSettings(
          Buffer.from(state.receipt.originalContentBase64, 'base64').toString('utf8') || '{}',
          'AntiGravity hooks configuration'
        )
      : parseSettings(currentContent ?? '{}', 'Changed AntiGravity hooks configuration')
    const installed = cloneObject(base)
    installed[state.hookName] = cloneObject(survivorHook)
    const content = `${JSON.stringify(installed, null, 2)}\n`
    const nextReceipt: AntigravityHookLeaseReceipt = {
      ...state.receipt,
      installedSha256: sha256(content)
    }
    await writeAtomic(
      hookReceiptPathFor(state.hooksPath),
      `${JSON.stringify(nextReceipt, null, 2)}\n`
    )
    await writeAtomic(state.hooksPath, content)
    state.receipt = nextReceipt
    state.lastInstalledSha = nextReceipt.installedSha256
    state.activeLeaseId = survivorId
  }

  private async joinMcp(
    mcpKey: string,
    leaseId: string,
    overlay: NonNullable<AntigravityPermissionLeaseRequest['mcpOverlay']>,
    signal?: AbortSignal
  ): Promise<boolean> {
    const state = this.mcpGrants.get(mcpKey)
    if (state) {
      // The registration content is static (same command + args for every
      // run; per-run routing rides the child environment), so joiners simply
      // share whatever the first holder achieved.
      state.holders.add(leaseId)
      return state.registered
    }
    const installed = await installMcpOverlay(overlay, signal)
    this.mcpGrants.set(mcpKey, {
      holders: new Set([leaseId]),
      registered: installed.registered,
      release: installed.release
    })
    return installed.registered
  }

  private async leaveMcp(mcpKey: string, leaseId: string): Promise<void> {
    const state = this.mcpGrants.get(mcpKey)
    if (!state || !state.holders.has(leaseId)) return
    state.holders.delete(leaseId)
    if (state.holders.size > 0) return
    this.mcpGrants.delete(mcpKey)
    await state.release?.()
  }

  async acquire(input: AntigravityPermissionLeaseRequest): Promise<AntigravityPermissionLease> {
    throwIfPermissionLeaseAborted(input.signal)
    const leaseId = randomUUID()
    const settingsPath = resolve(input.settingsPath)
    const hooksKey = input.hookOverlay ? resolve(input.hookOverlay.hooksPath) : null
    const mcpKey = input.mcpOverlay ? resolve(input.mcpOverlay.configPath) : null
    const undo: Array<() => Promise<void>> = []
    let mcpRegistered = false
    try {
      await this.runExclusive(settingsPath, () => this.joinSettings(settingsPath, leaseId, input))
      undo.push(() => this.runExclusive(settingsPath, () => this.leaveSettings(settingsPath, leaseId)))
      throwIfPermissionLeaseAborted(input.signal)
      if (input.hookOverlay && hooksKey) {
        const overlay = input.hookOverlay
        await this.runExclusive(hooksKey, () => this.joinHook(hooksKey, leaseId, overlay, input.signal))
        undo.push(() => this.runExclusive(hooksKey, () => this.leaveHook(hooksKey, leaseId)))
        throwIfPermissionLeaseAborted(input.signal)
      }
      if (input.mcpOverlay && mcpKey) {
        const overlay = input.mcpOverlay
        // The MCP registration is an enhancement, never a launch precondition:
        // a failure here costs the run its TaskWraith tools, which is what
        // every agy run had before this existed. Only an abort propagates.
        try {
          mcpRegistered = await this.runExclusive(mcpKey, () =>
            this.joinMcp(mcpKey, leaseId, overlay, input.signal)
          )
          undo.push(() => this.runExclusive(mcpKey, () => this.leaveMcp(mcpKey, leaseId)))
        } catch (error) {
          if (input.signal?.aborted) throw error
          mcpRegistered = false
        }
      }
      throwIfPermissionLeaseAborted(input.signal)
    } catch (error) {
      for (const step of undo.reverse()) {
        await step().catch(() => undefined)
      }
      if (input.signal?.aborted) throw new AntigravityPermissionLeaseAbortedError()
      throw error
    }

    let releaseOperation: Promise<void> | undefined
    return Object.freeze({
      leaseId,
      settingsPath,
      mcpRegistered,
      release: () => {
        if (!releaseOperation) {
          // Hook first: once this run's claim on the hook entry is resolved
          // (handed over or removed), no late tool call of ours races the
          // settings shrink. The MCP registration only decides what agy
          // discovers at STARTUP, so its ordering is about a clean disk.
          releaseOperation = (async () => {
            if (hooksKey) {
              await this.runExclusive(hooksKey, () => this.leaveHook(hooksKey, leaseId))
            }
            if (mcpKey) {
              await this.runExclusive(mcpKey, () => this.leaveMcp(mcpKey, leaseId))
            }
            await this.runExclusive(settingsPath, () => this.leaveSettings(settingsPath, leaseId))
          })()
        }
        return releaseOperation
      }
    })
  }
}
