import * as fs from 'node:fs'
import * as path from 'node:path'

/** Same-process custody also protects a second journal instance's startup sweep. */
export const activePreparedCheckpointPaths = new Set<string>()
const PREPARED_NAME = /^\.([A-Za-z0-9_-]{1,256})\.checkpoint-prepared-(\d+)-[a-f0-9-]+\.tmp$/

export function removePreparedCheckpointFiles(
  baseDir: string,
  chatId?: string,
  orphanedOnly = false
): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(baseDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of entries) {
    const match = PREPARED_NAME.exec(name)
    if (!match || (chatId !== undefined && match[1] !== chatId)) continue
    const filePath = path.join(baseDir, name)
    if (orphanedOnly) {
      if (activePreparedCheckpointPaths.has(filePath)) continue
      const pid = Number(match[2])
      if (pid !== process.pid) {
        try {
          process.kill(pid, 0)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      }
    }
    fs.rmSync(filePath, { force: true })
  }
}

/** A freshness witness, not a retained historical snapshot. */
export interface CheckpointFileIdentity {
  dev: string
  ino: string
  size: number
  mtimeNs: string
  ctimeNs: string
}

export interface CheckpointFileReference {
  path: string
  identity: CheckpointFileIdentity
}

export function checkpointFileIdentity(stat: fs.BigIntStats): CheckpointFileIdentity {
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Checkpoint preparation requires a regular, bounded file')
  }
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  }
}

export function checkpointFileReference(filePath: string): CheckpointFileReference {
  return {
    path: filePath,
    identity: checkpointFileIdentity(fs.lstatSync(filePath, { bigint: true }))
  }
}

export function sameCheckpointFile(a: CheckpointFileIdentity, b: CheckpointFileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

export function checkpointReferenceIsCurrent(reference: CheckpointFileReference): boolean {
  try {
    return sameCheckpointFile(reference.identity, checkpointFileReference(reference.path).identity)
  } catch {
    return false
  }
}

export interface CheckpointPreparationSource {
  chatId: string
  revision: number
  savedAt: string
  checkpoint: CheckpointFileReference
  journal: CheckpointFileReference
}

export interface CheckpointPreparationRequest extends CheckpointPreparationSource {
  output: CheckpointFileReference
  maxOutputBytes: number
}

export interface PreparedCheckpoint {
  chatId: string
  revision: number
  sha256: string
  identity: CheckpointFileIdentity
}

export type CheckpointPreparationReply =
  | { ok: true; prepared: PreparedCheckpoint }
  | { ok: false; error: string }

export interface CheckpointPreparationJob {
  readonly output: CheckpointFileReference
  readonly result: Promise<PreparedCheckpoint>
  /** Fence immediately; no worker is permitted to recreate the unlinked output. */
  cancel(): void
  /** Release custody after adoption/discard; credit stays held until process exit. */
  release(): void
}

export interface CheckpointPreparationPort {
  /** No waiting payload queue. null means capacity is unavailable; keep the journal. */
  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null
}

export type DeferredCheckpointResult = 'checkpointed' | 'unchanged' | 'superseded' | 'unavailable'
