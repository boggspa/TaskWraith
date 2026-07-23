import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { ipcMain } from 'electron'
import type { ResolvedProviderBinary } from '../providers/CliProviderRuntime'
import { registerProviderTerminalHandlers } from './providerTerminalHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createResolved(binaryPath: string | null): ResolvedProviderBinary {
  return {
    provider: 'codex',
    binaryPath,
    source: binaryPath ? 'path' : 'missing'
  }
}

function createDeps() {
  const userDataPath = '/tmp/taskwraith'
  const deps = {
    resolveCliProviderBinary: vi.fn(async (provider: string) =>
      createResolved(`/usr/local/bin/${provider}`)
    ),
    getUserDataPath: vi.fn(() => userDataPath),
    openPath: vi.fn(async () => ''),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    getPlatform: vi.fn(() => 'darwin' as NodeJS.Platform)
  }
  return {
    deps,
    loginDir: join(userDataPath, 'login')
  }
}

describe('registerProviderTerminalHandlers', () => {
  it('registers provider terminal IPC channels', () => {
    registerProviderTerminalHandlers(createDeps().deps)

    expect(handlerFor('provider:open-login-terminal')).toBeTypeOf('function')
    expect(handlerFor('provider:open-logout-terminal')).toBeTypeOf('function')
    expect(handlerFor('provider:open-upgrade-terminal')).toBeTypeOf('function')
    expect(handlerFor('provider:open-kimi-upgrade-terminal')).toBeTypeOf('function')
  })

  it('returns the Gemini login/logout unsupported error exactly', async () => {
    const { deps } = createDeps()
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-login-terminal')({}, 'gemini')).resolves.toEqual({
      ok: false,
      error: 'Gemini terminal login is not supported here.'
    })
    await expect(handlerFor('provider:open-logout-terminal')({}, 'gemini')).resolves.toEqual({
      ok: false,
      error: 'Gemini terminal logout is not supported here.'
    })
  })

  it('returns the unknown provider terminal error exactly', async () => {
    const { deps } = createDeps()
    registerProviderTerminalHandlers(deps)

    await expect(
      handlerFor('provider:open-login-terminal')({}, 'invalid-provider')
    ).resolves.toEqual({
      ok: false,
      error: 'No terminal login for invalid-provider.'
    })
  })

  it('opens only the official user-installed agy CLI for AntiGravity sign-in', async () => {
    const { deps, loginDir } = createDeps()
    const commandFile = join(loginDir, 'antigravity-login.command')
    registerProviderTerminalHandlers(deps)

    await expect(
      handlerFor('provider:open-login-terminal')({}, 'antigravity')
    ).resolves.toEqual({
      ok: true,
      scope: 'user-owned-provider-setup',
      managedRunReady: false,
      notice: expect.stringMatching(/official user-installed agy CLI/i)
    })

    expect(deps.resolveCliProviderBinary).not.toHaveBeenCalled()
    expect(deps.writeFileSync).toHaveBeenCalledWith(
      commandFile,
      expect.stringContaining("'agy'"),
      { mode: 0o755 }
    )
    const script = String(deps.writeFileSync.mock.calls[0]?.[1] || '')
    expect(script).toContain('does not read, copy, or store Google or AntiGravity OAuth')
    expect(script).toContain('unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS')
    expect(script).not.toContain('--dangerously-skip-permissions')
    expect(deps.openPath).toHaveBeenCalledWith(commandFile)
  })

  it.each(['logout', 'upgrade'] as const)(
    'rejects unsupported AntiGravity %s without starting agy',
    async (action) => {
      const { deps } = createDeps()
      registerProviderTerminalHandlers(deps)

      await expect(handlerFor(`provider:open-${action}-terminal`)({}, 'antigravity')).resolves.toEqual({
        ok: false,
        error: `AntiGravity terminal ${action} is not supported here. No agy process was started.`
      })
      expect(deps.resolveCliProviderBinary).not.toHaveBeenCalled()
      expect(deps.writeFileSync).not.toHaveBeenCalled()
      expect(deps.openPath).not.toHaveBeenCalled()
    }
  )

  it('clears Google credential environment variables before agy on Windows', async () => {
    const { deps } = createDeps()
    deps.getPlatform.mockReturnValue('win32')
    registerProviderTerminalHandlers(deps)

    await expect(
      handlerFor('provider:open-login-terminal')({}, 'antigravity')
    ).resolves.toMatchObject({ ok: true, scope: 'user-owned-provider-setup' })

    const script = String(deps.writeFileSync.mock.calls[0]?.[1] || '')
    expect(script).toContain('Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue')
    expect(script).toContain('Remove-Item Env:GOOGLE_API_KEY -ErrorAction SilentlyContinue')
    expect(script).toContain(
      'Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue'
    )
  })

  it.each(['login', 'logout'] as const)(
    'opens a Cursor %s terminal via cursor-agent',
    async (action) => {
      const { deps } = createDeps()
      deps.resolveCliProviderBinary.mockResolvedValueOnce(
        createResolved('/usr/local/bin/cursor-agent')
      )
      registerProviderTerminalHandlers(deps)

      await expect(handlerFor(`provider:open-${action}-terminal`)({}, 'cursor')).resolves.toEqual({
        ok: true
      })
      expect(deps.resolveCliProviderBinary).toHaveBeenCalledWith('cursor')
      expect(deps.mkdirSync).toHaveBeenCalled()
      expect(deps.writeFileSync).toHaveBeenCalled()
      const script = String(deps.writeFileSync.mock.calls[0]?.[1] || '')
      expect(script).toContain('cursor-agent')
      expect(script).toContain(action)
      expect(deps.openPath).toHaveBeenCalled()
    }
  )

  it('opens a Cursor upgrade terminal via the official installer', async () => {
    const { deps } = createDeps()
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-upgrade-terminal')({}, 'cursor')).resolves.toEqual({
      ok: true
    })
    expect(deps.resolveCliProviderBinary).toHaveBeenCalledWith('cursor')
    const script = String(deps.writeFileSync.mock.calls[0]?.[1] || '')
    expect(script).toContain('curl https://cursor.com/install -fsS | bash')
  })

  it('preserves raw-command fallback branches', async () => {
    const { deps } = createDeps()
    deps.resolveCliProviderBinary.mockResolvedValueOnce(createResolved(null))
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-upgrade-terminal')({}, 'claude')).resolves.toEqual({
      ok: true
    })
    const script = deps.writeFileSync.mock.calls[0]?.[1]
    expect(script).toContain('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('quotes commandParts on non-windows and chmods/opens the .command file', async () => {
    const { deps, loginDir } = createDeps()
    const commandFile = join(loginDir, 'claude-login.command')
    deps.resolveCliProviderBinary.mockResolvedValueOnce(
      createResolved("/Applications/Claude App/claude'o")
    )
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-login-terminal')({}, 'claude')).resolves.toEqual({
      ok: true
    })
    const script = deps.writeFileSync.mock.calls[0]?.[1]
    expect(script).toContain("'/Applications/Claude App/claude'\\''o' 'auth' 'login'")
    expect(deps.mkdirSync).toHaveBeenCalledWith(loginDir, { recursive: true })
    expect(deps.writeFileSync).toHaveBeenCalledWith(commandFile, expect.any(String), {
      mode: 0o755
    })
    expect(deps.chmodSync).toHaveBeenCalledWith(commandFile, 0o755)
    expect(deps.writeFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      deps.chmodSync.mock.invocationCallOrder[0]
    )
    expect(deps.openPath).toHaveBeenCalledWith(commandFile)
  })

  it('generates Windows .ps1/.cmd launchers and opens the .cmd', async () => {
    const { deps, loginDir } = createDeps()
    const psFile = join(loginDir, 'codex-upgrade.ps1')
    const cmdFile = join(loginDir, 'codex-upgrade.cmd')
    deps.getPlatform.mockReturnValue('win32')
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-upgrade-terminal')({}, 'codex')).resolves.toEqual({
      ok: true
    })
    expect(deps.writeFileSync).toHaveBeenNthCalledWith(
      1,
      psFile,
      expect.stringContaining("'npm' 'install' '-g' '@openai/codex@latest'")
    )
    expect(deps.writeFileSync).toHaveBeenNthCalledWith(
      2,
      cmdFile,
      expect.stringContaining('powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0codex-upgrade.ps1"')
    )
    expect(deps.openPath).toHaveBeenCalledWith(cmdFile)
  })

  it('returns shell.openPath error strings and catch-to-string error shapes', async () => {
    const { deps } = createDeps()
    registerProviderTerminalHandlers(deps)

    deps.openPath.mockResolvedValueOnce('launch failed')
    await expect(handlerFor('provider:open-upgrade-terminal')({}, 'ollama')).resolves.toEqual({
      ok: false,
      error: 'launch failed'
    })

    deps.mkdirSync.mockImplementationOnce(() => {
      throw 'boom'
    })
    await expect(handlerFor('provider:open-upgrade-terminal')({}, 'ollama')).resolves.toEqual({
      ok: false,
      error: 'boom'
    })
  })

  it('opens Kimi upgrade terminal with the hardcoded kimi provider', async () => {
    const { deps } = createDeps()
    deps.resolveCliProviderBinary.mockResolvedValueOnce(createResolved(null))
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-kimi-upgrade-terminal')({})).resolves.toEqual({
      ok: true,
      scope: 'user-owned-provider-setup',
      managedRunReady: false,
      notice: expect.stringMatching(/outside TaskWraith managed-run containment/i)
    })
    expect(deps.resolveCliProviderBinary).toHaveBeenCalledWith('kimi')
    expect(deps.writeFileSync.mock.calls[0]?.[1]).toContain(
      'Success does not qualify this runtime for managed Kimi turns or compaction.'
    )
  })

  it('rejects Kimi logout without resolving or launching a bare Kimi session', async () => {
    const { deps } = createDeps()
    registerProviderTerminalHandlers(deps)

    await expect(handlerFor('provider:open-logout-terminal')({}, 'kimi')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/bounded logout command.*No Kimi process was started/i),
      scope: 'user-owned-provider-setup',
      managedRunReady: false,
      notice: expect.stringMatching(/outside TaskWraith managed-run containment/i)
    })
    expect(deps.resolveCliProviderBinary).not.toHaveBeenCalled()
    expect(deps.mkdirSync).not.toHaveBeenCalled()
    expect(deps.writeFileSync).not.toHaveBeenCalled()
    expect(deps.openPath).not.toHaveBeenCalled()
  })
})
