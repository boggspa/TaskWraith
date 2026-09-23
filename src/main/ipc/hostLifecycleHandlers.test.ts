import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog, type IpcMainInvokeEvent } from 'electron'

import {
  isHostLifecycleInspectResult,
  type HostLifecycleActionResult,
  type HostLifecycleSnapshot
} from '../../shared/hostLifecycle'
import type { HostStatusProjection } from '../../shared/hostProtocol'
import {
  HOST_LIFECYCLE_INSPECT_CHANNEL,
  HOST_LIFECYCLE_SET_CHANNEL,
  HOST_LIFECYCLE_STATUS_CHANNEL,
  countHostLiveRuns,
  createHostRestartAction,
  registerHostLifecycleHandlers,
  type HostLifecycleInspectPort
} from './hostLifecycleHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  },
  dialog: {
    showMessageBox: vi.fn()
  }
}))

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function snapshot(overrides: Partial<HostLifecycleSnapshot> = {}): HostLifecycleSnapshot {
  return {
    revision: 4,
    phase: 'running',
    desired: 'running',
    reason: 'user-start',
    changedAt: '2026-08-12T12:00:00.000Z',
    ...overrides
  }
}

function hostStatus(runs: number): HostStatusProjection {
  return {
    pid: 4242,
    startedAt: '2026-09-23T10:00:00.000Z',
    uptimeMs: 60_000,
    hostId: 'host-install-1',
    profilePath: '/profile',
    persist: false,
    lifetime: { phase: 'held', holders: 1, implicitHolders: 0, declined: 2 },
    liveWork: { runs },
    clients: []
  }
}

function harness(inspect?: HostLifecycleInspectPort) {
  const handlers = new Map<string, RegisteredHandler>()
  const ipc = {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
  let listener: ((value: HostLifecycleSnapshot) => void) | undefined
  const unsubscribe = vi.fn()
  const controller = {
    getSnapshot: vi.fn(() => snapshot()),
    start: vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({
        ok: true,
        snapshot: snapshot({ revision: 6, reason: 'user-start' })
      })
    ),
    stop: vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({
        ok: true,
        snapshot: snapshot({
          revision: 8,
          phase: 'stopped',
          desired: 'stopped',
          reason: 'user-stop'
        })
      })
    ),
    restart: vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({
        ok: true,
        snapshot: snapshot({ revision: 10, reason: 'user-restart' })
      })
    ),
    subscribe: vi.fn((next: (value: HostLifecycleSnapshot) => void) => {
      listener = next
      return unsubscribe
    })
  }
  const assertMainRendererSender = vi.fn()
  const publishChanged = vi.fn()
  const dispose = registerHostLifecycleHandlers({
    controller,
    assertMainRendererSender,
    publishChanged,
    ...(inspect ? { inspect } : {}),
    ipc: ipc as never
  })
  const event = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent
  return {
    handlers,
    ipc,
    controller,
    assertMainRendererSender,
    publishChanged,
    emit: (value: HostLifecycleSnapshot) => listener?.(value),
    unsubscribe,
    dispose,
    event
  }
}

describe('registerHostLifecycleHandlers', () => {
  it('registers idempotent status, action and inspect channels', () => {
    const value = harness()
    expect([...value.handlers.keys()]).toEqual([
      HOST_LIFECYCLE_STATUS_CHANNEL,
      HOST_LIFECYCLE_SET_CHANNEL,
      HOST_LIFECYCLE_INSPECT_CHANNEL
    ])
    expect(value.ipc.removeHandler).toHaveBeenCalledWith(HOST_LIFECYCLE_STATUS_CHANNEL)
    expect(value.ipc.removeHandler).toHaveBeenCalledWith(HOST_LIFECYCLE_SET_CHANNEL)
    expect(value.ipc.removeHandler).toHaveBeenCalledWith(HOST_LIFECYCLE_INSPECT_CHANNEL)
  })

  it('returns current state only after main-renderer authorization', () => {
    const value = harness()
    const result = value.handlers.get(HOST_LIFECYCLE_STATUS_CHANNEL)?.(value.event)
    expect(result).toEqual({ ok: true, snapshot: snapshot() })
    expect(value.assertMainRendererSender).toHaveBeenCalledWith(value.event)
  })

  it('denies secondary renderers before reading or mutating lifecycle state', async () => {
    const inspect = {
      readHostStatus: vi.fn(async () => hostStatus(0)),
      leaseProjection: vi.fn(() => ({
        mode: 'lease' as const,
        held: true,
        reasons: ['app' as const]
      }))
    }
    const value = harness(inspect)
    value.assertMainRendererSender.mockImplementation(() => {
      throw new Error('secondary renderer')
    })

    expect(value.handlers.get(HOST_LIFECYCLE_STATUS_CHANNEL)?.(value.event)).toEqual({
      ok: false,
      error: 'Only the main TaskWraith window can control Host.'
    })
    await expect(
      value.handlers.get(HOST_LIFECYCLE_SET_CHANNEL)?.(value.event, { action: 'stop' })
    ).resolves.toEqual({
      ok: false,
      error: 'Only the main TaskWraith window can control Host.'
    })
    await expect(
      value.handlers.get(HOST_LIFECYCLE_SET_CHANNEL)?.(value.event, { action: 'restart' })
    ).resolves.toEqual({
      ok: false,
      error: 'Only the main TaskWraith window can control Host.'
    })
    await expect(
      value.handlers.get(HOST_LIFECYCLE_INSPECT_CHANNEL)?.(value.event)
    ).resolves.toEqual({
      ok: false,
      error: 'Only the main TaskWraith window can control Host.'
    })
    expect(value.controller.getSnapshot).not.toHaveBeenCalled()
    expect(value.controller.stop).not.toHaveBeenCalled()
    expect(value.controller.restart).not.toHaveBeenCalled()
    expect(inspect.readHostStatus).not.toHaveBeenCalled()
    expect(inspect.leaseProjection).not.toHaveBeenCalled()
  })

  it('routes exact start, stop and restart requests and rejects extra fields', async () => {
    const value = harness()
    const set = value.handlers.get(HOST_LIFECYCLE_SET_CHANNEL)

    await set?.(value.event, { action: 'start' })
    await set?.(value.event, { action: 'stop' })
    await expect(set?.(value.event, { action: 'restart' })).resolves.toMatchObject({
      ok: true,
      snapshot: { reason: 'user-restart' }
    })
    expect(value.controller.start).toHaveBeenCalledWith('user-start')
    expect(value.controller.stop).toHaveBeenCalledWith('user-stop')
    expect(value.controller.restart).toHaveBeenCalledWith('user-restart')

    for (const request of [
      { action: 'stop', hidden: true },
      { action: 'restart', reason: 'poison-restart' },
      { action: 'reboot' },
      ['restart']
    ]) {
      await expect(set?.(value.event, request)).resolves.toEqual({
        ok: false,
        error: 'Host lifecycle request must contain exactly one start, stop or restart action.',
        snapshot: snapshot()
      })
    }
    expect(value.controller.stop).toHaveBeenCalledTimes(1)
    expect(value.controller.restart).toHaveBeenCalledTimes(1)
  })

  it("inspects the lifecycle with the Host's own status and main's lease", async () => {
    const inspect = {
      readHostStatus: vi.fn(async () => hostStatus(2)),
      leaseProjection: vi.fn(() => ({
        mode: 'lease' as const,
        held: true,
        reasons: ['app' as const]
      }))
    }
    const value = harness(inspect)
    const result = await value.handlers.get(HOST_LIFECYCLE_INSPECT_CHANNEL)?.(value.event)
    expect(result).toEqual({
      ok: true,
      snapshot: snapshot(),
      host: hostStatus(2),
      lease: { mode: 'lease', held: true, reasons: ['app'] }
    })
    // What the renderer's decoder accepts, so the Settings card can read it.
    expect(isHostLifecycleInspectResult(result)).toBe(true)
  })

  it('still answers the inspect channel when the live status cannot be read', async () => {
    const unreadable = harness({
      readHostStatus: vi.fn(async () => {
        throw new Error('socket closed')
      }),
      leaseProjection: () => ({ mode: 'lease', held: false, reasons: ['app'] })
    })
    await expect(
      unreadable.handlers.get(HOST_LIFECYCLE_INSPECT_CHANNEL)?.(unreadable.event)
    ).resolves.toEqual({
      ok: true,
      snapshot: snapshot(),
      host: null,
      lease: { mode: 'lease', held: false, reasons: ['app'] }
    })
    // The in-process Host: no lease, no live status.
    const inProcess = harness()
    const result = await inProcess.handlers.get(HOST_LIFECYCLE_INSPECT_CHANNEL)?.(inProcess.event)
    expect(result).toEqual({ ok: true, snapshot: snapshot(), host: null, lease: null })
    expect(isHostLifecycleInspectResult(result)).toBe(true)
  })

  it('publishes bounded controller transitions and disposes the subscription', () => {
    const value = harness()
    const changed = snapshot({ revision: 5, phase: 'stopping', desired: 'stopped' })
    value.emit(changed)
    expect(value.publishChanged).toHaveBeenCalledWith(changed)

    value.dispose()
    value.emit(snapshot({ revision: 6 }))
    expect(value.publishChanged).toHaveBeenCalledTimes(1)
    expect(value.unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('countHostLiveRuns', () => {
  const projection = (outcomes: readonly string[]) => async () => ({
    ok: true as const,
    snapshot: { runs: outcomes.map((providerOutcome) => ({ providerOutcome })) }
  })

  it("reads the Host's own count first", async () => {
    const snapshotRead = vi.fn(projection(['running']))
    await expect(
      countHostLiveRuns({ readHostStatus: async () => hostStatus(3), snapshot: snapshotRead })
    ).resolves.toBe(3)
    expect(snapshotRead).not.toHaveBeenCalled()
  })

  it("falls back to the projection's running runs, then to unknown", async () => {
    await expect(
      countHostLiveRuns({
        readHostStatus: async () => null,
        snapshot: projection(['running', 'completed', 'running'])
      })
    ).resolves.toBe(2)
    await expect(
      countHostLiveRuns({
        readHostStatus: async () => {
          throw new Error('unauthorized')
        },
        snapshot: projection([])
      })
    ).resolves.toBe(0)
    await expect(
      countHostLiveRuns({
        readHostStatus: async () => null,
        snapshot: async () => ({ ok: false as const })
      })
    ).resolves.toBeNull()
  })
})

describe('createHostRestartAction', () => {
  beforeEach(() => {
    vi.mocked(dialog.showMessageBox).mockReset()
  })

  function action(runs: number | null, confirm?: (liveRuns: number | null) => Promise<boolean>) {
    const restart = vi.fn(
      async (): Promise<HostLifecycleActionResult> => ({
        ok: true,
        snapshot: snapshot({ reason: 'user-restart' })
      })
    )
    const log = vi.fn()
    const run = createHostRestartAction({
      controller: { restart },
      readHostStatus: async () => (runs === null ? null : hostStatus(runs)),
      snapshot: async () => ({ ok: false as const }),
      ...(confirm ? { confirm } : {}),
      log
    })
    return { run, restart, log }
  }

  it('restarts at once when no run is live', async () => {
    const confirm = vi.fn(async () => false)
    const { run, restart } = action(0, confirm)
    await expect(run()).resolves.toMatchObject({ ok: true })
    expect(confirm).not.toHaveBeenCalled()
    expect(restart).toHaveBeenCalledWith('user-restart')
  })

  it('asks first when runs are live or their count is unknown, and a cancel restarts nothing', async () => {
    const declined = vi.fn(async () => false)
    const live = action(2, declined)
    await expect(live.run()).resolves.toBeNull()
    expect(declined).toHaveBeenCalledWith(2)
    expect(live.restart).not.toHaveBeenCalled()
    expect(live.log).toHaveBeenCalledWith('[host-lifecycle] restart cancelled by the user')

    const accepted = vi.fn(async () => true)
    const unknown = action(null, accepted)
    await expect(unknown.run()).resolves.toMatchObject({ ok: true })
    expect(accepted).toHaveBeenCalledWith(null)
    expect(unknown.restart).toHaveBeenCalledWith('user-restart')
  })

  it('asks through a warning dialog whose default is Cancel', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const { run, restart } = action(1)
    await expect(run()).resolves.toBeNull()
    expect(restart).not.toHaveBeenCalled()
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        buttons: ['Restart Host', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        detail: '1 run is in progress. Restarting the Host cancels it.'
      })
    )
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await expect(run()).resolves.toMatchObject({ ok: true })
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('logs a restart that failed and returns its result', async () => {
    const { run, restart, log } = action(0)
    restart.mockResolvedValueOnce({
      ok: false,
      error: 'Host did not stop.',
      snapshot: snapshot({ phase: 'failed', reason: 'stop-failed' })
    })
    await expect(run()).resolves.toMatchObject({ ok: false, error: 'Host did not stop.' })
    expect(log).toHaveBeenCalledWith('[host-lifecycle] restart failed: Host did not stop.')
  })
})
