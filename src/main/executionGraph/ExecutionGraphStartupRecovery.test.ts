import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ThreadCatalogueOpenResult,
  ThreadCatalogueProjection
} from '../../shared/threadCatalogueTypes'
import type { ExecutionGraphServiceDiagnostic } from '../ipc/executionGraphHandlers'
import {
  ExecutionGraphCoordinator,
  type ExecutionGraphCoordinatorDeps,
  type ExecutionGraphRecoveryDiagnostic
} from '../services/ExecutionGraphCoordinator'
import {
  CATALOGUE_EXECUTION_RECOVERY_RETRY_DELAYS_MS,
  catalogueExecutionOwnerStatus,
  preloadCatalogueExecutionOwners,
  startCatalogueExecutionRecovery
} from '../startup/ThreadCatalogueExecutionOwners'
import { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type { ProviderId, RunQueueJob, RunQueueJobStatus } from '../store/types'
import { compileExecutionGraphRevision } from './ExecutionGraphCompiler'
import type { ExecutionGraphRevision, ExecutionPermissionCeilingRef } from './ExecutionGraphModel'
import { ExecutionGraphRecoveryController } from './ExecutionGraphRecoveryController'
import { ExecutionGraphRepository } from './ExecutionGraphRepository'

/*
 * Startup recovery across passes, over the real ledger, coordinator, recovery
 * controller and owner-metadata starter. Each world is a previous process that
 * left one queued Stack attempt per owner chat, then a restart over the same
 * ledger root and queue rows.
 */

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const OWNER_LOADING = 'Execution owner metadata is loading'

function ownerRow(chatId: string): ThreadCatalogueProjection {
  return {
    revision: 1,
    summary: {
      chatId,
      title: 'Owner',
      provider: 'claude',
      chatKind: 'single',
      scope: 'global',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      messageCount: 1,
      runCount: 0
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

/**
 * The thread catalogue; the owners in `failOnce` cannot be opened the first
 * time, and every request takes `delayMs` to answer.
 */
function catalogue(failOnce: readonly string[] = [], delayMs = 0): ThreadCatalogueMirror {
  const pending = new Set(failOnce)
  return new ThreadCatalogueMirror({
    query: async <T>(query: { method: string; chatId?: string }) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (query.method !== 'open') return true as T
      const chatId = query.chatId ?? ''
      if (pending.delete(chatId)) {
        throw new Error(`Thread catalogue Host could not open ${chatId} yet`)
      }
      const opened: ThreadCatalogueOpenResult = {
        leaseId: `lease-${chatId}`,
        entry: {
          chatId,
          databaseId: 'db',
          generation: 'g',
          sourceWitness: 'w',
          epoch: { global: 'e', chat: 'e' },
          heads: { desktop: null, host: null },
          projection: ownerRow(chatId),
          snapshot: false
        }
      }
      return opened as T
    }
  })
}

function queueJob(input: {
  runId: string
  provider: ProviderId
  workspaceId: string
  rootChatId: string
  executionGraph: RunQueueJob['executionGraph']
}): RunQueueJob {
  return {
    id: input.runId,
    runId: input.runId,
    provider: input.provider,
    scope: 'workspace',
    workspaceId: input.workspaceId,
    workspacePath: '/workspace',
    chatId: input.rootChatId,
    source: 'system',
    status: 'paused',
    executionGraph: input.executionGraph,
    priority: 0,
    attempt: 1,
    createdAt: '2026-07-18T11:00:00.000Z',
    updatedAt: '2026-07-18T11:00:00.000Z'
  }
}

interface World {
  readonly root: string
  /** The persisted run queue, shared by both processes. */
  readonly jobs: Map<string, RunQueueJob>
  readonly executionIds: readonly string[]
}

function processOver(
  world: Pick<World, 'root' | 'jobs'>,
  label: string,
  resolveOwnerStatus: ExecutionGraphCoordinatorDeps['resolveOwnerStatus']
) {
  const repository = new ExecutionGraphRepository(world.root)
  let id = 0
  const deps: ExecutionGraphCoordinatorDeps = {
    repository,
    materializePausedQueueJob: (input) => {
      const job = queueJob({
        runId: input.runId,
        provider: input.provider,
        workspaceId: input.workspaceId,
        rootChatId: input.rootChatId,
        executionGraph: {
          schemaVersion: 1,
          executionId: input.executionId,
          activationId: input.activationId,
          attemptId: input.attemptId,
          runTemplateRef: input.runTemplate.templateId,
          permissionCeilingAuthorityDigest: input.permissionCeilingAuthorityDigest
        }
      })
      world.jobs.set(input.runId, job)
      return job
    },
    getQueueJob: (runId) => world.jobs.get(runId) ?? null,
    transitionQueueJob: (runId: string, status: RunQueueJobStatus) => {
      const existing = world.jobs.get(runId)
      if (!existing) return null
      const next = { ...existing, status }
      world.jobs.set(runId, next)
      return next
    },
    resolveAnchorRunStatus: () => 'missing',
    resolveOwnerStatus,
    cancelActiveRun: () => true,
    now: () => '2026-07-18T11:00:00.000Z',
    createId: () => `${label}-${++id}`,
    onChanged: () => {}
  }
  return { repository, coordinator: new ExecutionGraphCoordinator(deps), deps }
}

const CEILING: ExecutionPermissionCeilingRef = {
  schemaVersion: 1,
  referenceId: 'ceiling-workspace-one',
  authorityDigest: 'a'.repeat(64),
  workspaceId: 'workspace-one'
}

function saveTemplate(repository: ExecutionGraphRepository, chatId: string): string {
  return repository.saveRunTemplate({
    schemaVersion: 1,
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-one',
    workspacePath: '/workspace',
    chatId,
    request: {
      prompt: 'Do the next task',
      selectedModelType: 'default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: []
    }
  }).templateId
}

/** An UltraTask's graph: one scout the owning turn waits on. */
function ultraTaskRevision(repository: ExecutionGraphRepository): ExecutionGraphRevision {
  const compiled = compileExecutionGraphRevision({
    graphId: 'ultra-task-graph',
    revision: 1,
    workspaceId: 'workspace-one',
    name: 'UltraTask graph',
    createdAt: '2026-07-18T11:00:00.000Z',
    steps: [
      {
        id: 'scout',
        kind: 'solo_agent',
        title: 'Scout',
        objective: 'Survey the requested change.',
        effect: 'read_only',
        outputs: [
          { name: 'report', schema: { type: 'object', additionalProperties: true }, required: true }
        ],
        retry: { maxAttempts: 1 },
        agent: {
          provider: 'codex',
          model: 'gpt-5.5',
          runTemplateRef: saveTemplate(repository, 'chat-one'),
          session: { mode: 'fresh' }
        }
      }
    ],
    edges: [],
    limits: { maxSteps: 1, maxConcurrentSteps: 1, maxAttempts: 1 }
  })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues))
  repository.saveRevision(compiled.revision)
  return compiled.revision
}

/** A previous process that queued one Stack attempt per owner chat and quit before dispatch. */
function previousProcess(owners: readonly string[]): World {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-graph-startup-'))
  roots.push(root)
  const world = { root, jobs: new Map<string, RunQueueJob>() }
  const { repository, coordinator } = processOver(world, 'previous', () => 'live')
  const executionIds = owners.map((owner, index) => {
    return coordinator.appendStackStep({
      clientRequestId: `client-request-${index + 1}`,
      clientSubmissionDigest: 'c'.repeat(64),
      workspaceId: 'workspace-one',
      rootChatId: owner,
      stepTitle: `Work for ${owner}`,
      objective: 'Inspect the requested change carefully.',
      provider: 'codex',
      effect: 'read_only',
      runTemplateRef: saveTemplate(repository, owner),
      permissionCeilingRef: CEILING
    }).executionId
  })
  return { ...world, executionIds }
}

/** The restarted process, resolving owners through the thread catalogue as index.ts does. */
function restart(world: World, mirror: ThreadCatalogueMirror) {
  return processOver(world, 'restarted', (owner) =>
    catalogueExecutionOwnerStatus(mirror, owner.threadId, () => true)
  )
}

/** The recovery controller over the snapshot's two lists, wired as index.ts wires it. */
function controllerFor(coordinator: ExecutionGraphCoordinator) {
  let paused: readonly ExecutionGraphRecoveryDiagnostic[] = []
  let service: readonly ExecutionGraphServiceDiagnostic[] = []
  const controller = new ExecutionGraphRecoveryController({
    coordinator: () => coordinator,
    readDiagnostics: () => paused,
    writeDiagnostics: (next) => {
      paused = next
    },
    readServiceDiagnostics: () => service,
    writeServiceDiagnostics: (next) => {
      service = next
    },
    log: () => {}
  })
  return { controller, paused: () => paused, service: () => service }
}

/** The controller behind the owner-metadata starter, as index.ts starts it at launch. */
function startupRecovery(coordinator: ExecutionGraphCoordinator, mirror: ThreadCatalogueMirror) {
  const recovery = controllerFor(coordinator)
  const stop = startCatalogueExecutionRecovery({
    mirror,
    ownerIds: () => recovery.controller.startupOwnerIds(),
    recover: () => {
      recovery.controller.runStartupRecovery()
    },
    onError: (error, retrying) => recovery.controller.startupPassFailed(error, retrying)
  })
  return { ...recovery, stop }
}

/** index.ts's boot sweep: every queued graph row, leased through the main dispatcher's path. */
function bootSweep(coordinator: ExecutionGraphCoordinator, world: World): void {
  for (const job of [...world.jobs.values()]) {
    if (job.status !== 'queued' || !job.executionGraph) continue
    coordinator.assertQueueJobDispatchable(job.runId)
    world.jobs.set(job.runId, { ...job, status: 'starting' })
    coordinator.noteDispatchLease(job.runId)
  }
}

function stack(coordinator: ExecutionGraphCoordinator, world: World, executionId: string) {
  const projection = coordinator.getExecution(executionId)!
  const attempts = Object.values(projection.attempts)
  return {
    state: projection.state,
    attempts: attempts.map((attempt) => attempt.state),
    rows: attempts.map((attempt) => world.jobs.get(attempt.providerRunRef ?? '')?.status)
  }
}

function runIdOf(coordinator: ExecutionGraphCoordinator, executionId: string): string {
  const attempt = Object.values(coordinator.getExecution(executionId)!.attempts)[0]
  return attempt.providerRunRef!
}

const REGISTRY_UNREADABLE = {
  code: 'startup_recovery_failed',
  message: 'execution registry unreadable'
}

describe('execution graph startup recovery across passes', () => {
  it('a startup pass that runs again leaves a stack the launch pass recovered running', async () => {
    // Fake timers keep the automatic retry the launch pass arms from firing.
    vi.useFakeTimers()
    const world = previousProcess(['chat-one', 'chat-two'])
    const [a, b] = world.executionIds
    const mirror = catalogue(['chat-two'])
    const next = restart(world, mirror)
    const recovery = controllerFor(next.coordinator)

    // The launch pass, as the starter runs it: preload the owners, recover.
    expect(await preloadCatalogueExecutionOwners(mirror, ['chat-one', 'chat-two'])).toEqual([
      'chat-two'
    ])
    recovery.controller.runStartupRecovery()
    expect(recovery.paused()).toEqual([{ executionId: b, message: OWNER_LOADING }])

    // The dispatcher takes the attempt the launch pass re-queued. Left without
    // its lease note here, only the next pass's scope protects it.
    const aRun = runIdOf(next.coordinator, a)
    world.jobs.set(aRun, { ...world.jobs.get(aRun)!, status: 'active' })
    expect(stack(next.coordinator, world, a)).toEqual({
      state: 'running',
      attempts: ['queued'],
      rows: ['active']
    })

    // chat-two failed to preload, so the starter runs the pass again.
    expect(await preloadCatalogueExecutionOwners(mirror, ['chat-two'])).toEqual([])
    recovery.controller.runStartupRecovery()

    expect(stack(next.coordinator, world, a)).toEqual({
      state: 'running',
      attempts: ['queued'],
      rows: ['active']
    })
    expect(stack(next.coordinator, world, b)).toEqual({
      state: 'running',
      attempts: ['queued'],
      rows: ['queued']
    })
    expect(recovery.paused()).toEqual([])
  })

  it('leaves the stacks the boot sweep leased running through the launch pass and its re-run', async () => {
    vi.useFakeTimers()
    const world = previousProcess(['chat-one', 'chat-two'])
    const [a, b] = world.executionIds
    const mirror = catalogue(['chat-two'])
    const next = restart(world, mirror)
    // The dispatcher is installed, and sweeps the queue, before the deferred
    // launch pass runs.
    bootSweep(next.coordinator, world)
    const recovery = startupRecovery(next.coordinator, mirror)

    await vi.advanceTimersByTimeAsync(500)
    const live = { state: 'running', attempts: ['queued'], rows: ['starting'] }
    expect(stack(next.coordinator, world, a)).toEqual(live)
    // chat-two's owner could not be read yet: paused, although already leased.
    expect(recovery.paused()).toEqual([{ executionId: b, message: OWNER_LOADING }])

    await vi.advanceTimersByTimeAsync(120_000)
    recovery.stop()

    expect(stack(next.coordinator, world, a)).toEqual(live)
    expect(stack(next.coordinator, world, b)).toEqual(live)
    expect(recovery.paused()).toEqual([])
    expect(recovery.service()).toEqual([])
  })

  it('parks a stack whose leased dispatch failed before its session and could not be contained', async () => {
    vi.useFakeTimers()
    const world = previousProcess(['chat-one'])
    const [a] = world.executionIds
    const mirror = catalogue()
    const next = restart(world, mirror)
    bootSweep(next.coordinator, world)
    // The dispatch fails before a provider session on a full disk: the queue
    // row takes the failure and the ledger append does not.
    const append = vi.spyOn(next.repository, 'appendExecutionEvents').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, write')
    })
    expect(() =>
      next.coordinator.recordPreSessionDispatchFailure(
        runIdOf(next.coordinator, a),
        'Graph-owned provider dispatch failed: adapter refused'
      )
    ).toThrow('ENOSPC')
    append.mockRestore()
    expect(stack(next.coordinator, world, a)).toEqual({
      state: 'running',
      attempts: ['queued'],
      rows: ['failed']
    })

    const recovery = startupRecovery(next.coordinator, mirror)
    await vi.advanceTimersByTimeAsync(60_000)
    recovery.stop()

    // Visible, as it was before the lease note: no run is left behind it, and
    // the chat's next message must not queue silently behind it.
    expect(stack(next.coordinator, world, a)).toEqual({
      state: 'requires_action',
      attempts: ['interrupted'],
      rows: ['failed']
    })
  })

  it('leaves an UltraTask a turn here started during the launch pass owner preload running', async () => {
    vi.useFakeTimers()
    const world = previousProcess(['chat-one'])
    // Every catalogue request takes 30 s, so the launch pass runs at about 60 s.
    const mirror = catalogue([], 30_000)
    const next = restart(world, mirror)
    const recovery = startupRecovery(next.coordinator, mirror)
    await vi.advanceTimersByTimeAsync(1_000)
    // The sidebar inventory lists the chat the user is working in.
    mirror.observe(ownerRow('chat-one'))
    await vi.advanceTimersByTimeAsync(4_000)
    const rows = () =>
      [...world.jobs.values()]
        .filter((job) => job.executionGraph?.executionId === 'ultra-live-turn')
        .map((job) => job.status)

    // A live turn in this process calls ultra_task.
    const started = next.coordinator.startExecutionGraph({
      executionId: 'ultra-live-turn',
      title: 'UltraTask from a live turn',
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      tenant: { kind: 'workflow' },
      owner: {
        threadId: 'chat-one',
        initiatingRunId: 'live-run-in-this-process',
        seatId: 'claude:opus'
      },
      revision: ultraTaskRevision(next.repository),
      permissionCeilingRef: CEILING
    })
    expect(started.state).toBe('running')
    expect(rows()).toEqual(['queued'])

    await vi.advanceTimersByTimeAsync(600_000)
    recovery.stop()

    // Its owning run is alive here: nothing ended the turn the tether follows.
    expect(next.coordinator.getExecution('ultra-live-turn')?.state).toBe('running')
    expect(rows()).toEqual(['queued'])
  })

  it('reports a stack listing that cannot be read once, after a re-run, and stops at the bound', async () => {
    vi.useFakeTimers()
    const world = previousProcess(['chat-one'])
    const mirror = catalogue()
    const next = restart(world, mirror)
    const listing = vi.spyOn(next.repository, 'listExecutions').mockImplementation(() => {
      throw new Error('execution registry unreadable')
    })
    const recovery = startupRecovery(next.coordinator, mirror)

    await vi.advanceTimersByTimeAsync(0)
    expect(listing).toHaveBeenCalledTimes(1)
    expect(recovery.service()).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(listing).toHaveBeenCalledTimes(2)
    expect(recovery.service()).toEqual([REGISTRY_UNREADABLE])

    // The launch pass and every re-run the starter allows, then nothing.
    await vi.advanceTimersByTimeAsync(3_600_000)
    recovery.stop()
    expect(listing).toHaveBeenCalledTimes(1 + CATALOGUE_EXECUTION_RECOVERY_RETRY_DELAYS_MS.length)
    expect(recovery.service()).toEqual([REGISTRY_UNREADABLE])
  })

  it('recovers a listing that failed once between owner preload and recovery, without a report', async () => {
    vi.useFakeTimers()
    const world = previousProcess(['chat-one'])
    const [a] = world.executionIds
    const mirror = catalogue()
    const next = restart(world, mirror)
    const queued = vi.fn()
    next.deps.onAttemptQueued = queued
    const read = next.repository.listExecutions.bind(next.repository)
    let calls = 0
    vi.spyOn(next.repository, 'listExecutions').mockImplementation(() => {
      calls += 1
      if (calls === 2) throw new Error('execution registry briefly unreadable')
      return read()
    })
    const recovery = startupRecovery(next.coordinator, mirror)

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)
    expect(queued).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(600_000)
    recovery.stop()

    // The re-run recovered the stack: its queued attempt was handed back to
    // the dispatcher, and nothing was ever reported.
    expect(queued).toHaveBeenCalledWith(runIdOf(next.coordinator, a))
    expect(recovery.service()).toEqual([])
    expect(stack(next.coordinator, world, a)).toEqual({
      state: 'running',
      attempts: ['queued'],
      rows: ['queued']
    })
  })

  it('withdraws the report once a later pass gets through', async () => {
    vi.useFakeTimers()
    const world = previousProcess(['chat-one'])
    const [a] = world.executionIds
    const mirror = catalogue()
    const next = restart(world, mirror)
    const queued = vi.fn()
    next.deps.onAttemptQueued = queued
    const read = next.repository.listExecutions.bind(next.repository)
    let calls = 0
    vi.spyOn(next.repository, 'listExecutions').mockImplementation(() => {
      calls += 1
      if (calls <= 2) throw new Error('execution registry unreadable')
      return read()
    })
    const recovery = startupRecovery(next.coordinator, mirror)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(recovery.service()).toEqual([REGISTRY_UNREADABLE])

    await vi.advanceTimersByTimeAsync(600_000)
    recovery.stop()

    expect(recovery.service()).toEqual([])
    expect(queued).toHaveBeenCalledWith(runIdOf(next.coordinator, a))
  })
})
