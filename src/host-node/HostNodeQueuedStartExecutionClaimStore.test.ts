import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHostNodeQueuedStartLifecycle } from './HostNodeQueuedStartLifecycle'
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
    fresh.record(claim())

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
    fresh.record(claim({ claimedAt: 999 }))
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
})
