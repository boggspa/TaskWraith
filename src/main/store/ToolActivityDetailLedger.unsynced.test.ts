/**
 * Tool detail written without a sync. The staging writes a save's segments
 * with the bytes-only half of a commit, and syncs them, every folder on the
 * path to them and their checkpoint off the save, before any record
 * references them. The first half pins what it writes; the second runs it
 * over a model of a power loss. Beside each, a writer that syncs, as the
 * store has it with barrier durability off.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunEventLedgerWriter } from './RunEventLedgerWriter'
import type { ThreadDurabilityPort } from './ThreadDurabilityDebt'
import {
  TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME,
  ToolActivityDetailBatchWriter,
  hydrateToolActivityDetails,
  readToolActivityDetailSync,
  type ToolActivityDetailCheckpoint
} from './ToolActivityDetailLedger'
import {
  createToolActivityDetailStaging,
  type ToolActivityDetailStaging
} from './ToolActivityDetailStaging'
import type { ChatRecord, RunEventInput, ToolActivity, ToolActivityDetailRef } from './types'
import {
  countSyncs,
  watchCrashDisk,
  type CrashDisk,
  type SyncCount
} from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-tool-detail-unsynced-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

const CHAT = 'chat-1'

function activity(id: string, output = `output of ${id}`): ToolActivity {
  return {
    id,
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    parameters: { command: `printf ${id}` },
    resultSummary: output,
    rawResultEvent: { output }
  }
}

const CHAT_RECORD = {
  appChatId: CHAT,
  title: 'Tool detail',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  runs: []
} as unknown as ChatRecord

/** A segment's checkpoint run event, as the store would append it. */
function checkpointInput(
  chat: ChatRecord,
  checkpoint: ToolActivityDetailCheckpoint
): RunEventInput {
  return {
    runId: checkpoint.runId,
    chatId: chat.appChatId,
    kind: 'tool',
    phase: 'artifact',
    source: 'main',
    payload: {
      type: 'tool_activity_detail_checkpoint',
      offset: checkpoint.offset,
      byteLength: checkpoint.byteLength,
      sha256: checkpoint.sha256
    }
  }
}

/** A staging writing under `root`, its checkpoints in a ledger writer of its own. */
function stagingIn(root: string, port: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'>) {
  const runArtifactsDir = path.join(root, 'run-artifacts')
  const events = new RunEventLedgerWriter({
    runEventsDir: path.join(root, 'run-events'),
    runArtifactsDir
  })
  return createToolActivityDetailStaging({
    runArtifactsDir,
    port,
    appendRunEvent: (input) => events.appendStaged(input),
    checkpointInput
  })
}

/** Until the staging has no batch outstanding. */
const settled = (staging: ToolActivityDetailStaging): Promise<void> =>
  vi.waitFor(() => expect(staging.snapshot().outstanding).toBe(0))

/** One save: each activity staged for its run, then the commit. Returns what `stage` gave. */
function save(
  staging: ToolActivityDetailStaging,
  staged: Array<[string, ToolActivity]>
): Array<ToolActivityDetailRef | null> {
  const batch = staging.batch(CHAT_RECORD)
  const refs = staged.map(([run, detail]) => batch.stage(run, detail))
  batch.commit()
  return refs
}

/** Stage each activity in a save of its own, wait for its batch, and take its ref at the next. */
async function durably(
  staging: ToolActivityDetailStaging,
  staged: Array<[string, ToolActivity]>
): Promise<ToolActivityDetailRef[]> {
  expect(save(staging, staged)).toEqual(staged.map(() => null))
  await settled(staging)
  const refs = save(staging, staged)
  expect(refs).not.toContain(null)
  return refs as ToolActivityDetailRef[]
}

/** A port that makes every path safe at once. */
const instant: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'> = {
  syncFile: async () => 'synced',
  syncDirectory: async () => 'synced'
}

describe('tool detail the staging writes without a sync', () => {
  let root: string
  let runArtifactsDir: string
  let syncs: SyncCount

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    runArtifactsDir = path.join(root, 'run-artifacts')
    syncs = countSyncs()
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    removeTemporaryDirectory(root)
  })

  const folder = (run: string): string => path.join(runArtifactsDir, run)
  const file = (run: string): string => path.join(folder(run), TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME)
  /** One save's worth for a writer: stage each activity for its run, then commit. */
  const commit = (
    writer: ToolActivityDetailBatchWriter,
    staged: Array<[string, ToolActivity]>
  ): ToolActivityDetailRef[] => {
    const refs = staged.map(([run, detail]) => writer.stage(run, detail)!)
    writer.commit()
    return refs
  }

  it('writes a long run of segments, new files among them, without one sync on the calling thread', async () => {
    const staging = stagingIn(root, instant)
    const written: Array<{ ref: ToolActivityDetailRef; activity: ToolActivity }> = []
    for (let index = 0; index < 60; index += 1) {
      const detail = activity(`tool-${index}`)
      const [ref] = await durably(staging, [[`run-${index % 3}`, detail]])
      written.push({ ref, activity: detail })
    }

    expect(syncs.issued).toEqual([])
    for (const { ref, activity: detail } of written) {
      expect(readToolActivityDetailSync(runArtifactsDir, ref)).toEqual(detail)
    }
    await expect(
      hydrateToolActivityDetails(
        runArtifactsDir,
        written.map(({ ref }) => ref)
      )
    ).resolves.toHaveLength(60)
  })

  it('a writer that syncs issues one for each segment, and one more for each new file', () => {
    for (let index = 0; index < 6; index += 1) {
      commit(new ToolActivityDetailBatchWriter(runArtifactsDir), [
        [`run-${index % 3}`, activity(`tool-${index}`)]
      ])
    }

    expect(syncs.issued).toHaveLength(6 + 3)
  })

  it('writes the same bytes, and hands back the same refs and checkpoints, as a writer that syncs', () => {
    const elsewhere = path.join(root, 'synced', 'run-artifacts')
    const staged: Array<[string, ToolActivity]> = [
      ['run-1', activity('tool-1')],
      ['run-2', activity('tool-2')],
      ['run-1', activity('tool-3')]
    ]
    const synced = (): unknown[] => {
      const writer = new ToolActivityDetailBatchWriter(elsewhere)
      const refs = staged.map(([run, detail]) => writer.stage(run, detail))
      return [refs, writer.commit()]
    }
    const unsynced = (): unknown[] => {
      const writer = new ToolActivityDetailBatchWriter(runArtifactsDir)
      const refs = staged.map(([run, detail]) => writer.stage(run, detail))
      return [refs, writer.writeUnsynced().map(({ checkpoint }) => checkpoint)]
    }

    const first = [synced(), synced()]
    syncs.issued.length = 0
    const second = [unsynced(), unsynced()]

    expect(second).toEqual(first)
    expect(syncs.issued).toEqual([])
    for (const run of ['run-1', 'run-2']) {
      expect(fs.readFileSync(file(run))).toEqual(
        fs.readFileSync(path.join(elsewhere, run, TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME))
      )
    }
  })

  it('fails a commit whose write fails, closes the file, and syncs nothing for it', async () => {
    const asked: string[] = []
    const staging = stagingIn(root, {
      syncFile: async (target) => (asked.push(target), 'synced'),
      syncDirectory: async (target) => (asked.push(target), 'synced')
    })
    await durably(staging, [['run-1', activity('tool-1')]])
    asked.length = 0
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, write')
    })
    const batch = staging.batch(CHAT_RECORD)
    batch.stage('run-1', activity('tool-2'))

    expect(() => batch.commit()).toThrow('ENOSPC')

    expect(close).toHaveBeenCalledOnce()
    expect(asked).toEqual([])
    expect(syncs.issued).toEqual([])
    expect(staging.snapshot().batches).toMatchObject({ durable: 1, failed: 1 })
  })

  it('still refuses a file that changed between staging and the commit', async () => {
    const staging = stagingIn(root, instant)
    await durably(staging, [['run-1', activity('tool-1')]])
    const batch = staging.batch(CHAT_RECORD)
    batch.stage('run-1', activity('tool-2'))
    fs.appendFileSync(file('run-1'), 'written by someone else')

    expect(() => batch.commit()).toThrow('Tool detail artifact changed while staging run run-1')
    expect(staging.snapshot().batches).toMatchObject({ committed: 1, failed: 1 })
  })
})

describe.skipIf(process.platform === 'win32')(
  'what a power loss leaves of tool detail that was not synced',
  () => {
    let root: string
    let runArtifactsDir: string
    let disk: CrashDisk

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      runArtifactsDir = path.join(root, 'run-artifacts')
      disk = watchCrashDisk(root)
    })

    afterEach(() => {
      disk.dispose()
      removeTemporaryDirectory(root)
    })

    /** The disk's port, holding every sync until released. */
    const held = (): {
      port: Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'>
      release(): void
    } => {
      let release = (): void => {}
      const waiting = new Promise<void>((resolve) => (release = resolve))
      return {
        port: {
          syncFile: async (target) => (await waiting, disk.port.syncFile(target)),
          syncDirectory: async (target) => (await waiting, disk.port.syncDirectory(target))
        },
        release: () => release()
      }
    }

    it('keeps every detail a batch made durable, folders and all, and loses the detail after it', async () => {
      const staging = stagingIn(root, disk.port)
      const [first, second] = await durably(staging, [
        ['run-1', activity('tool-1')],
        ['run-1', activity('tool-2')]
      ])
      const end = second.offset + second.byteLength
      // A batch the power loss cuts off before its syncs.
      const later = stagingIn(root, held().port)
      expect(save(later, [['run-1', activity('tool-3')]])).toEqual([null])

      expect(disk.issued).toEqual([])
      expect(disk.paid).toEqual([
        `file:run-artifacts/run-1/${TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME}`,
        'directory:run-artifacts/run-1',
        'directory:run-artifacts',
        'directory:.',
        'file:run-events/run-1.jsonl',
        'directory:.',
        'directory:run-events'
      ])
      disk.powerLoss()

      expect(readToolActivityDetailSync(runArtifactsDir, first)).toEqual(activity('tool-1'))
      expect(readToolActivityDetailSync(runArtifactsDir, second)).toEqual(activity('tool-2'))
      // The file ends where the durable batch ended: the bytes after it are gone.
      expect(
        fs.statSync(path.join(runArtifactsDir, 'run-1', TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME)).size
      ).toBe(end)
      await expect(hydrateToolActivityDetails(runArtifactsDir, [first, second])).resolves.toEqual([
        { ref: first, activity: activity('tool-1') },
        { ref: second, activity: activity('tool-2') }
      ])
      // The next write carries on from the end of what is left.
      const [next] = await durably(stagingIn(root, disk.port), [['run-1', activity('tool-4')]])
      expect(next.offset).toBe(end)
    })

    it('a writer that syncs keeps a detail committed into a folder that was already safe', () => {
      fs.mkdirSync(path.join(runArtifactsDir, 'run-1'), { recursive: true })
      disk.flushedAnyway(root)
      disk.flushedAnyway(runArtifactsDir)
      const writer = new ToolActivityDetailBatchWriter(runArtifactsDir)
      const ref = writer.stage('run-1', activity('tool-1'))!
      writer.commit()

      disk.powerLoss()

      expect(readToolActivityDetailSync(runArtifactsDir, ref)).toEqual(activity('tool-1'))
    })

    it('keeps a second run beside the first only once a batch has synced its folder', async () => {
      const [first] = await durably(stagingIn(root, disk.port), [['run-1', activity('tool-1')]])
      expect(save(stagingIn(root, held().port), [['run-2', activity('tool-2')]])).toEqual([null])

      disk.powerLoss()
      expect(readToolActivityDetailSync(runArtifactsDir, first)).toEqual(activity('tool-1'))
      expect(fs.existsSync(path.join(runArtifactsDir, 'run-2'))).toBe(false)

      const [kept] = await durably(stagingIn(root, disk.port), [['run-2', activity('tool-2')]])
      disk.powerLoss()
      expect(readToolActivityDetailSync(runArtifactsDir, kept)).toEqual(activity('tool-2'))
    })
  }
)
