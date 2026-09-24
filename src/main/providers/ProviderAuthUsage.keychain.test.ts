import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasSwitch: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'taskwraith-keychain-isolation-test'),
    commandLine: { hasSwitch: mocks.hasSwitch }
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: mocks.spawn
}))

import { readClaudeKeychainCredential } from './ProviderAuthUsage'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' })
  mocks.hasSwitch.mockReset().mockReturnValue(false)
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      kill: vi.fn()
    })
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'test-only-token' } }))
      )
      child.emit('close', 0)
    })
    return child
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
})

describe('Claude native keychain isolation', () => {
  it('never starts the native keychain helper when Electron uses a mock keychain', async () => {
    mocks.hasSwitch.mockImplementation((name: string) => name === 'use-mock-keychain')

    await expect(readClaudeKeychainCredential()).resolves.toBeNull()

    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('preserves native credential discovery for ordinary macOS launches', async () => {
    await expect(readClaudeKeychainCredential()).resolves.toMatchObject({
      accessToken: 'test-only-token'
    })

    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w'
    ])
  })

  it('does not start a native keychain helper on other platforms', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })

    await expect(readClaudeKeychainCredential()).resolves.toBeNull()

    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
