import { describe, expect, it } from 'vitest'
import { OllamaLocalAdmissionCoordinator } from './OllamaLocalAdmissionCoordinator'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function coordinatorAt(capacity: number | undefined, clock: { ms: number }) {
  return new OllamaLocalAdmissionCoordinator({
    capacity,
    now: () => clock.ms
  })
}

describe('OllamaLocalAdmissionCoordinator', () => {
  it('admits through the gate and reports no queue time when nothing waited', async () => {
    const clock = { ms: 1_000 }
    const coordinator = coordinatorAt(2, clock)
    await coordinator.admit('run-a', 'qwen')
    expect(coordinator.queuedMsFor('run-a')).toBe(0)
    expect(coordinator.effectiveDeadline('run-a', 5_000)).toBe(5_000)
  })

  it('pushes a deadline by the time the lane actually spent queued', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(1, clock)
    await coordinator.admit('run-a', 'qwen')

    const queued = coordinator.admit('run-a', 'granite')
    await settle()
    expect(coordinator.queuedMsFor('run-a')).toBe(0)

    clock.ms = 4_000
    coordinator.release('run-a', 'qwen')
    await queued

    expect(coordinator.queuedMsFor('run-a')).toBe(4_000)
    expect(coordinator.effectiveDeadline('run-a', 10_000)).toBe(14_000)
  })

  it('keeps moving the deadline while a lane is STILL queued', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(1, clock)
    await coordinator.admit('run-a', 'qwen')
    void coordinator.admit('run-a', 'granite')
    await settle()

    clock.ms = 30_000
    // Nothing has been admitted yet, so a deadline anchored at dispatch would
    // already have fired. Anchored at admission it has not started counting.
    expect(coordinator.queuedMsFor('run-a')).toBe(30_000)
    expect(coordinator.effectiveDeadline('run-a', 10_000)).toBe(40_000)

    clock.ms = 90_000
    expect(coordinator.effectiveDeadline('run-a', 10_000)).toBe(100_000)
  })

  it('keeps queue accounting per owner so one run cannot extend another', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(1, clock)
    await coordinator.admit('run-a', 'qwen')
    void coordinator.admit('run-b', 'granite')
    await settle()

    clock.ms = 7_000
    expect(coordinator.queuedMsFor('run-b')).toBe(7_000)
    expect(coordinator.queuedMsFor('run-a')).toBe(0)
    expect(coordinator.effectiveDeadline('run-a', 10_000)).toBe(10_000)
  })

  it('sums repeated waits for the same owner', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(1, clock)
    await coordinator.admit('run-a', 'qwen')

    const first = coordinator.admit('run-a', 'granite')
    clock.ms = 2_000
    coordinator.release('run-a', 'qwen')
    await first

    const second = coordinator.admit('run-a', 'llama')
    clock.ms = 5_000
    coordinator.release('run-a', 'granite')
    await second

    expect(coordinator.queuedMsFor('run-a')).toBe(5_000)
  })

  it('never queues, and never extends a deadline, when capacity is unknown', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(undefined, clock)
    await Promise.all([
      coordinator.admit('run-a', 'a'),
      coordinator.admit('run-a', 'b'),
      coordinator.admit('run-a', 'c')
    ])
    clock.ms = 60_000
    expect(coordinator.queuedMsFor('run-a')).toBe(0)
    expect(coordinator.effectiveDeadline('run-a', 10_000)).toBe(10_000)
  })

  it('forgets an owner once its round is done', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(1, clock)
    await coordinator.admit('run-a', 'qwen')
    const queued = coordinator.admit('run-a', 'granite')
    clock.ms = 3_000
    coordinator.release('run-a', 'qwen')
    await queued
    expect(coordinator.queuedMsFor('run-a')).toBe(3_000)

    coordinator.forget('run-a')
    expect(coordinator.queuedMsFor('run-a')).toBe(0)
  })

  it('releases every slot an owner holds when its round is abandoned', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(2, clock)
    await coordinator.admit('run-a', 'qwen')
    await coordinator.admit('run-a', 'granite')
    expect(coordinator.inFlight).toBe(2)

    coordinator.forget('run-a')
    expect(coordinator.inFlight).toBe(0)
  })

  it('reconciles orphaned slots from authoritative state', async () => {
    const clock = { ms: 0 }
    const coordinator = coordinatorAt(2, clock)
    await coordinator.admit('run-a', 'qwen')
    await coordinator.admit('run-b', 'granite')

    coordinator.reconcile(['qwen'])
    expect(coordinator.inFlight).toBe(1)
  })
})
