import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { safeRunEventFileName } from '../RunEventStore'
import type { ToolActivity, ToolActivityDetailRef } from './types'

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

export interface HydratedToolActivityDetail {
  ref: ToolActivityDetailRef
  activity: ToolActivity
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
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

  constructor(private readonly runArtifactsDir: string) {}

  stage(runId: string, activity: ToolActivity): ToolActivityDetailRef | null {
    if (!runId || !activity?.id) return null
    const bytes = serializeDetail(runId, activity)
    if (!bytes) return null
    let batch = this.batches.get(runId)
    if (!batch) {
      const paths = detailArtifactPaths(this.runArtifactsDir, runId)
      let initialSize = 0
      try {
        initialSize = fs.statSync(paths.filePath).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      batch = {
        runId,
        ...paths,
        initialSize,
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
      fs.mkdirSync(path.dirname(batch.filePath), { recursive: true })
      let currentSize = 0
      try {
        currentSize = fs.statSync(batch.filePath).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (currentSize !== batch.initialSize) {
        throw new Error(`Tool detail artifact changed while staging run ${batch.runId}`)
      }
      const segment = Buffer.concat(batch.chunks)
      const fileExisted = currentSize > 0
      const fd = fs.openSync(batch.filePath, 'a')
      try {
        fs.writeFileSync(fd, segment)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (!fileExisted) fsyncDirectory(path.dirname(batch.filePath))
      checkpoints.push({
        runId: batch.runId,
        relativePath: batch.relativePath,
        offset: batch.initialSize,
        byteLength: segment.byteLength,
        sha256: sha256(segment),
        activityCount: batch.activityCount
      })
    }
    return checkpoints
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
