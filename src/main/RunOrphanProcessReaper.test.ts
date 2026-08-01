import { describe, expect, it, vi } from 'vitest'

import { RunOrphanProcessReaper } from './RunOrphanProcessReaper'
import type { KillController } from './localServers/killer'
import type { RunProcessOwnershipReceipt, RunQueueJob } from './store/types'

const NOW = '2026-08-01T10:00:00.000Z'

function job(partial: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'run-1',
    runId: 'run-1',
    provider: 'cursor',
    source: 'system',
    status: 'active',
    priority: 0,
    attempt: 1,
    createdAt: NOW,
    updatedAt: NOW,
    processPid: 4242,
    processCommand: 'cursor-agent --print',
    ...partial
  }
}

function receipt(partial: Partial<RunProcessOwnershipReceipt> = {}): RunProcessOwnershipReceipt {
  return {
    schemaVersion: 1,
    pid: 4242,
    processBirthIdentity: 'birth-4242',
    capturedAt: NOW,
    containment: { kind: 'posix_process_group', processGroupId: 4242 },
    ...partial
  }
}

function harness(input: {
  initial?: RunQueueJob
  identities?: Array<'dead' | 'unavailable' | string>
  processGroupId?: number | null
  controller?: KillController
  platform?: NodeJS.Platform
}) {
  const jobs = new Map<string, RunQueueJob>()
  const initial = input.initial ?? job()
  jobs.set(initial.runId, initial)
  const observations = [...(input.identities ?? ['birth-4242', 'birth-4242'])]
  const signals: string[] = []
  let alive = true
  const controller: KillController =
    input.controller ??
    ({
      signal: (signal) => {
        signals.push(signal)
        alive = false
      },
      isAlive: () => alive
    } satisfies KillController)
  const persistJob = vi.fn((runId: string, partial: Partial<RunQueueJob>) => {
    const current = jobs.get(runId)
    if (current) jobs.set(runId, { ...current, ...partial })
  })
  const reaper = new RunOrphanProcessReaper({
    platform: input.platform ?? 'darwin',
    now: () => NOW,
    graceMs: 1,
    processIdentity: {
      observe: async () => {
        const next = observations.shift() ?? 'dead'
        if (next === 'dead') return { state: 'dead' as const }
        if (next === 'unavailable') return { state: 'identity_unavailable' as const }
        return { state: 'live' as const, processBirthIdentity: next }
      }
    },
    loadJob: (runId) => jobs.get(runId) ?? null,
    persistJob,
    dependencies: {
      resolvePosixProcessGroupId: async () => input.processGroupId ?? 4242,
      createPosixProcessGroupController: () => controller,
      createWindowsProcessTreeController: () => controller,
      wait: async () => undefined
    }
  })
  return { jobs, persistJob, reaper, signals }
}

describe('RunOrphanProcessReaper', () => {
  it('captures a stable birth identity only for an isolated process-group leader', async () => {
    const { jobs, reaper } = harness({})

    const captured = await reaper.capture('run-1', 4242)

    expect(captured).toEqual({
      schemaVersion: 1,
      pid: 4242,
      processBirthIdentity: 'birth-4242',
      capturedAt: NOW,
      containment: { kind: 'posix_process_group', processGroupId: 4242 }
    })
    expect(jobs.get('run-1')?.processOwnership).toEqual(captured)
  })

  it('refuses to mint a receipt when the process shares somebody else’s group', async () => {
    const { jobs, persistJob, reaper } = harness({ processGroupId: 4000 })

    expect(await reaper.capture('run-1', 4242)).toBeNull()
    expect(jobs.get('run-1')?.processOwnership).toBeUndefined()
    expect(persistJob).not.toHaveBeenCalled()
  })

  it('terminates a matching owned process group and persists recovery evidence', async () => {
    const owned = job({ processOwnership: receipt() })
    const { jobs, reaper, signals } = harness({ initial: owned, identities: ['birth-4242'] })

    const snapshots = await reaper.reap([owned])

    expect(signals).toEqual(['SIGTERM'])
    expect(snapshots.get('run-1')).toMatchObject({
      pid: 4242,
      alive: false,
      detection: 'verified_process_identity',
      action: 'terminated'
    })
    expect(jobs.get('run-1')?.orphanProcess).toEqual(snapshots.get('run-1'))
  })

  it('escalates a process group that ignores TERM', async () => {
    const signals: string[] = []
    let alive = true
    const owned = job({ processOwnership: receipt() })
    const { reaper } = harness({
      initial: owned,
      identities: ['birth-4242', 'birth-4242'],
      controller: {
        signal: (signal) => {
          signals.push(signal)
          if (signal === 'SIGKILL') alive = false
        },
        isAlive: () => alive
      }
    })

    const snapshots = await reaper.reap([owned])

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(snapshots.get('run-1')?.action).toBe('force_killed')
    expect(snapshots.get('run-1')?.alive).toBe(false)
  })

  it('does not force-kill a group id after the verified root has exited', async () => {
    const signals: string[] = []
    const owned = job({ processOwnership: receipt() })
    const { reaper } = harness({
      initial: owned,
      identities: ['birth-4242', 'dead'],
      controller: {
        signal: (signal) => signals.push(signal),
        // Model either a stubborn descendant or a newly reused group id.
        isAlive: () => true
      }
    })

    const snapshots = await reaper.reap([owned])

    expect(signals).toEqual(['SIGTERM'])
    expect(snapshots.get('run-1')).toMatchObject({
      alive: true,
      action: 'termination_failed'
    })
  })

  it('does not signal a reused PID whose birth identity differs', async () => {
    const owned = job({ processOwnership: receipt() })
    const { reaper, signals } = harness({ initial: owned, identities: ['different-process'] })

    const snapshots = await reaper.reap([owned])

    expect(signals).toEqual([])
    expect(snapshots.get('run-1')).toMatchObject({
      alive: true,
      action: 'identity_mismatch'
    })
  })

  it('leaves legacy PID-only jobs for the existing warning path', async () => {
    const legacy = job()
    const { persistJob, reaper, signals } = harness({ initial: legacy })

    expect(await reaper.reap([legacy])).toEqual(new Map())
    expect(signals).toEqual([])
    expect(persistJob).not.toHaveBeenCalled()
  })
})
