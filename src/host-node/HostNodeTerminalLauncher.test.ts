import { describe, expect, it, vi } from 'vitest'

import { createHostNodeTerminalLauncher } from './HostNodeTerminalLauncher'

function fakeSpawn(shouldError = false) {
  const listeners = new Map<string, (() => void)[]>()
  const child = {
    once: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }
  } as never
  return vi.fn(() => {
    setTimeout(() => {
      for (const listener of listeners.get(shouldError ? 'error' : 'spawn') ?? []) listener()
    }, 0)
    return child
  })
}

describe('HostNodeTerminalLauncher', () => {
  it('launches Muse login with exact [binary, login] argv', async () => {
    const spawn = fakeSpawn()
    const launcher = createHostNodeTerminalLauncher({ spawn })
    await launcher.launch({ argv: ['/usr/local/bin/muse', 'login'] })
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/muse', ['login'], {
      shell: false,
      stdio: 'inherit'
    })
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
      launcher.launchForProvider('grok', { argv: ['/usr/local/bin/grok', 'login'] })
    ).rejects.toThrow('Provider grok has no catalogued login flow.')
  })

  it('rejects non-absolute binary paths', async () => {
    const launcher = createHostNodeTerminalLauncher()
    await expect(launcher.launchForProvider('muse', { argv: ['muse', 'login'] })).rejects.toThrow(
      'Terminal launcher requires an exact login command.'
    )
  })

  it('rejects duplicate pending handoffs', async () => {
    const listeners = new Map<string, (() => void)[]>()
    const spawn = vi.fn(() => {
      const child = {
        once: (event: string, listener: () => void) => {
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
    // Resolve the first handoff so the pending entry clears.
    for (const listener of listeners.get('spawn') ?? []) listener()
    await first
  })
})
