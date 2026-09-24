import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createHostNodeQueuedStartLifecycle,
  type HostQueuedStartExecutionClaimCursor
} from './HostNodeQueuedStartLifecycle'
import type { HostNodeRunAdmissionLease } from './HostNodeRunAdmission'
import {
  HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME,
  openHostNodeQueuedStartExecutionClaimStore,
  type HostNodeQueuedStartExecutionClaimJournalIo
} from './HostNodeQueuedStartExecutionClaimStore'

const EPOCH_A = 'a'.repeat(64)
const EPOCH_B = 'b'.repeat(64)
const EPOCH_C = 'c'.repeat(64)

const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

function dataDir(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `host-queued-claim-${label}-`)))
  paths.push(path)
  return path
}

function claim(
  overrides: Partial<{
    commandId: string
    threadId: string
    fingerprint: string
    claimedAt: number
  }> = {}
) {
  return {
    commandId: 'command-1',
    threadId: 'thread-1',
    // Deliberately not a SHA: the lifecycle contract is a bounded opaque value.
    fingerprint: 'opaque fingerprint / exact bytes',
    claimedAt: 123.5,
    ...overrides
  }
}

function admissionLease(commandId = 'command-1', threadId = 'thread-1') {
  let releases = 0
  const lease: HostNodeRunAdmissionLease = {
    commandId,
    threadId,
    release: () => {
      releases += 1
    }
  }
  return { lease, releases: () => releases }
}

async function expectSecondReservationCannotDispatch(
  lifecycle: ReturnType<typeof createHostNodeQueuedStartLifecycle>
): Promise<void> {
  const second = claim({ commandId: 'command-2', threadId: 'thread-2' })
  lifecycle.reserve(second)
  const tracked = admissionLease(second.commandId, second.threadId)
  await expect(lifecycle.claim(second.commandId, tracked.lease)).resolves.toMatchObject({
    kind: 'refused',
    reason: 'claim_record_failed'
  })
  expect(tracked.releases()).toBe(1)
  const start = vi.fn()
  await lifecycle.executeStart(second.commandId, start)
  expect(start).not.toHaveBeenCalled()
}

describe('HostNodeQueuedStartExecutionClaimStore', () => {
  it('fsyncs a body-free claim, preserves opaque identity, and reopens under a pinned epoch', () => {
    const dir = dataDir('round-trip')
    const fresh = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })

    expect(fresh.coverageEpoch).toBe(EPOCH_A)
    expect(fresh.declaresDurableCoverage).toBe(false)
    const firstCursor = fresh.record(claim()) as HostQueuedStartExecutionClaimCursor
    expect(firstCursor).toEqual({ coverageEpoch: EPOCH_A, sequence: 1 })
    expect(fresh.readClaims!([firstCursor])).toEqual([claim()])

    const sourceAfterFirst = readFileSync(fresh.path, 'utf8')
    const rows = sourceAfterFirst
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'header', schemaVersion: 1, coverageEpoch: EPOCH_A })
    expect(rows[1]).toMatchObject({
      kind: 'claim',
      commandId: 'command-1',
      threadId: 'thread-1',
      fingerprint: 'opaque fingerprint / exact bytes',
      claimedAt: 123.5
    })
    expect(sourceAfterFirst).not.toMatch(/payload|prompt|providerWork|arguments|authorization/i)
    expect('replay' in fresh).toBe(false)
    expect('run' in fresh).toBe(false)

    // Same identity preserves the first durable time and appends nothing.
    expect(fresh.record(claim({ claimedAt: 999 }))).toEqual(firstCursor)
    expect(readFileSync(fresh.path, 'utf8')).toBe(sourceAfterFirst)

    const reopened = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_A,
      createCoverageEpoch: () => EPOCH_B
    })
    expect(reopened.coverageEpoch).toBe(EPOCH_A)
    expect(reopened.declaresDurableCoverage).toBe(false)
    expect(reopened.list()).toEqual([claim()])
  })

  it('batch-validates aligned claim cursors in one strict unbounded journal read', () => {
    const dir = dataDir('strict-cursor')
    const fresh = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const firstCursor = fresh.record(claim()) as HostQueuedStartExecutionClaimCursor
    const afterFirst = readFileSync(fresh.path, 'utf8')
    const second = claim({
      commandId: 'command-2',
      threadId: 'thread-2',
      fingerprint: 'fingerprint-2'
    })
    const secondCursor = fresh.record(second) as HostQueuedStartExecutionClaimCursor
    expect(secondCursor).toEqual({ coverageEpoch: EPOCH_A, sequence: 2 })
    expect(
      fresh.readClaims!([
        secondCursor,
        firstCursor,
        { coverageEpoch: EPOCH_B, sequence: 1 },
        { coverageEpoch: EPOCH_A, sequence: 99 },
        { coverageEpoch: 'not-an-epoch', sequence: 0 }
      ])
    ).toEqual([second, claim(), null, null, null])

    // A valid older prefix is still rollback relative to the store opened
    // before the rollback, so the whole batch fails conservatively.
    writeFileSync(fresh.path, afterFirst, { mode: 0o600 })
    expect(() => fresh.readClaims!([secondCursor, firstCursor])).toThrow(/journal changed/i)
  })

  it('keeps absence indeterminate even under a matching caller-pinned epoch', async () => {
    const dir = dataDir('coverage')
    const fresh = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const candidate = claim()

    const unpinned = openHostNodeQueuedStartExecutionClaimStore({ dataDir: dir })
    expect(unpinned.declaresDurableCoverage).toBe(false)
    await expect(
      createHostNodeQueuedStartLifecycle({ executionClaimStore: unpinned }).reopen([candidate])
    ).resolves.toEqual([
      { commandId: candidate.commandId, outcome: 'indeterminate', resubmittable: null }
    ])

    const wrongEpoch = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_B
    })
    expect(wrongEpoch.declaresDurableCoverage).toBe(false)
    expect(() => wrongEpoch.record(candidate)).toThrow(/epoch/i)
    await expect(
      createHostNodeQueuedStartLifecycle({ executionClaimStore: wrongEpoch }).reopen([candidate])
    ).resolves.toEqual([
      { commandId: candidate.commandId, outcome: 'indeterminate', resubmittable: null }
    ])

    const pinned = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: fresh.coverageEpoch
    })
    expect(pinned.declaresDurableCoverage).toBe(false)
    await expect(
      createHostNodeQueuedStartLifecycle({ executionClaimStore: pinned }).reopen([candidate])
    ).resolves.toEqual([
      { commandId: candidate.commandId, outcome: 'indeterminate', resubmittable: null }
    ])
  })

  it('does not turn a restored valid prefix with the same epoch into absence proof', async () => {
    const dir = dataDir('valid-prefix-rollback')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const headerOnly = readFileSync(store.path, 'utf8')
    store.record(claim())

    // Simulate loss of a whole, otherwise valid tail: the epoch and header
    // remain authentic-looking, so only an external recovery head can detect it.
    writeFileSync(store.path, headerOnly, { mode: 0o600 })
    const reopened = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_A
    })
    expect(reopened.list()).toEqual([])
    expect(reopened.declaresDurableCoverage).toBe(false)
    await expect(
      createHostNodeQueuedStartLifecycle({ executionClaimStore: reopened }).reopen([claim()])
    ).resolves.toEqual([{ commandId: 'command-1', outcome: 'indeterminate', resubmittable: null }])
  })

  it('mints a different epoch after a missing journal and keeps old candidates indeterminate', async () => {
    const dir = dataDir('recreated')
    const original = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const oldEpoch = original.coverageEpoch
    unlinkSync(original.path)

    const recreated = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: oldEpoch,
      createCoverageEpoch: () => EPOCH_C
    })
    expect(recreated.coverageEpoch).toBe(EPOCH_C)
    expect(recreated.declaresDurableCoverage).toBe(false)
    await expect(
      createHostNodeQueuedStartLifecycle({ executionClaimStore: recreated }).reopen([claim()])
    ).resolves.toEqual([{ commandId: 'command-1', outcome: 'indeterminate', resubmittable: null }])
  })

  it('refuses to recreate a missing journal with the caller expected epoch', () => {
    const dir = dataDir('same-epoch')
    expect(() =>
      openHostNodeQueuedStartExecutionClaimStore({
        dataDir: dir,
        expectedCoverageEpoch: EPOCH_A,
        createCoverageEpoch: () => EPOCH_A
      })
    ).toThrow(/must differ/i)
    expect(existsSync(join(dir, HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME))).toBe(false)
  })

  it('treats an EEXIST winner as existing and refuses writes on an epoch mismatch', () => {
    const dir = dataDir('create-race')
    let winnerPath = ''
    const outer = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_A,
      createCoverageEpoch: () => {
        const winner = openHostNodeQueuedStartExecutionClaimStore({
          dataDir: dir,
          createCoverageEpoch: () => EPOCH_B
        })
        winnerPath = winner.path
        return EPOCH_C
      }
    })
    const before = readFileSync(winnerPath, 'utf8')

    expect(outer.coverageEpoch).toBe(EPOCH_B)
    expect(outer.declaresDurableCoverage).toBe(false)
    expect(() => outer.record(claim())).toThrow(/epoch/i)
    expect(readFileSync(winnerPath, 'utf8')).toBe(before)
  })

  it('refuses malformed existing bytes without calling the epoch factory or rewriting', () => {
    const cases: Array<{ label: string; source: (dir: string) => string; error: RegExp }> = [
      {
        label: 'header',
        source: () => '{"kind":"header"}\n',
        error: /header/i
      },
      {
        label: 'oversized-line',
        source: (dir) => {
          const created = openHostNodeQueuedStartExecutionClaimStore({
            dataDir: dir,
            createCoverageEpoch: () => EPOCH_A
          })
          return `${readFileSync(created.path, 'utf8')}${'x'.repeat(4097)}\n`
        },
        error: /line/i
      },
      {
        label: 'complete-claim',
        source: (dir) => {
          const created = openHostNodeQueuedStartExecutionClaimStore({
            dataDir: dir,
            createCoverageEpoch: () => EPOCH_A
          })
          const header = JSON.parse(readFileSync(created.path, 'utf8').trim()) as {
            digest: string
          }
          const malformed = {
            kind: 'claim',
            schemaVersion: 1,
            sequence: 1,
            previousDigest: header.digest,
            commandId: 'command-bad',
            threadId: 'thread-bad',
            fingerprint: '   ',
            claimedAt: 1,
            digest: '0'.repeat(64)
          }
          return `${readFileSync(created.path, 'utf8')}${JSON.stringify(malformed)}\n`
        },
        error: /identity/i
      }
    ]

    for (const fixture of cases) {
      const dir = dataDir(`malformed-${fixture.label}`)
      const path = join(dir, HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME)
      const source = fixture.source(dir)
      writeFileSync(path, source, { mode: 0o600 })
      const epochFactory = vi.fn(() => EPOCH_B)
      expect(() =>
        openHostNodeQueuedStartExecutionClaimStore({
          dataDir: dir,
          expectedCoverageEpoch: EPOCH_A,
          createCoverageEpoch: epochFactory
        })
      ).toThrow(fixture.error)
      expect(epochFactory).not.toHaveBeenCalled()
      expect(readFileSync(path, 'utf8')).toBe(source)
    }
  })

  it('rejects conflicting or malformed identities without changing durable bytes', () => {
    const dir = dataDir('identity')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    store.record(claim())
    const before = readFileSync(store.path, 'utf8')

    expect(() => store.record(claim({ threadId: 'thread-2' }))).toThrow(/identity conflict/i)
    expect(() => store.record(claim({ fingerprint: 'different' }))).toThrow(/identity conflict/i)
    expect(() => store.record(claim({ commandId: '   ' }))).toThrow(/invalid/i)
    expect(() => store.record(claim({ commandId: 'x'.repeat(513) }))).toThrow(/invalid/i)
    expect(() => store.record(claim({ claimedAt: Number.NaN }))).toThrow(/invalid/i)
    expect(() => store.record(claim({ claimedAt: -1 }))).toThrow(/invalid/i)
    expect(readFileSync(store.path, 'utf8')).toBe(before)
    expect(store.list()).toEqual([claim()])
  })

  it('poisons a partial append, never dispatches, and never reconstructs over the torn bytes', async () => {
    const dir = dataDir('partial')
    const initial = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const before = readFileSync(initial.path, 'utf8')
    let wrotePartial = false
    const partialIo: HostNodeQueuedStartExecutionClaimJournalIo = {
      write: (fd, buffer, offset, length) => {
        const partial = Math.max(1, Math.floor(length / 2))
        const written = writeSync(fd, buffer, offset, partial)
        wrotePartial = true
        throw new Error(`simulated partial write after ${written} bytes`)
      },
      fsyncFile: vi.fn()
    }
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_A,
      journalIo: partialIo
    })
    const lifecycle = createHostNodeQueuedStartLifecycle({
      executionClaimStore: store,
      now: () => 123.5
    })
    lifecycle.reserve(claim())
    const tracked = admissionLease()

    await expect(lifecycle.claim('command-1', tracked.lease)).resolves.toMatchObject({
      kind: 'refused',
      reason: 'claim_record_failed',
      leaseCustody: 'released'
    })
    expect(wrotePartial).toBe(true)
    expect(partialIo.fsyncFile).not.toHaveBeenCalled()
    expect(tracked.releases()).toBe(1)
    const start = vi.fn()
    await expect(lifecycle.executeStart('command-1', start)).resolves.toMatchObject({
      kind: 'skipped',
      reason: 'terminal:failed'
    })
    expect(start).not.toHaveBeenCalled()
    expect(store.declaresDurableCoverage).toBe(false)
    await expectSecondReservationCannotDispatch(lifecycle)
    const torn = readFileSync(initial.path, 'utf8')
    expect(torn.startsWith(before)).toBe(true)
    expect(torn.endsWith('\n')).toBe(false)
    expect(() =>
      openHostNodeQueuedStartExecutionClaimStore({
        dataDir: dir,
        expectedCoverageEpoch: EPOCH_A,
        createCoverageEpoch: () => EPOCH_B
      })
    ).toThrow(/torn tail/i)
    expect(readFileSync(initial.path, 'utf8')).toBe(torn)
  })

  it('treats an fsync refusal as a failed claim and recovers visible bytes only as claimed', async () => {
    const dir = dataDir('fsync')
    const initial = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const failedFsync = vi.fn(() => {
      throw new Error('simulated claim fsync refusal')
    })
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_A,
      journalIo: {
        write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
        fsyncFile: failedFsync
      }
    })
    const lifecycle = createHostNodeQueuedStartLifecycle({
      executionClaimStore: store,
      now: () => 123.5
    })
    lifecycle.reserve(claim())
    const tracked = admissionLease()

    await expect(lifecycle.claim('command-1', tracked.lease)).resolves.toMatchObject({
      kind: 'refused',
      reason: 'claim_record_failed'
    })
    expect(failedFsync).toHaveBeenCalledTimes(1)
    expect(tracked.releases()).toBe(1)
    expect(store.declaresDurableCoverage).toBe(false)
    const start = vi.fn()
    await lifecycle.executeStart('command-1', start)
    expect(start).not.toHaveBeenCalled()
    await expectSecondReservationCannotDispatch(lifecycle)

    // The test filesystem still exposes the complete write. It can only make
    // recovery more conservative: presence classifies the command claimed.
    const reopened = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: initial.coverageEpoch
    })
    expect(reopened.declaresDurableCoverage).toBe(false)
    expect(reopened.list()).toEqual([claim()])
    await expect(
      createHostNodeQueuedStartLifecycle({ executionClaimStore: reopened }).reopen([claim()])
    ).resolves.toEqual([{ commandId: 'command-1', outcome: 'indeterminate', resubmittable: null }])
  })

  it('rejects in-place corruption before a later lifecycle claim can dispatch', async () => {
    const dir = dataDir('corrupt')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    store.record(claim())
    const valid = readFileSync(store.path, 'utf8')
    const corrupt = valid.replace(
      'opaque fingerprint / exact bytes',
      'opaque fingerprint / exact byteZ'
    )
    writeFileSync(store.path, corrupt, { mode: 0o600 })
    const future = new Date(Date.now() + 60_000)
    utimesSync(store.path, future, future)

    const lifecycle = createHostNodeQueuedStartLifecycle({ executionClaimStore: store })
    const nextClaim = claim({ commandId: 'command-2', threadId: 'thread-2' })
    lifecycle.reserve(nextClaim)
    const tracked = admissionLease('command-2', 'thread-2')
    await expect(lifecycle.claim('command-2', tracked.lease)).resolves.toMatchObject({
      kind: 'refused',
      reason: 'claim_record_failed'
    })
    expect(tracked.releases()).toBe(1)
    const start = vi.fn()
    await lifecycle.executeStart('command-2', start)
    expect(start).not.toHaveBeenCalled()
    expect(store.declaresDurableCoverage).toBe(false)
    expect(readFileSync(store.path, 'utf8')).toBe(corrupt)

    expect(() =>
      openHostNodeQueuedStartExecutionClaimStore({
        dataDir: dir,
        expectedCoverageEpoch: EPOCH_A,
        createCoverageEpoch: () => EPOCH_B
      })
    ).toThrow(/digest/i)
    expect(readFileSync(store.path, 'utf8')).toBe(corrupt)
  })

  it('rejects duplicate and unsafe journals without rewriting them', () => {
    const dir = dataDir('invalid-journal')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    store.record(claim())
    const valid = readFileSync(store.path, 'utf8')

    const duplicate = `${valid}${valid.trimEnd().split('\n')[1]}\n`
    writeFileSync(store.path, duplicate, { mode: 0o600 })
    expect(() =>
      openHostNodeQueuedStartExecutionClaimStore({
        dataDir: dir,
        expectedCoverageEpoch: EPOCH_A
      })
    ).toThrow(/record/i)
    expect(readFileSync(store.path, 'utf8')).toBe(duplicate)

    if (process.platform !== 'win32') {
      chmodSync(store.path, 0o644)
      expect(() =>
        openHostNodeQueuedStartExecutionClaimStore({
          dataDir: dir,
          expectedCoverageEpoch: EPOCH_A
        })
      ).toThrow(/unsafe/i)
    }
  })

  it('does not recreate a journal removed after open, including an exact duplicate claim', () => {
    const dir = dataDir('removed')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    store.record(claim())
    unlinkSync(store.path)

    expect(() => store.record(claim({ claimedAt: 999 }))).toThrow()
    expect(store.declaresDurableCoverage).toBe(false)
    expect(existsSync(join(dir, HOST_NODE_QUEUED_START_EXECUTION_CLAIM_FILENAME))).toBe(false)
  })

  it('upgrades v1 by compacting retained claims with stable cursors and append sequence', () => {
    const dir = dataDir('compact-upgrade')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A,
      compactAfterRecords: 3
    })
    const first = claim({ commandId: 'command-1', claimedAt: 1 })
    const second = claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 })
    const third = claim({ commandId: 'command-3', threadId: 'thread-3', claimedAt: 3 })
    const fourth = claim({ commandId: 'command-4', threadId: 'thread-4', claimedAt: 4 })
    const firstCursor = store.record(first) as HostQueuedStartExecutionClaimCursor
    const secondCursor = store.record(second) as HostQueuedStartExecutionClaimCursor
    const thirdCursor = store.record(third) as HostQueuedStartExecutionClaimCursor
    store.record(fourth)
    expect(JSON.parse(readFileSync(store.path, 'utf8').split('\n')[0]!).schemaVersion).toBe(1)

    expect(store.compact!(new Set(['command-1', 'command-3']))).toEqual({
      kind: 'compacted',
      physicalClaims: 4,
      retainedClaims: 2,
      nextSequence: 5
    })
    expect(JSON.parse(readFileSync(store.path, 'utf8').split('\n')[0]!)).toMatchObject({
      schemaVersion: 2,
      coverageEpoch: EPOCH_A,
      nextSequence: 5
    })
    expect(store.list()).toEqual([first, third])
    expect(store.list({ recoveryHeadSequence: 2 })).toEqual([first])
    expect(store.list({ recoveryHeadSequence: 3 })).toEqual([first, third])
    expect(store.readClaims!([firstCursor, secondCursor, thirdCursor])).toEqual([
      first,
      null,
      third
    ])
    expect(store.declaresDurableCoverage).toBe(false)

    const compacted = readFileSync(store.path, 'utf8')
    expect(store.record(claim({ ...third, claimedAt: 999 }))).toEqual(thirdCursor)
    expect(readFileSync(store.path, 'utf8')).toBe(compacted)

    const fifth = claim({ commandId: 'command-5', threadId: 'thread-5', claimedAt: 5 })
    const fifthCursor = store.record(fifth) as HostQueuedStartExecutionClaimCursor
    expect(fifthCursor).toEqual({ coverageEpoch: EPOCH_A, sequence: 5 })

    const reopened = openHostNodeQueuedStartExecutionClaimStore({ dataDir: dir })
    expect(reopened.list()).toEqual([first, third, fifth])
    expect(reopened.readClaims!([firstCursor, thirdCursor, fifthCursor])).toEqual([
      first,
      third,
      fifth
    ])
  })

  it('does not rewrite below threshold or when every claim is retained', () => {
    const dir = dataDir('compact-noop')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A,
      compactAfterRecords: 3
    })
    store.record(claim({ commandId: 'command-1', claimedAt: 1 }))
    store.record(claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 }))
    const belowThreshold = readFileSync(store.path, 'utf8')
    expect(store.compact!(new Set(['command-1']))).toEqual({
      kind: 'unchanged',
      physicalClaims: 2,
      retainedClaims: 1
    })
    expect(readFileSync(store.path, 'utf8')).toBe(belowThreshold)

    store.record(claim({ commandId: 'command-3', threadId: 'thread-3', claimedAt: 3 }))
    const allRetained = readFileSync(store.path, 'utf8')
    expect(store.compact!(new Set(['command-1', 'command-2', 'command-3']))).toEqual({
      kind: 'unchanged',
      physicalClaims: 3,
      retainedClaims: 3
    })
    expect(readFileSync(store.path, 'utf8')).toBe(allRetained)
  })

  it('fails closed when compact temp fsync or atomic rename is refused', () => {
    for (const failure of ['fsync', 'rename'] as const) {
      const dir = dataDir(`compact-${failure}`)
      const seed = openHostNodeQueuedStartExecutionClaimStore({
        dataDir: dir,
        createCoverageEpoch: () => EPOCH_A
      })
      seed.record(claim({ commandId: 'command-1', claimedAt: 1 }))
      seed.record(claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 }))
      const before = readFileSync(seed.path, 'utf8')
      const store = openHostNodeQueuedStartExecutionClaimStore({
        dataDir: dir,
        expectedCoverageEpoch: EPOCH_A,
        compactAfterRecords: 2,
        journalIo: {
          write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
          fsyncFile: () => {
            if (failure === 'fsync') throw new Error('simulated compact fsync refusal')
          },
          rename: (source, destination) => {
            if (failure === 'rename') throw new Error('simulated compact rename refusal')
            renameSync(source, destination)
          }
        }
      })

      expect(() => store.compact!(new Set(['command-1']))).toThrow(
        new RegExp(`compact ${failure} refusal`)
      )
      expect(readFileSync(seed.path, 'utf8')).toBe(before)
      expect(() => store.list()).toThrow(/unavailable/)
      expect(openHostNodeQueuedStartExecutionClaimStore({ dataDir: dir }).list()).toHaveLength(2)
    }
  })

  it('rejects a same-byte destination inode substituted by the rename seam', () => {
    const dir = dataDir('compact-substituted-destination')
    const seed = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    seed.record(claim({ commandId: 'command-1', claimedAt: 1 }))
    seed.record(claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 }))
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      expectedCoverageEpoch: EPOCH_A,
      compactAfterRecords: 2,
      journalIo: {
        write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
        fsyncFile: vi.fn(),
        rename: (source, destination) => {
          const substitute = `${destination}.same-bytes-substitute`
          writeFileSync(substitute, readFileSync(source), { mode: 0o600 })
          renameSync(source, destination)
          renameSync(substitute, destination)
        }
      }
    })

    expect(() => store.compact!(new Set(['command-1']))).toThrow(/substituted file/)
    expect(() => store.list()).toThrow(/unavailable/)
    // Logical bytes are valid, but this fresh instance never confuses that
    // with proof that the prior store published the inode it fsynced.
    expect(openHostNodeQueuedStartExecutionClaimStore({ dataDir: dir }).list()).toEqual([
      claim({ commandId: 'command-1', claimedAt: 1 })
    ])
  })

  it('poisons on directory-sync or inode uncertainty without inventing evidence', () => {
    const syncDir = dataDir('compact-directory-sync')
    const syncSeed = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: syncDir,
      createCoverageEpoch: () => EPOCH_A
    })
    syncSeed.record(claim({ commandId: 'command-1', claimedAt: 1 }))
    syncSeed.record(claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 }))
    const syncStore = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: syncDir,
      expectedCoverageEpoch: EPOCH_A,
      compactAfterRecords: 2,
      journalIo: {
        write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
        fsyncFile: vi.fn(),
        fsyncDirectory: () => {
          throw new Error('simulated directory sync uncertainty')
        }
      }
    })
    expect(() => syncStore.compact!(new Set(['command-1']))).toThrow(/directory sync uncertainty/)
    expect(() => syncStore.list()).toThrow(/unavailable/)
    expect(openHostNodeQueuedStartExecutionClaimStore({ dataDir: syncDir }).list()).toEqual([
      claim({ commandId: 'command-1', claimedAt: 1 })
    ])

    const inodeDir = dataDir('compact-inode')
    const inodeStore = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: inodeDir,
      createCoverageEpoch: () => EPOCH_B,
      compactAfterRecords: 2
    })
    inodeStore.record(claim({ commandId: 'command-1', claimedAt: 1 }))
    inodeStore.record(claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 }))
    const sameBytes = readFileSync(inodeStore.path, 'utf8')
    writeFileSync(inodeStore.path, sameBytes, { mode: 0o600 })
    const future = new Date(Date.now() + 60_000)
    utimesSync(inodeStore.path, future, future)
    expect(() => inodeStore.compact!(new Set(['command-1']))).toThrow(/changed before compaction/)
    expect(() => inodeStore.list()).toThrow(/unavailable/)
    expect(openHostNodeQueuedStartExecutionClaimStore({ dataDir: inodeDir }).list()).toHaveLength(2)
  })

  it('truncates list at the recovery-head sequence bound', () => {
    const dir = dataDir('recovery-head')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const first = claim({ commandId: 'command-1', claimedAt: 1 })
    const second = claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 })
    const third = claim({ commandId: 'command-3', threadId: 'thread-3', claimedAt: 3 })
    const fourth = claim({ commandId: 'command-4', threadId: 'thread-4', claimedAt: 4 })
    store.record(first)
    store.record(second)
    store.record(third)
    store.record(fourth)

    expect(store.list()).toEqual([first, second, third, fourth])
    expect(store.list({})).toEqual([first, second, third, fourth])
    expect(store.list({ recoveryHeadSequence: 0 })).toEqual([])
    expect(store.list({ recoveryHeadSequence: 2 })).toEqual([first, second])
    expect(store.list({ recoveryHeadSequence: 4 })).toEqual([first, second, third, fourth])
    expect(store.list({ recoveryHeadSequence: 99 })).toEqual([first, second, third, fourth])
    expect(store.declaresDurableCoverage).toBe(false)

    const fifth = claim({ commandId: 'command-5', threadId: 'thread-5', claimedAt: 5 })
    store.record(fifth)
    expect(store.list()).toEqual([first, second, third, fourth, fifth])
    expect(store.list({ recoveryHeadSequence: 2 })).toEqual([first, second])
  })

  it('does not parse past a recovery-head sequence bound', () => {
    const dir = dataDir('recovery-head-tail')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    const first = claim({ commandId: 'command-1', claimedAt: 1 })
    const second = claim({ commandId: 'command-2', threadId: 'thread-2', claimedAt: 2 })
    store.record(first)
    store.record(second)
    appendFileSync(store.path, 'this is not a claim line\n{"kind":"claim"}\n')

    expect(store.declaresDurableCoverage).toBe(false)
    expect(store.list({ recoveryHeadSequence: 2 })).toEqual([first, second])
    expect(() => store.list()).toThrow()
  })

  it('rejects an invalid recovery-head sequence without poisoning the journal', () => {
    const dir = dataDir('recovery-head-invalid')
    const store = openHostNodeQueuedStartExecutionClaimStore({
      dataDir: dir,
      createCoverageEpoch: () => EPOCH_A
    })
    store.record(claim())
    expect(() => store.list({ recoveryHeadSequence: -1 })).toThrow(/recovery-head/i)
    expect(() => store.list({ recoveryHeadSequence: 1.5 })).toThrow(/recovery-head/i)
    expect(() => store.list({ recoveryHeadSequence: Number.NaN })).toThrow(/recovery-head/i)
    expect(store.list()).toEqual([claim()])
    expect(store.declaresDurableCoverage).toBe(false)
  })
})
