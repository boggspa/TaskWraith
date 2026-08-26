import * as fs from 'node:fs'
import { createRunEventReplay } from './RunEventStore'
import type { RunEventRecord, RunEventReplay } from './store/types'

/** mtime+size-validated replay cache keyed by runId.
 *
 * Mirrors the {@link AppStore.workspaceChangeCache} precedent: repeated reads
 * of the same run-event file skip re-read and re-parse when the file has not
 * changed on disk. The cache is shared between the sync MCP path and the async
 * renderer IPC path so both benefit from prior loads.
 */
interface RunEventReplayCacheEntry {
  mtimeMs: number
  size: number
  replay: RunEventReplay
}

const replayCache = new Map<string, RunEventReplayCacheEntry>()

export function clearRunEventReplayCache(): void {
  replayCache.clear()
}

export function deleteRunEventReplayCacheEntry(runId: string): void {
  replayCache.delete(runId)
}

function replayForEmptyRun(runId: string): RunEventReplay {
  return createRunEventReplay(runId, [])
}

function isCacheHit(entry: RunEventReplayCacheEntry, stat: fs.Stats): boolean {
  return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size
}

/** Async cached replay loader for the renderer IPC hot path.
 *
 * Uses the caller-supplied async reader (the existing {@link readRunEventFileAsync})
 * so this module does not duplicate parsing or prefilter logic, and so the
 * main process yields the event loop while reading the file. All errors are
 * swallowed and return an empty replay, preserving the previous sync handler's
 * IPC reply shape exactly.
 */
export async function getRunEventReplayAsync(
  runId: string,
  filePath: string,
  readAsync: (filePath: string) => Promise<RunEventRecord[]>
): Promise<RunEventReplay> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch (e) {
    replayCache.delete(runId)
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`Failed to stat run-event replay for ${runId}`, e)
    }
    return replayForEmptyRun(runId)
  }

  const cached = replayCache.get(runId)
  if (cached && isCacheHit(cached, stat)) {
    return cached.replay
  }

  try {
    const events = await readAsync(filePath)
    const replay = createRunEventReplay(runId, events)
    replayCache.set(runId, { mtimeMs: stat.mtimeMs, size: stat.size, replay })
    return replay
  } catch (e) {
    replayCache.delete(runId)
    console.error(`Failed to read run-event replay for ${runId}`, e)
    return replayForEmptyRun(runId)
  }
}

/** Sync cached replay loader kept for the MCP tool path.
 *
 * The sync read is still cached so repeated MCP inspections of the same run
 * avoid redundant disk work, but the renderer's polling loop uses the async
 * variant above.
 */
export function getRunEventReplaySync(
  runId: string,
  filePath: string,
  readSync: (filePath: string) => RunEventRecord[]
): RunEventReplay {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch (e) {
    replayCache.delete(runId)
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`Failed to stat run-event replay for ${runId}`, e)
    }
    return replayForEmptyRun(runId)
  }

  const cached = replayCache.get(runId)
  if (cached && isCacheHit(cached, stat)) {
    return cached.replay
  }

  try {
    const events = readSync(filePath)
    const replay = createRunEventReplay(runId, events)
    replayCache.set(runId, { mtimeMs: stat.mtimeMs, size: stat.size, replay })
    return replay
  } catch (e) {
    replayCache.delete(runId)
    console.error(`Failed to read run-event replay for ${runId}`, e)
    return replayForEmptyRun(runId)
  }
}
