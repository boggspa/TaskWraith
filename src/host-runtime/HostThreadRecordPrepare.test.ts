/**
 * Independent Threads M4 slice 11: the transfer worker's pure prepare stage,
 * tested differentially against the legacy executor + store on twin profiles.
 * Every case runs the real `HostProfileRecordCommandExecutor` over a real
 * `HostProfileDomainStore` on profile A and `prepareHostThreadRecord` on an
 * identically seeded profile B, then compares codes, the adoption decision,
 * the bytes, the transfer directory file-for-file, the effects and the summary.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { withPeopleDonorMutationGate } from '../host-shared/thread-catalogue/PeopleDonorMutationGate'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostCommand
} from '../shared/hostProtocol'
import {
  HostProfileDomainStore,
  summarizeHostProfileThread,
  type HostProfileThread
} from './HostProfileDomainStore'
import { HostProfileRecordCommandExecutor } from './HostProfileRecordCommandExecutor'
import { modelHostThreadRecordEffects } from './HostThreadRecordEffectModel'
import {
  HOST_THREAD_RECORD_PREPARED_SUMMARY_MAX_BYTES,
  hostThreadRecordNormalizedTransferId,
  prepareHostThreadRecord,
  type HostThreadRecordPrepared,
  type HostThreadRecordPrepareInput,
  type HostThreadRecordPrepareResult
} from './HostThreadRecordPrepare'
import {
  hostThreadRecordTransferDirectory,
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer,
  type HostThreadRecordTransferDescriptor
} from './HostThreadRecordTransfer'
import { readHostThreadRecordTransfer } from './HostThreadRecordTransferWorker'

/**
 * A seam between artifact verification and body decoding, so a test can swap
 * the artifact's inode after it was verified and prove nobody removes the
 * substitute. Pass-through unless a test installs a hook.
 */
const substitution = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }))
vi.mock('./HostThreadRecordTransfer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HostThreadRecordTransfer')>()
  return {
    ...actual,
    decodeHostThreadRecordTransferBody: (body: Buffer) => {
      substitution.hook?.()
      return actual.decodeHostThreadRecordTransferBody(body)
    }
  }
})

const NOW = 1_760_000_000_000
const THREAD_ID = 'thread-1'
const TRANSFER_ID = 'transfer-1'
const POSIX = process.platform !== 'win32'

const roots: string[] = []

afterEach(() => {
  substitution.hook = undefined
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

interface Twin {
  readonly profilePath: string
  readonly store: HostProfileDomainStore
  readonly executor: HostProfileRecordCommandExecutor
}

function twin(): Twin {
  const profilePath = mkdtempSync(join(tmpdir(), 'host-thread-record-prepare-'))
  roots.push(profilePath)
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW
  })
  const executor = new HostProfileRecordCommandExecutor({
    profilePath,
    store,
    now: () => NOW,
    // The legacy read, synchronous and in-process: the same verify + decode +
    // inode-bound cleanup production runs on the worker.
    readTransfer: readHostThreadRecordTransfer
  })
  return { profilePath, store, executor }
}

function persistCommand(
  threadId: string,
  descriptor: HostThreadRecordTransferDescriptor,
  expectedRevision: number
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: `persist:${descriptor.transferId}`,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    name: 'thread.record.persist',
    target: { threadId },
    arguments: { ...descriptor, expectedRevision },
    issuedAt: '2026-09-25T00:00:00.000Z'
  }
}

type LooseRecord = Record<string, unknown>

function baseRecord(overrides: LooseRecord = {}): LooseRecord {
  return {
    appChatId: THREAD_ID,
    scope: 'global',
    title: 'Base',
    archived: false,
    createdAt: 10,
    messages: [
      { id: 'm1', role: 'user', content: 'hello there', timestamp: '2026-09-01T00:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'general', timestamp: '2026-09-01T00:00:01.000Z' }
    ],
    runs: [
      {
        runId: 'run-1',
        provider: 'codex',
        status: 'success',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:00:01.000Z'
      }
    ],
    updatedAt: 20,
    ...overrides
  }
}

function without(record: LooseRecord, key: string): LooseRecord {
  const { [key]: _dropped, ...rest } = record
  return rest
}

type Seed = 'none' | 'rev0' | 'rev2' | 'max'

function seed(store: HostProfileDomainStore, kind: Seed): void {
  if (kind === 'none') return
  store.persistThreadRecord({ threadId: THREAD_ID, record: baseRecord(), expectedRevision: 0 })
  if (kind === 'rev2') {
    store.persistThreadRecord({
      threadId: THREAD_ID,
      record: baseRecord({ title: 'Second' }),
      expectedRevision: 0
    })
    store.persistThreadRecord({
      threadId: THREAD_ID,
      record: baseRecord({ title: 'Third' }),
      expectedRevision: 1
    })
  } else if (kind === 'max') {
    store.persistThreadRecord({
      threadId: THREAD_ID,
      record: baseRecord({ title: 'Max', persistenceRevision: Number.MAX_SAFE_INTEGER }),
      expectedRevision: 0
    })
  }
}

function chatPath(profilePath: string, threadId = THREAD_ID): string {
  return join(profilePath, 'chats', `${threadId}.json`)
}

/** What the lane's revision cache would hold: the committed record's revision, or null. */
function currentRevisionOf(profilePath: string, threadId = THREAD_ID): number | null {
  const path = chatPath(profilePath, threadId)
  if (!existsSync(path)) return null
  const record = JSON.parse(readFileSync(path, 'utf8')) as { persistenceRevision?: number }
  return record.persistenceRevision ?? 0
}

function listing(profilePath: string): string[] {
  const directory = hostThreadRecordTransferDirectory(profilePath)
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

function artifactName(transferId: string): string {
  return `${transferId}.record.json`
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Publishes the same artifact on both twins; returns the descriptor and its bytes. */
function publishTwin(
  twins: readonly Twin[],
  record: LooseRecord,
  transferId = TRANSFER_ID
): { descriptor: HostThreadRecordTransferDescriptor; bytes: Buffer } {
  let descriptor: HostThreadRecordTransferDescriptor | undefined
  let bytes: Buffer | undefined
  for (const { profilePath } of twins) {
    const published = publishHostThreadRecordTransfer({ profilePath, transferId, record })
    const written = readFileSync(hostThreadRecordTransferPath(profilePath, transferId))
    if (descriptor) {
      expect(published).toEqual(descriptor)
      expect(written.equals(bytes!)).toBe(true)
    }
    descriptor = published
    bytes = written
  }
  return { descriptor: descriptor!, bytes: bytes! }
}

/** Writes raw bytes as an owner-only artifact on both twins, for non-record bodies. */
function writeRawTwin(
  twins: readonly Twin[],
  body: Buffer,
  transferId = TRANSFER_ID
): HostThreadRecordTransferDescriptor {
  for (const { profilePath } of twins) {
    // Publishing any record creates the owner-only directory; the body is then replaced.
    publishHostThreadRecordTransfer({ profilePath, transferId, record: {} })
    const path = hostThreadRecordTransferPath(profilePath, transferId)
    const temporary = `${path}.raw`
    writeFileSync(temporary, body, { mode: 0o600 })
    renameSync(temporary, path)
  }
  return { transferId, sha256: sha256(body), byteLength: body.byteLength }
}

interface Outcome {
  readonly legacy: { status: string; errorCode?: string; resultSummary?: string }
  readonly prepared: HostThreadRecordPrepareResult
  readonly legacyCode: string | null
  readonly preparedCode: string | null
}

async function runTwins(
  a: Twin,
  b: Twin,
  descriptor: HostThreadRecordTransferDescriptor,
  expectedRevision: number,
  threadId = THREAD_ID,
  extra: Partial<HostThreadRecordPrepareInput> = {}
): Promise<Outcome> {
  const legacy = (await a.executor.execute(
    persistCommand(threadId, descriptor, expectedRevision)
  )) as Outcome['legacy']
  const prepared = prepareHostThreadRecord({
    profilePath: b.profilePath,
    threadId,
    descriptor,
    expectedRevision,
    currentRevision: currentRevisionOf(b.profilePath, threadId),
    now: NOW,
    ...extra
  })
  return {
    legacy,
    prepared,
    legacyCode: legacy.status === 'failed' ? (legacy.errorCode ?? 'failed') : null,
    preparedCode: prepared.kind === 'rejected' ? prepared.errorCode : null
  }
}

function expectOwnerOnly(path: string): void {
  if (POSIX) expect(lstatSync(path).mode & 0o777).toBe(0o600)
}

/**
 * The full success comparison: adoption decision, artifact bytes, descriptor,
 * revision, effects and summary against the legacy twin's committed record.
 */
function expectPreparedMatchesLegacy(
  a: Twin,
  b: Twin,
  outcome: Outcome,
  originalBytes: Buffer,
  transferId = TRANSFER_ID
): HostThreadRecordPrepared {
  expect(outcome.legacy).toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })
  expect(outcome.prepared.kind).toBe('prepared')
  const prepared = outcome.prepared as HostThreadRecordPrepared
  const committed = a.store.getThread(THREAD_ID) as HostProfileThread
  expect(committed).not.toBeNull()
  const legacyBytes = readFileSync(chatPath(a.profilePath))
  const legacyDecision = legacyBytes.equals(originalBytes) ? 'original' : 'normalized'
  expect(prepared.artifact.source).toBe(legacyDecision)

  const artifactBytes = readFileSync(prepared.artifact.path)
  expect(artifactBytes.equals(legacyBytes)).toBe(true)
  expect(prepared.artifact.byteLength).toBe(artifactBytes.byteLength)
  expect(prepared.artifact.sha256).toBe(sha256(artifactBytes))
  const stat = lstatSync(prepared.artifact.path, { bigint: true })
  expect(prepared.artifact.identity).toEqual({ dev: String(stat.dev), ino: String(stat.ino) })
  expectOwnerOnly(prepared.artifact.path)

  expect(prepared.threadId).toBe(THREAD_ID)
  expect(prepared.persistenceRevision).toBe(committed.persistenceRevision)
  expect(prepared.effects).toEqual(modelHostThreadRecordEffects(committed))
  expect(prepared.summary).toEqual(summarizeHostProfileThread(committed))

  // Lifecycle: the legacy twin consumed its artifact either way; prepare keeps
  // exactly the one file the commit will rename.
  expect(listing(a.profilePath)).toEqual([])
  expect(prepared.artifact.path).toBe(
    hostThreadRecordTransferPath(
      b.profilePath,
      legacyDecision === 'original' ? transferId : hostThreadRecordNormalizedTransferId(transferId)
    )
  )
  expect(listing(b.profilePath)).toEqual([
    artifactName(
      legacyDecision === 'original' ? transferId : hostThreadRecordNormalizedTransferId(transferId)
    )
  ])
  return prepared
}

describe('prepareHostThreadRecord differential (contract §20.3 items 1, 2, 4)', () => {
  const successCorpus: Array<{
    name: string
    seed: Seed
    record: LooseRecord
    expectedRevision: number
    decision: 'original' | 'normalized'
    revision: number
  }> = [
    {
      name: 'fast path: revision stamped ahead of the CAS base adopts the original',
      seed: 'rev0',
      record: baseRecord({ title: 'Ahead', persistenceRevision: 1 }),
      expectedRevision: 0,
      decision: 'original',
      revision: 1
    },
    {
      name: 'legacy echo of the base revision is normalized to base + 1',
      seed: 'rev0',
      record: baseRecord({ title: 'Echo', persistenceRevision: 0 }),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 1
    },
    {
      name: 'omitted revision is normalized to base + 1',
      seed: 'rev0',
      record: baseRecord({ title: 'Omitted' }),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 1
    },
    {
      name: 'a new thread lands at revision 0 through a normalized write',
      seed: 'none',
      record: baseRecord({ title: 'New' }),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 0
    },
    {
      // Its stamp equals the revision the math produces, but it is not AHEAD
      // of the CAS base, so adoption declines.
      name: 'a new thread already stamped at revision 0 is normalized, not adopted',
      seed: 'none',
      record: baseRecord({ title: 'New at zero', persistenceRevision: 0 }),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 0
    },
    {
      name: 'a new thread stamped ahead is still normalized to revision 0',
      seed: 'none',
      record: baseRecord({ title: 'New ahead', persistenceRevision: 3 }),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 0
    },
    {
      name: 'repaired legacy input (no runs) is normalized even when stamped ahead',
      seed: 'rev0',
      record: without(baseRecord({ title: 'No runs', persistenceRevision: 1 }), 'runs'),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 1
    },
    {
      name: 'repaired legacy input (scope missing) is normalized even when stamped ahead',
      seed: 'rev0',
      record: without(baseRecord({ title: 'No scope', persistenceRevision: 1 }), 'scope'),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 1
    },
    {
      name: 'repaired legacy input (archived missing) is normalized even when stamped ahead',
      seed: 'rev0',
      record: without(baseRecord({ title: 'No archived', persistenceRevision: 1 }), 'archived'),
      expectedRevision: 0,
      decision: 'normalized',
      revision: 1
    }
  ]

  for (const entry of successCorpus) {
    it(entry.name, async () => {
      const a = twin()
      const b = twin()
      seed(a.store, entry.seed)
      seed(b.store, entry.seed)
      const { descriptor, bytes } = publishTwin([a, b], entry.record)
      const outcome = await runTwins(a, b, descriptor, entry.expectedRevision)
      const prepared = expectPreparedMatchesLegacy(a, b, outcome, bytes)
      expect(prepared.artifact.source).toBe(entry.decision)
      expect(prepared.persistenceRevision).toBe(entry.revision)
      expect(prepared.base).toBe(entry.seed === 'none' ? null : 0)
      expect(prepared.expectedRevision).toBe(entry.expectedRevision)
      expect(prepared.effects.kind).toBe('modelled')
      expect(prepared.summary).not.toBeNull()
      expect(prepared.summary!.messageCount).toBe(2)
    })
  }

  it('reports base as the revision the math ran against', async () => {
    const a = twin()
    const b = twin()
    seed(a.store, 'rev2')
    seed(b.store, 'rev2')
    const { descriptor, bytes } = publishTwin(
      [a, b],
      baseRecord({ title: 'Ahead of 2', persistenceRevision: 3 })
    )
    const outcome = await runTwins(a, b, descriptor, 2)
    const prepared = expectPreparedMatchesLegacy(a, b, outcome, bytes)
    expect(prepared.base).toBe(2)
    expect(prepared.expectedRevision).toBe(2)
    expect(prepared.persistenceRevision).toBe(3)
    expect(prepared.artifact.source).toBe('original')
  })

  const rejectionCorpus: Array<{
    name: string
    seed: Seed
    record?: LooseRecord
    body?: Buffer
    expectedRevision: number
    threadId?: string
    mutate?: (descriptor: HostThreadRecordTransferDescriptor) => HostThreadRecordTransferDescriptor
    code: string
    /** What the transfer directory holds afterwards, on BOTH twins. */
    leaves: string[]
  }> = [
    {
      name: 'revision moving backwards is thread_record_invalid',
      seed: 'rev2',
      record: baseRecord({ title: 'Backwards', persistenceRevision: 1 }),
      expectedRevision: 2,
      code: 'thread_record_invalid',
      leaves: []
    },
    {
      name: 'revision mismatch is thread_record_revision_conflict',
      seed: 'rev0',
      record: baseRecord({ title: 'Mismatch', persistenceRevision: 2 }),
      expectedRevision: 1,
      code: 'thread_record_revision_conflict',
      leaves: []
    },
    {
      name: 'not found with a non-zero base is thread_record_revision_conflict',
      seed: 'none',
      record: baseRecord({ title: 'Not found', persistenceRevision: 2 }),
      expectedRevision: 1,
      code: 'thread_record_revision_conflict',
      leaves: []
    },
    {
      name: 'identity mismatch is thread_record_identity_mismatch',
      seed: 'rev0',
      record: baseRecord({ appChatId: 'thread-2', persistenceRevision: 1 }),
      expectedRevision: 0,
      code: 'thread_record_identity_mismatch',
      leaves: []
    },
    {
      name: 'identity mismatch is reported before a revision mismatch (multi-fault order)',
      seed: 'rev0',
      record: baseRecord({ appChatId: 'thread-2', persistenceRevision: 1 }),
      expectedRevision: 7,
      code: 'thread_record_identity_mismatch',
      leaves: []
    },
    {
      name: 'a record the decoder refuses is thread_record_invalid',
      seed: 'rev0',
      record: baseRecord({ messages: 'not-an-array', persistenceRevision: 1 }),
      expectedRevision: 0,
      code: 'thread_record_invalid',
      leaves: []
    },
    {
      name: 'a decoder refusal is reported before a revision mismatch (multi-fault order)',
      seed: 'rev0',
      record: baseRecord({ messages: 'not-an-array', persistenceRevision: 1 }),
      expectedRevision: 9,
      code: 'thread_record_invalid',
      leaves: []
    },
    {
      name: 'a body that is not JSON is thread_record_transfer_integrity and is removed',
      seed: 'rev0',
      body: Buffer.from('{bad json}\n'),
      expectedRevision: 0,
      code: 'thread_record_transfer_integrity',
      leaves: []
    },
    {
      name: 'a body that is not a JSON object is thread_record_transfer_integrity and is removed',
      seed: 'rev0',
      body: Buffer.from('[]\n'),
      expectedRevision: 0,
      code: 'thread_record_transfer_integrity',
      leaves: []
    },
    {
      name: 'a digest mismatch is thread_record_transfer_integrity',
      seed: 'rev0',
      record: baseRecord({ title: 'Digest', persistenceRevision: 1 }),
      expectedRevision: 0,
      mutate: (descriptor) => ({ ...descriptor, sha256: 'f'.repeat(64) }),
      code: 'thread_record_transfer_integrity',
      // The shared verifier reaps the exact inode it inspected; both twins agree.
      leaves: []
    },
    {
      name: 'a byte-length mismatch is thread_record_transfer_integrity',
      seed: 'rev0',
      record: baseRecord({ title: 'Length', persistenceRevision: 1 }),
      expectedRevision: 0,
      mutate: (descriptor) => ({ ...descriptor, byteLength: descriptor.byteLength + 1 }),
      code: 'thread_record_transfer_integrity',
      leaves: []
    },
    {
      name: 'a missing artifact is thread_record_transfer_missing and touches nothing',
      seed: 'rev0',
      record: baseRecord({ title: 'Present', persistenceRevision: 1 }),
      expectedRevision: 0,
      mutate: (descriptor) => ({ ...descriptor, transferId: 'absent' }),
      code: 'thread_record_transfer_missing',
      leaves: [artifactName(TRANSFER_ID)]
    },
    {
      name: 'a base at MAX_SAFE_INTEGER that must advance is thread_record_persist_failed',
      seed: 'max',
      record: baseRecord({ title: 'Max echo', persistenceRevision: Number.MAX_SAFE_INTEGER }),
      expectedRevision: Number.MAX_SAFE_INTEGER,
      code: 'thread_record_persist_failed',
      leaves: []
    }
  ]

  for (const entry of rejectionCorpus) {
    it(entry.name, async () => {
      const a = twin()
      const b = twin()
      seed(a.store, entry.seed)
      seed(b.store, entry.seed)
      const chatBefore = existsSync(chatPath(a.profilePath))
        ? readFileSync(chatPath(a.profilePath))
        : null
      let descriptor = entry.body
        ? writeRawTwin([a, b], entry.body)
        : publishTwin([a, b], entry.record!).descriptor
      if (entry.mutate) descriptor = entry.mutate(descriptor)
      const outcome = await runTwins(a, b, descriptor, entry.expectedRevision, entry.threadId)
      expect(outcome.legacyCode).toBe(entry.code)
      expect(outcome.preparedCode).toBe(entry.code)
      expect(outcome.prepared).toMatchObject({ kind: 'rejected', errorCode: entry.code })
      expect(JSON.stringify(outcome.prepared)).not.toContain('messages')
      // File-for-file with the legacy twin, and exactly what the contract names.
      expect(listing(a.profilePath)).toEqual(entry.leaves)
      expect(listing(b.profilePath)).toEqual(entry.leaves)
      // Neither side committed anything.
      const chatAfterA = existsSync(chatPath(a.profilePath))
        ? readFileSync(chatPath(a.profilePath))
        : null
      const chatAfterB = existsSync(chatPath(b.profilePath))
        ? readFileSync(chatPath(b.profilePath))
        : null
      expect(chatAfterA === null ? null : chatAfterA.toString()).toBe(
        chatBefore === null ? null : chatBefore.toString()
      )
      expect(chatAfterB === null ? null : chatAfterB.toString()).toBe(
        chatBefore === null ? null : chatBefore.toString()
      )
    })
  }

  it.skipIf(!POSIX)(
    'an owner-only mode violation is thread_record_transfer_integrity and leaves the artifact',
    async () => {
      const a = twin()
      const b = twin()
      seed(a.store, 'rev0')
      seed(b.store, 'rev0')
      const { descriptor, bytes } = publishTwin([a, b], baseRecord({ persistenceRevision: 1 }))
      for (const { profilePath } of [a, b]) {
        chmodSync(hostThreadRecordTransferPath(profilePath, TRANSFER_ID), 0o644)
      }
      const outcome = await runTwins(a, b, descriptor, 0)
      expect(outcome.legacyCode).toBe('thread_record_transfer_integrity')
      expect(outcome.preparedCode).toBe('thread_record_transfer_integrity')
      for (const { profilePath } of [a, b]) {
        expect(listing(profilePath)).toEqual([artifactName(TRANSFER_ID)])
        expect(
          readFileSync(hostThreadRecordTransferPath(profilePath, TRANSFER_ID)).equals(bytes)
        ).toBe(true)
      }
    }
  )

  it('prepare-only refusals the command validator screens out of the legacy path', () => {
    const b = twin()
    seed(b.store, 'rev0')
    const { descriptor } = publishTwin([b], baseRecord({ persistenceRevision: 1 }))
    const invalidExpected = prepareHostThreadRecord({
      profilePath: b.profilePath,
      threadId: THREAD_ID,
      descriptor,
      expectedRevision: -1,
      currentRevision: 0,
      now: NOW
    })
    expect(invalidExpected).toMatchObject({ kind: 'rejected', errorCode: 'thread_record_invalid' })
    expect(listing(b.profilePath)).toEqual([])

    // The store's id check is trim + control characters (`Profile identity is
    // invalid` -> persist_failed); a merely different id is an identity mismatch.
    const { descriptor: second } = publishTwin(
      [b],
      baseRecord({ persistenceRevision: 1 }),
      'transfer-2'
    )
    const invalidThread = prepareHostThreadRecord({
      profilePath: b.profilePath,
      threadId: ' thread-1',
      descriptor: second,
      expectedRevision: 0,
      currentRevision: 0,
      now: NOW
    })
    expect(invalidThread).toMatchObject({
      kind: 'rejected',
      errorCode: 'thread_record_persist_failed'
    })
    expect(listing(b.profilePath)).toEqual([])
  })

  it('a substituted inode is never removed, on either twin, after a domain refusal', async () => {
    const a = twin()
    const b = twin()
    seed(a.store, 'rev0')
    seed(b.store, 'rev0')
    const { descriptor } = publishTwin(
      [a, b],
      baseRecord({ appChatId: 'thread-2', persistenceRevision: 1 })
    )
    const foreign = Buffer.from('foreign bytes\n')
    const substitute = (profilePath: string): void => {
      const path = hostThreadRecordTransferPath(profilePath, TRANSFER_ID)
      const replacement = `${path}.replacement`
      writeFileSync(replacement, foreign, { mode: 0o600 })
      renameSync(replacement, path)
    }
    substitution.hook = () => substitute(a.profilePath)
    const legacy = await a.executor.execute(persistCommand(THREAD_ID, descriptor, 0))
    substitution.hook = () => substitute(b.profilePath)
    const prepared = prepareHostThreadRecord({
      profilePath: b.profilePath,
      threadId: THREAD_ID,
      descriptor,
      expectedRevision: 0,
      currentRevision: 0,
      now: NOW
    })
    substitution.hook = undefined
    expect(legacy).toMatchObject({ status: 'failed', errorCode: 'thread_record_identity_mismatch' })
    expect(prepared).toMatchObject({
      kind: 'rejected',
      errorCode: 'thread_record_identity_mismatch'
    })
    for (const { profilePath } of [a, b]) {
      expect(listing(profilePath)).toEqual([artifactName(TRANSFER_ID)])
      expect(
        readFileSync(hostThreadRecordTransferPath(profilePath, TRANSFER_ID)).equals(foreign)
      ).toBe(true)
    }
  })

  it('a substituted inode survives a normalized prepare; only the normalized file joins it', () => {
    const b = twin()
    seed(b.store, 'rev0')
    const { descriptor } = publishTwin([b], baseRecord({ title: 'Echo', persistenceRevision: 0 }))
    const foreign = Buffer.from('foreign bytes\n')
    substitution.hook = () => {
      const path = hostThreadRecordTransferPath(b.profilePath, TRANSFER_ID)
      const replacement = `${path}.replacement`
      writeFileSync(replacement, foreign, { mode: 0o600 })
      renameSync(replacement, path)
    }
    const prepared = prepareHostThreadRecord({
      profilePath: b.profilePath,
      threadId: THREAD_ID,
      descriptor,
      expectedRevision: 0,
      currentRevision: 0,
      now: NOW
    })
    substitution.hook = undefined
    expect(prepared).toMatchObject({ kind: 'prepared', artifact: { source: 'normalized' } })
    expect(listing(b.profilePath)).toEqual(
      [
        artifactName(TRANSFER_ID),
        artifactName(hostThreadRecordNormalizedTransferId(TRANSFER_ID))
      ].sort()
    )
    expect(
      readFileSync(hostThreadRecordTransferPath(b.profilePath, TRANSFER_ID)).equals(foreign)
    ).toBe(true)
  })

  it('a retry replaces a leftover normalized file and its bytes still equal the legacy chat file', async () => {
    const a = twin()
    const b = twin()
    seed(a.store, 'rev0')
    seed(b.store, 'rev0')
    const { descriptor, bytes } = publishTwin(
      [a, b],
      baseRecord({ title: 'Retry', persistenceRevision: 0 })
    )
    const normalizedId = hostThreadRecordNormalizedTransferId(descriptor.transferId)
    expect(normalizedId).toMatch(/^n[a-f0-9]{63}$/)
    const leftoverPath = hostThreadRecordTransferPath(b.profilePath, normalizedId)
    writeFileSync(leftoverPath, 'leftover from a crashed prepare\n', { mode: 0o600 })
    const leftover = lstatSync(leftoverPath, { bigint: true })

    const outcome = await runTwins(a, b, descriptor, 0)
    const prepared = expectPreparedMatchesLegacy(a, b, outcome, bytes)
    expect(prepared.artifact.source).toBe('normalized')
    expect(prepared.artifact.path).toBe(leftoverPath)
    const replaced = lstatSync(leftoverPath, { bigint: true })
    expect(String(replaced.ino)).not.toBe(String(leftover.ino))
    expect(readFileSync(leftoverPath, 'utf8')).not.toContain('leftover')
  })

  it('the normalized id is deterministic per transfer id and distinct across ids', () => {
    const one = hostThreadRecordNormalizedTransferId('transfer-1')
    expect(one).toBe(hostThreadRecordNormalizedTransferId('transfer-1'))
    expect(one).toBe(
      `n${createHash('sha256').update('transfer-1', 'utf8').digest('hex').slice(0, 63)}`
    )
    expect(hostThreadRecordNormalizedTransferId('transfer-2')).not.toBe(one)
    expect(one).toHaveLength(64)
  })

  /**
   * Under the people-donor gate the legacy store needs the PREVIOUS record: an
   * edit that changes the donor inventory (here, the title) is refused, one
   * that does not is written normally (adoption declined). Prepare has no
   * previous record, so both are `unsupported` and the artifact is untouched.
   */
  const ownedCorpus: Array<{ name: string; record: LooseRecord; legacy: Outcome['legacy'] }> = [
    {
      name: 'an inventory-changing edit legacy refuses',
      record: baseRecord({ title: 'Owned', persistenceRevision: 1 }),
      legacy: { status: 'failed', errorCode: 'thread_record_persist_failed' }
    },
    {
      name: 'an inventory-preserving edit legacy writes normally',
      record: baseRecord({ pinned: true, persistenceRevision: 1 }),
      legacy: { status: 'succeeded', resultSummary: 'thread_record_persisted' }
    }
  ]

  for (const entry of ownedCorpus) {
    it(`a people-donor-owned profile is unsupported and leaves the original untouched: ${entry.name}`, async () => {
      const a = twin()
      const b = twin()
      seed(a.store, 'rev0')
      seed(b.store, 'rev0')
      const { descriptor, bytes } = publishTwin([a, b], entry.record)
      const before = lstatSync(hostThreadRecordTransferPath(b.profilePath, TRANSFER_ID), {
        bigint: true
      })

      const legacy = await withPeopleDonorMutationGate(a.profilePath, async () =>
        a.executor.execute(persistCommand(THREAD_ID, descriptor, 0))
      )
      const prepared = await withPeopleDonorMutationGate(b.profilePath, async () =>
        prepareHostThreadRecord({
          profilePath: b.profilePath,
          threadId: THREAD_ID,
          descriptor,
          expectedRevision: 0,
          currentRevision: 0,
          now: NOW
        })
      )
      expect(legacy).toEqual(entry.legacy)
      // Legacy consumed its artifact either way, and never adopted the bytes.
      expect(listing(a.profilePath)).toEqual([])
      expect(readFileSync(chatPath(a.profilePath)).equals(bytes)).toBe(false)
      if (entry.legacy.status === 'succeeded') {
        expect(a.store.getThread(THREAD_ID)).toMatchObject({
          pinned: true,
          persistenceRevision: 1,
          updatedAt: NOW
        })
      } else {
        expect(a.store.getThread(THREAD_ID)).toMatchObject({
          title: 'Base',
          persistenceRevision: 0
        })
      }

      expect(prepared).toEqual({
        kind: 'unsupported',
        threadId: THREAD_ID,
        reason: 'people_donor_owned'
      })
      expect(listing(b.profilePath)).toEqual([artifactName(TRANSFER_ID)])
      const after = lstatSync(hostThreadRecordTransferPath(b.profilePath, TRANSFER_ID), {
        bigint: true
      })
      expect(String(after.ino)).toBe(String(before.ino))
      expect(
        readFileSync(hostThreadRecordTransferPath(b.profilePath, TRANSFER_ID)).equals(bytes)
      ).toBe(true)
      expect(
        existsSync(
          hostThreadRecordTransferPath(
            b.profilePath,
            hostThreadRecordNormalizedTransferId(TRANSFER_ID)
          )
        )
      ).toBe(false)

      // Off the gate, the same untouched artifact prepares as the original.
      const later = prepareHostThreadRecord({
        profilePath: b.profilePath,
        threadId: THREAD_ID,
        descriptor,
        expectedRevision: 0,
        currentRevision: 0,
        now: NOW
      })
      expect(later).toMatchObject({ kind: 'prepared', artifact: { source: 'original' } })
    })
  }

  it('the people-donor gate is checked after the revision math: a conflict is rejected, not unsupported', async () => {
    const b = twin()
    seed(b.store, 'rev0')
    const { descriptor } = publishTwin([b], baseRecord({ persistenceRevision: 3 }))
    const prepared = await withPeopleDonorMutationGate(b.profilePath, async () =>
      prepareHostThreadRecord({
        profilePath: b.profilePath,
        threadId: THREAD_ID,
        descriptor,
        expectedRevision: 2,
        currentRevision: 0,
        now: NOW
      })
    )
    expect(prepared).toMatchObject({
      kind: 'rejected',
      errorCode: 'thread_record_revision_conflict'
    })
    expect(listing(b.profilePath)).toEqual([])
  })
})

/** Every object key reachable in `value`, with its dotted path. */
function collectKeys(value: unknown, prefix = '', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeys(item, `${prefix}[${index}]`, out))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(prefix ? `${prefix}.${key}` : key)
      collectKeys(item, prefix ? `${prefix}.${key}` : key, out)
    }
  }
  return out
}

/** Dotted paths at which two values differ. */
function diffPaths(left: unknown, right: unknown, prefix = ''): string[] {
  const here = prefix || '$'
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [here]
    return left.flatMap((item, index) => diffPaths(item, right[index], `${prefix}[${index}]`))
  }
  const objects =
    left !== null && right !== null && typeof left === 'object' && typeof right === 'object'
  if (objects && !Array.isArray(left) && !Array.isArray(right)) {
    const l = left as Record<string, unknown>
    const r = right as Record<string, unknown>
    const keys = new Set([...Object.keys(l), ...Object.keys(r)])
    return [...keys].flatMap((key) => diffPaths(l[key], r[key], prefix ? `${prefix}.${key}` : key))
  }
  return Object.is(left, right) ? [] : [here]
}

function messagesRecord(count: number, content: (index: number) => string): LooseRecord {
  return baseRecord({
    title: 'Bounded',
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: content(index),
      timestamp: '2026-09-01T00:00:00.000Z'
    }))
  })
}

function prepareNew(
  profilePath: string,
  transferId: string,
  record: LooseRecord,
  extra: Partial<HostThreadRecordPrepareInput> = {}
): HostThreadRecordPrepared {
  const descriptor = publishHostThreadRecordTransfer({ profilePath, transferId, record })
  const result = prepareHostThreadRecord({
    profilePath,
    threadId: THREAD_ID,
    descriptor,
    expectedRevision: 0,
    currentRevision: null,
    now: NOW,
    ...extra
  })
  expect(result.kind).toBe('prepared')
  return result as HostThreadRecordPrepared
}

describe('prepareHostThreadRecord boundedness (contract §20.3 item 3)', () => {
  it('carries no messages key and none of the transcript beyond the projection previews', () => {
    const b = twin()
    const count = 40
    const prepared = prepareNew(
      b.profilePath,
      'bounded',
      messagesRecord(count, (index) => `MARKER-${index}-END`)
    )
    const keys = collectKeys(prepared)
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.some((key) => key.endsWith('summary'))).toBe(true)
    expect(keys.some((key) => key.endsWith('effects'))).toBe(true)
    expect(keys.filter((key) => key === 'messages' || key.endsWith('.messages'))).toEqual([])
    const serialized = JSON.stringify(prepared)
    // The catalogue projection keeps the newest message as its preview and the
    // newest eight in its search text; every older message must be absent.
    const older = Array.from({ length: count - 8 }, (_, index) => `MARKER-${index}-END`)
    expect(older.length).toBeGreaterThan(0)
    for (const marker of older) expect(serialized).not.toContain(marker)
    expect(serialized).toContain(`MARKER-${count - 1}-END`)
    expect(prepared.summary?.messageCount).toBe(count)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(64 * 1024)
  })

  it('10 vs 20,000 messages differ only by the count fields when the newest eight match', () => {
    const b = twin()
    const content = (count: number) => (index: number) =>
      index >= count - 8 ? `tail-${count - 1 - index}` : `filler-${index}`
    const small = prepareNew(b.profilePath, 'small', messagesRecord(10, content(10)))
    const large = prepareNew(b.profilePath, 'large', messagesRecord(20_000, content(20_000)))
    expect(large.artifact.byteLength).toBeGreaterThan(small.artifact.byteLength * 100)

    const { artifact: _smallArtifact, ...smallRest } = small
    const { artifact: _largeArtifact, ...largeRest } = large
    const differing = diffPaths(smallRest, largeRest)
    expect(differing.length).toBeGreaterThan(0)
    expect(differing).toContain('summary.messageCount')
    for (const path of differing) expect(path).toMatch(/messageCount$/)
    expect(
      Math.abs(
        Buffer.byteLength(JSON.stringify(smallRest), 'utf8') -
          Buffer.byteLength(JSON.stringify(largeRest), 'utf8')
      )
    ).toBeLessThan(64)
  })

  it('omits the summary above the cap and keeps it at the exact cap', () => {
    const b = twin()
    const record = messagesRecord(3, (index) => `content-${index}`)
    const reference = prepareNew(b.profilePath, 'reference', record)
    expect(reference.summary).not.toBeNull()
    const summaryBytes = Buffer.byteLength(JSON.stringify(reference.summary), 'utf8')
    expect(summaryBytes).toBeGreaterThan(0)
    expect(summaryBytes).toBeLessThanOrEqual(HOST_THREAD_RECORD_PREPARED_SUMMARY_MAX_BYTES)

    const atCap = prepareNew(b.profilePath, 'at-cap', record, { summaryMaxBytes: summaryBytes })
    expect(atCap.summary).toEqual(reference.summary)

    const aboveCap = prepareNew(b.profilePath, 'above-cap', record, {
      summaryMaxBytes: summaryBytes - 1
    })
    expect(aboveCap.summary).toBeNull()
    const { artifact: _a, summary: _s, ...atCapRest } = atCap
    const { artifact: _b, summary: _t, ...aboveCapRest } = aboveCap
    expect(aboveCapRest).toEqual(atCapRest)
    expect(readFileSync(aboveCap.artifact.path).equals(readFileSync(atCap.artifact.path))).toBe(
      true
    )
  })

  it('the default cap is 256 KiB', () => {
    expect(HOST_THREAD_RECORD_PREPARED_SUMMARY_MAX_BYTES).toBe(256 * 1024)
  })
})
