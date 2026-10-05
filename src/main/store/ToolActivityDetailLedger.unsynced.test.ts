/**
 * A tool-detail writer told to leave syncing to the thread's barrier. A commit
 * then only writes each run's segment, and says what the disk is owed for it
 * and for which run. The second half runs it over a model of a power loss.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolActivityDetailDurability } from './ToolActivityDetailDurability'
import {
  TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME,
  ToolActivityDetailBatchWriter,
  hydrateToolActivityDetails,
  readToolActivityDetailSync
} from './ToolActivityDetailLedger'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtNote
} from './ThreadDurabilityDebt'
import type { ToolActivity, ToolActivityDetailRef } from './types'
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

describe('a tool-detail writer that leaves syncing to the thread barrier', () => {
  let root: string
  let runArtifactsDir: string
  let syncs: SyncCount
  let notes: Array<[string, ThreadDurabilityDebtNote]>
  const note: NoteThreadDurabilityDebt = (chatId, debt) => {
    notes.push([chatId, debt])
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    runArtifactsDir = path.join(root, 'run-artifacts')
    syncs = countSyncs()
    notes = []
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    removeTemporaryDirectory(root)
  })

  const unsynced = (directory = runArtifactsDir): ToolActivityDetailBatchWriter =>
    new ToolActivityDetailBatchWriter(directory, undefined, { chatId: CHAT, note })
  const folder = (run: string): string => path.join(runArtifactsDir, run)
  const file = (run: string): string => path.join(folder(run), TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME)
  const owedFile = (run: string): [string, ThreadDurabilityDebtNote] => [
    CHAT,
    { file: file(run), owner: 'detail', run }
  ]
  const owedDirectory = (directory: string, run: string): [string, ThreadDurabilityDebtNote] => [
    CHAT,
    { directory, run }
  ]
  /** One save's worth: stage each activity for its run, then commit. */
  const save = (
    writer: ToolActivityDetailBatchWriter,
    staged: Array<[string, ToolActivity]>
  ): ToolActivityDetailRef[] => {
    const refs = staged.map(([run, detail]) => writer.stage(run, detail)!)
    writer.commit()
    return refs
  }

  it('commits a long run of segments, new files among them, without one sync', async () => {
    const written: Array<{ ref: ToolActivityDetailRef; activity: ToolActivity }> = []
    for (let index = 0; index < 60; index += 1) {
      const detail = activity(`tool-${index}`)
      const [ref] = save(unsynced(), [[`run-${index % 3}`, detail]])
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
      save(new ToolActivityDetailBatchWriter(runArtifactsDir), [
        [`run-${index % 3}`, activity(`tool-${index}`)]
      ])
    }

    expect(syncs.issued).toHaveLength(6 + 3)
    expect(notes).toEqual([])
  })

  it('notes the file of the run for every segment, and each directory in which the segment made a name', () => {
    save(unsynced(), [['run-1', activity('tool-1')]])
    expect(notes).toEqual([
      owedDirectory(root, 'run-1'),
      owedDirectory(runArtifactsDir, 'run-1'),
      owedFile('run-1'),
      owedDirectory(folder('run-1'), 'run-1')
    ])

    notes.length = 0
    save(unsynced(), [['run-1', activity('tool-2')]])
    expect(notes).toEqual([owedFile('run-1')])

    // A second run adds a folder to the directory the first one made.
    notes.length = 0
    save(unsynced(), [['run-2', activity('tool-3')]])
    expect(notes).toEqual([
      owedDirectory(runArtifactsDir, 'run-2'),
      owedFile('run-2'),
      owedDirectory(folder('run-2'), 'run-2')
    ])
    expect(syncs.issued).toEqual([])
  })

  it('owes only the file and its folder when the folder was there already', () => {
    fs.mkdirSync(folder('run-1'), { recursive: true })

    save(unsynced(), [['run-1', activity('tool-1')]])

    expect(notes).toEqual([owedFile('run-1'), owedDirectory(folder('run-1'), 'run-1')])
  })

  it('notes each run of one save against that run', () => {
    fs.mkdirSync(runArtifactsDir, { recursive: true })

    save(unsynced(), [
      ['run-1', activity('tool-1')],
      ['run-2', activity('tool-2')],
      ['run-1', activity('tool-3')]
    ])

    expect(notes).toEqual([
      owedDirectory(runArtifactsDir, 'run-1'),
      owedFile('run-1'),
      owedDirectory(folder('run-1'), 'run-1'),
      owedDirectory(runArtifactsDir, 'run-2'),
      owedFile('run-2'),
      owedDirectory(folder('run-2'), 'run-2')
    ])
  })

  it('writes the same bytes, and hands back the same refs and checkpoints, as a writer that syncs', () => {
    const elsewhere = path.join(root, 'synced', 'run-artifacts')
    const staged: Array<[string, ToolActivity]> = [
      ['run-1', activity('tool-1')],
      ['run-2', activity('tool-2')],
      ['run-1', activity('tool-3')]
    ]
    const commit = (writer: ToolActivityDetailBatchWriter): unknown[] => {
      const refs = staged.map(([run, detail]) => writer.stage(run, detail))
      return [refs, writer.commit()]
    }

    const first = [
      commit(new ToolActivityDetailBatchWriter(elsewhere)),
      commit(new ToolActivityDetailBatchWriter(elsewhere))
    ]
    const second = [commit(unsynced()), commit(unsynced())]

    expect(second).toEqual(first)
    for (const run of ['run-1', 'run-2']) {
      expect(fs.readFileSync(file(run))).toEqual(
        fs.readFileSync(path.join(elsewhere, run, TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME))
      )
    }
  })

  it('fails a commit whose write fails, closes the file and owes nothing for the segment', () => {
    save(unsynced(), [['run-1', activity('tool-1')]])
    notes.length = 0
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, write')
    })
    const writer = unsynced()
    writer.stage('run-1', activity('tool-2'))

    expect(() => writer.commit()).toThrow('ENOSPC')

    expect(close).toHaveBeenCalledOnce()
    expect(notes).toEqual([])
    expect(syncs.issued).toEqual([])
  })

  it('still refuses a file that changed between staging and the commit', () => {
    save(unsynced(), [['run-1', activity('tool-1')]])
    const writer = unsynced()
    writer.stage('run-1', activity('tool-2'))
    fs.appendFileSync(file('run-1'), 'written by someone else')
    notes.length = 0

    expect(() => writer.commit()).toThrow('Tool detail artifact changed while staging run run-1')
    expect(notes).toEqual([])
  })

  it('leaves the deferred owner out of it when it is given one as well', () => {
    const owner = { append: vi.fn() } as unknown as ToolActivityDetailDurability
    const onDependency = vi.fn()
    const writer = new ToolActivityDetailBatchWriter(
      runArtifactsDir,
      { owner, onDependency },
      { chatId: CHAT, note }
    )

    const [ref] = save(writer, [['run-1', activity('tool-1')]])

    expect(owner.append).not.toHaveBeenCalled()
    expect(onDependency).not.toHaveBeenCalled()
    expect(writer.dependencies()).toEqual([])
    expect(syncs.issued).toEqual([])
    expect(notes).toContainEqual(owedFile('run-1'))
    expect(readToolActivityDetailSync(runArtifactsDir, ref)).toEqual(activity('tool-1'))
  })
})

describe.skipIf(process.platform === 'win32')(
  'what a power loss leaves of tool detail that was not synced',
  () => {
    let root: string
    let runArtifactsDir: string
    let disk: CrashDisk
    let debt: ThreadDurabilityDebt

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      runArtifactsDir = path.join(root, 'run-artifacts')
      disk = watchCrashDisk(root)
      debt = createThreadDurabilityDebt({ port: disk.port })
    })

    afterEach(() => {
      disk.dispose()
      removeTemporaryDirectory(root)
    })

    const commit = (
      run: string,
      detail: ToolActivity,
      owed: boolean | 'synced' = true
    ): ToolActivityDetailRef => {
      const writer =
        owed === 'synced'
          ? new ToolActivityDetailBatchWriter(runArtifactsDir)
          : new ToolActivityDetailBatchWriter(runArtifactsDir, undefined, {
              chatId: CHAT,
              note: debt.note
            })
      const ref = writer.stage(run, detail)!
      writer.commit()
      return ref
    }

    it('keeps every detail a barrier covered, folders and all, and loses the detail after it', async () => {
      const first = commit('run-1', activity('tool-1'))
      const second = commit('run-1', activity('tool-2'))
      await debt.barrier(CHAT)
      const third = commit('run-1', activity('tool-3'))

      expect(disk.issued).toEqual([])
      expect(disk.paid).toEqual([
        `file:run-artifacts/run-1/${TOOL_ACTIVITY_DETAIL_ARTIFACT_NAME}`,
        'directory:.',
        'directory:run-artifacts',
        'directory:run-artifacts/run-1'
      ])
      disk.powerLoss()

      expect(readToolActivityDetailSync(runArtifactsDir, first)).toEqual(activity('tool-1'))
      expect(readToolActivityDetailSync(runArtifactsDir, second)).toEqual(activity('tool-2'))
      // The file ends before this one: it is unavailable, and nothing else is.
      expect(readToolActivityDetailSync(runArtifactsDir, third)).toBeNull()
      await expect(
        hydrateToolActivityDetails(runArtifactsDir, [first, second, third])
      ).resolves.toEqual([
        { ref: first, activity: activity('tool-1') },
        { ref: second, activity: activity('tool-2') }
      ])
      // The next commit carries on from the end of what is left.
      expect(commit('run-1', activity('tool-4')).offset).toBe(third.offset)
    })

    it('loses a file no barrier covered, even in a folder that was already safe', async () => {
      fs.mkdirSync(path.join(runArtifactsDir, 'run-1'), { recursive: true })
      disk.flushedAnyway(root)
      disk.flushedAnyway(runArtifactsDir)
      const ref = commit('run-1', activity('tool-1'))

      disk.powerLoss()

      expect(fs.existsSync(path.join(runArtifactsDir, 'run-1'))).toBe(true)
      expect(readToolActivityDetailSync(runArtifactsDir, ref)).toBeNull()
      await expect(hydrateToolActivityDetails(runArtifactsDir, [ref])).resolves.toEqual([])
    })

    it('a writer that syncs keeps a detail committed into a folder that was already safe', () => {
      fs.mkdirSync(path.join(runArtifactsDir, 'run-1'), { recursive: true })
      disk.flushedAnyway(root)
      disk.flushedAnyway(runArtifactsDir)
      const ref = commit('run-1', activity('tool-1'), 'synced')

      disk.powerLoss()

      expect(readToolActivityDetailSync(runArtifactsDir, ref)).toEqual(activity('tool-1'))
    })

    it('keeps a second run beside the first only once a barrier has covered its folder', async () => {
      const first = commit('run-1', activity('tool-1'))
      await debt.barrier(CHAT)
      const lost = commit('run-2', activity('tool-2'))

      disk.powerLoss()
      expect(readToolActivityDetailSync(runArtifactsDir, first)).toEqual(activity('tool-1'))
      expect(readToolActivityDetailSync(runArtifactsDir, lost)).toBeNull()
      expect(fs.existsSync(path.join(runArtifactsDir, 'run-2'))).toBe(false)

      const kept = commit('run-2', activity('tool-2'))
      await debt.barrier(CHAT)
      disk.powerLoss()
      expect(readToolActivityDetailSync(runArtifactsDir, kept)).toEqual(activity('tool-2'))
    })
  }
)
