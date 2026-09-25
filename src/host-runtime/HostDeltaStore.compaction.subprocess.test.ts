import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  HostDeltaStore,
  HOST_DELTA_CHECKPOINT_FILENAME,
  hostDeltaGroupSetDigest,
  type HostDeltaCompactionStage
} from './HostDeltaStore'

// M4 slice 7c, design §15.6 K11: a real Node writer holding an unreleased
// open group is killed inside each compaction stage hook. After reopen the
// open group is found, positions and records are unchanged, the next append
// chains, and a second reopen is clean. A group released before the
// compaction is not found once the checkpoint that dropped it is renamed.
// These verify process-crash recovery, not survival of a machine power loss.
describe('Host delta compaction process crashes', () => {
  let root: string
  let executable: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'host-delta-compaction-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: {
        contents: `
          const { writeFileSync } = require('node:fs');
          const { join } = require('node:path');
          const { HostDeltaStore } = require(${JSON.stringify(join(__dirname, 'HostDeltaStore.ts'))});
          const [dataDir, cut] = process.argv.slice(2);
          const now = () => '2026-09-25T14:00:00.000Z';
          const stop = () => {
            writeFileSync(join(dataDir, 'cut-reached'), cut);
            process.kill(process.pid, 'SIGKILL');
            throw new Error('kill did not stop writer');
          };
          const fail = (message) => {
            writeFileSync(join(dataDir, 'writer-failed'), message);
            process.exit(1);
          };
          (async () => {
            const store = new HostDeltaStore({
              dataDir,
              now,
              compactAfterRecords: 10000,
              onCompactionStage: async (stage) => {
                if (stage === cut) stop();
              }
            });
            store.append({ kind: 'upsert', family: 'thread', entityId: 'seed-é', payload: { title: 'Seed' } });
            const open = store.appendGroup({
              commandId: 'cmd-open',
              effects: [
                { kind: 'upsert', family: 'thread', entityId: 'open-0', payload: { title: 'Open 0' } },
                { kind: 'upsert', family: 'thread', entityId: 'open-1', payload: { title: 'Open 1' } }
              ]
            });
            const released = store.appendGroup({
              commandId: 'cmd-released',
              effects: [
                { kind: 'upsert', family: 'thread', entityId: 'released-0', payload: { title: 'Released 0' } }
              ]
            });
            if (open.kind !== 'appended' || released.kind !== 'appended') {
              fail('group append: ' + JSON.stringify({ open, released }));
            }
            const durable = await store.awaitDurable();
            if (durable.kind !== 'durable') fail('durability: ' + JSON.stringify(durable));
            if (!store.releaseGroup('cmd-released')) fail('release returned false');
            const result = await store.compactInBackground();
            fail('crash boundary was not reached: ' + JSON.stringify(result));
          })().catch((error) => fail(String(error && error.stack || error)));
        `,
        resolveDir: process.cwd(),
        sourcefile: 'host-delta-compaction-crash-writer.cjs',
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

  const now = () => '2026-09-25T14:00:00.000Z'

  function killWriter(cut: HostDeltaCompactionStage) {
    const dataDir = join(root, cut)
    mkdirSync(dataDir)
    const killed = spawnSync(process.execPath, [executable, dataDir, cut], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(killed.error).toBeUndefined()
    expect(killed.stderr).toBe('')
    expect(existsSync(join(dataDir, 'writer-failed'))).toBe(false)
    expect(readFileSync(join(dataDir, 'cut-reached'), 'utf8')).toBe(cut)
    if (process.platform === 'win32') {
      expect(killed.signal === 'SIGKILL' || killed.status === 1).toBe(true)
    } else {
      expect(killed.signal).toBe('SIGKILL')
    }
    return dataDir
  }

  function expectOpenGroupIntact(dataDir: string) {
    const reopened = new HostDeltaStore({ dataDir, now })
    expect(reopened.getFailStop()).toBeNull()
    expect(reopened.getPosition()).toEqual({ generation: 1, cursor: 4 })
    expect(reopened.getAppendedPosition()).toEqual({ generation: 1, cursor: 4 })
    expect([1, 2, 3, 4].map((cursor) => reopened.getByCursor(cursor)?.envelope.entityId)).toEqual([
      'seed-é',
      'open-0',
      'open-1',
      'released-0'
    ])
    const open = {
      commandId: 'cmd-open',
      count: 2,
      setDigest: hostDeltaGroupSetDigest([
        reopened.getByCursor(2)!.contentFingerprint,
        reopened.getByCursor(3)!.contentFingerprint
      ]),
      start: { generation: 1, cursor: 2 },
      end: { generation: 1, cursor: 3 },
      durable: true
    }
    expect(reopened.findGroup('cmd-open')).toEqual(open)
    const since = reopened.since({ generation: 1, cursor: 0 })
    expect(since).toMatchObject({ kind: 'deltas', fromCursor: 0, toCursor: 4 })
    if (since.kind === 'deltas') {
      expect(since.deltas.map((delta) => [delta.cursor, delta.previousCursor])).toEqual([
        [1, 0],
        [2, 1],
        [3, 2],
        [4, 3]
      ])
    }
    expect(JSON.stringify(since)).not.toContain('"txn"')

    // The next append chains after the crash.
    const committed = reopened.append({
      kind: 'upsert',
      family: 'thread',
      entityId: 'after-crash',
      payload: { title: 'After' }
    })
    expect(committed).toMatchObject({
      kind: 'appended',
      position: { generation: 1, cursor: 5 }
    })
    if (committed.kind !== 'appended') throw new Error(`append was ${committed.kind}`)
    expect(committed.record.envelope.previousCursor).toBe(4)

    // A second reopen is clean and sees the same state plus the append.
    const final = new HostDeltaStore({ dataDir, now })
    expect(final.getRecoveryState().recoveryState).toBe('clean')
    expect(final.getFailStop()).toBeNull()
    expect(final.getPosition()).toEqual({ generation: 1, cursor: 5 })
    expect(final.getAppendedPosition()).toEqual({ generation: 1, cursor: 5 })
    expect(final.findGroup('cmd-open')).toEqual(open)
    expect(final.getByCursor(5)).toEqual(committed.record)
    expect(final.getByCursor(4)?.envelope.entityId).toBe('released-0')
    expect(final.findGroup('cmd-released')).toEqual(reopened.findGroup('cmd-released'))
    expect(final.appendGroup({ commandId: 'cmd-open', effects: [] })).toEqual({
      kind: 'exists',
      group: open
    })
    return { reopened, final }
  }

  it('K11 at rotated: the open group is found, state unchanged, the next append chains', () => {
    const dataDir = killWriter('rotated')
    expect(existsSync(join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME))).toBe(false)
    const { reopened } = expectOpenGroupIntact(dataDir)
    // No checkpoint recorded the release: the sealed segment replays the group.
    expect(reopened.findGroup('cmd-released')).toMatchObject({
      commandId: 'cmd-released',
      count: 1,
      start: { generation: 1, cursor: 4 },
      end: { generation: 1, cursor: 4 },
      durable: true
    })
  })

  it('K11 at checkpoint-written: the open group is found, state unchanged, the next append chains', () => {
    const dataDir = killWriter('checkpoint-written')
    expect(existsSync(join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME))).toBe(false)
    const { reopened } = expectOpenGroupIntact(dataDir)
    // The temp checkpoint was never renamed: the release is not yet recorded.
    expect(reopened.findGroup('cmd-released')).toMatchObject({
      commandId: 'cmd-released',
      start: { generation: 1, cursor: 4 },
      durable: true
    })
  })

  it('K11 at checkpoint-renamed: the open group is found and the released group is not', () => {
    const dataDir = killWriter('checkpoint-renamed')
    expect(existsSync(join(dataDir, HOST_DELTA_CHECKPOINT_FILENAME))).toBe(true)
    const { reopened, final } = expectOpenGroupIntact(dataDir)
    expect(reopened.findGroup('cmd-released')).toBeNull()
    expect(final.findGroup('cmd-released')).toBeNull()
    // The sealed segment the checkpoint covers adds nothing back.
    expect(reopened.getRecoveryState().recoveryState).toBe('clean')
    expect(final.appendGroup({ commandId: 'cmd-released', effects: [] })).toMatchObject({
      kind: 'appended',
      group: { commandId: 'cmd-released', count: 0 }
    })
  })
})
