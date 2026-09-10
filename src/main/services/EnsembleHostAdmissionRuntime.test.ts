import { describe, expect, it } from 'vitest'
import { EnsembleHostAdmissionScheduler } from './EnsembleHostAdmissionScheduler'
import { EnsembleHostAdmissionRuntime } from './EnsembleHostAdmissionRuntime'

function request(runId: string, kind: 'foreground' | 'lane' = 'lane') {
  return {
    runId,
    chatId: 'chat-a',
    roundId: 'round-a',
    participantId: `participant-${runId}`,
    provider: 'codex' as const,
    kind
  }
}

function taskQueue() {
  const tasks: Array<() => void> = []
  return {
    schedule: (task: () => void) => tasks.push(task),
    runOne: () => {
      const task = tasks.shift()
      if (!task) throw new Error('No admission task is scheduled.')
      task()
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('EnsembleHostAdmissionRuntime', () => {
  it('paces 30 concurrent heavyweight builds one scheduled macrotask at a time', async () => {
    const tasks = taskQueue()
    const runtime = new EnsembleHostAdmissionRuntime({ scheduleBuildTurn: tasks.schedule })
    const order: number[] = []
    const turns = Array.from({ length: 30 }, (_, index) => index + 1).map((value) =>
      runtime.waitForBuildTurn().then(() => {
        order.push(value)
      })
    )

    for (let index = 0; index < 30; index += 1) {
      await flushMicrotasks()
      tasks.runOne()
      await flushMicrotasks()
      expect(order).toEqual(Array.from({ length: index + 1 }, (_, value) => value + 1))
    }
    await Promise.all(turns)
    expect(order).toHaveLength(30)
  })

  it('exposes the scheduler span sink already wired in production', () => {
    const spans = { record: () => undefined }
    const runtime = new EnsembleHostAdmissionRuntime({ schedulerOptions: { spans } })
    expect(runtime.workSpans).toBe(spans)
    expect(new EnsembleHostAdmissionRuntime().workSpans).toBeUndefined()
  })

  it('owns reservation, synchronous claim and idempotent release bookkeeping', async () => {
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: {
        maxActive: 1,
        maxForeground: 1,
        maxQueued: 4,
        now: () => 1_000
      }
    })
    const reserved = runtime.reserve(request('run-1', 'foreground'))

    expect(reserved).toMatchObject({ kind: 'reserved', initialState: 'admitted' })
    await expect(runtime.claim('run-1')).resolves.toEqual({ ok: true, queuedForMs: 0 })
    expect(runtime.snapshot().occupancy.active).toBe(1)
    expect(runtime.release('run-1')).toBe(true)
    expect(runtime.release('run-1')).toBe(false)
  })

  it('lets cancellation win a queued-to-granted handoff before claim', async () => {
    const tasks = taskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 4,
      schedule: tasks.schedule
    })
    const runtime = new EnsembleHostAdmissionRuntime({ scheduler })
    runtime.reserve(request('holder'))
    await expect(runtime.claim('holder')).resolves.toMatchObject({ ok: true })
    runtime.reserve(request('raced'))

    runtime.release('holder')
    tasks.runOne()
    expect(runtime.snapshot().occupancy.active).toBe(1)
    expect(runtime.cancel('raced', 'Stopped during handoff.')).toBe(true)
    await expect(runtime.claim('raced')).resolves.toMatchObject({ ok: false })
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 0, queued: 0 })
  })

  it('cancels a pre-claim release instead of forgetting a live scheduler reservation', async () => {
    const tasks = taskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 4,
      schedule: tasks.schedule
    })
    const runtime = new EnsembleHostAdmissionRuntime({ scheduler })
    runtime.reserve(request('holder'))
    await runtime.claim('holder')
    runtime.reserve(request('pending'))

    expect(runtime.release('pending')).toBe(true)
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 1, queued: 0 })
    await expect(runtime.claim('pending')).resolves.toMatchObject({ ok: false })
    runtime.release('holder')
    await scheduler.whenIdle()
  })

  it('keeps a replacement generation when an older in-flight claim settles cancellation', async () => {
    const tasks = taskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 4,
      schedule: tasks.schedule
    })
    const runtime = new EnsembleHostAdmissionRuntime({ scheduler })
    runtime.reserve(request('holder'))
    await runtime.claim('holder')
    runtime.reserve(request('reused'))
    const oldClaim = runtime.claim('reused')
    await expect(runtime.claim('reused')).resolves.toMatchObject({ ok: false })
    expect(runtime.cancel('reused', 'replace generation')).toBe(true)
    runtime.reserve(request('reused'))
    await expect(oldClaim).resolves.toMatchObject({ ok: false })
    await runtime.awaitPendingClaims()

    runtime.release('holder')
    tasks.runOne()
    await expect(runtime.claim('reused')).resolves.toMatchObject({ ok: true })
    runtime.release('reused')
    await scheduler.whenIdle()
  })

  it('publishes snapshots and preserves claimed leases across shutdown', async () => {
    const snapshots: number[] = []
    const runtime = new EnsembleHostAdmissionRuntime({
      schedulerOptions: { maxActive: 1, maxForeground: 1, maxQueued: 4 },
      onSnapshot: (snapshot) => snapshots.push(snapshot.occupancy.active)
    })
    runtime.reserve(request('active'))
    await runtime.claim('active')
    runtime.reserve(request('queued'))

    expect(runtime.shutdown()).toMatchObject({
      cancelledQueued: 1,
      occupancy: { active: 1, queued: 0, shuttingDown: true }
    })
    expect(runtime.cancel('active', 'too late')).toBe(false)
    expect(runtime.release('active')).toBe(true)
    expect(snapshots.length).toBeGreaterThan(0)
    expect(runtime.snapshot().occupancy.active).toBe(0)
  })

  it('runs provider maintenance only after a fair claim and releases it in finally', async () => {
    const admissionTasks = taskQueue()
    const buildTasks = taskQueue()
    const scheduler = new EnsembleHostAdmissionScheduler({
      maxActive: 1,
      maxForeground: 1,
      maxQueued: 4,
      schedule: admissionTasks.schedule
    })
    const runtime = new EnsembleHostAdmissionRuntime({
      scheduler,
      scheduleBuildTurn: buildTasks.schedule
    })
    runtime.reserve(request('holder'))
    await runtime.claim('holder')
    let ran = false
    const maintenance = runtime.runMaintenance(request('maintenance'), async () => {
      ran = true
      return 'done'
    })

    await flushMicrotasks()
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 1, queued: 1 })
    expect(ran).toBe(false)
    runtime.release('holder')
    admissionTasks.runOne()
    await flushMicrotasks()
    expect(ran).toBe(false)
    buildTasks.runOne()
    await expect(maintenance).resolves.toMatchObject({ ok: true, value: 'done' })
    expect(runtime.snapshot().occupancy).toMatchObject({ active: 0, queued: 0 })
  })
})
