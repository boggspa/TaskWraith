import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkSpanAggregates } from '../host-shared/perf/WorkSpanRecorder'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import type { HostPerfSnapshotFileFs, HostPerfSnapshotFileTimers } from './HostPerfSnapshotFile'
import {
  createHostStandaloneComposition,
  HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS
} from './HostStandaloneComposition'

const paths: string[] = []
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
      expect(workSpans.byResource.host_chain).toMatchObject({ count: 1 })
      expect(workSpans.exact.byKind.host_queue_wait).toMatchObject({ offeredCount: 1 })
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
      }
    })
    try {
      expect(directories).toEqual([join(runtimePath, 'perf')])
      expect(intervals).toEqual([HOST_PERF_SNAPSHOT_FILE_INTERVAL_MS])
      expect(composition.perf.identity).toEqual({
        process: 'host',
        instanceId: 'standalone-host',
        generation: composition.getPosition().generation,
        pid: process.pid
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
})
