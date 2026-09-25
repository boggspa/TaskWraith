import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'
import type { HostTransactionPrepareRecord } from './HostTransactionManifest'

// M4 slice 8 (design §16), the K2/K3-style cut: a real killed Node writer
// using the production log's async I/O seams. The mid-line cut leaves a torn
// last line, which a reopen discards; the before-fsync cut lets the whole
// line reach the page cache, which a process crash keeps. Both verify
// process-crash recovery, not survival of a machine power loss.

const DIGEST = 'a'.repeat(64)
const EPOCH = { hostIncarnation: 'b'.repeat(64), deleteCounter: 0 }

function prepare(commandId: string): HostTransactionPrepareRecord {
  return {
    kind: 'prepare',
    commandId,
    threadId: `chat-${commandId}`,
    epoch: EPOCH,
    expectedRevision: 13,
    resultingRevision: 14,
    prior: { dev: '16777232', ino: '1001', size: 4_096 },
    resulting: { dev: '16777232', ino: '2002', size: 5_120 },
    effects: { count: 3, setDigest: DIGEST },
    preparedAt: 1_000
  }
}
const SEED = prepare('cmd-seed')
const CRASH = prepare('cmd-crash')
const line = (record: unknown) => `${JSON.stringify(record)}\n`

type Cut = 'mid-line' | 'before-fsync'

describe('HostTransactionLog process crashes', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-transaction-log-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const { openSync, writeSync, closeSync, appendFileSync, writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const { HostTransactionLog } = require(${JSON.stringify(join(__dirname, 'HostTransactionLog.ts'))});
          const [dataDir, cut] = process.argv.slice(2);
          const seed = ${JSON.stringify(SEED)};
          const crash = ${JSON.stringify(CRASH)};
          const stop = () => {
            writeFileSync(join(dataDir, 'cut-reached'), cut);
            process.kill(process.pid, 'SIGKILL');
            throw new Error('kill did not stop writer');
          };
          async function main() {
            // The seed goes through the default seams and is durable before the cut.
            const seeded = await HostTransactionLog.open({ dataDir }).append(seed);
            if (seeded.kind !== 'durable') throw new Error('seed not durable: ' + JSON.stringify(seeded));
            const log = HostTransactionLog.open({
              dataDir,
              write: async (path, data) => {
                if (cut === 'mid-line') {
                  const fd = openSync(path, 'a');
                  const partial = Buffer.from(data, 'utf8').subarray(0, 17);
                  let written = 0;
                  while (written < partial.length) {
                    written += writeSync(fd, partial, written, partial.length - written, null);
                  }
                  closeSync(fd);
                  stop();
                }
                appendFileSync(path, data);
              },
              fsync: async () => {
                if (cut === 'before-fsync') stop();
                writeFileSync(join(dataDir, 'fsync-called'), cut);
              },
              rename: async () => { throw new Error('rename is not part of an append'); }
            });
            const result = await log.append(crash);
            throw new Error('crash boundary was not reached: ' + JSON.stringify(result));
          }
          main().catch((error) => { console.error(String(error && error.stack || error)); process.exit(2); });
        `,
        resolveDir: process.cwd(),
        sourcefile: 'host-transaction-log-crash-writer.cjs',
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

  function killWriter(cut: Cut) {
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
    // The cut record's batch never reached its fsync.
    expect(existsSync(join(dataDir, 'fsync-called'))).toBe(false)
    return dataDir
  }

  const logPath = (dataDir: string) => join(dataDir, HOST_TRANSACTION_LOG_FILENAME)

  /** The next append starts on its own line and survives another reopen. */
  async function expectNextAppendSurvives(dataDir: string, reopened: HostTransactionLog) {
    const before = readFileSync(logPath(dataDir), 'utf8')
    expect(before.endsWith('\n')).toBe(true)
    const next = { kind: 'abort', commandId: 'cmd-seed', reason: 'after-crash', at: 9 }
    expect(await reopened.append(next)).toEqual({ kind: 'durable' })
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(before + line(next))
    const final = HostTransactionLog.open({ dataDir })
    expect(final.get('cmd-seed')).toEqual({ prepare: SEED, terminal: next })
    expect(final.getFailure()).toBeNull()
    return final
  }

  it('a writer killed mid-line reopens with the torn line discarded, and the next append does not concatenate', async () => {
    const dataDir = killWriter('mid-line')
    const torn = readFileSync(logPath(dataDir), 'utf8')
    expect(torn).toBe(line(SEED) + JSON.stringify(CRASH).slice(0, 17))

    const reopened = HostTransactionLog.open({ dataDir })
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(line(SEED))
    expect(reopened.commandIds()).toEqual(['cmd-seed'])
    expect(reopened.get('cmd-crash')).toBeNull()
    expect(reopened.get('cmd-seed')).toEqual({ prepare: SEED, terminal: null })
    expect(reopened.stats()).toMatchObject({ commands: 1, conflicts: 0 })

    const final = await expectNextAppendSurvives(dataDir, reopened)
    expect(final.commandIds()).toEqual(['cmd-seed'])
    expect(final.get('cmd-crash')).toBeNull()
    // The command may prepare again: nothing of the torn line was kept.
    expect(await final.append(CRASH)).toEqual({ kind: 'durable' })
    expect(HostTransactionLog.open({ dataDir }).get('cmd-crash')).toEqual({
      prepare: CRASH,
      terminal: null
    })
  })

  it('a writer killed after the write and before the fsync keeps the record', async () => {
    const dataDir = killWriter('before-fsync')
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(line(SEED) + line(CRASH))

    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.commandIds()).toEqual(['cmd-seed', 'cmd-crash'])
    expect(reopened.get('cmd-crash')).toEqual({ prepare: CRASH, terminal: null })
    expect(reopened.stats()).toEqual({ commands: 2, conflicts: 0, corrupt: 0 })

    const final = await expectNextAppendSurvives(dataDir, reopened)
    expect(final.commandIds()).toEqual(['cmd-seed', 'cmd-crash'])
    expect(final.get('cmd-crash')).toEqual({ prepare: CRASH, terminal: null })
    expect(await final.append(CRASH)).toEqual({ kind: 'duplicate' })
  })
})
