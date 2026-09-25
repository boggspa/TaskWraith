import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostCommandReceiptStore, type HostCommandReceiptRecord } from './HostCommandReceiptStore'
import { HostDeltaStore, type HostDeltaCompactionStage } from './HostDeltaStore'
import { HOST_TRANSACTION_LOG_FILENAME, HostTransactionLog } from './HostTransactionLog'
import {
  decideHostTransactionRecovery,
  hostTransactionRecordsCompactable,
  type HostFileIdentity,
  type HostTransactionRecoveryAction,
  type HostTransactionRecoveryInput
} from './HostTransactionManifest'
import type { HostCursorPosition } from '../shared/hostProtocol'

// M4 slice 10 (design §19): the transaction crash harness. A bundled Node
// writer runs the transactional persist's durable steps against the real
// receipt store, transaction log and delta store in one data directory, and
// SIGKILLs itself at one of Appendix D's kill points. The test process then
// runs a stub recovery driver in RR-2's boot order over the killed directory
// and checks the kill point's outcome, that a second run decides `none` and
// writes nothing, and that compaction of terminal commands changes nothing.
// Process-crash recovery only: the page cache survives, so a kill after a
// write and before its fsync keeps the bytes.
//
// Observational collapses under process-crash semantics (each is pinned as
// the row it lands on, and noted at its case):
// - K2 (killed inside the prepare's fsync) and K3 (after it) both keep the
//   prepare line, so both are D4 with an abort record;
// - K4 (before the directory fsync) and K5 (before the group write) both
//   show the committed record with no group, so both are D1;
// - K7 (before `awaitDurable`) and K10 (after it) both keep the whole group
//   line, so both are D3 completing at the group's end.

type ExecutorCut = 'K1' | 'K2' | 'K3' | 'K4' | 'K5' | 'K6' | 'K7' | 'K8' | 'K9' | 'K10'
type Cut =
  | ExecutorCut
  | `K11:${HostDeltaCompactionStage}`
  | 'K12:fence-only'
  | 'K12:envelope-prefix'

interface HarnessCase {
  cut: Cut
  prior: 'absent' | 'present'
  effects: 'one' | 'none'
  /** Re-run `appendGroup` for the same command with other effects before the cut. */
  duplicate: boolean
}

const NOW = '2026-09-25T15:00:00.000Z'
const THREAD = 't-1'
const EPOCH = { hostIncarnation: 'crash-harness-incarnation', deleteCounter: 0 }
const ACTOR = {
  actorId: 'harness-actor',
  clientId: 'harness-client',
  clientClass: 'desktop' as const
}
const RESET_POSITION: HostCursorPosition = { generation: 2, cursor: 1 }

const EXECUTOR_CUTS: ExecutorCut[] = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10']
const GROUP_CUTS: ExecutorCut[] = ['K5', 'K6', 'K7', 'K8', 'K9', 'K10']
const COMPACTION_STAGES: HostDeltaCompactionStage[] = [
  'rotated',
  'checkpoint-written',
  'checkpoint-renamed'
]

const CASES: HarnessCase[] = [
  ...(['absent', 'present'] as const).flatMap((prior) =>
    EXECUTOR_CUTS.map((cut) => ({ cut, prior, effects: 'one' as const, duplicate: false }))
  ),
  ...(['absent', 'present'] as const).flatMap((prior) =>
    GROUP_CUTS.map((cut) => ({ cut, prior, effects: 'none' as const, duplicate: false }))
  ),
  ...(['K7', 'K8', 'K9', 'K10'] as const).map((cut) => ({
    cut,
    prior: 'present' as const,
    effects: 'one' as const,
    duplicate: true
  })),
  ...COMPACTION_STAGES.map((stage) => ({
    cut: `K11:${stage}` as const,
    prior: 'absent' as const,
    effects: 'one' as const,
    duplicate: false
  })),
  ...(['absent', 'present'] as const).flatMap((prior) =>
    (['K12:fence-only', 'K12:envelope-prefix'] as const).map((cut) => ({
      cut,
      prior,
      effects: 'one' as const,
      duplicate: false
    }))
  )
]

function caseName(harnessCase: HarnessCase): string {
  return `${harnessCase.cut} prior-${harnessCase.prior} effects-${harnessCase.effects}${
    harnessCase.duplicate ? ' duplicate-group' : ''
  }`
}

const modulePath = (name: string) => JSON.stringify(join(__dirname, name))

/**
 * The stub executor (§19), bundled once. Arguments: dataDir, cut, prior,
 * effects, duplicate. It kills itself at the named cut, through a seam or
 * between steps, after writing `cut-reached`; any other exit writes
 * `writer-failed` with the reason.
 */
const WRITER_SOURCE = `
  const fs = require('node:fs');
  const { join } = require('node:path');
  const { createHash } = require('node:crypto');
  const { open: openAsync } = require('node:fs/promises');
  const { HostDeltaStore } = require(${modulePath('HostDeltaStore.ts')});
  const { HostCommandReceiptStore } = require(${modulePath('HostCommandReceiptStore.ts')});
  const { HostTransactionLog } = require(${modulePath('HostTransactionLog.ts')});
  const { decideHostTransactionRecovery } = require(${modulePath('HostTransactionManifest.ts')});

  const [dataDir, cut, prior, effectsMode, duplicate] = process.argv.slice(2);
  const [cutKind, cutStage] = cut.split(':');
  const now = () => ${JSON.stringify(NOW)};
  let clock = 1000;
  const at = () => clock++;
  const EPOCH = ${JSON.stringify(EPOCH)};
  const ACTOR = ${JSON.stringify(ACTOR)};
  const THREAD = ${JSON.stringify(THREAD)};
  const chatsDir = join(dataDir, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const chatPath = (threadId) => join(chatsDir, threadId + '.json');

  const stop = () => {
    fs.writeFileSync(join(dataDir, 'cut-reached'), cut);
    process.kill(process.pid, 'SIGKILL');
    throw new Error('kill did not stop writer');
  };
  const fail = (message) => {
    fs.writeFileSync(join(dataDir, 'writer-failed'), message);
    process.exit(1);
  };
  const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  const fsyncPathSync = (path) => {
    const fd = fs.openSync(path, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const fsyncPathAsync = async (path) => {
    const handle = await openAsync(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const identityOf = (path) => {
    try {
      const stat = fs.lstatSync(path, { bigint: true });
      return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size) };
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };

  // One-shot cut on the delta store's journal write seam, armed right before
  // the write it cuts (the seam is shared by seeds, groups and resets).
  let armedWrite = null;
  const batchWrite = (fd, bytes, offset, length) => {
    if (armedWrite) {
      const cutWrite = armedWrite;
      armedWrite = null;
      return cutWrite(fd, bytes, offset, length);
    }
    return fs.writeSync(fd, bytes, offset, length, null);
  };
  const writePrefix = (fd, bytes, offset, count) => {
    let written = 0;
    while (written < count) written += fs.writeSync(fd, bytes, offset + written, count - written, null);
  };

  function makeStores(options) {
    const deltas = new HostDeltaStore({
      dataDir,
      now,
      compactAfterRecords: 10000,
      batchWrite,
      onCompactionStage: options.onCompactionStage
    });
    const receipts = new HostCommandReceiptStore({
      dataDir,
      now,
      getPosition: () => deltas.getPosition(),
      compactAfterRecords: 1000,
      scheduleCompaction: () => {}
    });
    const log = HostTransactionLog.open({
      dataDir,
      fsync: async (path) => {
        if (options.killAtLogFsync) stop();
        await fsyncPathAsync(path);
      }
    });
    return { deltas, receipts, log };
  }

  // §19's executor steps for one command, the live order (NH-1: published
  // before the receipt). Kill points apply only when spec.kills is set.
  async function persist(stores, spec) {
    const { deltas, receipts, log } = stores;
    const { commandId, threadId } = spec;
    const k = (name) => spec.kills && cut === name;

    // 1. receipt begin, class txn-record-persist.
    const begun = receipts.begin({
      commandId,
      idempotencyKey: commandId + '-key',
      commandName: 'thread.record.persist',
      commandFingerprint: sha256(commandId),
      actor: ACTOR,
      target: { kind: 'thread', id: threadId },
      authority: { decision: 'allowed' },
      commandClass: 'txn-record-persist'
    });
    if (begun.kind !== 'created') fail('begin: ' + JSON.stringify(begun));

    // 2. the artifact: write, fsync, read back its identity.
    const target = chatPath(threadId);
    const priorIdentity = identityOf(target);
    const artifact = target + '.' + commandId + '.tmp';
    fs.writeFileSync(
      artifact,
      JSON.stringify({ id: threadId, revision: spec.resultingRevision, title: spec.title }) + '\\n'
    );
    fsyncPathSync(artifact);
    const resulting = identityOf(artifact);
    fs.writeFileSync(
      join(dataDir, 'harness-identities-' + commandId + '.json'),
      JSON.stringify({ prior: priorIdentity, resulting })
    );
    if (k('K1')) stop();

    // 3. prepare, awaited (K2 is the log's fsync seam).
    const prepared = await log.append({
      kind: 'prepare',
      commandId,
      threadId,
      epoch: EPOCH,
      expectedRevision: spec.resultingRevision - 1,
      resultingRevision: spec.resultingRevision,
      prior: priorIdentity,
      resulting,
      effects: { count: spec.effects.length, setDigest: sha256(JSON.stringify(spec.effects)) },
      preparedAt: at()
    });
    if (prepared.kind !== 'durable') fail('prepare: ' + JSON.stringify(prepared));
    if (k('K3')) stop();

    // 4. the commit: rename, then the directory fsync.
    fs.renameSync(artifact, target);
    if (k('K4')) stop();
    fsyncPathSync(chatsDir);
    if (spec.haltAfterCommit) return null;

    // 5. the group line, written and not fsynced.
    if (k('K5')) stop();
    if (k('K6')) {
      armedWrite = (fd, bytes, offset, length) => {
        writePrefix(fd, bytes, offset, Math.min(17, length));
        stop();
      };
    }
    const appended = deltas.appendGroup({ commandId, effects: spec.effects });
    if (appended.kind !== 'appended') fail('appendGroup: ' + JSON.stringify(appended));
    if (spec.duplicate) {
      const again = deltas.appendGroup({
        commandId,
        effects: [{ kind: 'upsert', family: 'thread', entityId: threadId, payload: { title: 'Conflicting' } }]
      });
      if (again.kind !== 'exists' || JSON.stringify(again.group) !== JSON.stringify(appended.group)) {
        fail('duplicate appendGroup: ' + JSON.stringify(again));
      }
    }
    if (k('K7')) stop();

    // 6. durability.
    const durable = await deltas.awaitDurable();
    if (durable.kind !== 'durable') fail('awaitDurable: ' + JSON.stringify(durable));
    if (k('K10')) stop();
    if (spec.haltAfterDurable) return appended.group;

    // 7. published at the group's end, awaited.
    const published = await log.append({
      kind: 'published',
      commandId,
      position: appended.group.end,
      at: at()
    });
    if (published.kind !== 'durable') fail('published: ' + JSON.stringify(published));
    if (k('K8')) stop();

    // 8. the receipt, at the group's end.
    receipts.complete({ commandId, status: 'succeeded', position: appended.group.end });
    if (k('K9')) stop();
    return appended.group;
  }

  (async () => {
    const stores = makeStores({
      killAtLogFsync: cut === 'K2',
      onCompactionStage: async (stage) => {
        if (cutKind === 'K11' && stage === cutStage) stop();
      }
    });
    let revision = 0;
    if (prior === 'present') {
      // An earlier persist left the record at revision 1, and its delta.
      fs.writeFileSync(chatPath(THREAD), JSON.stringify({ id: THREAD, revision: 1, title: 'Prior' }) + '\\n');
      fsyncPathSync(chatPath(THREAD));
      fsyncPathSync(chatsDir);
      const seeded = stores.deltas.append({
        kind: 'upsert',
        family: 'thread',
        entityId: THREAD,
        payload: { title: 'Prior' }
      });
      if (seeded.kind !== 'appended') fail('seed: ' + JSON.stringify(seeded));
      revision = 1;
    }
    const effectsFor = (title) =>
      effectsMode === 'none'
        ? []
        : [{ kind: 'upsert', family: 'thread', entityId: THREAD, payload: { title } }];

    if (cutKind === 'K11') {
      await persist(stores, {
        commandId: 'cmd-1',
        threadId: THREAD,
        resultingRevision: revision + 1,
        title: 'First',
        effects: effectsFor('First'),
        kills: false
      });
      await persist(stores, {
        commandId: 'cmd-2',
        threadId: THREAD,
        resultingRevision: revision + 2,
        title: 'Second',
        effects: effectsFor('Second'),
        kills: false,
        haltAfterDurable: true
      });
      const result = await stores.deltas.compactInBackground();
      fail('compaction was not cut: ' + JSON.stringify(result));
    }

    if (cutKind === 'K12') {
      // A D1 state: committed, no group. Then a recovery whose reset is cut.
      await persist(stores, {
        commandId: 'cmd-1',
        threadId: THREAD,
        resultingRevision: revision + 1,
        title: 'Committed',
        effects: effectsFor('Committed'),
        kills: false,
        haltAfterCommit: true
      });
      const fresh = makeStores({});
      const entry = fresh.log.get('cmd-1');
      const receipt = fresh.receipts.list().find((record) => record.commandId === 'cmd-1');
      if (!entry || !receipt) fail('K12 state is missing its prepare or receipt');
      const decision = decideHostTransactionRecovery({
        receipt: {
          status: receipt.status,
          recoveryState: receipt.recoveryState ?? null,
          commandClass: receipt.commandClass
        },
        prepare: entry.prepare,
        terminal: entry.terminal,
        observed: identityOf(chatPath(THREAD)),
        group: fresh.deltas.findGroup('cmd-1')
      });
      if (decision.action !== 'reset_and_complete') fail('K12 decision: ' + JSON.stringify(decision));
      armedWrite = (fd, bytes, offset, length) => {
        // The batch is the fence line then the reset envelope line.
        const fenceEnd = bytes.indexOf(10, offset) + 1 - offset;
        const count = cutStage === 'fence-only' ? fenceEnd : Math.min(length, fenceEnd + 17);
        writePrefix(fd, bytes, offset, count);
        stop();
      };
      const reset = fresh.deltas.resetGeneration('transaction recovery');
      fail('reset was not cut: ' + JSON.stringify(reset));
    }

    await persist(stores, {
      commandId: 'cmd-1',
      threadId: THREAD,
      resultingRevision: revision + 1,
      title: 'Persisted',
      effects: effectsFor('Persisted'),
      kills: true,
      duplicate: duplicate === 'duplicate'
    });
    fail('crash boundary was not reached');
  })().catch((error) => fail(String((error && error.stack) || error)));
`

interface Stores {
  deltas: HostDeltaStore
  receipts: HostCommandReceiptStore
  log: HostTransactionLog
}

interface DriverRun {
  decisions: Map<string, HostTransactionRecoveryAction>
  stores: Stores
}

describe.skipIf(process.platform === 'win32')(
  'Host transaction crash harness (M4 slice 10)',
  () => {
    let root: string
    let executable: string

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'host-transaction-crash-harness-'))
      executable = join(root, 'writer.cjs')
      buildSync({
        stdin: {
          contents: WRITER_SOURCE,
          resolveDir: process.cwd(),
          sourcefile: 'host-transaction-crash-harness-writer.cjs',
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

    const now = () => '2026-09-25T16:00:00.000Z'
    let recordClock = 5000

    function killWriter(harnessCase: HarnessCase): string {
      const dataDir = join(root, caseName(harnessCase).replace(/[^A-Za-z0-9-]+/g, '_'))
      mkdirSync(dataDir)
      const killed = spawnSync(
        process.execPath,
        [
          executable,
          dataDir,
          harnessCase.cut,
          harnessCase.prior,
          harnessCase.effects,
          harnessCase.duplicate ? 'duplicate' : 'single'
        ],
        { cwd: root, encoding: 'utf8', timeout: 15_000 }
      )
      expect(killed.error).toBeUndefined()
      expect(killed.stderr).toBe('')
      const failed = join(dataDir, 'writer-failed')
      expect(existsSync(failed) ? readFileSync(failed, 'utf8') : null).toBeNull()
      expect(readFileSync(join(dataDir, 'cut-reached'), 'utf8')).toBe(harnessCase.cut)
      expect(killed.signal).toBe('SIGKILL')
      return dataDir
    }

    function chatPath(dataDir: string, threadId: string): string {
      return join(dataDir, 'chats', `${threadId}.json`)
    }

    function readIdentity(path: string): HostFileIdentity | null {
      try {
        const stat = lstatSync(path, { bigint: true })
        return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }

    function writerIdentities(
      dataDir: string,
      commandId: string
    ): { prior: HostFileIdentity | null; resulting: HostFileIdentity } {
      return JSON.parse(
        readFileSync(join(dataDir, `harness-identities-${commandId}.json`), 'utf8')
      ) as { prior: HostFileIdentity | null; resulting: HostFileIdentity }
    }

    function openStores(dataDir: string): Stores {
      const deltas = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10_000 })
      const receipts = new HostCommandReceiptStore({
        dataDir,
        now,
        getPosition: () => deltas.getPosition(),
        compactAfterRecords: 1000,
        scheduleCompaction: () => {}
      })
      const log = HostTransactionLog.open({ dataDir })
      return { deltas, receipts, log }
    }

    function receiptOf(stores: Stores, commandId: string): HostCommandReceiptRecord | null {
      return stores.receipts.list().find((record) => record.commandId === commandId) ?? null
    }

    function receiptInput(
      record: HostCommandReceiptRecord | null
    ): HostTransactionRecoveryInput['receipt'] {
      if (!record) return null
      return {
        status: record.status,
        recoveryState: record.recoveryState ?? null,
        commandClass: record.commandClass ?? 'legacy-observed'
      }
    }

    function recoveryInput(
      dataDir: string,
      stores: Stores,
      commandId: string
    ): HostTransactionRecoveryInput {
      const record = receiptOf(stores, commandId)
      const entry = stores.log.get(commandId)
      const threadId = entry?.prepare?.threadId ?? record?.target.id ?? THREAD
      return {
        receipt: receiptInput(record),
        prepare: entry?.prepare ?? null,
        terminal: entry?.terminal ?? null,
        observed: readIdentity(chatPath(dataDir, threadId)),
        group: (() => {
          const group = stores.deltas.findGroup(commandId)
          return group ? { count: group.count, setDigest: group.setDigest, end: group.end } : null
        })()
      }
    }

    async function appendDurable(stores: Stores, record: unknown): Promise<void> {
      const result = await stores.log.append(record)
      if (result.kind !== 'durable' && result.kind !== 'duplicate') {
        throw new Error(`manifest append failed: ${JSON.stringify(result)}`)
      }
    }

    /**
     * The stub recovery driver (§19), on fresh store instances, in RR-2's boot
     * order: decide everything; apply every D3 and D4; one reset, then every
     * D1 at it; then the indeterminates.
     */
    async function runDriver(dataDir: string): Promise<DriverRun> {
      const stores = openStores(dataDir)
      // Reopen leaves a transactional receipt pending for the manifest to
      // decide; it never promotes one to a recoverable indeterminate.
      for (const record of stores.receipts.list()) {
        if (record.commandClass !== 'txn-record-persist') continue
        expect(record.status).not.toBe('indeterminate')
        expect(record).not.toHaveProperty('recoveryState')
      }
      const commandIds = new Set<string>([
        ...stores.receipts.list().map((record) => record.commandId),
        ...stores.log.commandIds()
      ])
      const decisions = new Map<string, HostTransactionRecoveryAction>()
      for (const commandId of commandIds) {
        decisions.set(
          commandId,
          decideHostTransactionRecovery(recoveryInput(dataDir, stores, commandId))
        )
      }

      for (const [commandId, decision] of decisions) {
        if (decision.action === 'complete_at_position') {
          // NH-1's order: the manifest's mark, then the receipt.
          if (decision.markPublished) {
            await appendDurable(stores, {
              kind: 'published',
              commandId,
              position: decision.position,
              at: recordClock++
            })
          }
          stores.receipts.complete({ commandId, status: 'succeeded', position: decision.position })
        } else if (decision.action === 'mark_published') {
          await appendDurable(stores, {
            kind: 'published',
            commandId,
            position: decision.position,
            at: recordClock++
          })
        } else if (decision.action === 'fail_interrupted') {
          if (decision.writeAbort) {
            await appendDurable(stores, {
              kind: 'abort',
              commandId,
              reason: 'interrupted',
              at: recordClock++
            })
          }
          if (decision.completeReceipt) {
            stores.receipts.complete({ commandId, status: 'failed', errorCode: 'interrupted' })
          }
        }
      }

      const resets = [...decisions].filter(
        ([, decision]) => decision.action === 'reset_and_complete'
      )
      if (resets.length > 0) {
        const reset = stores.deltas.resetGeneration('transaction recovery')
        if (reset.kind !== 'appended') throw new Error(`reset was ${reset.kind}`)
        for (const [commandId] of resets) {
          await appendDurable(stores, {
            kind: 'published',
            commandId,
            position: reset.position,
            at: recordClock++
          })
          stores.receipts.complete({ commandId, status: 'succeeded', position: reset.position })
        }
      }

      for (const [commandId, decision] of decisions) {
        if (decision.action !== 'indeterminate') continue
        if (stores.log.get(commandId)?.prepare) {
          await appendDurable(stores, {
            kind: 'indeterminate',
            commandId,
            reason: decision.reason,
            at: recordClock++
          })
        }
        if (receiptOf(stores, commandId)?.status === 'pending') {
          stores.receipts.markIndeterminate({
            commandId,
            position: stores.deltas.getPosition(),
            errorCode: 'transaction_recovery_indeterminate'
          })
        }
      }
      return { decisions, stores }
    }

    function snapshotFiles(dataDir: string): Map<string, string> {
      const files = new Map<string, string>()
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) walk(path)
          else files.set(relative(dataDir, path), readFileSync(path).toString('hex'))
        }
      }
      walk(dataDir)
      return files
    }

    /** Every delta journal file (active, sealed) as its lines. */
    function deltaJournalLines(dataDir: string): string[] {
      return readdirSync(dataDir)
        .filter((name) => name.startsWith('host-deltas.journal') && name.endsWith('.jsonl'))
        .sort()
        .flatMap((name) =>
          readFileSync(join(dataDir, name), 'utf8')
            .split('\n')
            .filter((line) => line.length > 0)
        )
    }

    function groupLines(dataDir: string, commandId: string): number {
      return deltaJournalLines(dataDir).filter((line) => {
        const event = JSON.parse(line) as { op: string; commandId?: string }
        return event.op === 'group' && event.commandId === commandId
      }).length
    }

    function resetLines(dataDir: string): number {
      return deltaJournalLines(dataDir).filter(
        (line) => (JSON.parse(line) as { op: string }).op === 'generation-reset'
      ).length
    }

    function expectReceiptAt(
      record: HostCommandReceiptRecord | null,
      status: 'succeeded' | 'failed',
      position?: HostCursorPosition
    ): void {
      expect(record?.status).toBe(status)
      expect(record?.commandClass).toBe('txn-record-persist')
      expect(record).not.toHaveProperty('recoveryState')
      if (position) {
        expect({ generation: record?.generation, cursor: record?.cursor }).toEqual(position)
      }
    }

    function decisionOf(run: DriverRun, commandId: string): HostTransactionRecoveryAction {
      const decision = run.decisions.get(commandId)
      if (!decision) throw new Error(`no decision for ${commandId}`)
      return decision
    }

    /** §19's every-point invariants: the second run is a no-op, and so is the third after compaction. */
    async function expectRecoveryIsDone(dataDir: string, commandIds: string[]): Promise<void> {
      const before = snapshotFiles(dataDir)
      const second = await runDriver(dataDir)
      expect([...second.decisions.keys()].sort()).toEqual([...commandIds].sort())
      for (const commandId of commandIds) {
        expect(decisionOf(second, commandId)).toEqual({ action: 'none' })
      }
      expect(snapshotFiles(dataDir)).toEqual(before)

      // Compaction may drop every command whose receipt is terminal.
      const terminal = commandIds.filter((commandId) =>
        hostTransactionRecordsCompactable(receiptInput(receiptOf(second.stores, commandId)))
      )
      expect(terminal).toEqual(commandIds)
      const manifested = commandIds.filter((commandId) => second.stores.log.get(commandId) !== null)
      const compacted = await second.stores.log.compact((commandId) =>
        receiptInput(receiptOf(second.stores, commandId))
      )
      expect(compacted).toEqual({
        kind: 'compacted',
        kept: 0,
        dropped: manifested.length,
        keptIndeterminate: 0
      })
      const third = await runDriver(dataDir)
      for (const commandId of commandIds) {
        expect(decisionOf(third, commandId)).toEqual({ action: 'none' })
        expect(third.stores.log.get(commandId)).toBeNull()
      }
    }

    it.each(CASES.map((harnessCase) => [caseName(harnessCase), harnessCase] as const))(
      '%s',
      async (_name, harnessCase) => {
        const dataDir = killWriter(harnessCase)
        const [cutKind] = harnessCase.cut.split(':') as [string, string?]
        const chat = chatPath(dataDir, THREAD)
        const effectCount = harnessCase.effects === 'one' ? 1 : 0
        const seedCursor = harnessCase.prior === 'present' ? 1 : 0

        const first = await runDriver(dataDir)

        if (cutKind === 'K11') {
          // cmd-1 finished; cmd-2's group is durable with no published record
          // and a pending receipt, and the compaction was cut at a stage.
          const one = writerIdentities(dataDir, 'cmd-1')
          const two = writerIdentities(dataDir, 'cmd-2')
          expect(one.prior).toBeNull()
          expect(two.prior).toEqual(one.resulting)
          const groupOne = first.stores.deltas.findGroup('cmd-1')
          const groupTwo = first.stores.deltas.findGroup('cmd-2')
          expect(groupOne).toMatchObject({
            count: 1,
            end: { generation: 1, cursor: 1 },
            durable: true
          })
          expect(groupTwo).toMatchObject({
            count: 1,
            end: { generation: 1, cursor: 2 },
            durable: true
          })
          expect(decisionOf(first, 'cmd-1')).toEqual({ action: 'none' })
          expect(decisionOf(first, 'cmd-2')).toEqual({
            action: 'complete_at_position',
            row: 'D3',
            position: { generation: 1, cursor: 2 },
            markPublished: true
          })
          expect(readIdentity(chat)).toEqual(two.resulting)
          expectReceiptAt(receiptOf(first.stores, 'cmd-1'), 'succeeded', {
            generation: 1,
            cursor: 1
          })
          expectReceiptAt(receiptOf(first.stores, 'cmd-2'), 'succeeded', {
            generation: 1,
            cursor: 2
          })
          expect(first.stores.log.get('cmd-2')?.terminal).toMatchObject({
            kind: 'published',
            position: { generation: 1, cursor: 2 }
          })
          expect(first.stores.deltas.getPosition()).toEqual({ generation: 1, cursor: 2 })
          expect(groupLines(dataDir, 'cmd-1')).toBe(1)
          expect(groupLines(dataDir, 'cmd-2')).toBe(1)
          expect(resetLines(dataDir)).toBe(0)
          await expectRecoveryIsDone(dataDir, ['cmd-1', 'cmd-2'])
          return
        }

        const identities = writerIdentities(dataDir, 'cmd-1')
        if (harnessCase.prior === 'present') expect(identities.prior).not.toBeNull()
        else expect(identities.prior).toBeNull()
        const decision = decisionOf(first, 'cmd-1')
        const receipt = receiptOf(first.stores, 'cmd-1')
        const entry = first.stores.log.get('cmd-1')

        if (cutKind === 'K12') {
          // The cut reset (a lone fence, or a fence with a torn envelope) is
          // discarded as a truncated tail: the state is D1 again, and this
          // driver run is the "second" one that completes it.
          expect(first.stores.deltas.getRecoveryState().recoveryState).toBe(
            'recovered-truncated-tail'
          )
          expect(decision).toEqual({ action: 'reset_and_complete', row: 'D1' })
          expect(readIdentity(chat)).toEqual(identities.resulting)
          expectReceiptAt(receipt, 'succeeded', RESET_POSITION)
          expect(entry?.terminal).toMatchObject({ kind: 'published', position: RESET_POSITION })
          expect(first.stores.deltas.findGroup('cmd-1')).toBeNull()
          expect(groupLines(dataDir, 'cmd-1')).toBe(0)
          expect(resetLines(dataDir)).toBe(1)
          const reopened = new HostDeltaStore({ dataDir, now })
          expect(reopened.getPosition()).toEqual(RESET_POSITION)
          expect(reopened.getRecoveryState().recoveryState).toBe('clean')
          await expectRecoveryIsDone(dataDir, ['cmd-1'])
          return
        }

        switch (harnessCase.cut as ExecutorCut) {
          case 'K1':
          case 'K2':
          case 'K3': {
            // D4: interrupted before the commit. K1 never prepared; K2 and K3
            // both keep the prepare line (a process crash keeps the page cache).
            expect(decision).toEqual({
              action: 'fail_interrupted',
              row: 'D4',
              writeAbort: harnessCase.cut !== 'K1',
              completeReceipt: true
            })
            expect(readIdentity(chat)).toEqual(identities.prior)
            expect(first.stores.deltas.findGroup('cmd-1')).toBeNull()
            expect(groupLines(dataDir, 'cmd-1')).toBe(0)
            expectReceiptAt(receipt, 'failed')
            expect(receipt?.errorCode).toBe('interrupted')
            if (harnessCase.cut === 'K1') {
              expect(entry).toBeNull()
              expect(existsSync(join(dataDir, HOST_TRANSACTION_LOG_FILENAME))).toBe(false)
            } else {
              expect(entry?.prepare).toMatchObject({
                prior: identities.prior,
                resulting: identities.resulting,
                expectedRevision: seedCursor,
                resultingRevision: seedCursor + 1
              })
              expect(entry?.terminal).toMatchObject({ kind: 'abort', reason: 'interrupted' })
            }
            expect(first.stores.deltas.getPosition()).toEqual({ generation: 1, cursor: seedCursor })
            break
          }
          case 'K4':
          case 'K5':
          case 'K6': {
            // D1: committed, and no whole group. K6's torn line is repaired away
            // on reopen and never visible; K4 and K5 wrote nothing.
            expect(decision).toEqual({ action: 'reset_and_complete', row: 'D1' })
            expect(first.stores.deltas.getRecoveryState().recoveryState).toBe(
              harnessCase.cut === 'K6' ? 'recovered-truncated-tail' : 'clean'
            )
            expect(readIdentity(chat)).toEqual(identities.resulting)
            expectReceiptAt(receipt, 'succeeded', RESET_POSITION)
            expect(entry?.terminal).toMatchObject({ kind: 'published', position: RESET_POSITION })
            expect(first.stores.deltas.findGroup('cmd-1')).toBeNull()
            expect(first.stores.deltas.getPosition()).toEqual(RESET_POSITION)
            expect(groupLines(dataDir, 'cmd-1')).toBe(0)
            expect(resetLines(dataDir)).toBe(1)
            for (const line of deltaJournalLines(dataDir))
              expect(() => JSON.parse(line)).not.toThrow()
            break
          }
          case 'K7':
          case 'K8':
          case 'K9':
          case 'K10': {
            // D3: the whole group line survived, so completion is at its end,
            // with no second group and no reset. K7 and K10 both lack the
            // published record; K8 has it; K9 is already done.
            const end: HostCursorPosition = { generation: 1, cursor: seedCursor + effectCount }
            const group = first.stores.deltas.findGroup('cmd-1')
            expect(group).toMatchObject({
              commandId: 'cmd-1',
              count: effectCount,
              end,
              durable: true
            })
            const expected: HostTransactionRecoveryAction =
              harnessCase.cut === 'K9'
                ? { action: 'none' }
                : {
                    action: 'complete_at_position',
                    row: 'D3',
                    position: end,
                    markPublished: harnessCase.cut !== 'K8'
                  }
            expect(decision).toEqual(expected)
            expect(readIdentity(chat)).toEqual(identities.resulting)
            expectReceiptAt(receipt, 'succeeded', end)
            expect(entry?.terminal).toMatchObject({ kind: 'published', position: end })
            expect(first.stores.deltas.getPosition()).toEqual(end)
            expect(groupLines(dataDir, 'cmd-1')).toBe(1)
            expect(resetLines(dataDir)).toBe(0)
            if (harnessCase.duplicate) {
              // The conflicting re-run answered `exists` in the writer; the
              // driver never writes a second group either.
              expect(first.stores.deltas.appendGroup({ commandId: 'cmd-1', effects: [] })).toEqual({
                kind: 'exists',
                group
              })
              expect(groupLines(dataDir, 'cmd-1')).toBe(1)
            }
            break
          }
        }

        await expectRecoveryIsDone(dataDir, ['cmd-1'])
      }
    )
  }
)
