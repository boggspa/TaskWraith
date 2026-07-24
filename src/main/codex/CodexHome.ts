import { constants as fsConstants, createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, link, lstat, mkdir, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { isCodexAppServerThreadId } from '../CodexSessionIdentity'

export const TASKWRAITH_CODEX_HOME_DIRECTORY = 'codex-home'

const MAX_SESSION_META_BYTES = 2 * 1024 * 1024
const TASKWRAITH_ROLLOUT_ORIGINATORS = new Set(['taskwraith', 'agbench', 'guigemini'])
const linkedRolloutMigrationQueues = new Map<string, Promise<unknown>>()
export const TASKWRAITH_CODEX_PROTECTED_STATE_ENTRIES = [
  '.codex-global-state.json',
  'archived_sessions',
  'auth.json',
  'config.toml',
  'history.jsonl',
  'session_index.jsonl',
  'sessions',
  'sqlite',
  'state_5.sqlite',
  'state_5.sqlite-shm',
  'state_5.sqlite-wal'
] as const
const PROTECTED_CODEX_HOME_ENTRIES = new Set<string>(
  TASKWRAITH_CODEX_PROTECTED_STATE_ENTRIES
)
const RECURSIVE_CODEX_HOME_DIRECTORIES = new Set(['archived_sessions', 'sessions', 'sqlite'])

export type CodexRolloutMigrationResult =
  | 'already-present'
  | 'migrated'
  | 'invalid-thread-id'
  | 'not-found'
  | 'not-taskwraith'

export class CodexHomeContinuityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexHomeContinuityError'
  }
}

export function taskWraithCodexHomePath(userDataPath: string): string {
  if (!isAbsolute(userDataPath)) {
    throw new Error('TaskWraith userData path must be absolute before resolving CODEX_HOME.')
  }
  return join(userDataPath, TASKWRAITH_CODEX_HOME_DIRECTORY)
}

export function legacyCodexHomePath(userHome: string = homedir()): string {
  return join(userHome, '.codex')
}

export function requireAbsoluteCodexHome(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!normalized || !isAbsolute(normalized)) {
    throw new Error('TaskWraith CODEX_HOME must be a non-empty absolute path.')
  }
  return normalized
}

export function withTaskWraithCodexHomeEnv(
  env: Record<string, string>,
  codexHome: string
): Record<string, string> {
  return {
    ...env,
    // Caller-owned launch state deliberately wins over inherited and runtime-
    // profile values. A split home would break both isolation and native resume.
    CODEX_HOME: requireAbsoluteCodexHome(codexHome)
  }
}

export async function ensureTaskWraithCodexHome(codexHome: string): Promise<string> {
  const resolved = requireAbsoluteCodexHome(codexHome)
  await mkdir(resolved, { recursive: true, mode: 0o700 })
  const stat = await lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('TaskWraith CODEX_HOME must resolve to a private directory, not a symlink.')
  }
  // mkdir's mode is affected by umask and does not tighten an existing path.
  // Codex writes auth.json here, so keep the owning directory private.
  await chmod(resolved, 0o700)
  return resolved
}

export async function ensureTaskWraithCodexHomeForProtectedRead(
  codexHome: string,
  entries: readonly string[]
): Promise<string> {
  const resolved = await ensureTaskWraithCodexHome(codexHome)
  for (const entry of entries) {
    if (!PROTECTED_CODEX_HOME_ENTRIES.has(entry)) {
      throw new Error(`Unknown protected Codex state path: ${entry}`)
    }
    try {
      const stat = await lstat(join(resolved, entry))
      if (stat.isSymbolicLink()) {
        throw new Error(
          `TaskWraith CODEX_HOME contains a symlink in protected Codex state: ${entry}`
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw error
    }
  }
  return resolved
}

async function assertNoSymlinksInDirectoryTree(directory: string, codexHome: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const candidate = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(
        `TaskWraith CODEX_HOME contains a symlink in protected Codex state: ${relative(codexHome, candidate)}`
      )
    }
    if (entry.isDirectory()) {
      await assertNoSymlinksInDirectoryTree(candidate, codexHome)
    }
  }
}

/**
 * Prepare the private home for a Codex process that may write state. Native
 * plugins may deliberately use their own symlinks, so the check is limited to
 * Codex's auth/config/database/session paths and recursively covers rollout
 * directory ancestors.
 */
export async function ensureTaskWraithCodexHomeForLaunch(codexHome: string): Promise<string> {
  const resolved = await ensureTaskWraithCodexHome(codexHome)
  const entries = await readdir(resolved, { withFileTypes: true })
  for (const entry of entries) {
    if (!PROTECTED_CODEX_HOME_ENTRIES.has(entry.name)) continue
    const candidate = join(resolved, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(
        `TaskWraith CODEX_HOME contains a symlink in protected Codex state: ${entry.name}`
      )
    }
    if (RECURSIVE_CODEX_HOME_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory()) {
        throw new Error(
          `TaskWraith CODEX_HOME protected state path must be a directory: ${entry.name}`
        )
      }
      await assertNoSymlinksInDirectoryTree(candidate, resolved)
    }
  }
  return resolved
}

function canonicalThreadId(threadId: string): string {
  return threadId.trim().replace(/^urn:uuid:/i, '').toLowerCase()
}

export function isTaskWraithCodexRolloutOriginator(value: unknown): boolean {
  return (
    typeof value === 'string' && TASKWRAITH_ROLLOUT_ORIGINATORS.has(value.trim().toLowerCase())
  )
}

async function findRolloutByThreadId(root: string, threadId: string): Promise<string | null> {
  const suffix = `${canonicalThreadId(threadId)}.jsonl`
  const visit = async (directory: string): Promise<string | null> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const candidate = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = await visit(candidate)
        if (nested) return nested
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
        return candidate
      }
    }
    return null
  }
  return visit(root)
}

async function readFirstJsonLine(path: string): Promise<Record<string, unknown> | null> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  let buffered = ''
  try {
    for await (const chunk of stream) {
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline >= 0) {
        buffered = buffered.slice(0, newline)
        break
      }
      if (buffered.length > MAX_SESSION_META_BYTES) return null
    }
  } finally {
    stream.destroy()
  }
  if (!buffered.trim() || buffered.length > MAX_SESSION_META_BYTES) return null
  try {
    const parsed = JSON.parse(buffered)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function isTaskWraithRollout(path: string, threadId: string): Promise<boolean> {
  const first = await readFirstJsonLine(path)
  const payload =
    first?.payload && typeof first.payload === 'object' && !Array.isArray(first.payload)
      ? (first.payload as Record<string, unknown>)
      : null
  return Boolean(
    first?.type === 'session_meta' &&
      isTaskWraithCodexRolloutOriginator(payload?.originator) &&
      typeof payload?.id === 'string' &&
      canonicalThreadId(payload.id) === canonicalThreadId(threadId)
  )
}

function migratedDestination(codexHome: string, legacyHome: string, source: string): string {
  const legacySessionsRoot = join(legacyHome, 'sessions')
  const sourceRelative = relative(legacySessionsRoot, source)
  if (sourceRelative && !sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) {
    return join(codexHome, 'sessions', sourceRelative)
  }

  // archived_sessions is flat in current Codex releases. Reconstruct the
  // ordinary date hierarchy from the rollout filename so thread/resume can
  // discover and read-repair it through the normal sessions path.
  const filename = basename(source)
  const date = filename.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/)
  return date
    ? join(codexHome, 'sessions', date[1], date[2], date[3], filename)
    : join(codexHome, 'sessions', 'migrated', filename)
}

/**
 * Preserve native resume across the one-time shared-home → private-home
 * cutover without importing Codex Desktop state. Only the exact TaskWraith
 * rollout referenced by a durable linkedProviderSessionId is copied; auth,
 * config, plugins, SQLite/WAL files, caches, and unrelated sessions remain in
 * the external Codex home.
 *
 * Codex app-server discovers a rollout by id and read-repairs its private
 * state database on thread/resume. The copy is exclusive and idempotent, so
 * concurrent seats may safely race the same legacy id.
 */
export async function migrateLinkedCodexRollout(input: {
  threadId: string
  codexHome: string
  legacyCodexHome?: string
  legacyCodexHomes?: readonly string[]
}): Promise<CodexRolloutMigrationResult> {
  if (!isCodexAppServerThreadId(input.threadId)) return 'invalid-thread-id'
  const migrationKey = `${requireAbsoluteCodexHome(input.codexHome)}\0${canonicalThreadId(input.threadId)}`
  const previous = linkedRolloutMigrationQueues.get(migrationKey) ?? Promise.resolve()
  const current = previous
    .catch(() => undefined)
    .then(() => migrateLinkedCodexRolloutOnce(input))
  linkedRolloutMigrationQueues.set(migrationKey, current)
  try {
    return await current
  } finally {
    if (linkedRolloutMigrationQueues.get(migrationKey) === current) {
      linkedRolloutMigrationQueues.delete(migrationKey)
    }
  }
}

async function migrateLinkedCodexRolloutOnce(input: {
  threadId: string
  codexHome: string
  legacyCodexHome?: string
  legacyCodexHomes?: readonly string[]
}): Promise<CodexRolloutMigrationResult> {
  const codexHome = await ensureTaskWraithCodexHomeForLaunch(input.codexHome)
  const existing =
    (await findRolloutByThreadId(join(codexHome, 'sessions'), input.threadId)) ||
    (await findRolloutByThreadId(join(codexHome, 'archived_sessions'), input.threadId))
  if (existing && (await isTaskWraithRollout(existing, input.threadId))) {
    return 'already-present'
  }

  const requestedLegacyHomes =
    input.legacyCodexHomes ??
    (input.legacyCodexHome ? [input.legacyCodexHome] : [legacyCodexHomePath()])
  const legacyHomes = [
    ...new Set(
      requestedLegacyHomes
        .map((candidate) => requireAbsoluteCodexHome(candidate))
        .filter((candidate) => candidate !== codexHome)
    )
  ]
  let source: string | null = null
  let sourceHome: string | null = null
  let rejectedNonTaskWraith = false
  for (const legacyHome of legacyHomes) {
    const candidate =
      (await findRolloutByThreadId(join(legacyHome, 'sessions'), input.threadId)) ||
      (await findRolloutByThreadId(join(legacyHome, 'archived_sessions'), input.threadId))
    if (!candidate) continue
    if (!(await isTaskWraithRollout(candidate, input.threadId))) {
      rejectedNonTaskWraith = true
      continue
    }
    source = candidate
    sourceHome = legacyHome
    break
  }
  if (!source || !sourceHome) return rejectedNonTaskWraith ? 'not-taskwraith' : 'not-found'

  const destination = migratedDestination(codexHome, sourceHome, source)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (existing) {
    // The pre-atomic implementation could expose a partial destination if a
    // copy crashed. Re-check immediately before removing that exact derived
    // destination; never delete an unexpected matching rollout elsewhere.
    if (existing !== destination) {
      throw new CodexHomeContinuityError(
        `TaskWraith's private Codex home contains an invalid duplicate rollout for ${input.threadId}.`
      )
    }
    if (await isTaskWraithRollout(existing, input.threadId)) return 'already-present'
    await unlink(existing)
  }

  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.taskwraith-${process.pid}-${randomUUID()}.tmp`
  )
  try {
    // Publish only after the complete private copy is durable at a distinct
    // path. A hard-link install is atomic and refuses to replace a winner from
    // a concurrent migration.
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL)
    await chmod(temporary, 0o600)
    try {
      await link(temporary, destination)
      return 'migrated'
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      if (await isTaskWraithRollout(destination, input.threadId)) return 'already-present'
      throw new CodexHomeContinuityError(
        `TaskWraith's private Codex rollout for ${input.threadId} was not installed completely.`
      )
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
