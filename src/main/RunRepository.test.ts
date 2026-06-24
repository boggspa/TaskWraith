import { describe, expect, it, vi } from 'vitest'
import { RunRepository } from './RunRepository'
import { AppStore } from './store'
import type { RunQueueJob } from './store/types'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-test'
  }
}))

describe('RunRepository', () => {
  it('emits queue changes for explicit transitions', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const save = vi.spyOn(repository, 'saveRunQueueJob').mockImplementation((input: any) => {
      emitRunQueueChanged()
      return {
        id: input.id,
        runId: input.runId,
        provider: input.provider,
        workspacePath: input.workspacePath,
        source: input.source,
        status: input.status,
        priority: 0,
        attempt: 1,
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z'
      }
    })
    let statuses: Array<string | undefined> = []

    try {
      repository.markQueued({ runId: 'run-1', provider: 'codex', workspacePath: '/repo' })
      repository.markStarting({ runId: 'run-1', provider: 'codex', workspacePath: '/repo' })
      repository.markCompleted({ runId: 'run-1', provider: 'codex', workspacePath: '/repo' })
      statuses = save.mock.calls.map((call) => call[0].status)
    } finally {
      save.mockRestore()
    }

    expect(statuses).toEqual(['queued', 'starting', 'completed'])
    expect(emitRunQueueChanged).toHaveBeenCalledTimes(3)
  })

  it('emits run event changes when events append successfully', () => {
    const emitRunEventsChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged
    })
    const append = vi.spyOn(AppStore, 'appendRunEvent').mockImplementation((input: any) => ({
      schemaVersion: 1,
      id: 'event-1',
      sequence: 7,
      timestamp: '2026-05-08T00:00:00.000Z',
      ...input
    }))

    try {
      const event = repository.appendRunEvent({
        runId: 'run-1',
        provider: 'codex',
        kind: 'lifecycle',
        phase: 'control',
        source: 'main'
      })

      expect(event?.sequence).toBe(7)
      expect(emitRunEventsChanged).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-1', sequence: 7 })
      )
    } finally {
      append.mockRestore()
    }
  })

  it('reads run events after the last seen sequence', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const getEvents = vi.spyOn(AppStore, 'getRunEvents').mockReturnValue([
      {
        schemaVersion: 1,
        id: 'event-3',
        sequence: 3,
        runId: 'run-1',
        provider: 'codex',
        kind: 'lifecycle',
        phase: 'control',
        source: 'main',
        timestamp: '2026-05-08T00:00:00.000Z'
      }
    ])

    try {
      const events = repository.eventsForRunSinceSequence('run-1', 2)

      expect(getEvents).toHaveBeenCalledWith({ runId: 'run-1', fromSequence: 3 })
      expect(events.map((event) => event.sequence)).toEqual([3])
    } finally {
      getEvents.mockRestore()
    }
  })

  it('leases queued jobs by moving them to starting', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const queuedJob: any = {
      id: 'run-1',
      runId: 'run-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'queued',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(queuedJob)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, partial: any) => ({
        ...queuedJob,
        ...partial
      }))

    try {
      const leased = repository.leaseQueuedRun({ runId: 'run-1', provider: 'gemini' })

      expect(leased?.status).toBe('starting')
      expect(update).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'starting' }))
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(1)
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })

  it('leases global queued jobs without workspace paths', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const queuedJob: any = {
      id: 'global-run-1',
      runId: 'global-run-1',
      provider: 'codex',
      scope: 'global',
      chatId: 'global-chat-1',
      source: 'manual',
      status: 'queued',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(queuedJob)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, partial: any) => ({
        ...queuedJob,
        ...partial
      }))

    try {
      const leased = repository.leaseQueuedRun({ runId: 'global-run-1', provider: 'codex' })

      expect(leased).toMatchObject({ scope: 'global', status: 'starting' })
      expect(update).toHaveBeenCalledWith(
        'global-run-1',
        expect.objectContaining({ status: 'starting' })
      )
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(1)
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })

  it('transitions queue jobs through the main repository API', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((runId, partial: any) => ({
        id: runId,
        runId,
        provider: 'codex',
        workspacePath: '/repo',
        source: 'manual',
        status: partial.status,
        statusReason: partial.statusReason,
        lastError: partial.lastError,
        priority: 0,
        attempt: 1,
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z'
      }))

    try {
      const transitioned = repository.transitionRunQueueJob('run-1', 'failed', {
        statusReason: 'Provider failed.',
        lastError: 'boom'
      })

      expect(transitioned).toMatchObject({
        status: 'failed',
        statusReason: 'Provider failed.',
        lastError: 'boom'
      })
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(1)
    } finally {
      update.mockRestore()
    }
  })

  it('promotes queued jobs for steer with owner-token idempotency', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    let stored: any = {
      id: 'run-1',
      runId: 'run-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'queued',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockImplementation(() => stored)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, partial: any) => {
        stored = { ...stored, ...partial }
        return stored
      })
    try {
      const first = repository.promoteQueuedJobForSteer({ runId: 'run-1', ownerToken: 'owner-token' })
      expect(first?.status).toBe('steer_promoting')
      expect(update).toHaveBeenCalledTimes(1)
      expect(update).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: 'steer_promoting',
          promotionOwnerToken: 'owner-token',
          promotionToken: 'owner-token'
        })
      )

      const second = repository.promoteQueuedJobForSteer({
        runId: 'run-1',
        ownerToken: 'owner-token'
      })
      expect(second?.status).toBe('steer_promoting')
      expect(update).toHaveBeenCalledTimes(1)
      expect(first).toBe(second)
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(1)
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })

  it('rejects steer promotion requests with a mismatched owner token', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const queued: RunQueueJob = {
      id: 'run-1',
      runId: 'run-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'steer_promoting',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      promotionOwnerToken: 'owner-token'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(queued)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, _partial: any) => queued)

    try {
      const rejected = repository.promoteQueuedJobForSteer({
        runId: 'run-1',
        ownerToken: 'other-owner-token'
      })
      expect(rejected).toBeNull()
      expect(update).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })

  it('does not lease non-queued jobs from the normal queued-lease path', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const job: any = {
      id: 'run-1',
      runId: 'run-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'steer_promoting',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(job)
    const update = vi.spyOn(AppStore, 'updateRunQueueJob')

    try {
      const leased = repository.leaseQueuedRun({ runId: 'run-1' })
      expect(leased).toBeNull()
      expect(update).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })

  it('leases a promoted job for steer only with the matching owner token', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const job: any = {
      id: 'run-1',
      runId: 'run-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'steer_promoting',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      promotionOwnerToken: 'owner-token'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(job)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, partial: any) => ({ ...job, ...partial }))

    try {
      const leased = repository.leasePromotedSteerJob({
        runId: 'run-1',
        ownerToken: 'owner-token'
      })
      expect(leased?.status).toBe('starting')
      expect(update).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: 'starting',
          promotionOwnerToken: undefined,
          promotionToken: undefined
        })
      )
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(1)
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })

  it('falls back a promoted job to queued or terminal based on reason with statusReason', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const promoted: any = {
      id: 'run-1',
      runId: 'run-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'steer_promoting',
      priority: 0,
      attempt: 1,
      promotionOwnerToken: 'owner-token',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(promoted)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, partial: any) => ({ ...promoted, ...partial }))

    try {
      expect(
        repository.fallbackPromotedSteerJob({
          runId: 'run-1',
          ownerToken: 'owner-token',
          reason: 'retry queued'
        })?.status
      ).toBe('queued')
      expect(
        repository.fallbackPromotedSteerJob({
          runId: 'run-1',
          ownerToken: 'owner-token',
          reason: 'failed due to infrastructure issue',
          fallbackStatus: 'queued'
        })?.status
      ).toBe('queued')
      expect(
        repository.fallbackPromotedSteerJob({
          runId: 'run-1',
          ownerToken: 'owner-token',
          reason: 'failed due to infrastructure issue'
        })?.status
      ).toBe('failed')
      expect(update).toHaveBeenCalledTimes(3)
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(3)
    } finally {
      get.mockRestore()
      update.mockRestore()
    }
  })
})
