import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthoredChatTranscriptMutation } from './ChatRecordMutation'
import {
  prepareChatForPersistence,
  type ChatPersistenceDetailBatch
} from './ChatPersistencePreparation'
import { TOOL_DETAIL_EXTERNALIZATION_GENERATION } from './ChatToolDetailExternalization'
import { readToolActivityDetailSync } from './ToolActivityDetailLedger'
import {
  createToolActivityDetailStaging,
  type ToolActivityDetailStaging
} from './ToolActivityDetailStaging'
import type { ChatRecord, ToolActivityDetailRef } from './types'

function detailRef(): ToolActivityDetailRef {
  return {
    schemaVersion: 1,
    storage: 'run_event_artifact',
    runId: 'run-1',
    activityId: 'tool-1',
    offset: 0,
    byteLength: 70_000,
    sha256: 'a'.repeat(64)
  }
}

function liveToolChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Tool-heavy chat',
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 2,
    archived: false,
    messages: [
      {
        id: 'message-1',
        role: 'tool',
        content: '',
        timestamp: '2026-09-04T00:00:00.000Z',
        runId: 'run-1',
        toolActivities: [
          {
            id: 'tool-1',
            toolName: 'run_shell_command',
            displayName: 'Ran command',
            category: 'shell',
            status: 'success',
            endedAt: '2026-09-04T00:00:01.000Z',
            parameters: { command: 'printf hello' },
            rawResultEvent: { output: 'x'.repeat(70_000) }
          }
        ]
      }
    ],
    runs: [
      {
        runId: 'run-1',
        startedAt: '2026-09-04T00:00:00.000Z',
        status: 'running'
      }
    ]
  }
}

function authored(chat: ChatRecord): AuthoredChatTranscriptMutation {
  return {
    operations: [
      {
        type: 'message_put',
        messageId: chat.messages[0].id,
        message: chat.messages[0]
      }
    ],
    transcriptOps: [{ op: 'update', id: chat.messages[0].id, message: chat.messages[0] }],
    changedMessageCount: 1
  }
}

describe('prepareChatForPersistence', () => {
  it('commits and checkpoints detail before publishing stripped chat and authored operations', () => {
    const source = liveToolChat()
    const order: string[] = []
    const persistDetailCheckpoint = vi.fn(() => order.push('checkpoint'))

    const result = prepareChatForPersistence({
      chat: source,
      previous: null,
      authoredTranscript: authored(source),
      authoredTranscriptEligible: true,
      createDetailBatch: () => ({
        stage: () => {
          order.push('stage')
          return detailRef()
        },
        commit: () => {
          order.push('commit')
          return [{ runId: 'run-1' }]
        }
      }),
      readArchivedDetail: () => null,
      persistDetailCheckpoint,
      maxTerminalRunsPerPass: 25
    })

    expect(order).toEqual(['stage', 'commit', 'checkpoint'])
    expect(result.externalizationFailed).toBe(false)
    const activity = result.chat.messages[0].toolActivities![0]
    expect(activity.detailRef).toEqual(detailRef())
    expect(activity.parameters).toBeUndefined()
    expect(activity.rawResultEvent).toBeUndefined()
    const operation = result.authoredTranscript?.operations[0]
    expect(operation?.type).toBe('message_put')
    if (operation?.type !== 'message_put') throw new Error('expected substituted message_put')
    expect(operation.message.toolActivities?.[0].detailRef).toEqual(detailRef())
    expect(operation.message.toolActivities?.[0].rawResultEvent).toBeUndefined()
  })

  it('retains inline detail and requests full compatibility fallback when checkpointing fails', () => {
    const source = liveToolChat()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = prepareChatForPersistence({
        chat: source,
        previous: null,
        authoredTranscriptEligible: true,
        createDetailBatch: () => ({
          stage: () => detailRef(),
          commit: () => [{ runId: 'run-1' }]
        }),
        readArchivedDetail: () => null,
        persistDetailCheckpoint: () => {
          throw new Error('checkpoint failed')
        },
        maxTerminalRunsPerPass: 25
      })

      expect(result.externalizationFailed).toBe(true)
      expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('treats an unarchived sealed jumbo activity as a preparation failure', () => {
    const source = liveToolChat()
    const result = prepareChatForPersistence({
      chat: source,
      previous: null,
      authoredTranscriptEligible: true,
      createDetailBatch: () => ({ stage: () => null, commit: () => [] }),
      readArchivedDetail: () => null,
      persistDetailCheckpoint: () => {},
      maxTerminalRunsPerPass: 25
    })

    expect(result.externalizationFailed).toBe(true)
    expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
  })

  it('drops authored operations when the caller says its transcript lineage is ineligible', () => {
    const source = liveToolChat()
    const result = prepareChatForPersistence({
      chat: source,
      previous: null,
      authoredTranscript: authored(source),
      authoredTranscriptEligible: false,
      createDetailBatch: () => ({ stage: () => detailRef(), commit: () => [] }),
      readArchivedDetail: () => null,
      persistDetailCheckpoint: () => {},
      maxTerminalRunsPerPass: 25
    })

    expect(result.authoredTranscript).toBeUndefined()
  })
})

const AT = '2026-09-04T00:00:00.000Z'

/** A port whose syncs succeed when the test lets them all run. */
class HeldPort {
  private waiting: Array<() => void> = []
  syncFile = (): Promise<'synced'> =>
    new Promise((resolve) => this.waiting.push(() => resolve('synced')))
  syncDirectory = this.syncFile
  /** Run every sync, step after step, until a batch has nothing more to ask. */
  async drain(): Promise<void> {
    while (this.waiting.length > 0) {
      for (const done of this.waiting.splice(0)) done()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

describe('rows left inline until their bytes are durable', () => {
  const TEMPORARY_PREFIX = 'log-preparation-staging-'
  let root: string
  let port: HeldPort

  /** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
  const removeTemporaryDirectory = (directory: string): void => {
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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    port = new HeldPort()
  })

  afterEach(() => {
    removeTemporaryDirectory(root)
  })

  const staging = (maxOutstanding?: number): ToolActivityDetailStaging =>
    createToolActivityDetailStaging({
      runArtifactsDir: path.join(root, 'run-artifacts'),
      port,
      appendRunEvent: (input) => ({
        file: path.join(root, 'run-events', `${input.runId}.jsonl`),
        directories: []
      }),
      checkpointInput: (chat, checkpoint) => ({
        runId: checkpoint.runId,
        chatId: chat.appChatId,
        kind: 'tool',
        phase: 'artifact',
        source: 'main',
        payload: { type: 'tool_activity_detail_checkpoint', ...checkpoint }
      }),
      maxOutstanding
    })

  const prepare = (chat: ChatRecord, batch: () => ChatPersistenceDetailBatch<unknown>) =>
    prepareChatForPersistence({
      chat,
      previous: chat,
      authoredTranscriptEligible: false,
      createDetailBatch: batch,
      readArchivedDetail: (ref) =>
        readToolActivityDetailSync(path.join(root, 'run-artifacts'), ref),
      persistDetailCheckpoint: () => {
        throw new Error('A staged batch has no checkpoint for the save to persist')
      },
      maxTerminalRunsPerPass: 25
    })

  /** The chat of the first tests with its run finished, stamped by nothing yet. */
  function finishedToolChat(): ChatRecord {
    const chat = liveToolChat()
    chat.runs = [{ runId: 'run-1', startedAt: AT, endedAt: AT, status: 'completed', exitCode: 0 }]
    return chat
  }

  it('does not count a live row the batch says awaits durability as a failure', () => {
    const result = prepare(liveToolChat(), () => ({
      stage: () => null,
      commit: () => [],
      awaitsDurability: (runId, activityId) => runId === 'run-1' && activityId === 'tool-1'
    }))

    expect(result.externalizationFailed).toBe(false)
    expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
  })

  it('still counts a row the batch says nothing about, and a write that throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const unknown = prepare(liveToolChat(), () => ({
        stage: () => null,
        commit: () => [],
        awaitsDurability: () => false
      }))
      const thrown = prepare(liveToolChat(), () => ({
        stage: () => null,
        commit: () => {
          throw new Error('ENOSPC: no space left on device, write')
        },
        awaitsDurability: () => true
      }))

      expect(unknown.externalizationFailed).toBe(true)
      expect(thrown.externalizationFailed).toBe(true)
      expect(thrown.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps a live row inline without a failure while it is staged, waiting or not admitted, and strips it once durable', async () => {
    const detail = staging(1)
    const live = liveToolChat()
    const other = { ...liveToolChat(), appChatId: 'chat-2' }

    const staged = prepare(live, () => detail.batch(live))
    const waiting = prepare(live, () => detail.batch(live))
    const notAdmitted = prepare(other, () => detail.batch(other))
    for (const result of [staged, waiting, notAdmitted]) {
      expect(result.externalizationFailed).toBe(false)
      expect(result.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
    }
    expect(detail.snapshot()).toMatchObject({ rows: { staged: 1, passedOver: 2 } })

    await port.drain()
    const swapped = prepare(live, () => detail.batch(live))

    expect(swapped.externalizationFailed).toBe(false)
    const activity = swapped.chat.messages[0].toolActivities![0]
    expect(activity.rawResultEvent).toBeUndefined()
    expect(
      readToolActivityDetailSync(path.join(root, 'run-artifacts'), activity.detailRef!)
    ).toEqual(liveToolChat().messages[0].toolActivities![0])
  })

  it('stamps a finished run only at the save after its batch is durable', async () => {
    const detail = staging()
    let chat = finishedToolChat()

    chat = prepare(chat, () => detail.batch(chat)).chat
    expect(chat.runs[0].toolDetailExternalizationGeneration).toBeUndefined()
    expect(chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
    // A save while its batch is outstanding changes nothing either.
    chat = prepare(chat, () => detail.batch(chat)).chat
    expect(chat.runs[0].toolDetailExternalizationGeneration).toBeUndefined()

    await port.drain()
    const result = prepare(chat, () => detail.batch(chat))

    expect(result.externalizationFailed).toBe(false)
    expect(result.chat.runs[0].toolDetailExternalizationGeneration).toBe(
      TOOL_DETAIL_EXTERNALIZATION_GENERATION
    )
    expect(result.chat.messages[0].toolActivities?.[0]).toMatchObject({
      id: 'tool-1',
      detailRef: expect.objectContaining({ runId: 'run-1', activityId: 'tool-1' })
    })
  })

  it('counts a live row the staging cannot write at all as a failure', () => {
    const detail = staging()
    const chat = liveToolChat()
    // Large enough to move out, and with a value no record of it can hold.
    chat.messages[0].toolActivities![0].rawResultEvent = { count: BigInt(1) }
    chat.messages[0].toolActivities![0].parameters = { command: 'x'.repeat(70_000) }

    const result = prepare(chat, () => detail.batch(chat))

    expect(result.externalizationFailed).toBe(true)
    expect(detail.snapshot()).toMatchObject({ rows: { staged: 0, passedOver: 0 } })
  })

  it('counts a staged live row whose write throws as a failure, and not the saves that back off after it', () => {
    const detail = staging()
    const chat = liveToolChat()
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, write')
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const thrown = prepare(chat, () => detail.batch(chat))
      const backingOff = prepare(chat, () => detail.batch(chat))

      expect(thrown.externalizationFailed).toBe(true)
      expect(thrown.chat.messages[0].toolActivities?.[0].rawResultEvent).toBeDefined()
      expect(backingOff.externalizationFailed).toBe(false)
      expect(detail.snapshot()).toMatchObject({
        batches: { committed: 0, failed: 1 },
        rows: { staged: 1, passedOver: 1 }
      })
    } finally {
      write.mockRestore()
      consoleError.mockRestore()
    }
  })
})
