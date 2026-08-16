import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { HostProjectionIncompatibleProtocolError } from '../main/host/HostProjectionClient'
import {
  ensureTuiHostAvailable,
  resolveTuiHostLaunchCommand,
  type TuiHostLaunchCommand
} from './hostProcessManager'

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
    executable: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    args: ['--taskwraith-headless-host', '--taskwraith-headless-parent=7'],
    cwd: '/Applications/TaskWraith.app/Contents/MacOS',
    env: {}
  }
}

describe('TUI Host process manager', () => {
  it('resolves the packaged application executable without Electron-as-Node', async () => {
    const executable = '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'production',
      parentPid: 77,
      platform: 'darwin',
      moduleDir: '/Applications/TaskWraith.app/Contents/Resources/tui/tui',
      homeDirectory: '/Users/example',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      pathExists: async (path) => path === executable
    })

    expect(result).toEqual({
      executable,
      args: ['--taskwraith-headless-host', '--taskwraith-headless-parent=77'],
      cwd: '/Applications/TaskWraith.app/Contents/MacOS',
      env: {}
    })
  })

  it('resolves a built development Host with the exact repo and instance environment', async () => {
    const repoRoot = '/repo'
    const executable = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    const required = new Set([executable, '/repo/package.json', '/repo/out/main/index.js'])
    const result = await resolveTuiHostLaunchCommand({
      profile: 'development',
      parentPid: 88,
      platform: 'darwin',
      moduleDir: '/repo/out/tui/tui',
      workingDirectory: '/elsewhere',
      env: { TASKWRAITH_INSTANCE_ID: 'qa-two' },
      pathExists: async (path) => required.has(path)
    })

    expect(result).toMatchObject({
      executable,
      cwd: repoRoot,
      args: [repoRoot, '--taskwraith-headless-host', '--taskwraith-headless-parent=88'],
      env: { TASKWRAITH_INSTANCE_ID: 'qa-two' }
    })
  })

  it('uses Windows path semantics when resolving a packaged executable', async () => {
    const executable = 'C:\\Apps\\TaskWraith\\TaskWraith.exe'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'production',
      parentPid: 99,
      platform: 'win32',
      moduleDir: 'C:\\Apps\\TaskWraith\\resources\\tui\\tui',
      env: {},
      pathExists: async (path) => path === executable
    })

    expect(result).toMatchObject({
      executable,
      cwd: 'C:\\Apps\\TaskWraith',
      args: ['--taskwraith-headless-host', '--taskwraith-headless-parent=99']
    })
  })

  it('uses the real packaged launch resolver for an isolated package smoke profile', async () => {
    const executable = '/tmp/TaskWraith-smoke.app/Contents/MacOS/TaskWraith'
    const userDataPath = join(tmpdir(), 'taskwraith-tui-package-smoke-resolver')
    const result = await resolveTuiHostLaunchCommand({
      profile: 'package-smoke',
      userDataPath,
      parentPid: 101,
      platform: 'darwin',
      moduleDir: '/tmp/TaskWraith-smoke.app/Contents/Resources/tui/tui',
      env: { TASKWRAITH_TUI_APP_EXECUTABLE: executable },
      pathExists: async (path) => path === executable
    })

    expect(result).toMatchObject({
      executable,
      args: [
        '--taskwraith-package-smoke',
        `--taskwraith-package-smoke-user-data=${userDataPath}`,
        '--taskwraith-headless-host',
        '--taskwraith-headless-parent=101',
        '--use-mock-keychain'
      ]
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
