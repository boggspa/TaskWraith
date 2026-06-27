import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerTrustHandlers } from './trustHandlers'
import type { TrustStatusResult, TrustWriteResult } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function createDeps(overrides: Partial<Parameters<typeof registerTrustHandlers>[0]> = {}) {
  return {
    checkTrust: vi.fn(
      (_workspacePath: string): TrustStatusResult => ({
        status: 'trusted'
      })
    ),
    trustWorkspace: vi.fn(
      (workspacePath: string): TrustWriteResult => ({
        ok: true,
        status: 'trusted',
        path: workspacePath
      })
    ),
    getSessionYoloMode: vi.fn(() => ({
      enabled: false,
      enabledAt: null
    })),
    setSessionYoloMode: vi.fn(),
    ...overrides
  }
}

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerTrustHandlers', () => {
  it('delegates trust status reads and persistent trust writes', async () => {
    const deps = createDeps()
    registerTrustHandlers(deps)

    expect(handlerFor('check-trust')({} as any, '/repo')).toEqual({
      status: 'trusted'
    })
    expect(deps.checkTrust).toHaveBeenCalledWith('/repo')

    expect(handlerFor('trust-workspace')({} as any, '/repo')).toEqual({
      ok: true,
      status: 'trusted',
      path: '/repo'
    })
    expect(deps.trustWorkspace).toHaveBeenCalledWith('/repo')
  })

  it('returns the current session yolo state', async () => {
    const deps = createDeps({
      getSessionYoloMode: vi.fn(() => ({
        enabled: true,
        enabledAt: '2026-06-27T16:00:00.000Z'
      }))
    })
    registerTrustHandlers(deps)

    expect(handlerFor('agentic-yolo-get')({} as any)).toEqual({
      enabled: true,
      enabledAt: '2026-06-27T16:00:00.000Z'
    })
    expect(deps.getSessionYoloMode).toHaveBeenCalledTimes(1)
  })

  it('sets yolo mode and returns the updated session state', async () => {
    const deps = createDeps({
      getSessionYoloMode: vi.fn(() => ({
        enabled: true,
        enabledAt: '2026-06-27T16:00:00.000Z'
      }))
    })
    registerTrustHandlers(deps)

    expect(handlerFor('agentic-yolo-set')({} as any, true)).toEqual({
      enabled: true,
      enabledAt: '2026-06-27T16:00:00.000Z'
    })
    expect(deps.setSessionYoloMode).toHaveBeenCalledWith(true)
    expect(deps.getSessionYoloMode).toHaveBeenCalledTimes(1)
  })
})
