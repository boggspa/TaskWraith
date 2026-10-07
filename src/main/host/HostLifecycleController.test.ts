import { describe, expect, it, vi } from 'vitest'

import type { HostSupervisor } from '../../host-runtime/HostSupervisor'
import type { HostLifecycleHostIdentity } from '../../shared/hostLifecycle'
import { HostLifecycleController, type HostLifecycleSupervisor } from './HostLifecycleController'

/**
 * Byte goldens of every lifecycle transition sequence this suite exercised before
 * S2, recorded from a pristine worktree at a3f48c3b9 on a stepped clock: the
 * snapshots published to a subscriber, the action results, and the final
 * snapshot. S2 must reproduce them byte for byte (no host block without a Host).
 */
const PRE_S2_LIFECYCLE_GOLDENS: Record<string, string> = {
  'app-start':
    '{"published":[{"revision":1,"phase":"starting","desired":"running","reason":"app-start","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"running","desired":"running","reason":"app-start","changedAt":"2026-09-23T00:00:03.000Z"}],"results":[{"ok":true,"snapshot":{"revision":2,"phase":"running","desired":"running","reason":"app-start","changedAt":"2026-09-23T00:00:03.000Z"}}],"final":{"revision":2,"phase":"running","desired":"running","reason":"app-start","changedAt":"2026-09-23T00:00:03.000Z"}}',
  'start-stop-start':
    '{"published":[{"revision":1,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"},{"revision":3,"phase":"stopping","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:04.000Z"},{"revision":4,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:05.000Z"},{"revision":5,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:06.000Z"},{"revision":6,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:07.000Z"}],"results":[{"ok":true,"snapshot":{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"}},{"ok":true,"snapshot":{"revision":4,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:05.000Z"}},{"ok":true,"snapshot":{"revision":6,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:07.000Z"}}],"final":{"revision":6,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:07.000Z"}}',
  'stop-without-start':
    '{"published":[{"revision":1,"phase":"stopping","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:03.000Z"}],"results":[{"ok":true,"snapshot":{"revision":2,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:03.000Z"}}],"final":{"revision":2,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:03.000Z"}}',
  'stop-during-start':
    '{"published":[{"revision":1,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"},{"revision":3,"phase":"stopping","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:04.000Z"},{"revision":4,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:05.000Z"}],"results":[{"ok":true,"snapshot":{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"}},{"ok":true,"snapshot":{"revision":4,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:05.000Z"}}],"final":{"revision":4,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:05.000Z"}}',
  'failed-start-then-retry':
    '{"published":[{"revision":1,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"failed","desired":"running","reason":"start-failed","changedAt":"2026-09-23T00:00:03.000Z","error":"socket bind failed"},{"revision":3,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:04.000Z"},{"revision":4,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:05.000Z"}],"results":[{"ok":false,"error":"socket bind failed","snapshot":{"revision":2,"phase":"failed","desired":"running","reason":"start-failed","changedAt":"2026-09-23T00:00:03.000Z","error":"socket bind failed"}},{"ok":true,"snapshot":{"revision":4,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:05.000Z"}}],"final":{"revision":4,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:05.000Z"}}',
  'failed-stop-then-retry':
    '{"published":[{"revision":1,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"},{"revision":3,"phase":"stopping","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:04.000Z"},{"revision":4,"phase":"failed","desired":"stopped","reason":"stop-failed","changedAt":"2026-09-23T00:00:05.000Z","error":"listener still closing"},{"revision":5,"phase":"stopping","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:06.000Z"},{"revision":6,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:07.000Z"}],"results":[{"ok":true,"snapshot":{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"}},{"ok":false,"error":"listener still closing","snapshot":{"revision":4,"phase":"failed","desired":"stopped","reason":"stop-failed","changedAt":"2026-09-23T00:00:05.000Z","error":"listener still closing"}},{"ok":true,"snapshot":{"revision":6,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:07.000Z"}}],"final":{"revision":6,"phase":"stopped","desired":"stopped","reason":"user-stop","changedAt":"2026-09-23T00:00:07.000Z"}}',
  'stopSync-then-start':
    '{"published":[{"revision":1,"phase":"starting","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:02.000Z"},{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"},{"revision":3,"phase":"stopping","desired":"stopped","reason":"app-quit","changedAt":"2026-09-23T00:00:04.000Z"},{"revision":4,"phase":"stopped","desired":"stopped","reason":"app-quit","changedAt":"2026-09-23T00:00:05.000Z"}],"results":[{"ok":true,"snapshot":{"revision":2,"phase":"running","desired":"running","reason":"user-start","changedAt":"2026-09-23T00:00:03.000Z"}},{"ok":false,"error":"TaskWraith is shutting down; Host cannot be started.","snapshot":{"revision":4,"phase":"stopped","desired":"stopped","reason":"app-quit","changedAt":"2026-09-23T00:00:05.000Z"}}],"final":{"revision":4,"phase":"stopped","desired":"stopped","reason":"app-quit","changedAt":"2026-09-23T00:00:05.000Z"}}'
}

function supervisor(overrides: Partial<HostLifecycleSupervisor> = {}): HostLifecycleSupervisor {
  let running = false
  let stopped = false
  const connectedClientCount = 0
  const value: HostLifecycleSupervisor = {
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

  it('never restarts after stopSync', async () => {
    const active = supervisor()
    const createSupervisor = vi.fn(() => active)
    const onOffline = vi.fn()
    const controller = new HostLifecycleController({ createSupervisor, onOffline })
    await controller.start()
    controller.stopSync()
    const fenced = controller.getSnapshot()
    const offlineCalls = onOffline.mock.calls.length

    await expect(controller.restart('user-restart')).resolves.toMatchObject({
      ok: false,
      error: 'TaskWraith is shutting down; Host cannot be restarted.'
    })
    await expect(controller.restart('poison-restart')).resolves.toMatchObject({ ok: false })
    // Nothing moved: no stop or start transition was published after the fence.
    expect(controller.getSnapshot()).toEqual(fenced)
    expect(createSupervisor).toHaveBeenCalledTimes(1)
    expect(active.stop).not.toHaveBeenCalled()
    expect(onOffline).toHaveBeenCalledTimes(offlineCalls)
    expect(controller.isClosing).toBe(true)
  })
})

/** Replays each pre-S2 sequence exactly as the goldens were recorded. */
async function replayPreS2Sequence(name: string): Promise<string> {
  let tick = Date.parse('2026-09-23T00:00:00.000Z')
  const run = async (
    createSupervisor: () => HostLifecycleSupervisor,
    steps: (controller: HostLifecycleController) => Promise<unknown>[] | Promise<Promise<unknown>[]>
  ): Promise<string> => {
    const controller = new HostLifecycleController({ createSupervisor, now: () => (tick += 1000) })
    const published: unknown[] = []
    controller.subscribe((snapshot) => published.push(JSON.parse(JSON.stringify(snapshot))))
    const results: unknown[] = []
    for (const result of await steps(controller)) {
      results.push(JSON.parse(JSON.stringify(await result)))
    }
    return JSON.stringify({ published, results, final: controller.getSnapshot() })
  }
  switch (name) {
    case 'app-start':
      return run(
        () => supervisor(),
        async (controller) => [await controller.start('app-start')].map((r) => Promise.resolve(r))
      )
    case 'start-stop-start': {
      const created = [supervisor(), supervisor()]
      return run(
        () => created.shift()!,
        async (controller) => {
          const out = [await controller.start(), await controller.stop(), await controller.start()]
          return out.map((r) => Promise.resolve(r))
        }
      )
    }
    case 'stop-without-start':
      return run(
        () => supervisor(),
        async (controller) => [Promise.resolve(await controller.stop())]
      )
    case 'stop-during-start': {
      let releaseStart: (() => void) | undefined
      let running = false
      const gate = new Promise<void>((resolve) => {
        releaseStart = () => {
          running = true
          resolve()
        }
      })
      const active: HostSupervisor = {
        start: vi.fn(() => gate),
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
      return run(
        () => active,
        async (controller) => {
          const start = controller.start()
          const stop = controller.stop()
          await Promise.resolve()
          releaseStart?.()
          const started = await start
          const stoppedResult = await stop
          return [Promise.resolve(started), Promise.resolve(stoppedResult)]
        }
      )
    }
    case 'failed-start-then-retry': {
      const created = [
        supervisor({
          start: vi.fn(async () => {
            throw new Error('socket bind failed')
          })
        }),
        supervisor()
      ]
      return run(
        () => created.shift()!,
        async (controller) => {
          const out = [await controller.start(), await controller.start()]
          return out.map((r) => Promise.resolve(r))
        }
      )
    }
    case 'failed-stop-then-retry': {
      let attempt = 0
      const active = supervisor({
        stop: vi.fn(async () => {
          attempt += 1
          if (attempt === 1) throw new Error('listener still closing')
        })
      })
      return run(
        () => active,
        async (controller) => {
          const out = [await controller.start(), await controller.stop(), await controller.stop()]
          return out.map((r) => Promise.resolve(r))
        }
      )
    }
    case 'stopSync-then-start':
      return run(
        () => supervisor(),
        async (controller) => {
          const started = await controller.start()
          controller.stopSync()
          return [Promise.resolve(started), Promise.resolve(await controller.start())]
        }
      )
  }
  throw new Error(`no replay for ${name}`)
}

describe('HostLifecycleController pre-S2 goldens', () => {
  it.each(Object.keys(PRE_S2_LIFECYCLE_GOLDENS))(
    'publishes the byte-identical %s sequence it published before S2',
    async (name) => {
      expect(await replayPreS2Sequence(name)).toBe(PRE_S2_LIFECYCLE_GOLDENS[name])
    }
  )
})

const HOST_A: HostLifecycleHostIdentity = {
  pid: 4101,
  hostId: 'host-install-1',
  startedAt: '2026-09-23T10:00:00.000Z',
  payloadVersion: `sha256:${'a'.repeat(64)}`
}
const HOST_B: HostLifecycleHostIdentity = {
  ...HOST_A,
  pid: 4202,
  startedAt: '2026-09-23T11:00:00.000Z'
}

/** A supervisor that reports the Host it attached to, like the external adapter. */
function attachedSupervisor(
  host: HostLifecycleHostIdentity,
  overrides: Partial<HostLifecycleSupervisor> = {}
): HostLifecycleSupervisor & { hostIdentity: HostLifecycleHostIdentity | null } {
  let running = false
  let stopped = false
  const value = {
    hostIdentity: null as HostLifecycleHostIdentity | null,
    start: vi.fn(async () => {
      running = true
      stopped = false
      value.hostIdentity = host
    }),
    stop: vi.fn(async () => {
      running = false
      stopped = true
      value.hostIdentity = null
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
    healthProvider: () => ({
      hostStatus: running ? ('ok' as const) : ('offline' as const),
      connectionPhase: running ? ('live' as const) : ('connecting' as const),
      supervised: running,
      freshness: 'live' as const
    }),
    ...overrides
  }
  return value
}

describe('HostLifecycleController restart (D10)', () => {
  it('restarts as one serialized stop then start on a fresh supervisor', async () => {
    const first = attachedSupervisor(HOST_A)
    const second = attachedSupervisor(HOST_B)
    const createSupervisor = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const onOffline = vi.fn()
    const controller = new HostLifecycleController({ createSupervisor, onOffline })
    await controller.start('app-start')
    const seen: string[] = []
    controller.subscribe((state) =>
      seen.push(`${state.phase}/${state.reason}/${state.host?.pid ?? '-'}`)
    )

    const result = await controller.restart('user-restart')
    expect(result).toMatchObject({
      ok: true,
      snapshot: { phase: 'running', desired: 'running', reason: 'user-restart', host: HOST_B }
    })
    expect(seen).toEqual([
      'stopping/user-restart/4101',
      'stopped/user-restart/-',
      'starting/user-restart/-',
      'running/user-restart/4202'
    ])
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(second.start).toHaveBeenCalledTimes(1)
    expect(createSupervisor).toHaveBeenCalledTimes(2)
    expect(onOffline).toHaveBeenCalledTimes(1)
  })

  it('does not let a queued poison restart revive a Host the user stopped', async () => {
    const active = attachedSupervisor(HOST_A)
    const createSupervisor = vi.fn(() => active)
    const controller = new HostLifecycleController({ createSupervisor })
    await controller.start()
    const stop = controller.stop()
    const restart = controller.restart('poison-restart', HOST_A)
    await stop
    await expect(restart).resolves.toMatchObject({ ok: false, snapshot: { phase: 'stopped' } })
    expect(active.stop).toHaveBeenCalledTimes(1)
    expect(createSupervisor).toHaveBeenCalledTimes(1)
  })

  it('does not apply an old poison verdict to a replacement Host', async () => {
    const active = attachedSupervisor(HOST_B)
    const controller = new HostLifecycleController({ createSupervisor: () => active })
    await controller.start()
    await expect(controller.restart('poison-restart', HOST_A)).resolves.toMatchObject({
      ok: false,
      snapshot: { phase: 'running', host: HOST_B }
    })
    expect(active.stop).not.toHaveBeenCalled()
  })

  it('keeps the handle and starts nothing when the stop half fails', async () => {
    const active = supervisor({
      stop: vi.fn(async () => {
        throw new Error('Host did not stop: identity_unavailable')
      })
    })
    const createSupervisor = vi.fn(() => active)
    const controller = new HostLifecycleController({ createSupervisor })
    await controller.start()
    const result = await controller.restart('poison-restart')
    expect(result).toMatchObject({
      ok: false,
      error: 'Host did not stop: identity_unavailable',
      snapshot: { phase: 'failed', desired: 'stopped', reason: 'stop-failed' }
    })
    expect(createSupervisor).toHaveBeenCalledTimes(1)
    expect(active.start).toHaveBeenCalledTimes(1)
  })

  it('serializes a restart behind a start still in flight', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = supervisor({ start: vi.fn(() => gate) })
    let slowRunning = false
    Object.defineProperty(slow, 'isRunning', { get: () => slowRunning })
    ;(slow.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate
      slowRunning = true
    })
    ;(slow.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      slowRunning = false
    })
    const fresh = supervisor()
    const createSupervisor = vi.fn().mockReturnValueOnce(slow).mockReturnValueOnce(fresh)
    const controller = new HostLifecycleController({ createSupervisor })
    const start = controller.start()
    const restart = controller.restart('user-restart')
    await Promise.resolve()
    expect(slow.stop).not.toHaveBeenCalled()
    release?.()
    await expect(start).resolves.toMatchObject({ ok: true })
    await expect(restart).resolves.toMatchObject({ ok: true, snapshot: { reason: 'user-restart' } })
    expect(slow.stop).toHaveBeenCalledTimes(1)
    expect(fresh.start).toHaveBeenCalledTimes(1)
  })
})

describe('HostLifecycleController ensure (lease re-acquire, D6)', () => {
  it('is a no-op for a Host that is still there', async () => {
    const active = attachedSupervisor(HOST_A, { ensureLive: vi.fn(async () => false) })
    const controller = new HostLifecycleController({ createSupervisor: () => active })
    await controller.start('app-start')
    const before = controller.getSnapshot()
    await expect(controller.ensure('lease-reacquire')).resolves.toMatchObject({ ok: true })
    expect(active.ensureLive).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toEqual(before)
  })

  it('publishes the relaunched Host when the one behind the lifecycle exited', async () => {
    const active = attachedSupervisor(HOST_A)
    ;(active as { ensureLive?: () => Promise<boolean> }).ensureLive = vi.fn(async () => {
      active.hostIdentity = HOST_B
      return true
    })
    const createSupervisor = vi.fn(() => active)
    const controller = new HostLifecycleController({ createSupervisor })
    await controller.start('app-start')
    const result = await controller.ensure('lease-reacquire')
    expect(result).toMatchObject({
      ok: true,
      snapshot: { phase: 'running', reason: 'lease-reacquire', host: HOST_B }
    })
    // The same supervisor relaunched it: no second owner was constructed.
    expect(createSupervisor).toHaveBeenCalledTimes(1)
  })

  it('never starts a Host the user stopped, one whose start failed, or one after stopSync', async () => {
    const stoppedByUser = supervisor({ ensureLive: vi.fn(async () => true) })
    const stoppedController = new HostLifecycleController({ createSupervisor: () => stoppedByUser })
    await stoppedController.start()
    await stoppedController.stop()
    await expect(stoppedController.ensure('lease-reacquire')).resolves.toMatchObject({
      ok: false,
      snapshot: { phase: 'stopped', reason: 'user-stop' }
    })
    expect(stoppedByUser.start).toHaveBeenCalledTimes(1)
    expect(stoppedByUser.ensureLive).not.toHaveBeenCalled()

    const failing = supervisor({
      start: vi.fn(async () => {
        throw new Error('socket bind failed')
      })
    })
    const createFailing = vi.fn(() => failing)
    const failedController = new HostLifecycleController({ createSupervisor: createFailing })
    await failedController.start()
    await expect(failedController.ensure('lease-reacquire')).resolves.toMatchObject({
      ok: false,
      snapshot: { phase: 'failed', reason: 'start-failed' }
    })
    expect(createFailing).toHaveBeenCalledTimes(1)

    const fenced = supervisor({ ensureLive: vi.fn(async () => true) })
    const fencedController = new HostLifecycleController({ createSupervisor: () => fenced })
    await fencedController.start()
    fencedController.stopSync()
    await expect(fencedController.ensure('lease-reacquire')).resolves.toMatchObject({ ok: false })
    expect(fenced.ensureLive).not.toHaveBeenCalled()

    // A stop that failed keeps its handle for the retry, but the user asked
    // for the Host to stop: a lost lease must not bring it back through it.
    const stuck = attachedSupervisor(HOST_A, {
      stop: vi.fn(async () => {
        throw new Error('Host did not stop.')
      }),
      ensureLive: vi.fn(async () => true)
    })
    const stuckController = new HostLifecycleController({ createSupervisor: () => stuck })
    await stuckController.start()
    await expect(stuckController.stop()).resolves.toMatchObject({ ok: false })
    expect(stuckController.getSnapshot()).toMatchObject({ desired: 'stopped' })
    await expect(stuckController.ensure('lease-reacquire')).resolves.toMatchObject({
      ok: false,
      error: 'Host is not running; only an explicit start brings it back.'
    })
    expect(stuck.ensureLive).not.toHaveBeenCalled()
  })

  it('detaches a failed re-attach without stopping a Host that may still be healthy', async () => {
    const onOffline = vi.fn()
    const active = attachedSupervisor(HOST_A, {
      ensureLive: vi.fn(async () => {
        throw new Error('External Host exited 1 before readiness.')
      })
    })
    const createSupervisor = vi.fn(() => active)
    const controller = new HostLifecycleController({ createSupervisor, onOffline })
    await controller.start('app-start')
    const result = await controller.ensure('lease-reacquire')
    expect(result).toMatchObject({
      ok: false,
      error: 'External Host exited 1 before readiness.',
      snapshot: { phase: 'failed', desired: 'running', reason: 'start-failed' }
    })
    expect(active.stop).not.toHaveBeenCalled()
    expect(active.stopSync).toHaveBeenCalledTimes(1)
    expect(onOffline).toHaveBeenCalledTimes(1)
    await expect(controller.ensure('lease-reacquire')).resolves.toMatchObject({ ok: false })
    expect(active.ensureLive).toHaveBeenCalledTimes(1)
    expect(createSupervisor).toHaveBeenCalledTimes(1)
  })
})

describe('HostLifecycleController host identity block (D11)', () => {
  it('carries the attached Host while running and drops it once stopped', async () => {
    const active = attachedSupervisor(HOST_A)
    const controller = new HostLifecycleController({ createSupervisor: () => active })
    await controller.start('app-start')
    expect(controller.getSnapshot().host).toEqual(HOST_A)
    // A detached copy: the controller's state cannot be mutated through it.
    expect(controller.getSnapshot().host).not.toBe(controller.getSnapshot().host)
    await controller.stop()
    expect(controller.getSnapshot()).not.toHaveProperty('host')
  })
})

describe('HostLifecycleController failure detail (transport log)', () => {
  it('hands the unbounded launch error to onFailure while the snapshot stays bounded', async () => {
    const stderr = `boot trace ${'x'.repeat(1_500)} FATAL: authority busy`
    const failed = supervisor({
      start: vi.fn(async () => {
        throw new Error(`External Host exited 1 before readiness. stderr: ${stderr}`)
      })
    })
    const failures: Array<{ reason: string; error: unknown }> = []
    const controller = new HostLifecycleController({
      createSupervisor: () => failed,
      onFailure: (failure) => {
        failures.push(failure)
        throw new Error('a failing observer must not change the lifecycle')
      }
    })

    const result = await controller.start()
    expect(result).toMatchObject({ ok: false, snapshot: { phase: 'failed' } })
    expect(controller.getSnapshot().error!.length).toBeLessThanOrEqual(512)
    expect(failures).toHaveLength(1)
    expect(failures[0].reason).toBe('start-failed')
    expect((failures[0].error as Error).message).toContain('FATAL: authority busy')
  })
})
