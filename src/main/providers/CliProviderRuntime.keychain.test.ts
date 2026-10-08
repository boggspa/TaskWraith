import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hasSwitch: vi.fn(),
  spawn: vi.fn(),
  code: 0,
  stdout: '',
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

import {
  getCliProviderStatus,
  readClaudeAuthState,
  type ResolvedProviderBinary
} from './CliProviderRuntime'
import type { AppSettings } from '../store/types'

const resolved: ResolvedProviderBinary = {
  provider: 'claude',
  binaryPath: '/test-only/claude',
  source: 'settings'
}

beforeEach(() => {
  mocks.hasSwitch.mockReset().mockReturnValue(false)
  mocks.code = 0
  mocks.stdout = ''
  mocks.stderr = ''
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(mocks.stdout))
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

describe('Mistral native credential isolation', () => {
  it('skips native auth discovery in mock mode while preserving availability and version', async () => {
    mocks.hasSwitch.mockImplementation((name: string) => name === 'use-mock-keychain')
    mocks.stdout = '2.24.3\n'
    const stat = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (
        basename(String(candidate)) === (process.platform === 'win32' ? 'vibe-acp.exe' : 'vibe-acp')
      ) {
        return { isFile: () => true, isSymbolicLink: () => false } as Awaited<
          ReturnType<typeof fs.stat>
        >
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const probeMistralAuthStatus = vi.fn(async () => ({
      authState: 'authenticated' as const,
      credentialPresent: true,
      authSource: 'os_keyring',
      version: '2.24.3',
      probeStatus: 'verified' as const
    }))

    try {
      await expect(
        getCliProviderStatus('mistral', {
          env: { PATH: '/test-only/bin' },
          getRuntimeProfiles: () => [],
          getSettings: () => ({}) as AppSettings,
          probeMistralAuthStatus
        })
      ).resolves.toMatchObject({
        provider: 'mistral',
        available: true,
        version: '2.24.3',
        authState: 'unknown',
        credentialPresent: null,
        authSource: null,
        probeStatus: 'skipped'
      })
      expect(probeMistralAuthStatus).not.toHaveBeenCalled()
      expect(mocks.spawn).toHaveBeenCalledOnce()
      expect(mocks.spawn).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]vibe-acp(?:\.exe)?$/),
        ['--version'],
        expect.any(Object)
      )
    } finally {
      stat.mockRestore()
    }
  })
})
