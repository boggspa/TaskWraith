import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ToolActivityDetailBatchWriter,
  hydrateToolActivityDetails,
  readToolActivityDetailSync
} from './ToolActivityDetailLedger'
import type { ToolActivity } from './types'

const tempDirs: string[] = []

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tool-detail-'))
  tempDirs.push(directory)
  return directory
}

function activity(id: string, output: string): ToolActivity {
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

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('ToolActivityDetailBatchWriter', () => {
  it('appends one fsynced run segment and hydrates exact authenticated ranges', async () => {
    const root = tempDir()
    const writer = new ToolActivityDetailBatchWriter(root)
    const first = activity('tool-1', 'first output')
    const second = activity('tool-2', 'second output')
    const firstRef = writer.stage('run-1', first)!
    const secondRef = writer.stage('run-1', second)!
    const checkpoints = writer.commit()

    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({ runId: 'run-1', activityCount: 2, offset: 0 })
    expect(secondRef.offset).toBe(firstRef.byteLength)
    await expect(hydrateToolActivityDetails(root, [secondRef, firstRef])).resolves.toEqual([
      { ref: secondRef, activity: second },
      { ref: firstRef, activity: first }
    ])
  })

  it('rejects a forged hash without exposing artifact bytes', async () => {
    const root = tempDir()
    const writer = new ToolActivityDetailBatchWriter(root)
    const detailRef = writer.stage('run-1', activity('tool-1', 'secret output'))!
    writer.commit()

    await expect(
      hydrateToolActivityDetails(root, [{ ...detailRef, sha256: '0'.repeat(64) }])
    ).resolves.toEqual([])
  })

  it('appends later checkpoints without rewriting prior bytes', async () => {
    const root = tempDir()
    const firstWriter = new ToolActivityDetailBatchWriter(root)
    const firstRef = firstWriter.stage('run-1', activity('tool-1', 'one'))!
    firstWriter.commit()
    const secondWriter = new ToolActivityDetailBatchWriter(root)
    const second = activity('tool-2', 'two')
    const secondRef = secondWriter.stage('run-1', second)!
    secondWriter.commit()

    expect(secondRef.offset).toBe(firstRef.byteLength)
    await expect(hydrateToolActivityDetails(root, [firstRef, secondRef])).resolves.toHaveLength(2)
  })
})

describe('readToolActivityDetailSync', () => {
  it('reads back the exact archived activity for a committed ref', () => {
    const root = tempDir()
    const writer = new ToolActivityDetailBatchWriter(root)
    const archived = activity('tool-1', 'sync output')
    const detailRef = writer.stage('run-1', archived)!
    writer.commit()

    expect(readToolActivityDetailSync(root, detailRef)).toEqual(archived)
  })

  it('returns null for a forged hash or a missing artifact', () => {
    const root = tempDir()
    const writer = new ToolActivityDetailBatchWriter(root)
    const detailRef = writer.stage('run-1', activity('tool-1', 'secret'))!
    writer.commit()

    expect(readToolActivityDetailSync(root, { ...detailRef, sha256: '0'.repeat(64) })).toBeNull()
    expect(readToolActivityDetailSync(tempDir(), detailRef)).toBeNull()
  })
})
