import { describe, expect, it, vi } from 'vitest'

import { createHostNodeTerminalLauncher } from './HostNodeTerminalLauncher'

function fakeSpawn(options: { shouldError?: boolean; exitCode?: number | null } = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const child = {
    once: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }
  } as never
  return vi.fn(() => {
    setTimeout(() => {
      if (options.shouldError) {
        for (const listener of listeners.get('error') ?? []) listener()
        return
      }
      for (const listener of listeners.get('spawn') ?? []) listener()
      for (const listener of listeners.get('close') ?? []) listener(options.exitCode ?? 0)
    }, 0)
    return child
  })
}

describe('HostNodeTerminalLauncher', () => {
  it('launches Muse login with exact [binary, login] argv and waits for close', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const handoff = await launcher.launchForProvider('muse', {
      argv: ['/usr/local/bin/muse', 'login']
    })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/muse', ['login'], {
      shell: false,
      stdio: 'inherit'
    })
    expect(handoff).toEqual({ providerId: 'muse', closed: true, exitCode: 0 })
    expect(handoff).not.toHaveProperty('authenticated')
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
    ).resolves.toEqual({ providerId: 'grok', closed: true, exitCode: 0 })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/grok', ['login'], {
      shell: false,
      stdio: 'inherit'
    })
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

  it('rejects providers with no catalogued login flow', async () => {
    const launcher = createHostNodeTerminalLauncher()
    await expect(
      launcher.launchForProvider('antigravity', { argv: ['/usr/local/bin/agy', 'login'] })
    ).rejects.toThrow('Provider antigravity has no catalogued login flow.')
  })

  it('rejects non-absolute binary paths', async () => {
    const launcher = createHostNodeTerminalLauncher()
    await expect(launcher.launchForProvider('muse', { argv: ['muse', 'login'] })).rejects.toThrow(
      'Terminal launcher requires an exact login command.'
    )
  })

  it('does not resolve on spawn; close is required and still is not authentication', async () => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const spawn = vi.fn(() => {
      const child = {
        once: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener])
          return child
        }
      } as never
      return child
    })
    const launcher = createHostNodeTerminalLauncher({ spawn })
    let resolved: unknown = 'pending'
    const pending = launcher
      .launchForProvider('codex', { argv: ['/usr/local/bin/codex', 'login'] })
      .then((handoff) => {
        resolved = handoff
        return handoff
      })
    for (const listener of listeners.get('spawn') ?? []) listener()
    await Promise.resolve()
    expect(resolved).toBe('pending')
    for (const listener of listeners.get('close') ?? []) listener(0)
    await expect(pending).resolves.toEqual({
      providerId: 'codex',
      closed: true,
      exitCode: 0
    })
    expect(resolved).not.toHaveProperty('authenticated')
  })

  it('returns a closed handoff for a non-zero exit without claiming authentication', async () => {
    const spawn = fakeSpawn({ exitCode: 1 })
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await expect(
      launcher.launchForProvider('kimi', { argv: ['/usr/local/bin/kimi', 'login'] })
    ).resolves.toEqual({ providerId: 'kimi', closed: true, exitCode: 1 })
  })

  it('rejects duplicate pending handoffs until the first child closes', async () => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const spawn = vi.fn(() => {
      const child = {
        once: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener])
          return child
        }
      } as never
      return child
    })
    const launcher = createHostNodeTerminalLauncher({ spawn })
    const first = launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })
    await expect(launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })).rejects.toThrow(
      'muse login terminal handoff is already pending.'
    )
    for (const listener of listeners.get('spawn') ?? []) listener()
    await expect(launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })).rejects.toThrow(
      'muse login terminal handoff is already pending.'
    )
    for (const listener of listeners.get('close') ?? []) listener(0)
    await first
  })
})
