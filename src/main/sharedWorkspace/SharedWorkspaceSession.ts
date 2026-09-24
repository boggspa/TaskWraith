import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Where a mutation was executed, which is NOT the same question as who asked
 * for it.
 *
 * 'broker' means TaskWraith performed the write itself, inside the brokered
 * critical section: the `before` bytes come from a pinned O_RDWR descriptor
 * with an inode/mtime re-check immediately before truncation, so they are
 * provably the bytes that were replaced.
 *
 * 'provider-native' means the provider's own tool performed the write in its
 * own process and TaskWraith observed it. The snapshot is two ordinary disk
 * reads taken around that write, with no descriptor and no fence, so a peer or
 * the user's editor can change the file in between. That degrades safely --
 * the journal re-hashes on preview and flips the row to 'changed' -- but it is
 * a genuinely weaker guarantee and whoever clicks Undo is entitled to know
 * which one they have.
 */
export type SharedWorkspaceMutationOrigin = 'broker' | 'provider-native'

export interface SharedWorkspaceActor {
  key: string
  chatId?: string
  runId: string
  provider: string
  participantId?: string
  laneId?: string
  lockOwnerId?: string
  /** Absent is read as 'broker'; only a native seat ever sets this. */
  mutationOrigin?: SharedWorkspaceMutationOrigin
}

interface OperationContext {
  actor?: SharedWorkspaceActor
  toolName?: string
  capture?: { recorded: boolean; claimed: boolean }
}

interface ReadVersion {
  sha256?: string
  version: string
}

const operationContext = new AsyncLocalStorage<OperationContext>()
const reads = new Map<string, { touchedAt: number; paths: Map<string, ReadVersion> }>()
const MAX_ACTORS = 256
const MAX_PATHS_PER_ACTOR = 256
const READ_RETENTION_MS = 2 * 60 * 60 * 1000

export function sharedWorkspaceOperationActive(): boolean {
  return operationContext.getStore() !== undefined
}

/** This context carries evidence, never permission. Main still resolves and authorizes every call. */
export function withSharedWorkspaceOperation<T>(operation: () => T): T {
  return operationContext.run({}, operation)
}

export function sharedWorkspaceToolExecutor<Args extends unknown[], Result>(
  execute: (...args: Args) => Result
): (...args: Args) => Result {
  return (...args) => withSharedWorkspaceOperation(() => execute(...args))
}

/** Called only with the host-resolved context at workspace admission, including reads. */
export function bindSharedWorkspaceActor(
  context: {
    scope: string
    appChatId?: string
    appRunId?: string
    ensembleRun?: { participantId?: string; laneId?: string }
  },
  provider: string,
  toolName: string,
  lockOwnerId?: string,
  mutationOrigin?: SharedWorkspaceMutationOrigin
): void {
  const operation = operationContext.getStore()
  if (!operation) return
  operation.actor = undefined
  operation.toolName = toolName
  if (context.scope !== 'workspace' || !context.appRunId) return
  const participantId = context.ensembleRun?.participantId
  const laneId = context.ensembleRun?.laneId
  operation.actor = {
    key: JSON.stringify([provider, context.appChatId || context.appRunId, participantId, laneId]),
    runId: context.appRunId,
    provider,
    ...(context.appChatId ? { chatId: context.appChatId } : {}),
    ...(participantId ? { participantId } : {}),
    ...(laneId ? { laneId } : {}),
    ...(lockOwnerId ? { lockOwnerId } : {}),
    ...(mutationOrigin && mutationOrigin !== 'broker' ? { mutationOrigin } : {})
  }
}

export function currentSharedWorkspaceActor(): SharedWorkspaceActor | undefined {
  return operationContext.getStore()?.actor
}

export function currentSharedWorkspaceTool(): string | undefined {
  return operationContext.getStore()?.toolName
}

export function reportSharedWorkspaceCapture(recorded: boolean, claimed: boolean): void {
  const operation = operationContext.getStore()
  if (operation?.actor) operation.capture = { recorded, claimed }
}

export function sharedWorkspaceWriteNotice(text: string): string {
  const capture = operationContext.getStore()?.capture
  if (!capture) return text
  return `${text}\n${
    capture.recorded
      ? capture.claimed
        ? 'Contribution recorded; intent claim active.'
        : 'Contribution recorded; maintain a manual intent claim for this path.'
      : 'Contribution not recorded; use a manual claim and an explicit private-index patch.'
  }`
}

export class SharedWorkspaceStaleReadError extends Error {
  readonly code = 'WORKSPACE_STALE_READ'

  constructor(readonly path: string) {
    super(
      `WORKSPACE_STALE_READ: ${JSON.stringify(path)} changed since this task read it. ` +
        'Read the current file and revise the edit before retrying; no bytes were overwritten.'
    )
    this.name = 'SharedWorkspaceStaleReadError'
  }
}

export function sharedWorkspaceFileVersion(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

export function sharedWorkspaceContentHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** A line window records the complete file's version, never a hash of only the returned window. */
export function rememberSharedWorkspaceRead(
  path: string,
  before: BigIntStats,
  after: BigIntStats,
  buffer?: Buffer
): void {
  const actor = currentSharedWorkspaceActor()
  if (!actor || currentSharedWorkspaceTool() !== 'read_file') return
  if (sharedWorkspaceFileVersion(before) !== sharedWorkspaceFileVersion(after)) {
    throw new SharedWorkspaceStaleReadError(path)
  }
  remember(actor.key, path, {
    version: sharedWorkspaceFileVersion(after),
    ...(buffer ? { sha256: sharedWorkspaceContentHash(buffer) } : {})
  })
}

/** Missing evidence remains unobserved; it never impersonates a read or narrows a provider. */
export function assertSharedWorkspaceReadCurrent(
  path: string,
  stat: BigIntStats | null,
  buffer?: Buffer
): void {
  const actor = currentSharedWorkspaceActor()
  if (!actor) return
  const entry = reads.get(actor.key)
  if (!entry || Date.now() - entry.touchedAt > READ_RETENTION_MS) return
  const expected = entry.paths.get(resolve(path))
  if (!expected) return
  if (expected.version === 'missing' && stat === null) return
  if (
    !stat ||
    (expected.sha256 && buffer
      ? expected.sha256 !== sharedWorkspaceContentHash(buffer)
      : expected.version !== sharedWorkspaceFileVersion(stat))
  ) {
    throw new SharedWorkspaceStaleReadError(path)
  }
}

export function rememberSharedWorkspaceMissing(path: string): void {
  const actor = currentSharedWorkspaceActor()
  if (actor && currentSharedWorkspaceTool() === 'read_file')
    remember(actor.key, path, { version: 'missing' })
}

export function rememberSharedWorkspaceWrite(
  path: string,
  stat: BigIntStats,
  buffer: Buffer
): void {
  const actor = currentSharedWorkspaceActor()
  if (actor) {
    remember(actor.key, path, {
      version: sharedWorkspaceFileVersion(stat),
      sha256: sharedWorkspaceContentHash(buffer)
    })
  }
}

function remember(actorKey: string, path: string, version: ReadVersion): void {
  const now = Date.now()
  const existing = reads.get(actorKey)
  const entry =
    existing && now - existing.touchedAt <= READ_RETENTION_MS
      ? existing
      : { touchedAt: now, paths: new Map<string, ReadVersion>() }
  entry.touchedAt = now
  const key = resolve(path)
  entry.paths.delete(key)
  entry.paths.set(key, version)
  while (entry.paths.size > MAX_PATHS_PER_ACTOR) {
    entry.paths.delete(entry.paths.keys().next().value!)
  }
  reads.delete(actorKey)
  reads.set(actorKey, entry)
  while (reads.size > MAX_ACTORS) reads.delete(reads.keys().next().value!)
}
