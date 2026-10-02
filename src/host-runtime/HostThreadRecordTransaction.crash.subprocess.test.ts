import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HostDeltaStore } from './HostDeltaStore'
import { HostCommandReceiptStore } from './HostCommandReceiptStore'
import { HostTransactionLog } from './HostTransactionLog'
import { recoverHostTransactions } from './HostTransactionRecovery'

const NOW = '2026-09-25T15:00:00.000Z'
const COMMAND = 'crash-command'
const THREAD = 'crash-thread'
const modulePath = (name: string) => JSON.stringify(join(__dirname, name))

// Only port wrappers choose a kill boundary. The production class owns every
// durable step, CAS, rename, publication and completion.
const writer = `
const fs = require('node:fs');
const { join } = require('node:path');
const { HostThreadRecordTransaction, createHostThreadRecordCommitPort } = require(${modulePath('HostThreadRecordTransaction.ts')});
const { HostProfileDomainStore } = require(${modulePath('HostProfileDomainStore.ts')});
const { HostDeltaStore } = require(${modulePath('HostDeltaStore.ts')});
const { HostCommandReceiptStore } = require(${modulePath('HostCommandReceiptStore.ts')});
const { HostTransactionLog } = require(${modulePath('HostTransactionLog.ts')});
const { HostPublicWindowIndex } = require(${modulePath('HostPublicWindowIndex.ts')});
const { createHostCommitGate } = require(${modulePath('HostCommitGate.ts')});
const { createHostScopeLedger, hostThreadScope } = require(${modulePath('HostScopeLedger.ts')});
const { prepareHostThreadRecord } = require(${modulePath('HostThreadRecordPrepare.ts')});
const { publishHostThreadRecordTransfer } = require(${modulePath('HostThreadRecordTransfer.ts')});
const [profilePath, cut, prior] = process.argv.slice(2);
const dataDir = join(profilePath, 'host-data');
const threadId = 'crash-thread', commandId = 'crash-command';
const now = () => '2026-09-25T15:00:00.000Z';
const identity = path => {
  if (!fs.existsSync(path)) return null;
  const s = fs.lstatSync(path, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino), size: Number(s.size) };
};
const chat = join(profilePath, 'chats', threadId + '.json');
const stop = () => {
  fs.writeFileSync(join(profilePath, 'cut-reached'), cut);
  process.kill(process.pid, 'SIGKILL');
};
(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new HostProfileDomainStore({
    profilePath, authority: { assertProfileAuthority() {} }, now: () => Date.parse(now()),
    idFactory: () => threadId
  });
  if (prior === 'present') store.createThread({ scope: 'global', title: 'Prior' });
  const record = { appChatId: threadId, scope: 'global', title: 'Result', archived: false,
    createdAt: 10, updatedAt: 20, messages: [], runs: [], persistenceRevision: 1 };
  const descriptor = publishHostThreadRecordTransfer({ profilePath, transferId: 'crash-transfer', record });
  const deltas = new HostDeltaStore({ dataDir, now, compactAfterRecords: 10000 });
  const receipts = new HostCommandReceiptStore({
    dataDir, now, getPosition: () => deltas.getPosition(),
    compactAfterRecords: 1000, scheduleCompaction() {}
  });
  receipts.begin({ commandId, idempotencyKey: 'crash-key', commandName: 'thread.record.persist',
    commandFingerprint: 'a'.repeat(64),
    actor: { actorId: 'actor', clientId: 'client', clientClass: 'desktop' },
    target: { kind: 'thread', id: threadId }, authority: { decision: 'allowed' },
    commandClass: 'txn-record-persist' });
  const log = HostTransactionLog.open({ dataDir });
  const ledger = createHostScopeLedger({ hostIncarnation: 'real-crash' });
  const records = createHostThreadRecordCommitPort({
    store, profilePath, beginTicket: async () => ({ finish() {}, fail() {} })
  });
  const priorIdentity = identity(chat);
  const transaction = new HostThreadRecordTransaction({
    ledger, gate: createHostCommitGate(), index: new HostPublicWindowIndex(),
    log: { append: async entry => {
      if (entry.kind === 'prepare') {
        fs.writeFileSync(join(profilePath, 'identities.json'),
          JSON.stringify({ prior: priorIdentity, resulting: entry.resulting }));
        if (cut === 'D4') stop();
      }
      if (entry.kind === 'published' && cut === 'D3') stop();
      const result = await log.append(entry);
      if (entry.kind === 'published' && cut === 'published-before-receipt') stop();
      return result;
    }},
    deltas: {
      appendGroup: input => deltas.appendGroup(input),
      awaitDurable: () => deltas.awaitDurable(),
      getPosition: () => deltas.getPosition(),
      resetGeneration: reason => deltas.resetGeneration(reason)
    },
    receipts,
    prepare: async input => prepareHostThreadRecord(input),
    records: { ...records, syncChatsDirectory: async id => {
      await records.syncChatsDirectory(id);
      if (cut === 'D1') stop();
      if (cut === 'D6') {
        const replacement = chat + '.unknown';
        fs.writeFileSync(replacement, JSON.stringify(record), { mode: 0o600 });
        fs.renameSync(replacement, chat);
        stop();
      }
    }},
    legacy: async () => { throw new Error('unexpected legacy'); },
    publicationLock: async work => work(),
    profilePath, now: () => Date.parse(now())
  });
  const result = await transaction.execute({
    commandId, threadId, descriptor, expectedRevision: 0,
    epoch: ledger.view(hostThreadScope(threadId)).epoch
  });
  if (cut === 'D5' && result.kind === 'succeeded') stop();
  throw new Error('cut not reached: ' + JSON.stringify(result));
})().catch(error => { fs.writeFileSync(join(profilePath, 'writer-failed'), String(error.stack)); process.exit(1); });
`

function identity(path: string) {
  if (!existsSync(path)) return null
  const stat = lstatSync(path, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) }
}

function files(path: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of readdirSync(path).sort()) {
    const relative = prefix + name
    const full = join(path, name)
    if (lstatSync(full).isDirectory()) Object.assign(result, files(full, relative + '/'))
    else result[relative] = readFileSync(full).toString('base64')
  }
  return result
}

describe('production transaction subprocess crash rows', () => {
  let root: string
  let executable: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'real-host-transaction-crash-'))
    executable = join(root, 'writer.cjs')
    buildSync({
      stdin: { contents: writer, resolveDir: __dirname, loader: 'js' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: executable
    })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const cases = (['D4', 'D1', 'D3', 'published-before-receipt', 'D5', 'D6'] as const).flatMap(
    (cut) => (['absent', 'present'] as const).map((prior) => ({ cut, prior }))
  )
  it.each(cases)(
    '$cut with $prior revision-zero base',
    async ({ cut, prior }) => {
      const profilePath = join(root, cut + '-' + prior)
      mkdirSync(profilePath)
      const child = spawnSync(process.execPath, [executable, profilePath, cut, prior], {
        timeout: 10000
      })
      expect(
        existsSync(join(profilePath, 'writer-failed'))
          ? readFileSync(join(profilePath, 'writer-failed'), 'utf8')
          : null
      ).toBeNull()
      expect(child.signal).toBe('SIGKILL')
      expect(readFileSync(join(profilePath, 'cut-reached'), 'utf8')).toBe(cut)
      const witnesses = JSON.parse(readFileSync(join(profilePath, 'identities.json'), 'utf8'))
      const chat = join(profilePath, 'chats', THREAD + '.json')
      const observed = identity(chat)
      if (cut === 'D4') expect(observed).toEqual(witnesses.prior)
      else if (cut === 'D6') {
        expect(observed).not.toEqual(witnesses.prior)
        expect(observed).not.toEqual(witnesses.resulting)
      } else expect(observed).toEqual(witnesses.resulting)

      const open = () => {
        const dataDir = join(profilePath, 'host-data')
        const deltas = new HostDeltaStore({ dataDir, now: () => NOW, compactAfterRecords: 10000 })
        const receipts = new HostCommandReceiptStore({
          dataDir,
          now: () => NOW,
          getPosition: () => deltas.getPosition(),
          compactAfterRecords: 1000,
          scheduleCompaction: () => {}
        })
        return { deltas, receipts, log: HostTransactionLog.open({ dataDir }) }
      }
      const stores = open()
      const group = stores.deltas.findGroup(COMMAND)
      const report = await recoverHostTransactions(
        { ...stores, profilePath, now: () => Date.parse(NOW) },
        { reset: 'when-needed' }
      )
      const action = report.decisions.get(COMMAND)
      if (cut === 'D5') expect(action?.action).toBe('none')
      else if (cut === 'D6')
        expect(action).toEqual({ action: 'indeterminate', reason: 'unknown_identity' })
      else expect(action).toMatchObject({ row: cut === 'published-before-receipt' ? 'D3' : cut })
      expect(report.reset).toEqual(cut === 'D1' ? { generation: 2, cursor: 1 } : null)
      const receipt = stores.receipts.list().find((entry) => entry.commandId === COMMAND)!
      expect(receipt.status).toBe(
        cut === 'D4' ? 'failed' : cut === 'D6' ? 'indeterminate' : 'succeeded'
      )
      const receiptPosition = { generation: receipt.generation, cursor: receipt.cursor }
      if (cut === 'D1') expect(receiptPosition).toEqual(report.reset)
      if (cut === 'published-before-receipt' || cut === 'D3' || cut === 'D5') {
        expect(group).not.toBeNull()
        expect(receiptPosition).toEqual(group!.end)
      }
      expect(identity(chat)).toEqual(observed)
      const before = files(profilePath)
      const reopened = open()
      const second = await recoverHostTransactions(
        { ...reopened, profilePath, now: () => Date.parse(NOW) },
        { reset: 'when-needed' }
      )
      expect(second.decisions.get(COMMAND)?.action).toBe('none')
      expect(second.reset).toBeNull()
      expect(files(profilePath)).toEqual(before)
    },
    20000
  )
})
