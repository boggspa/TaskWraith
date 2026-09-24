import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasSwitch: vi.fn(),
  spawn: vi.fn(),
  code: 0,
  stderr: ''
}))

vi.mock('electron', () => ({
  app: { commandLine: { hasSwitch: mocks.hasSwitch } }
}))

vi.mock('../store', () => ({
  AppStore: {
    getSettings: () => ({}),
    getRuntimeProfiles: () => [],
    resolveExtensionSecretValues: () => []
  }
}))

vi.mock('child_process', () => ({ spawn: mocks.spawn }))

import { readClaudeAuthState, type ResolvedProviderBinary } from './CliProviderRuntime'

const resolved: ResolvedProviderBinary = {
  provider: 'claude',
  binaryPath: '/test-only/claude',
  source: 'settings'
}

beforeEach(() => {
  mocks.hasSwitch.mockReset().mockReturnValue(false)
  mocks.code = 0
  mocks.stderr = ''
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    })
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from(mocks.stderr))
      child.emit('close', mocks.code)
    })
    return child
  })
})

describe('Claude CLI credential isolation', () => {
  it('returns unknown without starting auth status when the mock keychain is enabled', async () => {
    mocks.hasSwitch.mockImplementation((name: string) => name === 'use-mock-keychain')

    await expect(readClaudeAuthState(resolved)).resolves.toBe('unknown')

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('preserves successful auth-status discovery in an ordinary launch', async () => {
    await expect(readClaudeAuthState(resolved)).resolves.toBe('authenticated')

    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledWith(
      resolved.binaryPath,
      ['auth', 'status'],
      expect.any(Object)
    )
  })

  it('preserves the missing-auth result in an ordinary launch', async () => {
    mocks.code = 1
    mocks.stderr = 'Not logged in'

    await expect(readClaudeAuthState(resolved)).resolves.toBe('missing')

    expect(mocks.spawn).toHaveBeenCalledOnce()
  })

  it('keeps a missing binary unknown without starting a process', async () => {
    await expect(readClaudeAuthState({ ...resolved, binaryPath: null })).resolves.toBe('unknown')

    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
