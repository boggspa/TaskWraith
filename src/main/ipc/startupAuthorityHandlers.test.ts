import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { StartupAuthorityRecoveryState } from '../startup/StartupAuthorityRecovery'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

import {
  registerStartupAuthorityHandlers,
  STARTUP_AUTHORITY_GET_CHANNEL,
  STARTUP_AUTHORITY_RETRY_CHANNEL,
  STARTUP_AUTHORITY_STATE_CHANNEL
} from './startupAuthorityHandlers'

const degraded: StartupAuthorityRecoveryState = {
  status: 'degraded',
  failure: { failureClass: 'authority_busy', retryable: true, message: 'busy' },
  attempts: 1,
  nextRetryAtMs: 2_000,
  lastAttemptAtMs: 1_000,
  recoveredAfterRetry: false,
  bootRecoveryIncomplete: false
}

const available: StartupAuthorityRecoveryState = {
  ...degraded,
  status: 'available',
  failure: null,
  recoveredAfterRetry: true,
  nextRetryAtMs: null
}

beforeEach(() => handlers.clear())

describe('registerStartupAuthorityHandlers', () => {
  it('serves the current state and the explicit retry over IPC', async () => {
    const retryNow = vi.fn(async () => available)
    registerStartupAuthorityHandlers({
      getState: () => degraded,
      retryNow,
      forEachRendererWindow: () => {}
    })
    expect(await handlers.get(STARTUP_AUTHORITY_GET_CHANNEL)?.()).toEqual(degraded)
    expect(await handlers.get(STARTUP_AUTHORITY_RETRY_CHANNEL)?.()).toEqual(available)
    expect(retryNow).toHaveBeenCalledTimes(1)
  })

  it('broadcasts state changes to every live renderer and skips destroyed ones', () => {
    const sent: Array<[string, StartupAuthorityRecoveryState]> = []
    const live = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, state: StartupAuthorityRecoveryState) => sent.push([channel, state])
      }
    }
    const destroyed = {
      isDestroyed: () => true,
      webContents: {
        send: () => {
          throw new Error('a destroyed window must never be sent to')
        }
      }
    }
    const { broadcast } = registerStartupAuthorityHandlers({
      getState: () => degraded,
      retryNow: async () => available,
      forEachRendererWindow: (visit) => {
        visit(live as never)
        visit(destroyed as never)
      }
    })
    broadcast(degraded)
    expect(sent).toEqual([[STARTUP_AUTHORITY_STATE_CHANNEL, degraded]])
  })
})
