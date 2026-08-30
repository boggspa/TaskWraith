import { describe, expect, it, vi } from 'vitest'

import { createHostNodeTerminalLauncher } from './HostNodeTerminalLauncher'

function emitableChild() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const child = {
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

function fakeSpawn(options: { shouldError?: boolean; exitCode?: number | null } = {}) {
  return vi.fn(() => {
    const child = emitableChild()
    setTimeout(() => {
      if (options.shouldError) {
        child.emit('error')
        return
      }
      child.emit('spawn')
      child.emit('close', options.exitCode ?? 0)
    }, 0)
    return child as never
  })
}

describe('HostNodeTerminalLauncher', () => {
  it('launches Muse login with exact [binary, login] argv and resolves on spawn', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const handoff = await launcher.launchForProvider('muse', {
      argv: ['/usr/local/bin/muse', 'login']
    })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/muse', ['login'], {
      shell: false,
      stdio: 'inherit'
    })
    expect(handoff).toEqual({ providerId: 'muse', spawned: true })
    expect(handoff).not.toHaveProperty('authenticated')
    expect(handoff).not.toHaveProperty('closed')
    expect(handoff).not.toHaveProperty('exitCode')
  })

  it('launches Claude login with catalogued [binary, auth, login] argv', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await launcher.launchForProvider('claude', { argv: ['/usr/local/bin/claude', 'auth', 'login'] })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/claude', ['auth', 'login'], {
      shell: false,
      stdio: 'inherit'
    })
  })

  it('launches Grok login with catalogued [binary, login] argv', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await expect(
      launcher.launchForProvider('grok', { argv: ['/usr/local/bin/grok', 'login'] })
    ).resolves.toEqual({ providerId: 'grok', spawned: true })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/grok', ['login'], {
      shell: false,
      stdio: 'inherit'
    })
  })

  it('launches Ollama Cloud sign-in with the official signin argv', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await expect(
      launcher.launchForProvider('ollama', { argv: ['/usr/local/bin/ollama', 'signin'] })
    ).resolves.toEqual({ providerId: 'ollama', spawned: true })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/ollama', ['signin'], {
      shell: false,
      stdio: 'inherit'
    })
    await expect(
      launcher.launchForProvider('ollama', { argv: ['/usr/local/bin/ollama', 'login'] })
    ).rejects.toThrow('Terminal launcher requires an exact login command.')
  })

  it('rejects Pi because it has no catalogued terminal login', async () => {
    const launcher = createHostNodeTerminalLauncher()
    await expect(
      launcher.launchForProvider('pi', { argv: ['/usr/local/bin/pi', 'login'] })
    ).rejects.toThrow('Provider pi has no catalogued login flow.')
  })

  it('rejects wrong argv for a provider', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await expect(
      launcher.launchForProvider('claude', { argv: ['/usr/local/bin/claude', 'login'] })
    ).rejects.toThrow('Terminal launcher requires an exact login command.')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('launches the official bare agy login with its supplied credential-stripped environment', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await expect(
      launcher.launchForProvider('antigravity', {
        argv: ['/usr/local/bin/agy'],
        env: { PATH: '/usr/local/bin', FORCE_COLOR: '0' }
      })
    ).resolves.toEqual({ providerId: 'antigravity', spawned: true })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/agy', [], {
      shell: false,
      stdio: 'inherit',
      env: { PATH: '/usr/local/bin', FORCE_COLOR: '0' }
    })
    await expect(
      launcher.launchForProvider('antigravity', { argv: ['/usr/local/bin/agy', 'login'] })
    ).rejects.toThrow('Terminal launcher requires an exact login command.')
  })

  it('rejects non-absolute binary paths', async () => {
    const launcher = createHostNodeTerminalLauncher()
    await expect(launcher.launchForProvider('muse', { argv: ['muse', 'login'] })).rejects.toThrow(
      'Terminal launcher requires an exact login command.'
    )
  })

  it('resolves on spawn without waiting for close and still is not authentication', async () => {
    const child = emitableChild()
    const spawn = vi.fn(() => child as never)
    const launcher = createHostNodeTerminalLauncher({ spawn })
    let resolved: unknown = 'pending'
    const pending = launcher
      .launchForProvider('codex', { argv: ['/usr/local/bin/codex', 'login'] })
      .then((handoff) => {
        resolved = handoff
        return handoff
      })
    child.emit('spawn')
    await expect(pending).resolves.toEqual({
      providerId: 'codex',
      spawned: true
    })
    expect(resolved).not.toHaveProperty('authenticated')
    expect(resolved).not.toHaveProperty('closed')
    expect(resolved).not.toHaveProperty('exitCode')
  })

  it('does not treat a later close or non-zero exit as authentication', async () => {
    const child = emitableChild()
    const spawn = vi.fn(() => child as never)
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const pending = launcher.launchForProvider('kimi', {
      argv: ['/usr/local/bin/kimi', 'login']
    })
    child.emit('spawn')
    const handoff = await pending
    child.emit('close', 1)
    expect(handoff).toEqual({ providerId: 'kimi', spawned: true })
    expect(handoff).not.toHaveProperty('authenticated')
    expect(handoff).not.toHaveProperty('exitCode')
  })

  it('rejects duplicate pending handoffs until the first child closes', async () => {
    const child = emitableChild()
    const spawn = vi.fn(() => child as never)
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const first = launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })
    await expect(launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })).rejects.toThrow(
      'muse login terminal handoff is already pending.'
    )
    child.emit('spawn')
    await first
    await expect(launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })).rejects.toThrow(
      'muse login terminal handoff is already pending.'
    )
    child.emit('close', 0)
    const retryChild = emitableChild()
    spawn.mockImplementationOnce(() => retryChild as never)
    const retry = launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })
    retryChild.emit('spawn')
    await expect(retry).resolves.toBeUndefined()
  })

  it('rejects a pre-spawn error and unblocks a later login', async () => {
    const failing = emitableChild()
    const spawn = vi.fn(() => failing as never)
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const first = launcher.launchForProvider('codex', {
      argv: ['/usr/local/bin/codex', 'login']
    })
    failing.emit('error')
    await expect(first).rejects.toThrow('codex login terminal handoff failed.')

    const retryChild = emitableChild()
    spawn.mockImplementationOnce(() => retryChild as never)
    const retry = launcher.launchForProvider('codex', {
      argv: ['/usr/local/bin/codex', 'login']
    })
    retryChild.emit('spawn')
    await expect(retry).resolves.toEqual({ providerId: 'codex', spawned: true })
  })

  it('releases pendingBinaries on a post-spawn error with no close', async () => {
    const child = emitableChild()
    const spawn = vi.fn(() => child as never)
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const first = launcher.launchForProvider('claude', {
      argv: ['/usr/local/bin/claude', 'auth', 'login']
    })
    child.emit('spawn')
    await expect(first).resolves.toEqual({ providerId: 'claude', spawned: true })
    child.emit('error')
    await Promise.resolve()

    const retryChild = emitableChild()
    spawn.mockImplementationOnce(() => retryChild as never)
    const retry = launcher.launchForProvider('claude', {
      argv: ['/usr/local/bin/claude', 'auth', 'login']
    })
    retryChild.emit('spawn')
    await expect(retry).resolves.toEqual({ providerId: 'claude', spawned: true })
  })
})
