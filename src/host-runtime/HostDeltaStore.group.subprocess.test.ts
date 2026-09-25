import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostDeltaStore, hostDeltaGroupSetDigest } from './HostDeltaStore'

// M4 slice 7a, design §15.2 K6 and K7: a real killed Node writer using the
// production store's journal I/O seam. K6 cuts the group line mid-write; K7
// lets the whole line reach the page cache and kills before any fsync. Both
// verify process-crash recovery, not survival of a machine power loss.
describe('Host delta group process crashes', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-delta-group-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const { writeSync, writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const { HostDeltaStore } = require(${JSON.stringify(join(__dirname, 'HostDeltaStore.ts'))});
          const [dataDir, cut] = process.argv.slice(2);
          const now = () => '2026-09-25T09:00:00.000Z';
          const seed = new HostDeltaStore({ dataDir, now });
          seed.append({ kind: 'upsert', family: 'thread', entityId: 'seed-é', payload: { title: 'Seed' } });
          const stop = () => {
            writeFileSync(join(dataDir, 'cut-reached'), cut);
            process.kill(process.pid, 'SIGKILL');
            throw new Error('kill did not stop writer');
          };
          const store = new HostDeltaStore({
            dataDir,
            now,
            batchWrite: (fd, bytes, offset, length) => {
              const count = cut === 'K6-mid-line' ? Math.min(17, length) : length;
              let written = 0;
              while (written < count) written += writeSync(fd, bytes, offset + written, count - written, null);
              if (cut === 'K6-mid-line') stop();
              return written;
            },
            batchFsync: () => { writeFileSync(join(dataDir, 'sync-fsync-called'), cut); },
            groupFsync: async () => { writeFileSync(join(dataDir, 'group-fsync-called'), cut); }
          });
          const result = store.appendGroup({
            commandId: 'cmd-crash',
            effects: [
              { kind: 'upsert', family: 'thread', entityId: 'group-0', payload: { title: 'Group 0' } },
              { kind: 'upsert', family: 'thread', entityId: 'group-1', payload: { title: 'Group 1' } }
            ]
          });
          if (cut === 'K7-before-fsync' && result.kind === 'appended') stop();
          throw new Error('crash boundary was not reached: ' + JSON.stringify(result));
        `,
        resolveDir: process.cwd(),
        sourcefile: 'host-delta-group-crash-writer.cjs',
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

  const now = () => '2026-09-25T09:00:00.000Z'

  function killWriter(cut: 'K6-mid-line' | 'K7-before-fsync') {
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
    // The group append itself never fsyncs, synchronously or otherwise.
    expect(existsSync(join(dataDir, 'sync-fsync-called'))).toBe(false)
    expect(existsSync(join(dataDir, 'group-fsync-called'))).toBe(false)
    return dataDir
  }

  function expectNextAppendChains(dataDir: string, reopened: HostDeltaStore) {
    const head = reopened.getPosition()
    const committed = reopened.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'after-crash',
      payload: { title: 'After' }
    })
    expect(committed).toMatchObject({
      kind: 'appended',
      position: { ...head, cursor: head.cursor + 1 }
    })
    if (committed.kind !== 'appended') return
    expect(committed.record.envelope.previousCursor).toBe(head.cursor)
    const final = new HostDeltaStore({ dataDir, now })
    expect(final.getPosition()).toEqual({ ...head, cursor: head.cursor + 1 })
    expect(final.getAppendedPosition()).toEqual(final.getPosition())
    expect(final.getByCursor(head.cursor + 1)).toEqual(committed.record)
    expect(final.getRecoveryState().recoveryState).toBe('clean')
    return final
  }

  it('K6: a writer killed mid-group line leaves no group, prior state intact, and the next append chains', () => {
    const dataDir = killWriter('K6-mid-line')

    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getRecoveryState().recoveryState).toBe('recovered-truncated-tail')
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(reopened.getAppendedPosition()).toEqual({ generation: 1, cursor: 1 })
    expect(reopened.findGroup('cmd-crash')).toBeNull()
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('seed-é')
    expect(reopened.getByCursor(2)).toBeNull()
    expect(reopened.since({ generation: 1, cursor: 0 })).toMatchObject({
      kind: 'deltas',
      toCursor: 1
    })

    const final = expectNextAppendChains(dataDir, reopened)
    expect(final?.findGroup('cmd-crash')).toBeNull()
    expect(final?.getByCursor(2)?.envelope.entityId).toBe('after-crash')
  })

  it('K7: a writer killed after the write and before any fsync leaves the group whole and found', () => {
    const dataDir = killWriter('K7-before-fsync')

    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getRecoveryState().recoveryState).toBe('clean')
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 3 })
    expect(reopened.getAppendedPosition()).toEqual({ generation: 1, cursor: 3 })
    const group = reopened.findGroup('cmd-crash')
    expect(group).toEqual({
      commandId: 'cmd-crash',
      count: 2,
      setDigest: hostDeltaGroupSetDigest([
        reopened.getByCursor(2)!.contentFingerprint,
        reopened.getByCursor(3)!.contentFingerprint
      ]),
      start: { generation: 1, cursor: 2 },
      end: { generation: 1, cursor: 3 },
      durable: true
    })
    expect(reopened.getByCursor(1)?.envelope.entityId).toBe('seed-é')
    expect(reopened.getByCursor(2)?.envelope.entityId).toBe('group-0')
    expect(reopened.getByCursor(3)?.envelope.entityId).toBe('group-1')
    const since = reopened.since({ generation: 1, cursor: 1 })
    expect(since).toMatchObject({ kind: 'deltas', fromCursor: 1, toCursor: 3 })
    if (since.kind !== 'deltas') return
    expect(since.deltas.map((delta) => [delta.cursor, delta.previousCursor])).toEqual([
      [2, 1],
      [3, 2]
    ])
    expect(JSON.stringify(since)).not.toContain('"txn"')
    expect(JSON.stringify(reopened.getByCursor(2))).not.toContain('"txn"')

    const final = expectNextAppendChains(dataDir, reopened)
    expect(final?.findGroup('cmd-crash')).toEqual(group)
    expect(final?.getByCursor(4)?.envelope.entityId).toBe('after-crash')
  })
})
