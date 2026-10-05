/**
 * Seeds loaded in the worker while another process writes the thread, as the
 * desktop app writes a thread the Host follows: a record of about 5 MB, a
 * batch every 50 ms, and the app's compaction folding its log into a new
 * checkpoint every second or so, a moment after it rotates. Cold seeds are
 * asked for over and over, and a follower that keeps following is reseeded
 * now and then; every seed must succeed, and every view must be the writer's
 * record at its revision.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

import {
  HOST_THREAD_LOG_MAX_RETAINED_BYTES,
  HostThreadLogFollower,
  type HostThreadLogView,
  type HostThreadLogWindowSeed
} from './HostThreadLogFollower'
import { HostThreadLogWorkerSeed } from './HostThreadLogWorkerSeed'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-worker-process-'

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
/** The record starts at this revision, with a message for each revision after the first. */
const INITIAL = 2_000
const MESSAGE_BYTES = 2_500
const CADENCE_MS = 50
const WRITE_SECONDS = 8
const WINDOW = { windowMessages: 64, windowRuns: 16, maxViewBytes: 512 * 1024 }

/** The writer: the app's journal under the barrier, saving every CADENCE_MS, its worker folding a moment after each rotation. */
const WRITER = (store: string): string => `
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { createIncrementalChatJournal } = require(${JSON.stringify(path.join(store, 'IncrementalChatJournal.ts'))});
  const { deriveChatRecordMutation } = require(${JSON.stringify(path.join(store, 'ChatRecordMutation.ts'))});
  const { prepareCheckpoint } = require(${JSON.stringify(path.join(store, 'CheckpointPreparationCore.ts'))});
  const { checkpointFileReference } = require(${JSON.stringify(path.join(store, 'CheckpointPreparationProtocol.ts'))});
  const [directory, initialText, sizeText, cadenceText, secondsText] = process.argv.slice(2);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const compactor = {
    start(source) {
      const outputPath = path.join(directory, '.' + source.chatId + '.checkpoint-prepared-' + process.pid + '-' + randomUUID() + '.tmp');
      fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
      const output = checkpointFileReference(outputPath);
      const result = pause(5).then(() =>
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
    maxJournalBytes: 64 * 1024,
    canRepairOnRead: () => false,
    repairTornTailBeforeAppend: true
  });
  const AT = ${JSON.stringify(AT)};
  const grown = (record, revision) => ({
    ...record,
    updatedAt: revision,
    persistenceRevision: revision,
    messages: [...record.messages, { id: 'm' + revision, role: 'user', content: (revision + ' ').padEnd(Number(sizeText), '.'), timestamp: AT }]
  });
  (async () => {
    let record = { appChatId: ${JSON.stringify(CHAT)}, title: 'Thread', createdAt: 1, updatedAt: 1, archived: false, persistenceRevision: 1, messages: [], runs: [] };
    for (let revision = 2; revision <= Number(initialText); revision += 1) record = grown(record, revision);
    journal.initialize(record.appChatId, record);
    process.stdout.write('ready\\n');
    const end = Date.now() + Number(secondsText) * 1000;
    while (Date.now() < end) {
      const next = grown(record, record.persistenceRevision + 1);
      journal.append(deriveChatRecordMutation(record, next, { savedAt: new Date().toISOString() }));
      record = next;
      await pause(Number(cadenceText));
    }
    await pause(200);
    process.stdout.write('last ' + record.persistenceRevision + '\\n');
    process.exit(0);
  })().catch((error) => {
    process.stderr.write(String((error && error.stack) || error));
    process.exit(1);
  });
`

/** The writer's message for a revision. */
function messageAt(revision: number): Record<string, unknown> {
  return {
    id: `m${revision}`,
    role: 'user',
    content: `${revision} `.padEnd(MESSAGE_BYTES, '.'),
    timestamp: AT
  }
}

/**
 * How a view differs from the writer's record at its revision, or null: the
 * record without its transcript, the count, and the newest messages, each
 * built one at a time rather than the whole 5 MB record.
 */
function difference(
  view: Pick<HostThreadLogView, 'revision' | 'shell' | 'messageCount' | 'messages' | 'runCount'>
): string | null {
  const revision = view.revision
  const shell = {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision
  }
  if (JSON.stringify(view.shell) !== JSON.stringify(shell)) return `shell at ${revision}`
  if (view.messageCount !== revision - 1) return `message count at ${revision}`
  if (view.runCount !== 0) return `run count at ${revision}`
  const first = revision - view.messages.length + 1
  for (let index = 0; index < view.messages.length; index += 1) {
    if (JSON.stringify(view.messages[index]) !== JSON.stringify(messageAt(first + index))) {
      return `message ${index} at ${revision}`
    }
  }
  return null
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('seeds loaded in a worker while another process writes the thread', () => {
  it('all succeed, and every view after them is the record at its revision', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    const failures: string[] = []
    const report: Record<string, unknown> = {}
    try {
      const writerPath = path.join(root, 'writer.cjs')
      buildSync({
        stdin: {
          contents: WRITER(path.join(__dirname, '..', 'main', 'store')),
          resolveDir: process.cwd()
        },
        outfile: writerPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      const entryPath = path.join(root, 'seed-worker.cjs')
      buildSync({
        entryPoints: [path.join(__dirname, 'HostThreadLogSeedWorkerEntry.ts')],
        outfile: entryPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        logLevel: 'silent'
      })
      const directory = path.join(root, 'chat-journal-v2')
      const writer = spawn(
        process.execPath,
        [
          writerPath,
          directory,
          String(INITIAL),
          String(MESSAGE_BYTES),
          String(CADENCE_MS),
          String(WRITE_SECONDS)
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stdout = ''
      let stderr = ''
      writer.stdout.on('data', (chunk) => (stdout += String(chunk)))
      writer.stderr.on('data', (chunk) => (stderr += String(chunk)))
      const exited = new Promise<number | null>((resolve) => writer.on('exit', resolve))
      const port = new HostThreadLogWorkerSeed({ directory, entryPath })
      const seeded: HostThreadLogWindowSeed[] = []
      const checkSeed = (seed: HostThreadLogWindowSeed): void => {
        seeded.push(seed)
        const wrong = difference(seed)
        if (wrong) failures.push(`seed: ${wrong}`)
        // Every message before the window shows, and names no run.
        const before = seed.messageCount - seed.messages.length
        if (seed.entriesBefore.shown !== before) failures.push(`entries before at ${seed.revision}`)
        const bytes = seed.shellBytes + seed.messageBytes.reduce((sum, each) => sum + each, 0)
        if (bytes > WINDOW.maxViewBytes) failures.push(`seed over its bounds at ${seed.revision}`)
        if (seed.messages.length !== Math.min(WINDOW.windowMessages, seed.messageCount)) {
          // The byte bound may end the window first; it must then be full to that bound.
          const next = JSON.stringify(messageAt(seed.revision - seed.messages.length)).length
          if (bytes + next <= WINDOW.maxViewBytes) failures.push(`short window at ${seed.revision}`)
        }
      }
      let applied = 0
      const follower: HostThreadLogFollower = new HostThreadLogFollower({
        chatId: CHAT,
        directory,
        seedPort: port,
        ...WINDOW,
        observer: {
          seededWindow: checkSeed,
          seeded: () => failures.push('a whole record crossed to the Host loop'),
          applied: () => {
            applied += 1
            const view = follower.view()!
            const wrong = difference(view)
            if (wrong) failures.push(`after a batch: ${wrong}`)
            const memory = follower.memory()
            if (memory.viewBytes > WINDOW.maxViewBytes || memory.messages > WINDOW.windowMessages) {
              failures.push(`over its bounds at ${view.revision}`)
            }
            if (memory.retainedBytes > HOST_THREAD_LOG_MAX_RETAINED_BYTES) {
              failures.push(`kept too many batches at ${view.revision}`)
            }
          }
        }
      })
      await new Promise<void>((resolve, reject) => {
        writer.stdout.on('data', () => stdout.includes('ready') && resolve())
        void exited.then(() => reject(new Error(`the writer ended first: ${stderr}`)))
      })
      const firstCheckpointBytes = fs.statSync(path.join(directory, `${CHAT}.checkpoint.json`)).size
      let running = true
      void exited.then(() => (running = false))
      const cold: Array<{ ok: boolean; ms: number; revision?: number; why?: string }> = []
      // The follower that keeps following, polled every 20 ms and reseeded every half second.
      const following = (async () => {
        let polls = 0
        while (running) {
          try {
            await follower.poll()
          } catch (error) {
            failures.push(`follower: ${(error as Error).message}`)
          }
          polls += 1
          if (polls % 25 === 0) follower.requestSeed()
          await pause(20)
        }
      })()
      // Cold seeds, one after another, by new followers.
      while (running) {
        const fresh = new HostThreadLogFollower({
          chatId: CHAT,
          directory,
          seedPort: port,
          ...WINDOW,
          observer: { seededWindow: checkSeed }
        })
        const started = performance.now()
        try {
          const result = await fresh.poll()
          const ms = performance.now() - started
          if (result.status !== 'following') {
            cold.push({ ok: false, ms, why: result.status })
          } else {
            const wrong = difference(fresh.view()!)
            cold.push({
              ok: wrong === null,
              ms,
              revision: result.revision,
              why: wrong ?? undefined
            })
          }
        } catch (error) {
          cold.push({ ok: false, ms: performance.now() - started, why: (error as Error).message })
        } finally {
          fresh.close()
        }
        await pause(100)
      }
      await following
      expect(await exited, stderr).toBe(0)
      const last = Number(/last (\d+)/.exec(stdout)?.[1])
      for (let polls = 0; follower.headRevision !== last; polls += 1) {
        if (polls > 200) throw new Error(`the follower never reached ${last}`)
        await follower.poll()
      }
      expect(difference(follower.view()!)).toBeNull()
      follower.close()
      const stats = follower.stats()
      const portStats = port.stats()
      await port.close()
      const times = cold.map((each) => each.ms).sort((a, b) => a - b)
      Object.assign(report, {
        checkpointBytes: portStats.checkpointBytes,
        coldSeeds: cold.length,
        coldSucceeded: cold.filter((each) => each.ok).length,
        coldMs: {
          median: Math.round(times[Math.floor(times.length / 2)] ?? 0),
          max: Math.round(times.at(-1) ?? 0)
        },
        followerSeeds: stats.seeds,
        applied,
        lastRevision: last,
        port: portStats
      })
      // Measurements, for a run that asks for them: the file named is written.
      const reportPath = process.env.SEED_PROCESS_REPORT
      if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 1))
      expect(failures).toEqual([])
      expect(cold.filter((each) => !each.ok)).toEqual([])
      expect(cold.length).toBeGreaterThan(15)
      expect(stats.seeds.requested).toBeGreaterThan(5)
      expect(applied).toBeGreaterThan(50)
      expect(stats.observerFailures).toBe(0)
      expect(portStats).toMatchObject({ failures: 0, workerExits: 0, records: 0 })
      expect(firstCheckpointBytes).toBeGreaterThan(5_000_000)
      // The writer compacted while seeds were read: the checkpoint was replaced under them.
      expect(portStats.checkpointBytes.max).toBeGreaterThan(firstCheckpointBytes)
      expect(seeded.length).toBe(portStats.windows)
    } finally {
      removeTemporaryDirectory(root)
    }
  }, 120_000)
})
