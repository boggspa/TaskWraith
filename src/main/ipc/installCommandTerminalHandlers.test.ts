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
  INSTALL_COMMAND_TERMINAL_CHANNEL,
  registerInstallCommandTerminalHandlers,
  type InstallCommandTerminalHandlersDeps
} from './installCommandTerminalHandlers'

function makeDeps(
  overrides: Partial<InstallCommandTerminalHandlersDeps> = {}
): InstallCommandTerminalHandlersDeps & { written: Map<string, string>; opened: string[] } {
  const written = new Map<string, string>()
  const opened: string[] = []
  const deps = {
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
  } as InstallCommandTerminalHandlersDeps
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

describe('installCommandTerminalHandlers', () => {
  it('writes a terminal script for a provider install and opens it', async () => {
    const deps = makeDeps()
    registerInstallCommandTerminalHandlers(deps)
    const result = (await handlerFor(INSTALL_COMMAND_TERMINAL_CHANNEL)(null, 'codex')) as {
      ok: boolean
      command?: string
    }

    expect(result.ok).toBe(true)
    expect(result.command).toBe('npm i -g @openai/codex')
    expect(deps.opened).toHaveLength(1)
    const script = deps.written.get(deps.opened[0])
    expect(script).toContain('npm i -g @openai/codex')
    expect(script).toContain('Installing Codex for TaskWraith')
    expect(script).toContain('.zshrc')
  })

  it('pulls an ollama model with a pull-flavoured script', async () => {
    const deps = makeDeps()
    registerInstallCommandTerminalHandlers(deps)
    const result = (await handlerFor(INSTALL_COMMAND_TERMINAL_CHANNEL)(
      null,
      'qwen3:4b-instruct'
    )) as { ok: boolean }

    expect(result.ok).toBe(true)
    const script = deps.written.get(deps.opened[0])
    expect(script).toContain('ollama run qwen3:4b-instruct')
    expect(script).toContain('Pulling Qwen 3 (4B Param) for TaskWraith')
    // Row ids contain characters that are not filename-safe (the model tag
    // colon); the script filename must be sanitized.
    expect(deps.opened[0]).not.toContain(':')
  })

  it('refuses unknown ids fail-closed without touching the filesystem', async () => {
    const deps = makeDeps()
    registerInstallCommandTerminalHandlers(deps)
    const result = (await handlerFor(INSTALL_COMMAND_TERMINAL_CHANNEL)(null, 'rm -rf /')) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown install command')
    expect(deps.written.size).toBe(0)
    expect(deps.opened).toHaveLength(0)
  })

  it('refuses a platform-bound installer on the wrong platform', async () => {
    const deps = makeDeps({ getPlatform: () => 'win32' as NodeJS.Platform })
    registerInstallCommandTerminalHandlers(deps)
    const result = (await handlerFor(INSTALL_COMMAND_TERMINAL_CHANNEL)(null, 'mistral')) as {
      ok: boolean
      error?: string
    }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not available for this platform')
    expect(deps.opened).toHaveLength(0)
  })

  it('writes a PowerShell pair on Windows for platform-open installers', async () => {
    const deps = makeDeps({ getPlatform: () => 'win32' as NodeJS.Platform })
    registerInstallCommandTerminalHandlers(deps)
    const result = (await handlerFor(INSTALL_COMMAND_TERMINAL_CHANNEL)(null, 'codex')) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
    expect(deps.opened[0].endsWith('.cmd')).toBe(true)
    const cmd = deps.written.get(deps.opened[0])
    expect(cmd).toContain('powershell.exe')
  })
})
