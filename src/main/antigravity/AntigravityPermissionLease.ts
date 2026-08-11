import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

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
 *    `uniq`, `tree`, `file`, `hostname`, `date`) are deliberately absent
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
  readonly signal?: AbortSignal
}

export interface AntigravityPermissionLease {
  readonly leaseId: string
  readonly settingsPath: string
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

async function installHookOverlay(
  overlay: NonNullable<AntigravityPermissionLeaseRequest['hookOverlay']>,
  signal?: AbortSignal
): Promise<{ release: () => Promise<void> }> {
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
  return {
    release: () => cleanHookReceipt(hooksPath, receiptPath, receipt)
  }
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

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous
  if (signal.aborted) return Promise.reject(new AntigravityPermissionLeaseAbortedError())
  return new Promise((resolveWait, rejectWait) => {
    const abort = (): void => rejectWait(new AntigravityPermissionLeaseAbortedError())
    signal.addEventListener('abort', abort, { once: true })
    previous.then(
      () => {
        signal.removeEventListener('abort', abort)
        resolveWait()
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        rejectWait(error)
      }
    )
  })
}

/**
 * Official agy reads one global settings file and offers no per-run config
 * path. Serialize these short-lived overlays so two workspaces can never see
 * each other's native allow rules. Provider admission remains unchanged.
 */
export class AntigravityPermissionLeaseCoordinator {
  private tail: Promise<void> = Promise.resolve()

  async acquire(input: AntigravityPermissionLeaseRequest): Promise<AntigravityPermissionLease> {
    const previous = this.tail.catch(() => undefined)
    let releaseQueue!: () => void
    const queueGate = new Promise<void>((resolveGate) => {
      releaseQueue = resolveGate
    })
    this.tail = previous.then(() => queueGate)

    try {
      await waitForTurn(previous, input.signal)
    } catch (error) {
      releaseQueue()
      throw error
    }
    if (input.signal?.aborted) {
      releaseQueue()
      throw new AntigravityPermissionLeaseAbortedError()
    }

    let receipt: AntigravityPermissionLeaseReceipt | undefined
    let hookRelease: (() => Promise<void>) | undefined
    try {
      receipt = await installPermissionLease(input)
      throwIfPermissionLeaseAborted(input.signal)
      if (input.hookOverlay) {
        hookRelease = (await installHookOverlay(input.hookOverlay, input.signal)).release
      }
      throwIfPermissionLeaseAborted(input.signal)
    } catch (error) {
      let cleanupError: unknown
      try {
        await hookRelease?.()
      } catch (releaseError) {
        cleanupError = releaseError
      }
      if (receipt) {
        try {
          await recoverInterruptedAntigravityPermissionLease(receipt.settingsPath)
        } catch (releaseError) {
          cleanupError ??= releaseError
        }
      }
      releaseQueue()
      if (input.signal?.aborted) throw new AntigravityPermissionLeaseAbortedError()
      if (cleanupError) throw cleanupError
      throw error
    }

    let releaseOperation: Promise<void> | undefined
    return Object.freeze({
      leaseId: receipt.leaseId,
      settingsPath: receipt.settingsPath,
      release: () => {
        if (!releaseOperation) {
          // Hook overlay first: once it is gone no further tool call can reach
          // the bridge, so the settings restore never races a late hook.
          releaseOperation = (hookRelease ? hookRelease() : Promise.resolve())
            .then(() =>
              cleanReceipt(receipt.settingsPath, receiptPathFor(receipt.settingsPath), receipt)
            )
            .finally(releaseQueue)
        }
        return releaseOperation
      }
    })
  }
}
