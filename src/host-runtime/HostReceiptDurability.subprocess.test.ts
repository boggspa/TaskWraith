import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HostCommandReceiptStore,
  HOST_COMMAND_RECEIPT_JOURNAL_FILENAME
} from './HostCommandReceiptStore'

const NOW = '2026-09-24T10:00:00.000Z'
const actor = { actorId: 'crash-actor', clientId: 'crash-client', clientClass: 'desktop' as const }
const admission = {
  commandId: 'crash-command',
  idempotencyKey: 'crash-command-key',
  commandName: 'thread.record.persist' as const,
  commandFingerprint: 'a'.repeat(64),
  actor,
  target: { kind: 'thread', id: 'crash-thread' },
  authority: { decision: 'allowed' as const }
}

// Real production journal/checkpoint writes in a separate killed Node process.
// Complete unfsynced bytes may survive SIGKILL. Recovery syncs those bytes before
// exposing a terminal witness; this is not a power-loss test.
describe('Host receipt durability process crashes', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-receipt-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const fs = require('node:fs');
          const native = { ...fs };
          const { join } = require('node:path');
          const { HostCommandReceiptStore, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME } =
            require(${JSON.stringify(join(__dirname, 'HostCommandReceiptStore.ts'))});
          const [dataDir, cut] = process.argv.slice(2);
          const input = ${JSON.stringify(admission)};
          const legacyUpgrade = cut === 'legacy-checkpoint-before-unlink';
          let clock = Date.parse(${JSON.stringify(NOW)});
          const options = {
            dataDir,
            now: () => new Date(clock++).toISOString(),
            getPosition: () => ({ generation: 1, cursor: 7 }),
            ...(legacyUpgrade ? { maxRecords: 2, compactAfterRecords: 1000 } : {})
          };
          if (cut === 'recover-sync-fails' || cut === 'recover-syncs') {
            const synced = [];
            fs.fsyncSync = (fd) => {
              if (cut === 'recover-sync-fails') throw new Error('recovery sync refused');
              native.fsyncSync(fd);
              synced.push(native.fstatSync(fd).isDirectory() ? 'directory' : 'file');
            };
            try {
              const recovered = new HostCommandReceiptStore(options);
              process.stdout.write(JSON.stringify({
                kind: 'recovered', synced,
                receipt: recovered.getByCommandId(input.commandId, input.actor)
              }));
            } catch (error) {
              process.stdout.write(JSON.stringify({ kind: 'blocked', synced, message: error.message }));
            }
            process.exit(0);
          }
          let store = new HostCommandReceiptStore(options);
          const seed = { ...input, commandId: 'seed', idempotencyKey: 'seed-key' };
          store.begin(seed);
          store.complete({ commandId: 'seed', status: 'succeeded' });
          if (cut !== 'begin-prefix') store.begin(input);
          if (legacyUpgrade) {
            // Seed the pre-sequence journal format, then upgrade and acknowledge
            // a terminal receipt before checkpoint retention evicts the old seed.
            const path = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME);
            const lines = native.readFileSync(path, 'utf8').trimEnd().split('\\n').map((line) => {
              const event = JSON.parse(line);
              delete event.seq;
              return JSON.stringify(event);
            });
            native.writeFileSync(path, lines.join('\\n') + '\\n');
            store = new HostCommandReceiptStore(options);
            store.complete({ commandId: input.commandId, status: 'succeeded' });
          }
          const descriptors = new Map();
          let checkpointRenamed = false;
          let checkpointDirectorySynced = false;
          const isJournal = (fd) => descriptors.get(fd)?.endsWith(HOST_COMMAND_RECEIPT_JOURNAL_FILENAME);
          const stop = () => {
            native.writeFileSync(join(dataDir, 'cut-reached'), cut);
            process.kill(process.pid, 'SIGKILL');
            throw new Error('kill did not stop writer');
          };
          fs.openSync = (...args) => {
            const fd = native.openSync(...args);
            descriptors.set(fd, String(args[0]));
            return fd;
          };
          fs.closeSync = (fd) => {
            try { return native.closeSync(fd); } finally { descriptors.delete(fd); }
          };
          fs.writeSync = (fd, data, offset, length, position) => {
            if (isJournal(fd) && cut.endsWith('-prefix')) {
              const count = Math.min(17, length);
              let written = 0;
              while (written < count) written += native.writeSync(fd, data, offset + written, count - written, position);
              stop();
            }
            return native.writeSync(fd, data, offset, length, position);
          };
          fs.fsyncSync = (fd) => {
            if (isJournal(fd) && cut === 'complete-before-fsync') stop();
            native.fsyncSync(fd);
            if (checkpointRenamed && descriptors.get(fd) === dataDir) checkpointDirectorySynced = true;
            if (isJournal(fd) && cut === 'complete-after-fsync') stop();
          };
          fs.renameSync = (...args) => {
            native.renameSync(...args);
            checkpointRenamed = true;
            if (cut === 'checkpoint-after-rename') stop();
          };
          fs.unlinkSync = (...args) => {
            if (legacyUpgrade && String(args[0]).endsWith(HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)) {
              if (!checkpointRenamed || (process.platform !== 'win32' && !checkpointDirectorySynced)) {
                throw new Error('journal retired before durable checkpoint');
              }
              stop();
            }
            return native.unlinkSync(...args);
          };
          if (legacyUpgrade) store.begin({ ...input, commandId: 'later', idempotencyKey: 'later-key' });
          else if (cut === 'begin-prefix') store.begin(input);
          else {
            store.complete({ commandId: input.commandId, status: 'succeeded' });
            if (cut === 'checkpoint-after-rename') store.compact();
          }
          throw new Error('crash boundary was not reached');
        `,
        resolveDir: process.cwd(),
        sourcefile: 'host-receipt-crash-writer.cjs',
        loader: 'js'
      },
      outfile: executable,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it.each([
    'begin-prefix',
    'complete-prefix',
    'complete-before-fsync',
    'complete-after-fsync',
    'checkpoint-after-rename',
    'legacy-checkpoint-before-unlink'
  ] as const)('recovers durable identity after a writer is killed at %s', (cut) => {
    const dataDir = join(root, cut)
    mkdirSync(dataDir)
    const killed = spawnSync(process.execPath, [executable, dataDir, cut], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(killed.error).toBeUndefined()
    expect(killed.stderr).toBe('')
    expect(readFileSync(join(dataDir, 'cut-reached'), 'utf8')).toBe(cut)
    if (process.platform === 'win32') {
      expect(killed.signal === 'SIGKILL' || killed.status === 1).toBe(true)
    } else {
      expect(killed.signal).toBe('SIGKILL')
    }

    if (cut === 'complete-before-fsync') {
      const journalPath = join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME)
      const readableBytes = readFileSync(journalPath, 'utf8')
      const lastLine = readableBytes.trimEnd().split('\n').at(-1)!
      expect(JSON.parse(lastLine).record.status).toBe('succeeded')
      const recoverInProcess = (mode: string): Record<string, unknown> => {
        const result = spawnSync(process.execPath, [executable, dataDir, mode], {
          cwd: root,
          encoding: 'utf8',
          timeout: 15_000
        })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stderr).toBe('')
        return JSON.parse(result.stdout)
      }
      // Readability alone cannot produce a success response when recovery sync fails.
      expect(recoverInProcess('recover-sync-fails')).toEqual({
        kind: 'blocked',
        synced: [],
        message: 'recovery sync refused'
      })
      expect(readFileSync(journalPath, 'utf8')).toBe(readableBytes)
      expect(recoverInProcess('recover-syncs')).toEqual({
        kind: 'recovered',
        synced: process.platform === 'win32' ? ['file'] : ['file', 'directory'],
        receipt: expect.objectContaining({
          kind: 'found',
          receipt: expect.objectContaining({ status: 'succeeded' })
        })
      })
    }

    const options = {
      dataDir,
      now: () => NOW,
      getPosition: () => ({ generation: 1, cursor: 7 }),
      ...(cut === 'legacy-checkpoint-before-unlink' ? { maxRecords: 2 } : {})
    }
    const recovered = new HostCommandReceiptStore(options)
    if (cut === 'legacy-checkpoint-before-unlink') {
      // Covered legacy rows must not resurrect evicted identities or replace a
      // terminal receipt with an earlier pending row after the upgrade crash.
      expect(recovered.durabilityStatus).toEqual({ kind: 'ok' })
      expect(recovered.getByCommandId('seed', actor)).toEqual({ kind: 'not_found' })
      expect(recovered.begin(admission)).toMatchObject({
        kind: 'existing',
        receipt: { status: 'succeeded', generation: 1, cursor: 7 }
      })
      expect(recovered.getByCommandId('later', actor)).toMatchObject({
        kind: 'found',
        receipt: { status: 'indeterminate' }
      })
      const reopened = new HostCommandReceiptStore(options)
      expect(reopened.getByCommandId('seed', actor)).toEqual({ kind: 'not_found' })
      expect(reopened.begin(admission)).toEqual(recovered.begin(admission))
      return
    }
    expect(recovered.getByCommandId('seed', actor)).toMatchObject({
      kind: 'found',
      receipt: { status: 'succeeded', generation: 1, cursor: 7 }
    })
    if (cut === 'begin-prefix') {
      // The killed admission never returned and no executor was called.
      expect(recovered.getByCommandId(admission.commandId, actor)).toEqual({ kind: 'not_found' })
      expect(recovered.begin(admission).kind).toBe('created')
    } else {
      const status = cut === 'complete-prefix' ? 'indeterminate' : 'succeeded'
      expect(recovered.begin(admission)).toMatchObject({
        kind: 'existing',
        receipt: { status, generation: 1, cursor: 7 }
      })
    }
    if (cut.endsWith('-prefix')) {
      // A repaired tail must not swallow the next durable admission/promotion.
      const journal = readFileSync(join(dataDir, HOST_COMMAND_RECEIPT_JOURNAL_FILENAME), 'utf8')
      expect(journal.endsWith('\n')).toBe(true)
      for (const line of journal.trimEnd().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
    const durableAfterRecovery = new HostCommandReceiptStore(options)
    expect(durableAfterRecovery.begin(admission)).toMatchObject({
      kind: 'existing',
      receipt: {
        status: cut.endsWith('-prefix') ? 'indeterminate' : 'succeeded',
        generation: 1,
        cursor: 7
      }
    })
    const terminal = durableAfterRecovery.complete({
      commandId: admission.commandId,
      status: 'succeeded'
    })
    expect(terminal).toMatchObject({ status: 'succeeded', generation: 1, cursor: 7 })
    const reopened = new HostCommandReceiptStore(options)
    expect(reopened.getByCommandId(admission.commandId, actor)).toEqual({
      kind: 'found',
      receipt: terminal
    })
    expect(reopened.begin(admission)).toEqual({ kind: 'existing', receipt: terminal })
  })
})
