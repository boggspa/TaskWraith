import { describe, expect, it, vi } from 'vitest'

import type { HostSupervisor } from './HostSupervisor'
import { HostLifecycleController } from './HostLifecycleController'

function supervisor(overrides: Partial<HostSupervisor> = {}): HostSupervisor {
  let running = false
  let stopped = false
  const connectedClientCount = 0
  const value: HostSupervisor = {
    start: vi.fn(async () => {
      running = true
      stopped = false
    }),
    stop: vi.fn(async () => {
      running = false
      stopped = true
    }),
    stopSync: vi.fn(() => {
      running = false
      stopped = true
    }),
    get isRunning() {
      return running
    },
    get isStopped() {
      return stopped
    },
    get connectedClientCount() {
      return connectedClientCount
    },
    healthProvider: () => ({
      hostStatus: running ? 'ok' : 'offline',
      connectionPhase: running ? 'live' : 'connecting',
      supervised: running,
      freshness: 'live'
    }),
    ...overrides
  }
  return value
}

describe('HostLifecycleController', () => {
  it('starts only when asked and publishes an honest startup transition', async () => {
    const created = supervisor()
    const createSupervisor = vi.fn(() => created)
    const controller = new HostLifecycleController({
      createSupervisor,
      now: () => Date.parse('2026-08-12T12:00:00.000Z')
    })
    const phases: string[] = []
    controller.subscribe((state) => phases.push(state.phase))

    expect(createSupervisor).not.toHaveBeenCalled()
    expect(controller.getSnapshot().phase).toBe('stopped')

    const result = await controller.start('app-start')
    expect(result.ok).toBe(true)
    expect(createSupervisor).toHaveBeenCalledTimes(1)
    expect(phases).toEqual(['starting', 'running'])
    expect(controller.getSnapshot()).toMatchObject({
      revision: 2,
      phase: 'running',
      desired: 'running',
      reason: 'app-start'
    })
  })

  it('uses a fresh supervisor after user stop then explicit restart', async () => {
    const first = supervisor()
    const second = supervisor()
    const createSupervisor = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const onOffline = vi.fn()
    const controller = new HostLifecycleController({ createSupervisor, onOffline })

    await controller.start()
    const stopped = await controller.stop()
    expect(stopped).toMatchObject({
      ok: true,
      snapshot: { phase: 'stopped', reason: 'user-stop' }
    })
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(onOffline).toHaveBeenCalledTimes(1)

    await controller.start()
    expect(createSupervisor).toHaveBeenCalledTimes(2)
    expect(second.start).toHaveBeenCalledTimes(1)
  })

  it('projects bounded client occupancy from only the active supervisor', async () => {
    const active = supervisor({ connectedClientCount: 3 })
    const controller = new HostLifecycleController({ createSupervisor: () => active })
    expect(controller.getConnectedClientCount()).toBe(0)
    await controller.start()
    expect(controller.getConnectedClientCount()).toBe(3)
    await controller.stop()
    expect(controller.getConnectedClientCount()).toBe(0)
  })

  it('serializes a stop requested while startup is still in flight', async () => {
    let releaseStart: (() => void) | undefined
    let running = false
    const startGate = new Promise<void>((resolve) => {
      releaseStart = () => {
        running = true
        resolve()
      }
    })
    const active: HostSupervisor = {
      start: vi.fn(() => startGate),
      stop: vi.fn(async () => {
        running = false
      }),
      stopSync: vi.fn(),
      get isRunning() {
        return running
      },
      get isStopped() {
        return !running
      },
      healthProvider: () => ({
        hostStatus: running ? 'ok' : 'offline',
        connectionPhase: running ? 'live' : 'connecting',
        supervised: running,
        freshness: 'live'
      })
    }
    const controller = new HostLifecycleController({ createSupervisor: () => active })

    const start = controller.start()
    const stop = controller.stop()
    await Promise.resolve()
    expect(active.stop).not.toHaveBeenCalled()

    releaseStart?.()
    await expect(start).resolves.toMatchObject({ ok: true })
    await expect(stop).resolves.toMatchObject({ ok: true, snapshot: { phase: 'stopped' } })
    expect(active.stop).toHaveBeenCalledTimes(1)
  })

  it('does not auto-retry a failed start and retries only after a new user action', async () => {
    const failed = supervisor({
      start: vi.fn(async () => {
        throw new Error('socket bind failed')
      })
    })
    const healthy = supervisor()
    const createSupervisor = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(healthy)
    const controller = new HostLifecycleController({ createSupervisor })

    const first = await controller.start()
    expect(first).toMatchObject({
      ok: false,
      error: 'socket bind failed',
      snapshot: { phase: 'failed', desired: 'running', reason: 'start-failed' }
    })
    expect(createSupervisor).toHaveBeenCalledTimes(1)

    await Promise.resolve()
    expect(createSupervisor).toHaveBeenCalledTimes(1)

    const second = await controller.start()
    expect(second.ok).toBe(true)
    expect(createSupervisor).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed-stop handle so retry cannot create a second journal owner', async () => {
    let stopAttempt = 0
    const active = supervisor({
      stop: vi.fn(async () => {
        stopAttempt += 1
        if (stopAttempt === 1) throw new Error('listener still closing')
      })
    })
    const createSupervisor = vi.fn(() => active)
    const controller = new HostLifecycleController({ createSupervisor })
    await controller.start()

    const first = await controller.stop()
    expect(first).toMatchObject({
      ok: false,
      snapshot: { phase: 'failed', desired: 'stopped', reason: 'stop-failed' }
    })
    const second = await controller.stop()
    expect(second.ok).toBe(true)
    expect(createSupervisor).toHaveBeenCalledTimes(1)
    expect(active.stop).toHaveBeenCalledTimes(2)
  })

  it('synchronously fences process exit and never revives afterwards', async () => {
    const active = supervisor()
    const controller = new HostLifecycleController({ createSupervisor: () => active })
    await controller.start()

    controller.stopSync()
    expect(active.stopSync).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'stopped',
      desired: 'stopped',
      reason: 'app-quit'
    })
    await expect(controller.start()).resolves.toMatchObject({ ok: false })
  })
})
