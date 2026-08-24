import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { HostProjectionIncompatibleProtocolError } from '../main/host/HostProjectionClient'
import {
  assertTuiStandaloneHostWelcome,
  ensureTuiHostAvailable,
  resolveTuiHostLaunchCommand,
  TuiHostProductionCapabilityError,
  TUI_STANDALONE_HOST_CAPABILITY_FLOOR,
  TUI_STANDALONE_HOST_PRODUCTION_VERSION,
  type TuiHostLaunchCommand
} from './hostProcessManager'
import type { HostBootstrapWelcome } from '../shared/hostProtocol'

class FakeChild extends EventEmitter {
  pid = 42
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  unref = vi.fn()

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

function command(): TuiHostLaunchCommand {
  return {
    executable: '/resources/tui-runtime/darwin-arm64/node',
    args: [
      '/resources/host/host-runtime/cli.js',
      'serve',
      '--mode',
      'production',
      '--profile',
      '/profiles/a'
    ],
    cwd: '/resources/host/host-runtime',
    env: {}
  }
}

describe('TUI Host process manager', () => {
  it('accepts only the standalone production version with the complete capability floor', () => {
    const welcome = (overrides: Partial<HostBootstrapWelcome> = {}) =>
      ({
        hostVersion: TUI_STANDALONE_HOST_PRODUCTION_VERSION,
        capabilities: [...TUI_STANDALONE_HOST_CAPABILITY_FLOOR],
        ...overrides
      }) as HostBootstrapWelcome

    expect(() => assertTuiStandaloneHostWelcome(welcome({ hostVersion: '1.9.6' }))).toThrow(
      TuiHostProductionCapabilityError
    )
    expect(() =>
      assertTuiStandaloneHostWelcome(welcome({ capabilities: ['commands', 'receipts'] }))
    ).toThrow(TuiHostProductionCapabilityError)
    expect(() => assertTuiStandaloneHostWelcome(welcome())).not.toThrow()
  })

  it('resolves the packaged platform Node runtime and Host CLI without Electron', async () => {
    const executable =
      '/Applications/TaskWraith.app/Contents/Resources/tui-runtime/darwin-arm64/node'
    const cli = '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'production',
      platform: 'darwin',
      architecture: 'arm64',
      moduleDir: '/Applications/TaskWraith.app/Contents/Resources/tui/tui',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      userDataPath: '/profiles/a',
      pathExists: async (path) => path === executable || path === cli
    })

    expect(result).toEqual({
      executable,
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/a'],
      cwd: '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime',
      env: {}
    })
  })

  it('resolves a built development Host through an injected ordinary Node executable', async () => {
    const repoRoot = '/repo'
    const executable = '/usr/local/bin/node'
    const cli = '/repo/out/host/host-runtime/cli.js'
    const required = new Set([executable, cli])
    const result = await resolveTuiHostLaunchCommand({
      profile: 'development',
      platform: 'darwin',
      moduleDir: '/repo/out/tui/tui',
      workingDirectory: '/elsewhere',
      userDataPath: '/profiles/dev',
      nodeExecutable: executable,
      env: { TASKWRAITH_INSTANCE_ID: 'qa-two' },
      pathExists: async (path) => required.has(path)
    })

    expect(result).toMatchObject({
      executable,
      cwd: '/repo/out/host/host-runtime',
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/dev'],
      env: { TASKWRAITH_INSTANCE_ID: 'qa-two' }
    })
  })

  it('uses Windows path semantics for packaged Node and Host CLI', async () => {
    const executable = 'C:\\Apps\\TaskWraith\\resources\\tui-runtime\\win32-x64\\node.exe'
    const cli = 'C:\\Apps\\TaskWraith\\resources\\host\\host-runtime\\cli.js'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'production',
      platform: 'win32',
      architecture: 'x64',
      moduleDir: 'C:\\Apps\\TaskWraith\\resources\\tui\\tui',
      env: {},
      userDataPath: 'C:\\profiles\\a',
      pathExists: async (path) => path === executable || path === cli
    })

    expect(result).toMatchObject({
      executable,
      cwd: 'C:\\Apps\\TaskWraith\\resources\\host\\host-runtime',
      args: [cli, 'serve', '--mode', 'production', '--profile', 'C:\\profiles\\a']
    })
  })

  it('rejects whitespace-padded profile paths instead of silently normalizing them', async () => {
    await expect(
      resolveTuiHostLaunchCommand({
        profile: 'production',
        platform: 'darwin',
        architecture: 'arm64',
        moduleDir: '/app/resources/tui/tui',
        userDataPath: ' /profiles/unsafe ',
        pathExists: async () => true
      })
    ).rejects.toThrow('absolute profile path')
  })

  it('uses the same direct Node Host invocation for an isolated package-smoke profile', async () => {
    const executable = '/tmp/TaskWraith-smoke.app/Contents/Resources/tui-runtime/darwin-arm64/node'
    const cli = '/tmp/TaskWraith-smoke.app/Contents/Resources/host/host-runtime/cli.js'
    const userDataPath = join(tmpdir(), 'taskwraith-tui-package-smoke-resolver')
    const result = await resolveTuiHostLaunchCommand({
      profile: 'package-smoke',
      userDataPath,
      platform: 'darwin',
      architecture: 'arm64',
      moduleDir: '/tmp/TaskWraith-smoke.app/Contents/Resources/tui/tui',
      env: {},
      pathExists: async (path) => path === executable || path === cli
    })

    expect(result).toMatchObject({
      executable,
      args: [cli, 'serve', '--mode', 'production', '--profile', userDataPath]
    })
  })

  it('reuses an authenticated Host without spawning', async () => {
    const spawn = vi.fn()
    const resolveLaunchCommand = vi.fn()
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/existing',
        profile: 'production',
        probe: vi.fn().mockResolvedValue(undefined),
        spawn,
        resolveLaunchCommand
      })
    ).resolves.toEqual({ kind: 'existing' })
    expect(resolveLaunchCommand).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('serializes launch races and waits for an authenticated handshake', async () => {
    const child = new FakeChild()
    const spawn = vi.fn().mockReturnValue(child.asChildProcess())
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    let releaseDelay: (() => void) | undefined
    const delay = vi.fn(
      () =>
        new Promise<void>((resolveDelay) => {
          releaseDelay = resolveDelay
        })
    )
    const input = {
      userDataPath: '/profiles/race',
      profile: 'production' as const,
      probe,
      spawn,
      resolveLaunchCommand: async () => command(),
      delay
    }

    const first = ensureTuiHostAvailable(input)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    const second = ensureTuiHostAvailable(input)
    releaseDelay?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'launched', pid: 42 },
      { kind: 'launched', pid: 42 }
    ])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][2]).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('never launches a competing Host for an incompatible or custom profile', async () => {
    const spawn = vi.fn()
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/incompatible',
        profile: 'production',
        probe: vi.fn().mockRejectedValue(new HostProjectionIncompatibleProtocolError()),
        spawn,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toBeInstanceOf(HostProjectionIncompatibleProtocolError)
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/custom',
        profile: 'custom',
        probe: vi.fn().mockRejectedValue(new Error('offline')),
        spawn,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toThrow(/explicit user-data profile/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('never launches beside an App-mode Host even when its capability set is complete', async () => {
    const spawn = vi.fn()
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/app-mode-host',
        profile: 'production',
        probe: vi.fn().mockRejectedValue(new TuiHostProductionCapabilityError()),
        spawn,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toBeInstanceOf(TuiHostProductionCapabilityError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a non-zero owned child exit without touching discovery PIDs', async () => {
    const child = new FakeChild()
    let clock = 0
    const delay = vi.fn(async (milliseconds: number) => {
      clock += milliseconds
      if (clock >= 500 && child.exitCode === null) {
        child.exitCode = 2
        child.emit('exit', 2, null)
      }
    })
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/failed-child',
        profile: 'production',
        timeoutMs: 2_000,
        pollMs: 500,
        now: () => clock,
        delay,
        probe: vi.fn().mockRejectedValue(new Error('offline')),
        spawn: vi.fn().mockReturnValue(child.asChildProcess()),
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toThrow(/exit code 2/)
  })
})
