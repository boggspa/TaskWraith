import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkSpanAggregates } from '../host-shared/perf/WorkSpanRecorder'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import { createHostPerfInstrumentation } from './HostPerfSnapshot'
import type { HostPerfSnapshotFileFs, HostPerfSnapshotFileTimers } from './HostPerfSnapshotFile'
import {
  createHostStandaloneComposition,
  HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS
} from './HostStandaloneComposition'

const paths: string[] = []
const BOOT_EPOCH_A = 'a'.repeat(64)
const actor = { actorId: 'actor-1', clientId: 'client-1', clientClass: 'test' as const }
const context = {
  actor,
  client: { clientId: 'client-1', clientClass: 'test' as const, clientVersion: '1.0.0' }
}

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

function command(): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'standalone-command-1',
    idempotencyKey: 'standalone-key-1',
    actor,
    name: 'thread.select',
    target: { threadId: 'thread-1' },
    arguments: {},
    issuedAt: '2026-08-24T00:00:00.000Z'
  }
}

function input(runtimePath: string, lease: { assertHeld(): void }) {
  return {
    runtimePath,
    lease,
    host: { hostId: 'standalone-host', hostVersion: '1.0.0' },
    hostCapabilityOffer: [
      'bootstrap',
      'snapshot',
      'deltas',
      'commands',
      'receipts',
      'health'
    ] as const,
    snapshotDonor: () => ({
      health: {
        hostStatus: 'ok' as const,
        connectionPhase: 'live' as const,
        supervised: false,
        freshness: 'live' as const
      },
      workspaces: [],
      threads: [],
      runs: [],
      missions: [],
      rounds: [],
      participants: [],
      providers: [],
      questions: [],
      approvals: [],
      schedules: [],
      usage: { availability: 'unavailable' as const },
      artifacts: [],
      warnings: []
    }),
    authorityEvaluator: () => ({ decision: 'allowed' as const }),
    commandExecutor: () => ({ status: 'succeeded' as const }),
    healthProvider: () => ({
      hostStatus: 'ok' as const,
      connectionPhase: 'live' as const,
      supervised: false,
      freshness: 'live' as const
    })
  }
}

describe('HostStandaloneComposition', () => {
  it('can cancel a run while another command is waiting for start capacity', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-cancel-'))
    paths.push(runtimePath)
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const executor = vi.fn(async (received: HostCommand) => {
      if (received.name !== 'run.cancel') await paused
      return { status: 'succeeded' as const }
    })
    const composition = createHostStandaloneComposition({
      ...input(runtimePath, { assertHeld: vi.fn() }),
      commandExecutor: executor
    })
    const pending = composition.authority.command(context, command())
    try {
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce())
      const cancellation = composition.authority.command(context, {
        ...command(),
        commandId: 'cancel-1',
        idempotencyKey: 'cancel-key-1',
        name: 'run.cancel'
      })
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2))
      await expect(cancellation).resolves.toMatchObject({
        ok: true,
        value: { status: 'succeeded' }
      })
    } finally {
      release()
      await pending
      await composition.shutdown()
    }
  })

  it.each(['succeeded', 'failed'] as const)(
    'keeps a %s command receipt coherent when reconciliation runs during execution',
    async (status) => {
      const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-observation-'))
      paths.push(runtimePath)
      const defaults = input(runtimePath, { assertHeld: vi.fn() })
      let title = 'Before'
      let release!: () => void
      const paused = new Promise<void>((resolve) => {
        release = resolve
      })
      const executor = vi.fn(async () => {
        title = 'After'
        await paused
        return { status }
      })
      const composition = createHostStandaloneComposition({
        ...defaults,
        snapshotDonor: () => ({
          ...defaults.snapshotDonor(),
          threads: [
            {
              id: 'thread-1',
              workspaceId: null,
              title,
              chatKind: 'single' as const,
              archived: false,
              pinned: false,
              updatedAt: 1,
              messageCount: 0
            }
          ]
        }),
        commandExecutor: executor
      })
      try {
        await composition.startProjectionReconciliation()
        const pending = composition.authority.command(context, command())
        await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce())
        const reconciliation = composition.reconcileProjection()
        // Let the background pass reach publication before releasing the command.
        await new Promise((resolve) => setTimeout(resolve, 20))
        release()
        await expect(pending).resolves.toMatchObject({ ok: true, value: { status } })
        await reconciliation
        expect(executor).toHaveBeenCalledOnce()
        await expect(composition.authority.snapshot(context)).resolves.toMatchObject({
          ok: true,
          value: { threads: [expect.objectContaining({ title: 'After' })] }
        })
      } finally {
        release()
        await composition.shutdown()
      }
    }
  )

  it('asserts the lease before opening the sole runtime and recovers receipt state after restart', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-'))
    paths.push(runtimePath)
    const order: string[] = []
    const lease = { assertHeld: vi.fn(() => order.push('lease')) }
    const first = createHostStandaloneComposition(input(runtimePath, lease))
    expect(order).toEqual(['lease'])
    const result = await first.authority.command(context, command())
    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded' } })
    await first.shutdown()

    const secondLease = { assertHeld: vi.fn() }
    const second = createHostStandaloneComposition(input(runtimePath, secondLease))
    const replay = await second.authority.command(context, command())
    expect(replay).toMatchObject({
      ok: true,
      value: { commandId: 'standalone-command-1', status: 'succeeded' }
    })
    await second.shutdown()
  })

  it('forwards the optional workspace Git read provider into Authority', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-git-'))
    paths.push(runtimePath)
    const gitReadProvider = vi.fn(() => ({
      scope: 'status' as const,
      branch: 'main',
      head: 'a'.repeat(40),
      files: [],
      truncated: false
    }))
    const composition = createHostStandaloneComposition({
      ...input(runtimePath, { assertHeld: vi.fn() }),
      gitReadProvider
    })

    await expect(
      composition.authority.gitRead?.(context, {
        workspaceId: 'workspace-1',
        scope: 'status'
      })
    ).resolves.toMatchObject({ ok: true, value: { scope: 'status' } })
    expect(gitReadProvider).toHaveBeenCalledWith(context, {
      workspaceId: 'workspace-1',
      scope: 'status'
    })
    await composition.shutdown()
  })

  it('does not construct a standalone composition when the lease assertion fails', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-fail-'))
    paths.push(runtimePath)
    expect(() =>
      createHostStandaloneComposition(
        input(runtimePath, {
          assertHeld: () => {
            throw new Error('lease missing')
          }
        })
      )
    ).toThrow('lease missing')
  })

  it('meters the Host loop and attributes projection queue waits from the first command', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-'))
    paths.push(runtimePath)
    const composition = createHostStandaloneComposition(input(runtimePath, { assertHeld: vi.fn() }))
    try {
      // No opt-in, no file transport: the meter and recorder still run in-process.
      expect(composition.perf.snapshotFile).toBeNull()
      expect(composition.perf.snapshot().eventLoopLag.sampling).toBe(true)
      await composition.authority.command(context, command())
      const workSpans = composition.perf.snapshot().sections.workSpans as WorkSpanAggregates
      expect(workSpans.process).toBe('host')
      expect(workSpans.byKind.host_queue_wait).toMatchObject({ count: 1 })
      expect(workSpans.byKind.receipt_delivery).toMatchObject({ count: 1 })
      expect(workSpans.byResource.host_chain).toMatchObject({ count: 2 })
      expect(workSpans.exact.byKind.host_queue_wait).toMatchObject({ offeredCount: 1 })
      expect(workSpans.exact.byKind.receipt_delivery).toMatchObject({ offeredCount: 1 })
      expect(workSpans.byChat['thread-1']?.host_queue_wait).toMatchObject({ count: 1 })
      expect(workSpans.byChat['thread-1']?.receipt_delivery).toMatchObject({ count: 1 })
      expect(
        composition.perf.spans
          .snapshot()
          .spans.map((span) => [span.kind, span.chatId, span.resource])
      ).toEqual([
        ['receipt_delivery', 'thread-1', 'host_chain'],
        ['host_queue_wait', 'thread-1', 'host_chain']
      ])
    } finally {
      await composition.shutdown()
    }
    // Shutdown drains the queue (one more span) and only then stops the meter;
    // the recorded aggregates stay readable afterwards.
    const afterShutdown = composition.perf.snapshot()
    expect(afterShutdown.eventLoopLag.sampling).toBe(false)
    expect(
      (afterShutdown.sections.workSpans as WorkSpanAggregates).byKind.host_queue_wait
    ).toMatchObject({ count: 2 })
  })

  it('stamps the opt-in snapshot file with the Host identity and stops it on shutdown', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-file-'))
    paths.push(runtimePath)
    const path = join(runtimePath, 'perf', 'host-snapshot.json')
    const files = new Map<string, string>()
    const fs: HostPerfSnapshotFileFs = {
      writeFileSync: (target, data) => {
        files.set(target, data)
      },
      renameSync: (from, to) => {
        files.set(to, files.get(from)!)
        files.delete(from)
      }
    }
    const intervals: number[] = []
    let cleared = 0
    const timers: HostPerfSnapshotFileTimers = {
      setInterval: (_callback, ms) => {
        intervals.push(ms)
        return { unref: () => undefined }
      },
      clearInterval: () => {
        cleared += 1
      }
    }
    const directories: string[] = []
    const composition = createHostStandaloneComposition({
      ...input(runtimePath, { assertHeld: vi.fn() }),
      perf: {
        snapshotFile: {
          path,
          fs,
          timers,
          ensureDirectory: (directory) => {
            directories.push(directory)
          }
        },
        now: () => new Date('2026-09-08T20:00:00.000Z')
      },
      bootEpochFactory: () => BOOT_EPOCH_A
    })
    try {
      expect(directories).toEqual([join(runtimePath, 'perf')])
      expect(intervals).toEqual([HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS])
      expect(composition.perf.identity).toEqual({
        process: 'host',
        instanceId: 'standalone-host',
        generation: composition.getPosition().generation,
        pid: process.pid,
        bootEpoch: BOOT_EPOCH_A
      })
      await composition.authority.command(context, command())
      expect(composition.perf.snapshotFile?.writeOnce()).toBe(true)
      const payload = JSON.parse(files.get(path)!)
      expect(payload.identity).toEqual(composition.perf.identity)
      expect(payload.sequence).toBe(1)
      expect(payload.capturedAt).toBe('2026-09-08T20:00:00.000Z')
      expect(payload.snapshot.sections.workSpans.byKind.host_queue_wait).toMatchObject({ count: 1 })
      expect(composition.perf.snapshotFile?.stats()).toMatchObject({ running: true, writes: 1 })
    } finally {
      await composition.shutdown()
    }
    expect(cleared).toBe(1)
    expect(composition.perf.snapshotFile?.stats()).toMatchObject({ running: false, writes: 1 })
  })

  it('keeps an unwritable snapshot directory out of Host startup', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-dir-'))
    paths.push(runtimePath)
    const composition = createHostStandaloneComposition({
      ...input(runtimePath, { assertHeld: vi.fn() }),
      perf: {
        snapshotFile: {
          path: join(runtimePath, 'perf', 'host-snapshot.json'),
          fs: {
            writeFileSync: () => {
              throw new Error('ENOENT')
            },
            renameSync: () => undefined
          },
          timers: { setInterval: () => null, clearInterval: () => undefined },
          ensureDirectory: () => {
            throw new Error('EACCES')
          }
        }
      }
    })
    try {
      expect(composition.perf.snapshotFile?.writeOnce()).toBe(false)
      expect(composition.perf.snapshotFile?.stats()).toMatchObject({ writes: 0, writeFailures: 1 })
      await expect(composition.authority.command(context, command())).resolves.toMatchObject({
        ok: true,
        value: { status: 'succeeded' }
      })
    } finally {
      await composition.shutdown()
    }
  })

  it('leaves no diagnostic armed when the snapshot transport cannot be started', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-arm-'))
    paths.push(runtimePath)
    const real = createHostPerfInstrumentation()
    let starts = 0
    let stops = 0
    const instrumentation = {
      ...real,
      start: () => {
        starts += 1
        real.start()
      },
      stop: () => {
        stops += 1
        real.stop()
      }
    }
    expect(() =>
      createHostStandaloneComposition({
        ...input(runtimePath, { assertHeld: vi.fn() }),
        perf: {
          instrumentation,
          snapshotFile: {
            path: join(runtimePath, 'perf', 'host-snapshot.json'),
            fs: { writeFileSync: () => undefined, renameSync: () => undefined },
            timers: {
              setInterval: () => {
                throw new Error('timer unavailable')
              },
              clearInterval: () => undefined
            },
            ensureDirectory: () => undefined
          }
        }
      })
    ).toThrow('timer unavailable')
    // The meter was armed before the transport threw; activation rolled it back.
    expect(starts).toBe(1)
    expect(stops).toBe(1)
    expect(real.snapshot().eventLoopLag.sampling).toBe(false)
  })

  it('keeps the activation error when rollback itself fails', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-rollback-'))
    paths.push(runtimePath)
    const real = createHostPerfInstrumentation()
    const instrumentation = {
      ...real,
      stop: () => {
        real.stop()
        throw new Error('stop failed')
      }
    }
    expect(() =>
      createHostStandaloneComposition({
        ...input(runtimePath, { assertHeld: vi.fn() }),
        perf: {
          instrumentation,
          snapshotFile: {
            path: join(runtimePath, 'perf', 'host-snapshot.json'),
            fs: { writeFileSync: () => undefined, renameSync: () => undefined },
            timers: {
              setInterval: () => {
                throw new Error('timer unavailable')
              },
              clearInterval: () => undefined
            },
            ensureDirectory: () => undefined
          }
        }
      })
    ).toThrow('timer unavailable')
    expect(real.snapshot().eventLoopLag.sampling).toBe(false)
  })

  it('refuses a malformed timer seam before arming anything', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-timers-'))
    paths.push(runtimePath)
    let starts = 0
    const instrumentation = {
      ...createHostPerfInstrumentation(),
      start: () => {
        starts += 1
      }
    }
    expect(() =>
      createHostStandaloneComposition({
        ...input(runtimePath, { assertHeld: vi.fn() }),
        perf: {
          instrumentation,
          snapshotFile: {
            path: join(runtimePath, 'perf', 'host-snapshot.json'),
            timers: { setInterval: 'soon' } as never,
            ensureDirectory: () => undefined
          }
        }
      })
    ).toThrow('Host perf snapshot timers must supply setInterval and clearInterval')
    expect(starts).toBe(0)
  })

  it('arms no transport timer when the meter refuses to start', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-perf-meter-'))
    paths.push(runtimePath)
    let stops = 0
    const instrumentation = {
      ...createHostPerfInstrumentation(),
      start: () => {
        throw new Error('meter unavailable')
      },
      stop: () => {
        stops += 1
      }
    }
    let armed = 0
    expect(() =>
      createHostStandaloneComposition({
        ...input(runtimePath, { assertHeld: vi.fn() }),
        perf: {
          instrumentation,
          snapshotFile: {
            path: join(runtimePath, 'perf', 'host-snapshot.json'),
            fs: { writeFileSync: () => undefined, renameSync: () => undefined },
            timers: {
              setInterval: () => {
                armed += 1
                return null
              },
              clearInterval: () => undefined
            },
            ensureDirectory: () => undefined
          }
        }
      })
    ).toThrow('meter unavailable')
    // Meter first, transport second: a refused meter never arms the timer.
    expect(armed).toBe(0)
    expect(stops).toBe(1)
  })
})

/**
 * The boot epoch exists for exactly one reason: pid, journal generation and
 * writer sequence all REPEAT across a same-process recreation, so a stale
 * snapshot file from the previous incarnation is otherwise indistinguishable
 * from the live one. These cases prove the mint is the only field that breaks
 * that tie, that a malformed epoch is refused rather than dropped, and that
 * the epoch is never the shape-identical transport auth token.
 */
describe('HostStandaloneComposition boot epoch', () => {
  function snapshotWriterSeams(): {
    files: Map<string, string>
    fs: HostPerfSnapshotFileFs
    timers: HostPerfSnapshotFileTimers
  } {
    const files = new Map<string, string>()
    return {
      files,
      fs: {
        writeFileSync: (target, data) => {
          files.set(target, data)
        },
        renameSync: (from, to) => {
          files.set(to, files.get(from)!)
          files.delete(from)
        }
      },
      timers: {
        setInterval: () => ({ unref: () => undefined }),
        clearInterval: () => undefined
      }
    }
  }

  it('mints a distinct epoch per incarnation while pid, generation and sequence repeat', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-boot-epoch-'))
    paths.push(runtimePath)
    const path = join(runtimePath, 'perf', 'host-snapshot.json')

    // Two incarnations on the SAME runtime path — the crash-loop recreation
    // that keeps the authority lease, the pid and the journal alive. The
    // default production mint is used deliberately: this must hold for the
    // real randomBytes path, not an injected fixture.
    const written: Record<string, unknown>[] = []
    for (let incarnation = 0; incarnation < 2; incarnation += 1) {
      const { files, fs, timers } = snapshotWriterSeams()
      const composition = createHostStandaloneComposition({
        ...input(runtimePath, { assertHeld: vi.fn() }),
        perf: {
          snapshotFile: { path, fs, timers, ensureDirectory: () => undefined },
          now: () => new Date('2026-09-08T20:00:00.000Z')
        }
      })
      try {
        expect(composition.perf.snapshotFile?.writeOnce()).toBe(true)
        written.push(JSON.parse(files.get(path)!))
      } finally {
        await composition.shutdown()
      }
    }

    const [first, second] = written as {
      identity: Record<string, unknown>
      sequence: number
    }[]

    // Everything a reader could otherwise pin on is IDENTICAL across the two
    // files — this is the counterexample, stated as an assertion.
    expect(second.identity.pid).toBe(first.identity.pid)
    expect(second.identity.generation).toBe(first.identity.generation)
    expect(second.identity.instanceId).toBe(first.identity.instanceId)
    expect(second.sequence).toBe(first.sequence)
    expect(second.sequence).toBe(1)

    // The epoch is the only discriminator, and both are well formed.
    expect(first.identity.bootEpoch).toMatch(/^[0-9a-f]{64}$/)
    expect(second.identity.bootEpoch).toMatch(/^[0-9a-f]{64}$/)
    expect(second.identity.bootEpoch).not.toBe(first.identity.bootEpoch)

    // Non-vacuous, and the whole point: the two identities differ in NOTHING
    // but the epoch, so a collector pinning the pre-epoch fields could not
    // reject the stale file. Only the identity is compared — the surrounding
    // payload carries live loop-lag measurements that differ between any two
    // captures, which would make a whole-artifact comparison flaky rather
    // than stronger.
    expect(second.identity).toEqual({ ...first.identity, bootEpoch: second.identity.bootEpoch })

    // Guards the assertion above against passing on a degenerate identity:
    // if the epoch were the only field, "differs in nothing but the epoch"
    // would be trivially true.
    expect(Object.keys(first.identity).sort()).toEqual([
      'bootEpoch',
      'generation',
      'instanceId',
      'pid',
      'process'
    ])
  })

  it('refuses a malformed minted epoch instead of dropping it', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-boot-epoch-bad-'))
    paths.push(runtimePath)
    // A dropped epoch would read downstream as legacy absence rather than as
    // a fault, silently disarming the collector's pin — so every one of these
    // must throw at construction.
    const malformed: [string, unknown][] = [
      ['uppercase', 'A'.repeat(64)],
      ['63 chars', 'a'.repeat(63)],
      ['65 chars', 'a'.repeat(65)],
      ['non-hex', `g${'a'.repeat(63)}`],
      ['empty', ''],
      ['not a string', 42]
    ]
    for (const [label, value] of malformed) {
      expect(
        () =>
          createHostStandaloneComposition({
            ...input(runtimePath, { assertHeld: vi.fn() }),
            bootEpochFactory: () => value as string
          }),
        label
      ).toThrow(/bootEpoch/)
    }
  })

  it('never reuses the transport auth token, which shares its exact shape', () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'host-standalone-boot-epoch-token-'))
    paths.push(runtimePath)
    // HostLocalServer mints its secret with randomBytes(32).toString('hex') —
    // byte-for-byte the same shape as this public epoch. Nothing structural
    // would catch a future swap, so pin independence explicitly.
    const tokens = new Set<string>()
    const epochs = new Set<string>()
    for (let index = 0; index < 64; index += 1) {
      tokens.add(randomBytes(32).toString('hex'))
      const composition = createHostStandaloneComposition({
        ...input(runtimePath, { assertHeld: vi.fn() })
      })
      epochs.add(composition.perf.identity.bootEpoch!)
      void composition.shutdown()
    }
    expect(epochs.size).toBe(64)
    for (const epoch of epochs) expect(tokens.has(epoch)).toBe(false)
  })

  it('mints independently of host identity and runtime path', () => {
    const first = mkdtempSync(join(tmpdir(), 'host-standalone-boot-epoch-i1-'))
    const second = mkdtempSync(join(tmpdir(), 'host-standalone-boot-epoch-i2-'))
    paths.push(first, second)
    // Identical inputs must not yield a reproducible epoch: an epoch derived
    // from stable inputs would be predictable and would repeat across a
    // restart, defeating the whole point.
    const a = createHostStandaloneComposition({ ...input(first, { assertHeld: vi.fn() }) })
    const b = createHostStandaloneComposition({ ...input(second, { assertHeld: vi.fn() }) })
    try {
      expect(a.perf.identity.instanceId).toBe(b.perf.identity.instanceId)
      expect(a.perf.identity.bootEpoch).not.toBe(b.perf.identity.bootEpoch)
    } finally {
      void a.shutdown()
      void b.shutdown()
    }
  })
})
