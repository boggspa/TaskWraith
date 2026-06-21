import { describe, expect, it, vi } from 'vitest'
import { parseLaunchStartInput, parseLaunchStopInput } from './launchHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

describe('launch IPC parsers', () => {
  it('accepts launch-start payloads with optional chat and run ids', () => {
    expect(
      parseLaunchStartInput({
        workspacePath: '/repo',
        targetId: 'target-1',
        provider: 'codex',
        chatId: 'chat-1',
        runId: 'run-1'
      })
    ).toEqual({
      workspacePath: '/repo',
      targetId: 'target-1',
      provider: 'codex',
      chatId: 'chat-1',
      runId: 'run-1'
    })
  })

  it('rejects malformed launch-start payloads before discovery', () => {
    expect(() => parseLaunchStartInput(null)).toThrow('launch-start input is required.')
    expect(() =>
      parseLaunchStartInput({ workspacePath: '', targetId: 'target-1', provider: 'codex' })
    ).toThrow('workspacePath is required.')
    expect(() =>
      parseLaunchStartInput({ workspacePath: '/repo', targetId: 'target-1', provider: 'bad' })
    ).toThrow('provider is invalid.')
  })

  it('accepts and rejects launch-stop payloads by attempt id shape', () => {
    expect(parseLaunchStopInput({ attemptId: 'attempt-1' })).toEqual({ attemptId: 'attempt-1' })
    expect(() => parseLaunchStopInput(undefined)).toThrow('launch-stop input is required.')
    expect(() => parseLaunchStopInput({ attemptId: ' ' })).toThrow('attemptId is required.')
  })
})
