import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createHostNodeTerminalWindowLauncher } from './HostNodeTerminalWindowLauncher'

function emitableChild() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const child = {
    unref: vi.fn(),
    once: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
  }
  return child
}

describe('HostNodeTerminalWindowLauncher', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it('opens an exact provider login in a separate macOS Terminal window', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-terminal-window-test-'))
    paths.push(directory)
    const child = emitableChild()
    const spawn = vi.fn(() => child as never)
    const launcher = createHostNodeTerminalWindowLauncher({
      platform: 'darwin',
      env: { PATH: '/usr/bin', GOOGLE_API_KEY: 'must-not-be-written' },
      spawn,
      temporaryDirectory: () => directory,
      idFactory: () => 'mac-login'
    })!

    const pending = launcher.launchForProvider('grok', {
      argv: ['/Applications/Grok CLI/grok', 'login'],
      env: { PATH: '/usr/bin' }
    })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/open',
      ['-a', 'Terminal', join(directory, 'provider-login-mac-login.command')],
      { shell: false, stdio: 'ignore' }
    )
    const script = readFileSync(join(directory, 'provider-login-mac-login.command'), 'utf8')
    expect(script).toContain("'/Applications/Grok CLI/grok' 'login'")
    expect(script).toContain('unset GOOGLE_API_KEY')
    expect(script).not.toContain('must-not-be-written')

    child.emit('spawn')
    await expect(pending).resolves.toEqual({ providerId: 'grok', spawned: true })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('retains the exact provider argv gate before creating a handoff script', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-terminal-window-gate-'))
    paths.push(directory)
    const spawn = vi.fn()
    const launcher = createHostNodeTerminalWindowLauncher({
      platform: 'darwin',
      spawn,
      temporaryDirectory: () => directory,
      idFactory: () => 'rejected-login'
    })!

    await expect(
      launcher.launchForProvider('claude', {
        argv: ['/usr/local/bin/claude', 'login']
      })
    ).rejects.toThrow('exact login command')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('stays unavailable on a headless Linux Host with no terminal display', () => {
    expect(
      createHostNodeTerminalWindowLauncher({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        pathExecutable: () => '/usr/bin/x-terminal-emulator'
      })
    ).toBeUndefined()
  })

  it('opens a generated script with an available Linux terminal emulator', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'host-terminal-window-linux-'))
    paths.push(directory)
    const child = emitableChild()
    const spawn = vi.fn(() => child as never)
    const launcher = createHostNodeTerminalWindowLauncher({
      platform: 'linux',
      env: { PATH: '/usr/bin', DISPLAY: ':0' },
      spawn,
      temporaryDirectory: () => directory,
      idFactory: () => 'linux-login',
      pathExecutable: (name) => (name === 'gnome-terminal' ? '/usr/bin/gnome-terminal' : null)
    })!

    const pending = launcher.launchForProvider('kimi', {
      argv: ['/usr/local/bin/kimi', 'login']
    })
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/gnome-terminal',
      ['--', join(directory, 'provider-login-linux-login.sh')],
      { detached: true, shell: false, stdio: 'ignore' }
    )
    child.emit('spawn')
    await expect(pending).resolves.toEqual({ providerId: 'kimi', spawned: true })
  })
})
