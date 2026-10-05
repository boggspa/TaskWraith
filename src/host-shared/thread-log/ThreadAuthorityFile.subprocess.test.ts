/**
 * Authority files under real processes: a writer killed before each step of a
 * write and of a remove, and a writer that keeps replacing files while this
 * process lists them. A killed process keeps what its steps did, so these show
 * what a reader meets after a process crash; what a power loss keeps is shown
 * on a disk in memory, in the module's own test file.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  ThreadAuthorityFiles,
  threadAuthorityDirectory,
  threadWriterLiveness,
  type ThreadAuthorityRead,
  type ThreadAuthorityRecord
} from './ThreadAuthorityFile'

const EARLIER: ThreadAuthorityRecord = {
  threadId: 'thread-1',
  writer: { writerId: 'writer-a', pid: 4242 },
  epoch: { host: 'host-1', grant: 3 },
  grantedAtRevision: 17,
  grantedAt: 1_780_000_000_000
}
const LATER: ThreadAuthorityRecord = {
  threadId: 'thread-1',
  writer: { writerId: 'writer-b', pid: 5151 },
  epoch: { host: 'host-2', grant: 1 },
  grantedAtRevision: 40,
  grantedAt: 1_780_000_100_000
}
const CHURN_THREADS = ['thread-a', 'thread-b', 'thread-c']
const CHURN_ROUNDS = 20

type Operation = 'write' | 'replace' | 'remove'

const PREFIX = 'owner-thread-authority-process-'

/**
 * Removes a folder this file made with mkdtemp under the temporary folder,
 * and refuses anything else.
 */
function removeTemporary(directory: string): void {
  const own = tmpdir() + sep + PREFIX
  if (directory === tmpdir() || !directory.startsWith(own) || directory.includes(sep, own.length)) {
    throw new Error(`Refusing to remove ${directory}`)
  }
  rmSync(directory, { recursive: true, force: true })
}

describe('authority files under real processes', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), PREFIX))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const { writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const { NODE_THREAD_AUTHORITY_FS, ThreadAuthorityFiles } = require(${JSON.stringify(
            join(__dirname, 'ThreadAuthorityFile.ts')
          )});
          const [mode, profile, argument, limit] = process.argv.slice(2);
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

          // Counts every step and kills this process, hard, before the step at the cut.
          function countingFs(cut) {
            let steps = 0;
            const step = async (run) => {
              if (steps === cut) {
                writeFileSync(join(profile, 'cut-reached'), String(steps));
                process.kill(process.pid, 'SIGKILL');
                await sleep(60000);
              }
              steps += 1;
              return run();
            };
            const fs = NODE_THREAD_AUTHORITY_FS;
            return {
              taken: () => steps,
              fs: {
                mkdir: (directory) => step(() => fs.mkdir(directory)),
                create: (file) => step(async () => {
                  const handle = await fs.create(file);
                  return {
                    write: (text) => step(() => handle.write(text)),
                    sync: () => step(() => handle.sync()),
                    close: () => step(() => handle.close())
                  };
                }),
                rename: (from, to) => step(() => fs.rename(from, to)),
                unlink: (file) => step(() => fs.unlink(file)),
                syncDirectory: (directory) => step(() => fs.syncDirectory(directory)),
                readFile: fs.readFile,
                readdir: fs.readdir
              }
            };
          }

          async function killed() {
            const counting = countingFs(Number(limit));
            const files = new ThreadAuthorityFiles(profile, counting.fs);
            if (argument === 'remove') await files.remove('thread-1');
            else await files.write(${JSON.stringify(LATER)});
            writeFileSync(join(profile, 'completed'), String(counting.taken()));
          }

          // Replaces every thread's file again and again. The pause after a file
          // is opened holds it empty for a while, which only a writer that opens
          // the thread's own file, rather than a temporary one, would show a reader.
          async function churn() {
            const fs = NODE_THREAD_AUTHORITY_FS;
            const files = new ThreadAuthorityFiles(profile, {
              ...fs,
              create: async (file) => {
                const handle = await fs.create(file);
                await sleep(2);
                return handle;
              }
            });
            const threads = ${JSON.stringify(CHURN_THREADS)};
            for (let round = 1; round <= Number(argument); round += 1) {
              for (const threadId of threads) {
                if (round % 5 === 0 && threadId === threads[0]) await files.remove(threadId);
                await files.write({
                  threadId,
                  writer: { writerId: 'churn-writer', pid: process.pid },
                  epoch: { host: 'churn-host', grant: round },
                  grantedAtRevision: round * 10,
                  grantedAt: 1780000000000 + round
                });
              }
              if (round === 1) writeFileSync(join(profile, 'ready'), '1');
            }
          }

          (mode === 'churn' ? churn() : killed()).catch((error) => {
            console.error(String((error && error.stack) || error));
            process.exit(2);
          });
        `,
        resolveDir: process.cwd(),
        sourcefile: 'thread-authority-writer.cjs',
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
    if (root) removeTemporary(root)
  })

  /** A profile holding what the operation starts from. */
  async function prepared(operation: Operation, name: string): Promise<string> {
    const profilePath = join(root, name)
    mkdirSync(profilePath)
    if (operation !== 'write') await new ThreadAuthorityFiles(profilePath).write(EARLIER)
    return profilePath
  }

  function run(operation: Operation, profilePath: string, cut: number) {
    return spawnSync(process.execPath, [executable, 'kill', profilePath, operation, String(cut)], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000
    })
  }

  /** What a reader meets after the writer was killed before each of its steps in turn. */
  async function readsAfterEachKill(operation: Operation): Promise<ThreadAuthorityRead[]> {
    const whole = await prepared(operation, `${operation}-whole`)
    const completed = run(operation, whole, Number.MAX_SAFE_INTEGER)
    expect(completed.stderr).toBe('')
    expect(completed.status).toBe(0)
    const steps = Number(readFileSync(join(whole, 'completed'), 'utf8'))
    expect(steps).toBeGreaterThan(1)

    const reads: ThreadAuthorityRead[] = []
    for (let cut = 0; cut < steps; cut += 1) {
      const profilePath = await prepared(operation, `${operation}-cut-${cut}`)
      const killed = run(operation, profilePath, cut)
      expect(killed.error).toBeUndefined()
      expect(killed.stderr).toBe('')
      expect(readFileSync(join(profilePath, 'cut-reached'), 'utf8')).toBe(String(cut))
      expect(existsSync(join(profilePath, 'completed'))).toBe(false)
      if (process.platform === 'win32') {
        expect(killed.signal === 'SIGKILL' || killed.status === 1).toBe(true)
      } else {
        expect(killed.signal).toBe('SIGKILL')
      }
      const files = new ThreadAuthorityFiles(profilePath)
      const read = await files.read('thread-1')
      // A listing agrees with the read, whatever the kill left in the directory.
      expect(await files.list()).toEqual(
        read.kind === 'none' ? [] : [{ threadId: 'thread-1', read }]
      )
      reads.push(read)
    }
    // After the whole operation, for comparison with the last kill.
    reads.push(await new ThreadAuthorityFiles(whole).read('thread-1'))
    return reads
  }

  it('a writer killed before any step of a first write leaves no file or the whole file', async () => {
    const reads = await readsAfterEachKill('write')

    for (const read of reads) {
      if (read.kind !== 'none') expect(read).toEqual({ kind: 'held', record: LATER })
    }
    expect(reads[0]).toEqual({ kind: 'none' })
    // Killed before the last step, the directory sync: the rename already happened.
    expect(reads.at(-2)).toEqual({ kind: 'held', record: LATER })
    expect(reads.at(-1)).toEqual({ kind: 'held', record: LATER })
  }, 60_000)

  it('a writer killed before any step of a write over an earlier file leaves one of the two', async () => {
    const reads = await readsAfterEachKill('replace')

    for (const read of reads) {
      expect(read.kind).toBe('held')
      expect([EARLIER, LATER]).toContainEqual((read as { record: ThreadAuthorityRecord }).record)
    }
    expect(reads[0]).toEqual({ kind: 'held', record: EARLIER })
    expect(reads.at(-2)).toEqual({ kind: 'held', record: LATER })
    expect(reads.at(-1)).toEqual({ kind: 'held', record: LATER })
  }, 60_000)

  it('a writer killed before any step of a remove leaves the file or no file', async () => {
    const reads = await readsAfterEachKill('remove')

    for (const read of reads) {
      if (read.kind !== 'none') expect(read).toEqual({ kind: 'held', record: EARLIER })
    }
    expect(reads[0]).toEqual({ kind: 'held', record: EARLIER })
    expect(reads.at(-2)).toEqual({ kind: 'none' })
    expect(reads.at(-1)).toEqual({ kind: 'none' })
  }, 60_000)

  it('finds a process that has exited dead, and a running one alive, by its real probe', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore'
    })
    const pid = child.pid!
    expect(threadWriterLiveness({ pid })).toBe('alive')

    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited

    expect(threadWriterLiveness({ pid })).toBe('dead')
  })

  it('one process lists while another keeps writing, and never meets a damaged file', async () => {
    const profilePath = join(root, 'churn')
    mkdirSync(profilePath)
    const writer = spawn(
      process.execPath,
      [executable, 'churn', profilePath, String(CHURN_ROUNDS)],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'pipe']
      }
    )
    let stderr = ''
    writer.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const exited = new Promise<number | null>((resolve) => writer.on('exit', resolve))
    let running = true
    void exited.then(() => {
      running = false
    })

    const files = new ThreadAuthorityFiles(profilePath)
    const grantsSeen = new Map<string, Set<number>>()
    const damaged: unknown[] = []
    let listings = 0
    while (running) {
      if (!existsSync(join(profilePath, 'ready'))) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        continue
      }
      const entries = await files.list()
      listings += 1
      for (const { threadId, read } of entries) {
        if (read.kind === 'damaged') {
          damaged.push({ threadId, read })
          continue
        }
        const { record } = read
        // The fields of one record belong together: none is from another write.
        expect(record.threadId).toBe(threadId)
        expect(record.writer.writerId).toBe('churn-writer')
        expect(record.grantedAtRevision).toBe(record.epoch.grant * 10)
        expect(record.grantedAt).toBe(1_780_000_000_000 + record.epoch.grant)
        if (!grantsSeen.has(threadId)) grantsSeen.set(threadId, new Set())
        grantsSeen.get(threadId)!.add(record.epoch.grant)
      }
    }

    expect(stderr).toBe('')
    expect(await exited).toBe(0)
    expect(damaged).toEqual([])
    // The listing really ran beside the writer: many passes, over files that changed under it.
    expect(listings).toBeGreaterThan(20)
    expect([...grantsSeen.keys()].sort()).toEqual(CHURN_THREADS)
    for (const grants of grantsSeen.values()) expect(grants.size).toBeGreaterThan(3)
    // What the writer left is whole, and nothing temporary is left beside it.
    expect(readdirSync(threadAuthorityDirectory(profilePath)).sort()).toEqual(
      CHURN_THREADS.map((threadId) => `${threadId}.json`)
    )
    expect((await files.list()).map((entry) => entry.read.kind)).toEqual(['held', 'held', 'held'])
  }, 60_000)
})
