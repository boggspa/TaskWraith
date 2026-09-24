import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostDeltaStore } from './HostDeltaStore'

// A real killed Node writer, using the production store's journal I/O seam.
// This verifies process-crash recovery, not survival of a machine power loss.
describe('Host delta publication process crashes', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-publication-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const { writeSync, writeFileSync, fsyncSync } = require('node:fs');
          const { join } = require('node:path');
          const { HostDeltaStore } = require(${JSON.stringify(join(__dirname, 'HostDeltaStore.ts'))});
          const [dataDir, cut] = process.argv.slice(2);
          const seed = new HostDeltaStore({ dataDir });
          seed.append({ kind: 'upsert', family: 'thread', entityId: 'seed-é' });
          const stop = () => {
            writeFileSync(join(dataDir, 'cut-reached'), cut);
            process.kill(process.pid, 'SIGKILL');
            throw new Error('kill did not stop writer');
          };
          const store = new HostDeltaStore({
            dataDir,
            batchWrite: (fd, bytes, offset, length) => {
              if (cut === 'after-fsync') return writeSync(fd, bytes, offset, length, null);
              const firstLine = bytes.indexOf(10, offset) - offset + 1;
              const count = cut === 'append-prefix' ? Math.min(17, length)
                : cut === 'reset-fence' ? firstLine
                : cut === 'reset-envelope-prefix' ? firstLine + 17
                : length;
              let written = 0;
              while (written < count) written += writeSync(fd, bytes, offset + written, count - written, null);
              stop();
            },
            batchFsync: (fd) => { fsyncSync(fd); stop(); }
          });
          if (cut === 'append-prefix' || cut === 'after-fsync') {
            store.append({ kind: 'upsert', family: 'thread', entityId: 'second' });
          } else {
            store.resetGeneration('crash fixture');
          }
          throw new Error('crash boundary was not reached');
        `,
        resolveDir: process.cwd(),
        sourcefile: 'host-publication-crash-writer.cjs',
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
    'append-prefix',
    'reset-fence',
    'reset-envelope-prefix',
    'reset-complete',
    'after-fsync'
  ] as const)('recovers and appends after a writer is killed at %s', (cut) => {
    const dataDir = join(root, cut)
    mkdirSync(dataDir)
    const killed = spawnSync(process.execPath, [executable, dataDir, cut], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(killed.error).toBeUndefined()
    expect(readFileSync(join(dataDir, 'cut-reached'), 'utf8')).toBe(cut)
    expect(killed.stderr).toBe('')
    if (process.platform === 'win32') {
      expect(killed.signal === 'SIGKILL' || killed.status === 1).toBe(true)
    } else {
      expect(killed.signal).toBe('SIGKILL')
    }

    const reopened = new HostDeltaStore({ dataDir })
    const position = reopened.getPosition()
    if (cut === 'reset-complete') {
      expect(position).toEqual({ generation: 2, cursor: 1 })
      expect(reopened.getByCursor(1)?.envelope.kind).toBe('generation-reset')
    } else if (cut === 'after-fsync') {
      expect(position).toEqual({ generation: 1, cursor: 2 })
      expect(reopened.getByCursor(2)?.envelope.entityId).toBe('second')
    } else {
      expect(position).toEqual({ generation: 1, cursor: 1 })
      expect(reopened.getByCursor(1)?.envelope.entityId).toBe('seed-é')
      expect(reopened.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
    }

    const committed = reopened.append({ kind: 'upsert', family: 'thread', entityId: 'after-crash' })
    expect(committed.kind).toBe('appended')
    if (committed.kind !== 'appended') return
    const final = new HostDeltaStore({ dataDir })
    expect(final.getPosition()).toEqual({ ...position, cursor: position.cursor + 1 })
    expect(final.getByCursor(position.cursor + 1)).toEqual(committed.record)
    expect(final.getRecoveryState().recoveryState).toBe('clean')
  })
})
