import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ChatRecord } from '../store/types'
import { registerFanoutCandidateHandlers } from './fanoutCandidateHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerFanoutCandidateHandlers', () => {
  it('keeps every channel registered when workspace-lock startup recovery is unavailable', async () => {
    const getWorkspaceDiff = vi.fn()
    registerFanoutCandidateHandlers({
      service: null,
      unavailableReason: () => 'Workspace-lock recovery is required.',
      getChat: () => ({ id: 'chat-1' }) as unknown as ChatRecord,
      getWorkspaceDiff
    })

    const unavailable = 'Fan-out candidates are unavailable: Workspace-lock recovery is required.'
    await expect(handlerFor('fanout-candidates:list')({}, 'chat-1')).rejects.toThrow(unavailable)
    await expect(handlerFor('fanout-candidates:diff')({}, 'chat-1', 'candidate-1')).rejects.toThrow(
      unavailable
    )
    await expect(
      handlerFor('fanout-candidates:promote')({}, 'chat-1', 'candidate-1')
    ).rejects.toThrow(unavailable)
    await expect(
      handlerFor('fanout-candidates:discard')({}, 'chat-1', 'candidate-1')
    ).rejects.toThrow(unavailable)
    expect(getWorkspaceDiff).not.toHaveBeenCalled()
  })
})
