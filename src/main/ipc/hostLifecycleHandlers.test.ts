import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

import type { HostLifecycleActionResult, HostLifecycleSnapshot } from '../../shared/hostLifecycle'
import {
  HOST_LIFECYCLE_SET_CHANNEL,
  HOST_LIFECYCLE_STATUS_CHANNEL,
  registerHostLifecycleHandlers
} from './hostLifecycleHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
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

function harness() {
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
  it('registers idempotent status and action channels', () => {
    const value = harness()
    expect([...value.handlers.keys()]).toEqual([
      HOST_LIFECYCLE_STATUS_CHANNEL,
      HOST_LIFECYCLE_SET_CHANNEL
    ])
    expect(value.ipc.removeHandler).toHaveBeenCalledWith(HOST_LIFECYCLE_STATUS_CHANNEL)
    expect(value.ipc.removeHandler).toHaveBeenCalledWith(HOST_LIFECYCLE_SET_CHANNEL)
  })

  it('returns current state only after main-renderer authorization', () => {
    const value = harness()
    const result = value.handlers.get(HOST_LIFECYCLE_STATUS_CHANNEL)?.(value.event)
    expect(result).toEqual({ ok: true, snapshot: snapshot() })
    expect(value.assertMainRendererSender).toHaveBeenCalledWith(value.event)
  })

  it('denies secondary renderers before reading or mutating lifecycle state', async () => {
    const value = harness()
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
    expect(value.controller.getSnapshot).not.toHaveBeenCalled()
    expect(value.controller.stop).not.toHaveBeenCalled()
  })

  it('routes exact start and stop requests and rejects extra fields', async () => {
    const value = harness()
    const set = value.handlers.get(HOST_LIFECYCLE_SET_CHANNEL)

    await set?.(value.event, { action: 'start' })
    await set?.(value.event, { action: 'stop' })
    expect(value.controller.start).toHaveBeenCalledWith('user-start')
    expect(value.controller.stop).toHaveBeenCalledWith('user-stop')

    const malformed = await set?.(value.event, { action: 'stop', hidden: true })
    expect(malformed).toMatchObject({ ok: false, snapshot: snapshot() })
    expect(value.controller.stop).toHaveBeenCalledTimes(1)
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
