import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { safeRunEventFileName } from '../RunEventStore'
import type { HydratedToolActivityDetail, ToolActivity, ToolActivityDetailRef } from './types'
import { flushToolDetailDependencies } from './ToolActivityDetailDurability'
import type {
  ToolActivityDetailDurability,
  ToolDetailDependency
} from './ToolActivityDetailDurability'

export const TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME = 'tool-activity-details.jsonl'
export const MAX_TOOL_ACTIVITY_DETAIL_BYTES = 32 * 1024 * 1024

interface ToolActivityDetailRecord {
  schemaVersion: 1
  runId: string
  activityId: string
  activity: ToolActivity
}

interface PendingRunBatch {
  runId: string
  filePath: string
  relativePath: string
  initialSize: number
  byteLength: number
  chunks: Buffer[]
  activityCount: number
}

export interface ToolActivityDetailCheckpoint {
  runId: string
  relativePath: string
  offset: number
  byteLength: number
  sha256: string
  activityCount: number
}

/** One run's segment as a commit's bytes-only half wrote it, and the file it went into. */
export interface ToolActivityDetailSegment {
  checkpoint: ToolActivityDetailCheckpoint
  filePath: string
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The size of a file, and 0 for one that is not there. */
function sizeOf(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return 0
  }
}

function checkpointOf(batch: PendingRunBatch, segment: Buffer): ToolActivityDetailCheckpoint {
  return {
    runId: batch.runId,
    relativePath: batch.relativePath,
    offset: batch.initialSize,
    byteLength: segment.byteLength,
    sha256: sha256(segment),
    activityCount: batch.activityCount
  }
}

function runArtifactDirectoryName(runId: string): string {
  return safeRunEventFileName(runId).replace(/\.jsonl$/, '')
}

function detailArtifactPaths(
  runArtifactsDir: string,
  runId: string
): { filePath: string; relativePath: string } {
  const directory = runArtifactDirectoryName(runId)
  return {
    filePath: path.join(runArtifactsDir, directory, TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME),
    relativePath: `${directory}/${TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME}`
  }
}

function activityWithoutDetailRef(activity: ToolActivity): ToolActivity {
  const { detailRef: _detailRef, ...detail } = activity
  return detail
}

function serializeDetail(runId: string, activity: ToolActivity): Buffer | null {
  try {
    const record: ToolActivityDetailRecord = {
      schemaVersion: 1,
      runId,
      activityId: activity.id,
      activity: activityWithoutDetailRef(activity)
    }
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    return bytes.byteLength <= MAX_TOOL_ACTIVITY_DETAIL_BYTES ? bytes : null
  } catch {
    return null
  }
}

/**
 * The sha256 a ref staged for this activity now would carry, or null for an
 * activity that cannot be staged at all: whether a ref staged earlier still
 * names exactly these bytes.
 */
export function toolActivityDetailSha256(runId: string, activity: ToolActivity): string | null {
  const bytes = serializeDetail(runId, activity)
  return bytes ? sha256(bytes) : null
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, 'r')
    fs.fsyncSync(fd)
  } catch {
    // The data file itself is fsync'd. Some platforms do not allow directory
    // handles; durability degrades to their normal create guarantees.
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** One-save append coordinator: stage refs first, fsync each run once. */
export class ToolActivityDetailBatchWriter {
  private readonly batches = new Map<string, PendingRunBatch>()
  private readonly pendingDependencies: ToolDetailDependency[] = []

  constructor(
    private readonly runArtifactsDir: string,
    private readonly deferred?: {
      owner: ToolActivityDetailDurability
      onDependency(dependency: ToolDetailDependency): void
    }
  ) {}

  dependencies(): readonly ToolDetailDependency[] {
    return [...this.pendingDependencies]
  }

  stage(runId: string, activity: ToolActivity): ToolActivityDetailRef | null {
    if (!runId || !activity?.id) return null
    const bytes = serializeDetail(runId, activity)
    if (!bytes) return null
    let batch = this.batches.get(runId)
    if (!batch) {
      const paths = detailArtifactPaths(this.runArtifactsDir, runId)
      batch = {
        runId,
        ...paths,
        initialSize: sizeOf(paths.filePath),
        byteLength: 0,
        chunks: [],
        activityCount: 0
      }
      this.batches.set(runId, batch)
    }
    const ref: ToolActivityDetailRef = {
      schemaVersion: 1,
      storage: 'run_event_artifact',
      runId,
      activityId: activity.id,
      offset: batch.initialSize + batch.byteLength,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes)
    }
    batch.chunks.push(bytes)
    batch.byteLength += bytes.byteLength
    batch.activityCount += 1
    return ref
  }

  commit(): ToolActivityDetailCheckpoint[] {
    const checkpoints: ToolActivityDetailCheckpoint[] = []
    for (const batch of this.batches.values()) {
      if (batch.chunks.length === 0) continue
      if (!this.deferred) fs.mkdirSync(path.dirname(batch.filePath), { recursive: true })
      const currentSize = sizeOf(batch.filePath)
      if (currentSize !== batch.initialSize) {
        throw new Error(`Tool detail artifact changed while staging run ${batch.runId}`)
      }
      const segment = Buffer.concat(batch.chunks)
      if (this.deferred) {
        const dependency = this.deferred.owner.append(batch.filePath, segment, batch.initialSize)
        this.pendingDependencies.push(dependency)
        try {
          this.deferred.onDependency(dependency)
        } catch (error) {
          try {
            flushToolDetailDependencies(this.pendingDependencies)
          } catch (debt) {
            throw new AggregateError(
              [error, debt],
              'Detail callback failed with pending durability'
            )
          }
          throw error
        }
      } else {
        const fileExisted = currentSize > 0
        const fd = fs.openSync(batch.filePath, 'a')
        try {
          fs.writeFileSync(fd, segment)
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        if (!fileExisted) fsyncDirectory(path.dirname(batch.filePath))
      }
      checkpoints.push(checkpointOf(batch, segment))
    }
    return checkpoints
  }

  /**
   * The bytes-only half of a commit: write each run's segment, sync nothing,
   * note nothing and leave any deferred owner out of it. Whoever calls it
   * makes the bytes durable, with every name on the path to them, before
   * anything references them.
   */
  writeUnsynced(): ToolActivityDetailSegment[] {
    const segments: ToolActivityDetailSegment[] = []
    for (const batch of this.batches.values()) {
      if (batch.chunks.length === 0) continue
      fs.mkdirSync(path.dirname(batch.filePath), { recursive: true })
      if (sizeOf(batch.filePath) !== batch.initialSize) {
        throw new Error(`Tool detail artifact changed while staging run ${batch.runId}`)
      }
      const segment = Buffer.concat(batch.chunks)
      const fd = fs.openSync(batch.filePath, 'a')
      try {
        fs.writeFileSync(fd, segment)
      } finally {
        fs.closeSync(fd)
      }
      segments.push({ checkpoint: checkpointOf(batch, segment), filePath: batch.filePath })
    }
    return segments
  }
}

function validRef(ref: ToolActivityDetailRef): boolean {
  return Boolean(
    ref &&
    ref.schemaVersion === 1 &&
    ref.storage === 'run_event_artifact' &&
    ref.runId &&
    ref.activityId &&
    Number.isSafeInteger(ref.offset) &&
    ref.offset >= 0 &&
    Number.isSafeInteger(ref.byteLength) &&
    ref.byteLength > 0 &&
    ref.byteLength <= MAX_TOOL_ACTIVITY_DETAIL_BYTES &&
    /^[a-f0-9]{64}$/.test(ref.sha256)
  )
}

function parseDetail(bytes: Buffer, ref: ToolActivityDetailRef): ToolActivity | null {
  if (sha256(bytes) !== ref.sha256) return null
  try {
    const record = JSON.parse(bytes.toString('utf8').trim()) as ToolActivityDetailRecord
    if (
      record?.schemaVersion !== 1 ||
      record.runId !== ref.runId ||
      record.activityId !== ref.activityId ||
      record.activity?.id !== ref.activityId
    ) {
      return null
    }
    return activityWithoutDetailRef(record.activity)
  } catch {
    return null
  }
}

/**
 * Synchronous single-ref read for the save path. The terminal fold of a
 * live-externalized activity must decide inside `saveChat` whether the archive
 * already covers the inline fields it is about to strip; a durable answer
 * cannot wait on the event loop. One bounded `readSync` at a verified offset —
 * never a whole-file read.
 */
export function readToolActivityDetailSync(
  runArtifactsDir: string,
  ref: ToolActivityDetailRef
): ToolActivity | null {
  if (!validRef(ref)) return null
  const { filePath } = detailArtifactPaths(runArtifactsDir, ref.runId)
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const bytes = Buffer.allocUnsafe(ref.byteLength)
    const bytesRead = fs.readSync(fd, bytes, 0, ref.byteLength, ref.offset)
    if (bytesRead !== ref.byteLength) return null
    return parseDetail(bytes, ref)
  } catch {
    return null
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** Read only the authenticated ranges requested by visible/expanded rows. */
export async function hydrateToolActivityDetails(
  runArtifactsDir: string,
  refs: readonly ToolActivityDetailRef[]
): Promise<HydratedToolActivityDetail[]> {
  const uniqueRefs = new Map<string, ToolActivityDetailRef>()
  for (const ref of refs) {
    if (validRef(ref)) uniqueRefs.set(`${ref.runId}\0${ref.activityId}`, ref)
  }
  const byRun = new Map<string, ToolActivityDetailRef[]>()
  for (const ref of uniqueRefs.values()) {
    const entries = byRun.get(ref.runId) || []
    entries.push(ref)
    byRun.set(ref.runId, entries)
  }

  const hydrated: HydratedToolActivityDetail[] = []
  for (const [runId, runRefs] of byRun) {
    const { filePath } = detailArtifactPaths(runArtifactsDir, runId)
    let handle: fs.promises.FileHandle | null = null
    try {
      handle = await fs.promises.open(filePath, 'r')
      for (const ref of runRefs) {
        const bytes = Buffer.allocUnsafe(ref.byteLength)
        const result = await handle.read(bytes, 0, ref.byteLength, ref.offset)
        if (result.bytesRead !== ref.byteLength) continue
        const activity = parseDetail(bytes, ref)
        if (activity) hydrated.push({ ref, activity })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      await handle?.close()
    }
  }
  return hydrated
}
