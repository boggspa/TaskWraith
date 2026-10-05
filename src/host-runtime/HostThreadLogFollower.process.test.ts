/**
 * The follower against the app's real journal written by another process, as
 * the Host follows a thread the desktop app owns. The writer appends, rotates,
 * compacts in its own loop (the worker's fold, a moment later), and now and
 * then checkpoints at the cap, while this process polls as fast as it can.
 * Which interleavings happen is up to the two processes: this is not
 * exhaustive (the interleavings test is), it shows the follower holding up
 * against the real thing.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { createIncrementalChatJournal } from '../main/store/IncrementalChatJournal'
import type { ChatRecord } from '../main/store/types'
import {
  HOST_THREAD_LOG_SEED_REASONS,
  HostThreadLogFollower,
  type HostThreadLogRecord,
  type HostThreadLogView
} from './HostThreadLogFollower'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-process-'

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
const AT = '2026-10-05T00:00:00.000Z'
const LAST = 800

/** The record the writer has at a revision: one message per revision after the first. */
function recordAt(revision: number): ChatRecord {
  const messages: ChatRecord['messages'] = []
  for (let index = 2; index <= revision; index += 1) {
    messages.push({
      id: `m${index}`,
      role: 'user',
      content: `${index} `.padEnd(200, '.'),
      timestamp: AT
    })
  }
  return {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages,
    runs: []
  }
}

/** The writer: the journal as the app runs it under the barrier, its worker folding a moment later. */
const WRITER = (store: string): string => `
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { createIncrementalChatJournal } = require(${JSON.stringify(path.join(store, 'IncrementalChatJournal.ts'))});
  const { deriveChatRecordMutation } = require(${JSON.stringify(path.join(store, 'ChatRecordMutation.ts'))});
  const { prepareCheckpoint } = require(${JSON.stringify(path.join(store, 'CheckpointPreparationCore.ts'))});
  const { checkpointFileReference } = require(${JSON.stringify(path.join(store, 'CheckpointPreparationProtocol.ts'))});
  const [directory, lastText] = process.argv.slice(2);
  const last = Number(lastText);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const compactor = {
    start(source) {
      const outputPath = path.join(directory, '.' + source.chatId + '.checkpoint-prepared-' + process.pid + '-' + randomUUID() + '.tmp');
      fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
      const output = checkpointFileReference(outputPath);
      const result = pause(1).then(() =>
        prepareCheckpoint({ ...source, output, maxOutputBytes: 64 * 1024 * 1024 })
      );
      const release = () => fs.rmSync(outputPath, { force: true });
      return { output, result, cancel: release, release };
    }
  };
  const journal = createIncrementalChatJournal(directory, {
    noteDurabilityDebt: () => {},
    checkpointPreparation: compactor,
    syncDirectory: () => pause(1),
    maxJournalBytes: 4096,
    canRepairOnRead: () => false,
    repairTornTailBeforeAppend: true
  });
  const AT = ${JSON.stringify(AT)};
  const grown = (record) => {
    const revision = record.persistenceRevision + 1;
    return {
      ...record,
      updatedAt: revision,
      persistenceRevision: revision,
      messages: [...record.messages, { id: 'm' + revision, role: 'user', content: (revision + ' ').padEnd(200, '.'), timestamp: AT }]
    };
  };
  (async () => {
    let record = { appChatId: ${JSON.stringify(CHAT)}, title: 'Thread', createdAt: 1, updatedAt: 1, archived: false, persistenceRevision: 1, messages: [], runs: [] };
    journal.initialize(record.appChatId, record);
    for (let revision = 2; revision <= last; revision += 1) {
      const next = grown(record);
      journal.append(deriveChatRecordMutation(record, next, { savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString() }));
      record = next;
      // The cap's checkpoint on the calling thread, now and then.
      if (revision % 197 === 0) journal.checkpoint(record.appChatId, 'bounded', record);
      await pause(revision % 3);
    }
    await pause(200);
    process.exit(0);
  })().catch((error) => {
    process.stderr.write(String((error && error.stack) || error));
    process.exit(1);
  });
`

/** The app's own load, read-only. A load racing the writer's renames may fail: it is asked again. */
async function appLoad(directory: string): Promise<ChatRecord | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return createIncrementalChatJournal(directory, {
        noteDurabilityDebt: () => {},
        canWrite: () => false
      }).replay(CHAT).record
    } catch (error) {
      if (attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

function difference(view: HostThreadLogView, record: ChatRecord): string | null {
  const { messages, runs, ...shell } = record
  if (view.revision !== record.persistenceRevision) return `revision ${view.revision}`
  if (!isDeepStrictEqual(view.shell, shell)) return 'record without its transcript'
  if (view.messageCount !== messages.length) return 'message count'
  const newest = messages.slice(messages.length - view.messages.length)
  if (!isDeepStrictEqual(view.messages, newest)) return 'messages'
  if (view.runCount !== runs.length) return 'run count'
  return null
}

/**
 * Follow the writer to its end, polling again `pause` after each poll (a turn
 * of the loop when null), and check the view after every batch.
 */
async function followWriter(
  pause: number | null
): Promise<ReturnType<HostThreadLogFollower['stats']>> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  try {
    const executable = path.join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: WRITER(path.join(__dirname, '..', 'main', 'store')),
        resolveDir: process.cwd()
      },
      outfile: executable,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    const directory = path.join(root, 'chat-journal-v2')
    const failures: string[] = []
    let applied = 0
    const follower = new HostThreadLogFollower({
      chatId: CHAT,
      directory,
      windowMessages: 32,
      seedPort: {
        seed: async () => (await appLoad(directory)) as unknown as HostThreadLogRecord | null
      },
      observer: {
        seeded: (record) => {
          const revision = (record as unknown as ChatRecord).persistenceRevision ?? 0
          if (!isDeepStrictEqual(record, recordAt(revision))) {
            failures.push(`seeded at ${revision} with another record`)
          }
        },
        applied: () => {
          applied += 1
          const view = follower.view()!
          const wrong = difference(view, recordAt(view.revision))
          if (wrong) failures.push(`at ${view.revision}: ${wrong}`)
        }
      }
    })
    const writer = spawn(process.execPath, [executable, directory, String(LAST)], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    writer.stderr.on('data', (chunk) => (stderr += String(chunk)))
    const exited = new Promise<number | null>((resolve) => writer.on('exit', resolve))
    let running = true
    void exited.then(() => (running = false))
    let polls = 0
    try {
      while (running) {
        await follower.poll()
        polls += 1
        await new Promise((resolve) =>
          pause === null ? setImmediate(resolve) : setTimeout(resolve, pause)
        )
      }
      expect(await exited, stderr).toBe(0)
      let result = await follower.poll()
      for (let more = 0; result.status !== 'following' || !result.caughtUp; more += 1) {
        if (more > 100) throw new Error('the follower never caught up')
        result = await follower.poll()
      }
      expect(result).toMatchObject({ status: 'following', revision: LAST, stoppedAt: null })
      expect(failures).toEqual([])
      expect(difference(follower.view()!, recordAt(LAST))).toBeNull()
      expect(await appLoad(directory)).toEqual(recordAt(LAST))
      const stats = follower.stats()
      // Every revision after the first seed's was either applied or in a later seed.
      expect(applied).toBe(stats.batchesApplied)
      expect(stats.seeds.cold).toBe(1)
      expect(stats.observerFailures).toBe(0)
      expect(polls).toBeGreaterThan(10)
      for (const reason of HOST_THREAD_LOG_SEED_REASONS) {
        if (reason !== 'cold' && reason !== 'checkpoint-passed') {
          expect(stats.seeds[reason], reason).toBe(0)
        }
      }
      return stats
    } finally {
      if (running) writer.kill('SIGKILL')
      await exited
      follower.close()
    }
  } finally {
    removeTemporaryDirectory(root)
  }
}

describe('a writer in another process', () => {
  it('is followed to its last revision by a follower that polls at every turn', async () => {
    await followWriter(null)
  }, 60_000)

  it('is followed to its last revision by a follower that falls behind, reseeding only where a checkpoint passed it', async () => {
    await followWriter(50)
  }, 60_000)
})
