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
  it('persists a spawned PID before requesting its ownership receipt', () => {
    const captureProcessOwnership = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      captureProcessOwnership,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const getExisting = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(null)
    const saveQueue = vi.spyOn(AppStore, 'saveRunQueueJob').mockImplementation((input: any) => input)

    try {
      repository.persistSessionQueueState({
        runId: 'run-owned-process',
        provider: 'cursor',
        appChatId: 'chat-1',
        workspacePath: '/repo',
        status: 'running',
        startedAt: Date.parse('2026-08-01T10:00:00.000Z'),
        updatedAt: Date.parse('2026-08-01T10:00:01.000Z'),
        process: {
          pid: 4242,
          spawnfile: '/usr/local/bin/cursor-agent',
          kill: vi.fn()
        } as any,
        approvalIds: new Set(),
        sessionGrants: new Set()
      })

      expect(saveQueue).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-owned-process',
          processPid: 4242,
          processCommand: '/usr/local/bin/cursor-agent'
        })
      )
      expect(captureProcessOwnership).toHaveBeenCalledWith({
        runId: 'run-owned-process',
        pid: 4242
      })
      expect(saveQueue.mock.invocationCallOrder[0]).toBeLessThan(
        captureProcessOwnership.mock.invocationCallOrder[0]
      )
    } finally {
      getExisting.mockRestore()
      saveQueue.mockRestore()
    }
  })

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

  it('stamps missing dispatch receipts on direct queue repository saves', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const getExisting = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(null)
    const saveQueue = vi
      .spyOn(AppStore, 'saveRunQueueJob')
      .mockImplementation((input: any) => input)

    try {
      repository.saveRunQueueJob({
        id: 'remote-queue-1',
        runId: 'remote-queue-1',
        provider: 'codex',
        scope: 'workspace',
        workspaceId: 'workspace-1',
        chatId: 'chat-1',
        workspacePath: '/repo',
        source: 'remote',
        status: 'queued',
        request: {
          scope: 'workspace',
          prompt: 'From phone',
          selectedModelType: 'cli-default',
          customModel: '',
          approvalMode: 'plan',
          workflowMode: 'plan',
          sessionTrust: false,
          imageAttachments: [],
          remoteComposer: {
            workspaceId: 'workspace-1',
            threadId: 'chat-1',
            provider: 'codex',
            text: 'From phone',
            approvalMode: 'plan',
            workflowMode: 'plan'
          }
        }
      })

      expect(saveQueue).toHaveBeenCalledWith(
        expect.objectContaining({
          dispatchReceipt: expect.objectContaining({
            schemaVersion: 1,
            runId: 'remote-queue-1',
            provider: 'codex',
            source: 'remote',
            workspaceId: 'workspace-1',
            chatId: 'chat-1',
            approvalMode: 'plan',
            workflowMode: 'plan',
            permissionPostureSignaturePresent: false,
            receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            remoteComposer: expect.objectContaining({
              workspaceId: 'workspace-1',
              threadId: 'chat-1',
              provider: 'codex',
              approvalMode: 'plan',
              workflowMode: 'plan'
            })
          })
        })
      )
    } finally {
      getExisting.mockRestore()
      saveQueue.mockRestore()
    }
  })

  it('persists permission posture snapshots on queue jobs and lifecycle events', () => {
    const permissionPosture = {
      schemaVersion: 1,
      approvalMode: 'plan',
      workflowMode: 'plan',
      presetId: 'plan',
      readOnly: true,
      networkAccess: 'deny',
      externalPathGrantCount: 0,
      postureHash: 'posture-hash',
      signature: 'signed-posture',
      signaturePresent: true
    } as const
    const dispatchReceipt = {
      schemaVersion: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
      receiptHash: 'd'.repeat(64),
      runId: 'run-1',
      provider: 'codex',
      source: 'scheduled',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      approvalMode: 'plan',
      workflowMode: 'plan',
      permissionPresetId: 'plan',
      readOnly: true,
      permissionPostureHash: 'posture-hash',
      permissionPostureSignaturePresent: true
    } as const
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      permissionPostureForSession: vi.fn(() => permissionPosture),
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const getExisting = vi
      .spyOn(AppStore, 'getRunQueueJob')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ dispatchReceipt } as RunQueueJob)
    const saveQueue = vi
      .spyOn(AppStore, 'saveRunQueueJob')
      .mockImplementation((input: any) => input)
    const append = vi.spyOn(AppStore, 'appendRunEvent').mockImplementation((input: any) => ({
      schemaVersion: 1,
      id: 'event-1',
      sequence: 1,
      timestamp: '2026-05-08T00:00:00.000Z',
      ...input
    }))
    const session: any = {
      runId: 'run-1',
      provider: 'codex',
      appChatId: 'chat-1',
      workspacePath: '/repo',
      status: 'running',
      startedAt: Date.parse('2026-05-08T00:00:00.000Z'),
      updatedAt: Date.parse('2026-05-08T00:00:01.000Z'),
      approvalIds: new Set(),
      sessionGrants: new Set()
    }

    try {
      repository.persistSessionQueueState(session)
      repository.appendLifecycleEvent('created', session)

      expect(saveQueue).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          permissionPosture
        })
      )
      expect(append.mock.results[0]?.value?.payload).toMatchObject({
        eventType: 'created',
        dispatchReceipt,
        permissionPosture
      })
    } finally {
      getExisting.mockRestore()
      saveQueue.mockRestore()
      append.mockRestore()
    }
  })

  it('attaches scheduled task dispatch receipts to lifecycle events for non-queued runs', () => {
    const dispatchReceipt = {
      schemaVersion: 1,
      generatedAt: '2026-05-08T00:00:00.000Z',
      receiptHash: 'e'.repeat(64),
      runId: 'run-1',
      provider: 'codex',
      source: 'scheduled',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      approvalMode: 'plan',
      workflowMode: 'normal',
      permissionPresetId: 'read_only',
      readOnly: true,
      permissionPostureHash: 'a'.repeat(64),
      permissionPostureSignaturePresent: true
    } as const
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const getQueueJob = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(null)
    const getScheduledTasks = vi.spyOn(AppStore, 'getScheduledTasks').mockReturnValue([
      {
        id: 'task-1',
        runId: 'run-1',
        dispatchReceipt
      } as any
    ])
    const append = vi.spyOn(AppStore, 'appendRunEvent').mockImplementation((input: any) => ({
      schemaVersion: 1,
      id: 'event-1',
      sequence: 1,
      timestamp: '2026-05-08T00:00:00.000Z',
      ...input
    }))

    try {
      repository.appendLifecycleEvent('created', {
        runId: 'run-1',
        provider: 'codex',
        appChatId: 'chat-1',
        workspacePath: '/repo',
        status: 'running',
        startedAt: Date.parse('2026-05-08T00:00:00.000Z'),
        updatedAt: Date.parse('2026-05-08T00:00:01.000Z'),
        approvalIds: new Set(),
        sessionGrants: new Set()
      } as any)

      expect(getQueueJob).toHaveBeenCalledWith('run-1')
      expect(getScheduledTasks).toHaveBeenCalled()
      expect(append.mock.results[0]?.value?.payload).toMatchObject({
        eventType: 'created',
        dispatchReceipt
      })
    } finally {
      getQueueJob.mockRestore()
      getScheduledTasks.mockRestore()
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

  it('mirrors ensemble participant metadata from chat runs when persisting queue state', () => {
    const emitRunQueueChanged = vi.fn()
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged,
      emitRunEventsChanged: vi.fn()
    })
    const getExisting = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(null)
    const getChat = vi.spyOn(AppStore, 'getChat').mockReturnValue({
      appChatId: 'chat-ensemble',
      runs: [
        {
          runId: 'run-ensemble',
          provider: 'grok',
          status: 'running',
          startedAt: '2026-05-08T00:00:00.000Z',
          ensembleParticipantId: 'participant-grok',
          ensembleLaneId: 'lane-round-1-participant-grok-1',
          ensembleRole: 'Reviewer',
          ensembleStageRole: 'reviewer'
        }
      ]
    } as any)
    const save = vi
      .spyOn(AppStore, 'saveRunQueueJob')
      .mockImplementation((input: any) => ({
        priority: 0,
        attempt: 1,
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
        ...input
      }))

    try {
      repository.persistSessionQueueState({
        runId: 'run-ensemble',
        provider: 'grok',
        appChatId: 'chat-ensemble',
        workspacePath: '/repo',
        status: 'running',
        startedAt: Date.parse('2026-05-08T00:00:00.000Z'),
        updatedAt: Date.parse('2026-05-08T00:00:01.000Z'),
        approvalIds: new Set(),
        sessionGrants: new Set()
      })

      expect(getChat).toHaveBeenCalledWith('chat-ensemble')
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-ensemble',
          chatId: 'chat-ensemble',
          ensembleParticipantId: 'participant-grok',
          ensembleLaneId: 'lane-round-1-participant-grok-1',
          ensembleRole: 'Reviewer',
          ensembleStageRole: 'reviewer'
        })
      )
      expect(emitRunQueueChanged).toHaveBeenCalledTimes(1)
    } finally {
      getExisting.mockRestore()
      getChat.mockRestore()
      save.mockRestore()
    }
  })

  it('mirrors ensemble lane and stage metadata into lifecycle event payloads', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const getChat = vi.spyOn(AppStore, 'getChat').mockReturnValue({
      appChatId: 'chat-ensemble',
      runs: [
        {
          runId: 'run-ensemble',
          provider: 'grok',
          status: 'running',
          startedAt: '2026-05-08T00:00:00.000Z',
          ensembleParticipantId: 'participant-grok',
          ensembleLaneId: 'lane-round-1-participant-grok-1',
          ensembleRole: 'Reviewer',
          ensembleStageRole: 'reviewer'
        }
      ]
    } as any)
    const append = vi.spyOn(AppStore, 'appendRunEvent').mockImplementation((input: any) => ({
      schemaVersion: 1,
      id: 'event-1',
      sequence: 1,
      timestamp: '2026-05-08T00:00:00.000Z',
      ...input
    }))

    try {
      repository.appendLifecycleEvent('created', {
        runId: 'run-ensemble',
        provider: 'grok',
        appChatId: 'chat-ensemble',
        workspacePath: '/repo',
        status: 'running',
        startedAt: Date.parse('2026-05-08T00:00:00.000Z'),
        updatedAt: Date.parse('2026-05-08T00:00:01.000Z'),
        approvalIds: new Set(),
        sessionGrants: new Set()
      } as any)

      expect(getChat).toHaveBeenCalledWith('chat-ensemble')
      expect(append.mock.results[0]?.value?.payload).toMatchObject({
        eventType: 'created',
        ensembleRun: {
          ensembleParticipantId: 'participant-grok',
          ensembleLaneId: 'lane-round-1-participant-grok-1',
          ensembleRole: 'Reviewer',
          ensembleStageRole: 'reviewer'
        }
      })
    } finally {
      getChat.mockRestore()
      append.mockRestore()
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

  it('repairs missing steer promotion events on same-owner retries', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
      emitRunEventsChanged: vi.fn()
    })
    const promoted: RunQueueJob = {
      id: 'run-1',
      runId: 'run-1',
      chatId: 'chat-1',
      provider: 'gemini',
      workspacePath: '/repo',
      source: 'manual',
      status: 'steer_promoting',
      statusReason: 'Existing promotion',
      priority: 0,
      attempt: 1,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
      promotionOwnerToken: 'owner-token',
      promotionAttempt: 2,
      transitionVersion: 3,
      queueMessageId: 'message-1'
    } as RunQueueJob
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(promoted)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, _partial: any) => promoted)
    const getEvents = vi.spyOn(AppStore, 'getRunEvents').mockReturnValue([])
    const append = vi.spyOn(AppStore, 'appendRunEvent').mockImplementation((input: any) => ({
      schemaVersion: 1,
      id: input.id,
      sequence: 8,
      timestamp: '2026-05-08T00:00:00.000Z',
      ...input
    }))

    try {
      const retried = repository.promoteQueuedJobForSteer({
        runId: 'run-1',
        ownerToken: 'owner-token'
      })
      const event = append.mock.results[0]?.value

      expect(retried).toBe(promoted)
      expect(update).not.toHaveBeenCalled()
      expect(getEvents).toHaveBeenCalledWith({ runId: 'run-1', kinds: ['lifecycle'] })
      expect(append).toHaveBeenCalledTimes(1)
      expect(event?.id).toBe('run-queue:run-1:steer-transition:3:queued:steer_promoting')
      expect(event?.payload).toMatchObject({
        eventType: 'steerTransition',
        idempotencyKey: 'run-queue:run-1:steer-transition:3:queued:steer_promoting',
        fromStatus: 'queued',
        toStatus: 'steer_promoting',
        ownerToken: 'owner-token',
        transitionVersion: 3,
        promotionAttempt: 2,
        queueMessageId: 'message-1',
        statusReason: 'Existing promotion'
      })
    } finally {
      get.mockRestore()
      update.mockRestore()
      getEvents.mockRestore()
      append.mockRestore()
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

  it('deduplicates retried steer lifecycle events with deterministic ids', () => {
    const repository = new RunRepository({
      providerLabel: (provider) => provider,
      emitRunQueueChanged: vi.fn(),
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
      transitionVersion: 3,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }
    const get = vi.spyOn(AppStore, 'getRunQueueJob').mockReturnValue(promoted)
    const update = vi
      .spyOn(AppStore, 'updateRunQueueJob')
      .mockImplementation((_runId, partial: any) => ({ ...promoted, ...partial }))
    const getEvents = vi.spyOn(AppStore, 'getRunEvents')
    const append = vi.spyOn(AppStore, 'appendRunEvent').mockImplementation((input: any) => ({
      schemaVersion: 1,
      id: input.id,
      sequence: 9,
      timestamp: '2026-05-08T00:00:00.000Z',
      ...input
    }))

    try {
      getEvents.mockReturnValueOnce([])

      const first = repository.fallbackPromotedSteerJob({
        runId: 'run-1',
        ownerToken: 'owner-token',
        reason: 'retry queued'
      })
      const event = append.mock.results[0]?.value

      expect(first?.status).toBe('queued')
      expect(event?.id).toBe('run-queue:run-1:steer-transition:3:steer_promoting:queued')
      expect(event?.payload).toMatchObject({
        eventType: 'steerTransition',
        idempotencyKey: 'run-queue:run-1:steer-transition:3:steer_promoting:queued',
        transitionVersion: 3,
        fromStatus: 'steer_promoting',
        toStatus: 'queued'
      })

      getEvents.mockReturnValueOnce([event])
      const second = repository.fallbackPromotedSteerJob({
        runId: 'run-1',
        ownerToken: 'owner-token',
        reason: 'retry queued'
      })

      expect(second?.status).toBe('queued')
      expect(append).toHaveBeenCalledTimes(1)
    } finally {
      get.mockRestore()
      update.mockRestore()
      getEvents.mockRestore()
      append.mockRestore()
    }
  })
})
