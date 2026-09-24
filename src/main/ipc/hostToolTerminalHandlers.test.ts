import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

import {
  HOST_TOOL_INSTALL_TERMINAL_CHANNEL,
  HOST_TOOL_STATUS_CHANNEL,
  hostToolTerminalCommand,
  registerHostToolTerminalHandlers,
  type HostToolTerminalHandlersDeps
} from './hostToolTerminalHandlers'

function makeDeps(
  overrides: Partial<HostToolTerminalHandlersDeps> = {}
): HostToolTerminalHandlersDeps & { written: Map<string, string>; opened: string[] } {
  const written = new Map<string, string>()
  const opened: string[] = []
  const deps = {
    resolveHostToolPath: () => null,
    getUserDataPath: () => '/userdata',
    openPath: async (path: string) => {
      opened.push(path)
      return ''
    },
    mkdirSync: () => undefined,
    writeFileSync: (path: string, data: string) => {
      written.set(path, data)
    },
    chmodSync: () => undefined,
    getPlatform: () => 'darwin' as NodeJS.Platform,
    ...overrides
  } as HostToolTerminalHandlersDeps
  return Object.assign(deps, { written, opened })
}

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler
}

beforeEach(() => {
  handlers.clear()
})

describe('hostToolTerminalCommand', () => {
  it('installs with the platform-correct command when the binary is absent', () => {
    expect(hostToolTerminalCommand(makeDeps(), 'gh')).toEqual({
      command: 'brew install gh',
      alreadyInstalled: false
    })
    expect(
      hostToolTerminalCommand(makeDeps({ getPlatform: () => 'win32' as NodeJS.Platform }), 'gh')
    ).toEqual({ command: 'winget install --id GitHub.cli', alreadyInstalled: false })
  })

  it('refuses rather than guessing an install command for an uncovered platform', () => {
    const result = hostToolTerminalCommand(
      makeDeps({ getPlatform: () => 'linux' as NodeJS.Platform }),
      'gh'
    )
    expect(result).toMatchObject({ alreadyInstalled: false })
    expect('error' in result && result.error).toContain('https://cli.github.com')
  })

  it('upgrades the resolved copy through the channel that owns it', () => {
    const deps = makeDeps({
      resolveHostToolPath: () => '/opt/homebrew/bin/gh',
      realpathSync: () => '/opt/homebrew/Cellar/gh/2.62.0/bin/gh'
    })
    expect(hostToolTerminalCommand(deps, 'gh')).toEqual({
      command: "'brew' 'upgrade' 'gh'",
      alreadyInstalled: true
    })
  })

  it('refuses to guess an upgrade when the install channel is unidentifiable', () => {
    // Upgrading the wrong copy reports success while the binary TaskWraith runs
    // never moves — strictly worse than declining.
    const deps = makeDeps({
      resolveHostToolPath: () => '/usr/local/bin/gh',
      realpathSync: () => '/usr/local/bin/gh'
    })
    const result = hostToolTerminalCommand(deps, 'gh')
    expect(result).toMatchObject({ alreadyInstalled: true })
    expect('error' in result && result.error).toContain('/usr/local/bin/gh')
  })
})

describe('registerHostToolTerminalHandlers', () => {
  it('registers both channels', () => {
    registerHostToolTerminalHandlers(makeDeps())
    expect(handlerFor(HOST_TOOL_INSTALL_TERMINAL_CHANNEL)).toBeTypeOf('function')
    expect(handlerFor(HOST_TOOL_STATUS_CHANNEL)).toBeTypeOf('function')
  })

  it('writes an executable install script and opens it', async () => {
    const deps = makeDeps()
    registerHostToolTerminalHandlers(deps)
    await expect(handlerFor(HOST_TOOL_INSTALL_TERMINAL_CHANNEL)({}, 'gh')).resolves.toMatchObject({
      ok: true,
      command: 'brew install gh',
      alreadyInstalled: false
    })
    // The handler composes this with join() (hostToolTerminalHandlers.ts:134,180),
    // so the lookup key must be composed the same way — a POSIX literal misses
    // the map entirely on Windows and `script` comes back undefined. The darwin
    // branch itself is already pinned through deps.getPlatform(), so this stays
    // a macOS assertion on every runner.
    const script = deps.written.get(join('/userdata', 'login', 'hosttool-gh-install.command'))
    expect(script).toContain('brew install gh')
    // brew itself is frequently only on the shell PATH, which is the very
    // narrowing this feature exists to work around.
    expect(script).toContain('source "$HOME/.zprofile"')
    expect(deps.opened).toEqual([join('/userdata', 'login', 'hosttool-gh-install.command')])
  })

  it('never assigns to the zsh read-only `status` parameter in the install script', async () => {
    // zsh reserves `status` as a read-only alias of `$?`; `status=$?` aborts a
    // `#!/bin/zsh` script with "read-only variable: status".
    const deps = makeDeps()
    registerHostToolTerminalHandlers(deps)
    await expect(handlerFor(HOST_TOOL_INSTALL_TERMINAL_CHANNEL)({}, 'gh')).resolves.toMatchObject({
      ok: true
    })
    const script = String(
      deps.written.get(join('/userdata', 'login', 'hosttool-gh-install.command')) || ''
    )
    // @portability-ok: deps.getPlatform() is pinned to 'darwin', so the
    // generated script is the zsh .command on every host runner.
    expect(script).toContain('#!/bin/zsh')
    expect(script).toContain('exit_code=$?')
    expect(script).toContain('(exit $exit_code)')
    expect(script).not.toMatch(/^status=/m)
    expect(script).not.toContain('$status')
  })

  it('drops the presence cache so the next probe sees a fresh install', async () => {
    const invalidateHostToolCache = vi.fn()
    registerHostToolTerminalHandlers(makeDeps({ invalidateHostToolCache }))
    await handlerFor(HOST_TOOL_INSTALL_TERMINAL_CHANNEL)({}, 'gh')
    expect(invalidateHostToolCache).toHaveBeenCalled()
  })

  it('rejects ids outside the bounded host-tool set', async () => {
    registerHostToolTerminalHandlers(makeDeps())
    await expect(
      handlerFor(HOST_TOOL_INSTALL_TERMINAL_CHANNEL)({}, 'codex')
    ).resolves.toMatchObject({ ok: false })
    await expect(handlerFor(HOST_TOOL_STATUS_CHANNEL)({}, 'codex')).rejects.toThrow(
      /Unknown host tool/
    )
  })

  it('reports presence and the resolved path', async () => {
    registerHostToolTerminalHandlers(
      makeDeps({ resolveHostToolPath: () => '/opt/homebrew/bin/gh' })
    )
    await expect(handlerFor(HOST_TOOL_STATUS_CHANNEL)({}, 'gh')).resolves.toEqual({
      id: 'gh',
      available: true,
      path: '/opt/homebrew/bin/gh'
    })
    handlers.clear()
    registerHostToolTerminalHandlers(makeDeps())
    await expect(handlerFor(HOST_TOOL_STATUS_CHANNEL)({}, 'gh')).resolves.toEqual({
      id: 'gh',
      available: false
    })
  })

  it('surfaces an openPath failure instead of reporting success', async () => {
    registerHostToolTerminalHandlers(makeDeps({ openPath: async () => 'Terminal is unavailable' }))
    await expect(handlerFor(HOST_TOOL_INSTALL_TERMINAL_CHANNEL)({}, 'gh')).resolves.toMatchObject({
      ok: false,
      error: 'Terminal is unavailable'
    })
  })
})
