import { describe, expect, it, vi } from 'vitest'
import {
  registerStudioResourceSnapshotHandlers,
  STUDIO_RESOURCE_SNAPSHOT_CHANNEL
} from './StudioResourceSnapshotHandlers'

function register(
  getLifecycle: Parameters<typeof registerStudioResourceSnapshotHandlers>[1]['getLifecycle']
) {
  const handle = vi.fn()
  registerStudioResourceSnapshotHandlers({ handle }, { getLifecycle })
  expect(handle).toHaveBeenCalledExactlyOnceWith(
    STUDIO_RESOURCE_SNAPSHOT_CHANNEL,
    expect.any(Function)
  )
  return handle.mock.calls[0][1] as (...args: unknown[]) => Promise<unknown>
}

describe('Studio resource snapshot IPC', () => {
  it('keeps unavailable unavailable without creating a lifecycle or starting a process', async () => {
    const getLifecycle = vi.fn(() => null)
    await expect(register(getLifecycle)()).resolves.toMatchObject({
      ok: false,
      code: 'studio_unavailable'
    })
    expect(getLifecycle).toHaveBeenCalledExactlyOnceWith()
  })

  it('queries only the existing lifecycle without forwarding caller paths, PIDs or methods', async () => {
    const outcome = {
      ok: false as const,
      code: 'resource_query_timeout' as const,
      message: 'timeout'
    }
    const getResourceSnapshot = vi.fn(async () => outcome)
    const invoke = register(() => ({ getResourceSnapshot }))
    await expect(invoke({}, { pid: 55, path: '/arbitrary', method: 'spawn' })).resolves.toBe(
      outcome
    )
    expect(getResourceSnapshot).toHaveBeenCalledExactlyOnceWith()
  })

  it('returns typed failure when the diagnostic method throws', async () => {
    const invoke = register(() => ({
      getResourceSnapshot: async () => {
        throw new Error('private detail')
      }
    }))
    await expect(invoke()).resolves.toEqual({
      ok: false,
      code: 'resource_snapshot_unavailable',
      message: 'Studio resource snapshot failed.'
    })
  })
})
