import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { KillResult } from '../localServers/killer'
import type { LaunchTarget } from '../launchTargets/types'
import { LaunchAttemptStore } from './LaunchAttemptStore'
import { LaunchManager } from './LaunchManager'

class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this
  }
}

class FakeChild extends EventEmitter {
  pid = 4321
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = new FakeReadable()
  stderr = new FakeReadable()
}

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-manager-'))
  return path.join(dir, 'launch-attempts.json')
}

function target(workspacePath: string, overrides: Partial<LaunchTarget> = {}): LaunchTarget {
  return {
    id: 'launch-target-1',
    label: 'npm run dev',
    subtitle: 'package.json script',
    workspacePath,
    source: 'package-script',
    kind: 'dev-server',
    platform: 'web',
    confidence: 0.9,
    command: {
      raw: 'npm run dev',
      argv: ['npm', 'run', 'dev'],
      cwd: workspacePath,
      longRunning: true
    },
    evidence: [{ path: path.join(workspacePath, 'package.json') }],
    blockers: [],
    ...overrides
  }
}

function managerFixture(
  storagePath: string,
  workspacePath: string,
  options: {
    resolveProcessStartedAt?: (pid: number) => Promise<string | null>
  } = {}
) {
  const child = new FakeChild()
  const approvals: unknown[] = []
  const tracked: unknown[] = []
  const untracked: number[] = []
  const lifecycleEvents: unknown[] = []
  const gatedStarts: number[] = []
  const spawnProcess = vi.fn(
    (_command: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
  )
  const spawnGatedProcess = vi.fn(
    (
      _command: string,
      _args: string[],
      _options: SpawnOptions,
      _workspaceLockOwnerId: string
    ) => ({
      child: child as unknown as ChildProcess,
      start: () => gatedStarts.push(child.pid)
    })
  )
  const requestApproval = vi.fn(async (_sender, _provider, _service, _workspace, request) => {
    approvals.push(request)
    return true
  })
  const killProcess = vi.fn(async (): Promise<KillResult> => ({ ok: true, escalated: false }))
  const manager = new LaunchManager({
    store: new LaunchAttemptStore(storagePath),
    platform: 'darwin',
    now: () => new Date('2026-06-21T12:00:00.000Z'),
    spawnProcess,
    spawnGatedProcess,
    requestApproval,
    createEnv: (extra) => ({ PATH: '/usr/bin', ...extra }),
    resolveProcessStartedAt: options.resolveProcessStartedAt,
    trackSpawn: (spawn) => tracked.push(spawn),
    untrackSpawn: (pid) => untracked.push(pid),
    killProcess,
    recordLifecycleEvent: (event) => lifecycleEvents.push(event)
  })
  return {
    manager,
    child,
    approvals,
    tracked,
    untracked,
    lifecycleEvents,
    gatedStarts,
    spawnProcess,
    spawnGatedProcess,
    requestApproval,
    killProcess,
    workspacePath
  }
}

describe('LaunchManager — self-launch refusal', () => {
  /**
   * A primary-profile child would hit TaskWraith's single-instance lock and
   * quit in milliseconds, which looks like a transient crash to a QA agent.
   * Only the exact executable receives a fresh isolated-profile selector after
   * approval; wrappers remain refused, and unrelated projects stay unblocked.
   */
  const OWN_ROOT = '/Applications/TaskWraith.app/Contents/Resources/app.asar'
  const OWN_EXE = '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'

  interface SelfAwareFixtureOptions {
    createIsolatedInstanceId?: () => string
    appRootPath?: string
    appExecutablePath?: string
    platform?: NodeJS.Platform
    createEnv?: (extra: Record<string, string>) => Record<string, string>
  }

  function selfAwareFixture(
    storagePath: string,
    workspacePath: string,
    options: SelfAwareFixtureOptions = {}
  ) {
    const base = managerFixture(storagePath, workspacePath)
    return {
      ...base,
      manager: new LaunchManager({
        store: new LaunchAttemptStore(storagePath),
        platform: options.platform || 'darwin',
        now: () => new Date('2026-06-21T12:00:00.000Z'),
        spawnProcess: base.spawnProcess,
        requestApproval: base.requestApproval,
        createEnv: options.createEnv || ((extra) => ({ PATH: '/usr/bin', ...extra })),
        appRootPath: () => options.appRootPath || OWN_ROOT,
        appExecutablePath: () => options.appExecutablePath || OWN_EXE,
        isPackagedApp: () => true,
        createIsolatedInstanceId: options.createIsolatedInstanceId,
        killProcess: base.killProcess
      })
    }
  }

  it('launches an exact own executable only after approval, with a fresh isolated profile', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-'))
    const storagePath = await tempFile()
    const isolatedInstanceId = 'a'.repeat(32)
    const mintIsolatedInstanceId = vi.fn(() => isolatedInstanceId)
    const fixture = selfAwareFixture(storagePath, workspacePath, {
      createIsolatedInstanceId: mintIsolatedInstanceId
    })
    const callerSuppliedId = 'caller-supplied-id'

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        label: 'TaskWraith',
        command: {
          raw: `${OWN_EXE} --qa --taskwraith-isolated-instance=${callerSuppliedId}`,
          argv: [
            OWN_EXE,
            '--qa',
            `--taskwraith-isolated-instance=${callerSuppliedId}`,
            '--taskwraith-isolated-instance',
            'second-caller-supplied-id',
            '--taskwraith-package-smoke',
            '--taskwraith-package-smoke-user-data=/tmp/taskwraith-tui-package-smoke-caller',
            '--taskwraith-package-smoke-user-data',
            '/tmp/taskwraith-tui-package-smoke-second-caller',
            '--taskwraith-gemini-mcp-bridge',
            '--taskwraith-mcp-route-from-env'
          ],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result.ok).toBe(true)
    expect(mintIsolatedInstanceId).toHaveBeenCalledTimes(1)
    expect(fixture.requestApproval).toHaveBeenCalledWith(
      null,
      'codex',
      'shellCommands',
      workspacePath,
      expect.objectContaining({
        forcePrompt: true,
        body: expect.stringMatching(
          /new isolated TaskWraith profile with no existing chats or pairings/i
        ),
        preview: expect.objectContaining({
          isolatedProfile: {
            created: true,
            disclosure: 'New isolated profile; no existing chats or pairings.'
          }
        })
      })
    )
    expect(fixture.spawnProcess).toHaveBeenCalledWith(
      OWN_EXE,
      ['--qa', `--taskwraith-isolated-instance=${isolatedInstanceId}`],
      expect.objectContaining({ shell: false })
    )
    const persisted = new LaunchAttemptStore(storagePath).list()[0]
    expect(persisted).toMatchObject({
      isolatedInstanceId,
      commandRaw: `${OWN_EXE} --qa`,
      argv: [OWN_EXE, '--qa'],
      targetSnapshot: expect.objectContaining({
        command: expect.objectContaining({ argv: [OWN_EXE, '--qa'] })
      })
    })
    expect(JSON.stringify(persisted)).not.toContain(callerSuppliedId)
    expect(JSON.stringify(persisted)).not.toContain('second-caller-supplied-id')
    expect(JSON.stringify(persisted)).not.toContain('taskwraith-tui-package-smoke')
    expect(JSON.stringify(persisted)).not.toContain('taskwraith-gemini-mcp-bridge')
    expect(JSON.stringify(persisted)).not.toContain('taskwraith-mcp-route-from-env')
  })

  // Host-gated, not platform-gated: selfAwareFixture pins the manager to
  // `darwin`, so canonicalLaunchPath uses path.posix (LaunchManager.ts:824,845)
  // while these fixtures are REAL files from os.tmpdir(). On a Windows runner
  // that returns `C:\Users\RUNNER~1\...`, which posix does not consider
  // absolute — so it anchors the token at the repo cwd and the manager compares
  // `/a/TaskWraith/TaskWraith/C:\Users\...` against a realpath. There is no
  // way to have both a real temp directory and POSIX path semantics on Windows.
  // Nothing is lost: the darwin behaviour is asserted on macOS and Linux, and
  // Windows executable identity has its own win32-pinned case below, which uses
  // synthetic `C:\Program Files\...` paths precisely to avoid this collision.
  it.skipIf(process.platform === 'win32')(
    'recognizes canonical, relative, and symlink aliases of the packaged executable',
    async () => {
      const workspacePath = await fs.mkdtemp(
        path.join(os.tmpdir(), 'taskwraith-launch-self-alias-')
      )
      const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-package-'))
      const ownExecutable = path.join(
        packageRoot,
        'TaskWraith.app',
        'Contents',
        'MacOS',
        'TaskWraith'
      )
      const ownRoot = path.join(packageRoot, 'TaskWraith.app', 'Contents', 'Resources', 'app.asar')
      await fs.mkdir(path.dirname(ownExecutable), { recursive: true })
      await fs.writeFile(ownExecutable, '#!/bin/sh\n')
      const symlinkAlias = path.join(workspacePath, 'TaskWraith-symlink')
      await fs.symlink(ownExecutable, symlinkAlias)
      const canonicalExecutable = await fs.realpath(ownExecutable)
      const aliases = [
        { label: 'canonical', argv0: ownExecutable },
        { label: 'relative', argv0: path.relative(workspacePath, ownExecutable) },
        { label: 'symlink', argv0: symlinkAlias }
      ]

      for (const [index, alias] of aliases.entries()) {
        const storagePath = await tempFile()
        const isolatedInstanceId = String(index + 1).repeat(32)
        const mint = vi.fn(() => isolatedInstanceId)
        const fixture = selfAwareFixture(storagePath, workspacePath, {
          appRootPath: ownRoot,
          appExecutablePath: ownExecutable,
          createIsolatedInstanceId: mint
        })

        const result = await fixture.manager.startTarget({
          sender: null,
          provider: 'codex',
          target: target(workspacePath, {
            label: 'TaskWraith ' + alias.label,
            command: {
              raw: alias.argv0 + ' --qa',
              argv: [alias.argv0, '--qa'],
              cwd: workspacePath,
              longRunning: true
            }
          })
        })

        expect(result.ok).toBe(true)
        expect(mint).toHaveBeenCalledTimes(1)
        expect(fixture.spawnProcess).toHaveBeenCalledWith(
          canonicalExecutable,
          ['--qa', '--taskwraith-isolated-instance=' + isolatedInstanceId],
          expect.objectContaining({ shell: false })
        )
      }
    }
  )

  // Host-gated, not platform-gated: selfAwareFixture pins the manager to
  // `darwin`, so canonicalLaunchPath uses path.posix (LaunchManager.ts:824,845)
  // while these fixtures are REAL files from os.tmpdir(). On a Windows runner
  // that returns `C:\Users\RUNNER~1\...`, which posix does not consider
  // absolute — so it anchors the token at the repo cwd and the manager compares
  // `/a/TaskWraith/TaskWraith/C:\Users\...` against a realpath. There is no
  // way to have both a real temp directory and POSIX path semantics on Windows.
  // Nothing is lost: the darwin behaviour is asserted on macOS and Linux, and
  // Windows executable identity has its own win32-pinned case below, which uses
  // synthetic `C:\Program Files\...` paths precisely to avoid this collision.
  it.skipIf(process.platform === 'win32')(
    'uses the filesystem case identity instead of unconditional case folding',
    async () => {
      const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-case-'))
      const packageRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'taskwraith-launch-case-package-')
      )
      const ownExecutable = path.join(
        packageRoot,
        'TaskWraith.app',
        'Contents',
        'MacOS',
        'TaskWraith'
      )
      await fs.mkdir(path.dirname(ownExecutable), { recursive: true })
      await fs.writeFile(ownExecutable, '#!/bin/sh\n')
      const caseAlias = path.join(path.dirname(ownExecutable), 'taskwraith')
      let aliasesTheSameFile = false
      try {
        aliasesTheSameFile = (await fs.realpath(caseAlias)) === (await fs.realpath(ownExecutable))
      } catch {
        // A case-sensitive volume must not accidentally classify a nonexistent
        // case variant as this app merely because the product is usually on macOS.
      }
      const isolatedInstanceId = 'c'.repeat(32)
      const mint = vi.fn(() => isolatedInstanceId)
      const fixture = selfAwareFixture(await tempFile(), workspacePath, {
        appExecutablePath: ownExecutable,
        createIsolatedInstanceId: mint
      })

      const result = await fixture.manager.startTarget({
        sender: null,
        provider: 'codex',
        target: target(workspacePath, {
          command: {
            raw: caseAlias + ' --qa',
            argv: [caseAlias, '--qa'],
            cwd: workspacePath,
            longRunning: true
          }
        })
      })

      expect(result.ok).toBe(true)
      if (aliasesTheSameFile) {
        expect(mint).toHaveBeenCalledTimes(1)
        expect(fixture.spawnProcess).toHaveBeenCalledWith(
          await fs.realpath(ownExecutable),
          ['--qa', '--taskwraith-isolated-instance=' + isolatedInstanceId],
          expect.anything()
        )
      } else {
        expect(mint).not.toHaveBeenCalled()
        expect(fixture.spawnProcess).toHaveBeenCalledWith(caseAlias, ['--qa'], expect.anything())
      }
    }
  )

  it('uses case-insensitive executable identity on Windows', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-win32-'))
    const ownExecutable = 'C:\\Program Files\\TaskWraith\\TaskWraith.exe'
    const lowerCaseAlias = 'c:\\program files\\taskwraith\\taskwraith.exe'
    const isolatedInstanceId = 'f'.repeat(32)
    const fixture = selfAwareFixture(await tempFile(), workspacePath, {
      appRootPath: 'C:\\Program Files\\TaskWraith\\resources\\app.asar',
      appExecutablePath: ownExecutable,
      platform: 'win32',
      createIsolatedInstanceId: () => isolatedInstanceId
    })

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: lowerCaseAlias + ' --qa',
          argv: [lowerCaseAlias, '--qa'],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result.ok).toBe(true)
    expect(fixture.spawnProcess).toHaveBeenCalledWith(
      lowerCaseAlias,
      ['--qa', '--taskwraith-isolated-instance=' + isolatedInstanceId],
      expect.objectContaining({ shell: false, detached: false })
    )
  })

  it('does not infer self-launch from raw literals or path-prefix lookalikes', async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'taskwraith-launch-self-literal-')
    )
    const cases = [
      {
        label: 'argv literal',
        source: 'package-script' as const,
        command: {
          raw: 'echo ' + OWN_EXE,
          argv: ['echo', OWN_EXE],
          cwd: workspacePath,
          longRunning: false
        },
        expectedSpawn: ['echo', [OWN_EXE]] as const
      },
      {
        label: 'shell literal',
        source: 'vscode-task' as const,
        command: {
          raw: 'echo ' + OWN_EXE,
          cwd: workspacePath,
          longRunning: false,
          shell: true
        },
        expectedSpawn: ['echo ' + OWN_EXE, []] as const
      },
      {
        label: 'prefix lookalike',
        source: 'package-script' as const,
        command: {
          raw: OWN_EXE + '-helper --qa',
          argv: [OWN_EXE + '-helper', '--qa'],
          cwd: workspacePath,
          longRunning: true
        },
        expectedSpawn: [OWN_EXE + '-helper', ['--qa']] as const
      }
    ]

    for (const item of cases) {
      const mint = vi.fn(() => 'd'.repeat(32))
      const fixture = selfAwareFixture(await tempFile(), workspacePath, {
        createIsolatedInstanceId: mint
      })
      const result = await fixture.manager.startTarget({
        sender: null,
        provider: 'codex',
        target: target(workspacePath, {
          label: item.label,
          source: item.source,
          command: item.command
        })
      })

      expect(result.ok).toBe(true)
      expect(mint).not.toHaveBeenCalled()
      expect(fixture.spawnProcess).toHaveBeenCalledWith(
        item.expectedSpawn[0],
        item.expectedSpawn[1],
        expect.anything()
      )
      const approval = fixture.approvals[0] as { preview: Record<string, unknown> }
      expect(approval.preview.isolatedProfile).toBeUndefined()
    }
  })

  it('hard-refuses a literal shell wrapper around this app instead of losing isolation', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-shell-self-'))
    const fixture = selfAwareFixture(await tempFile(), workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        source: 'vscode-task',
        command: {
          raw: "sh -c '" + OWN_EXE + " --qa'",
          cwd: workspacePath,
          longRunning: true,
          shell: true
        }
      })
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/hard-refused/i) })
    expect(fixture.requestApproval).not.toHaveBeenCalled()
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
  })

  it('strips target and inherited private helper or route environment before a self-launch', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-env-'))
    const storagePath = await tempFile()
    const isolatedInstanceId = 'e'.repeat(32)
    const fixture = selfAwareFixture(storagePath, workspacePath, {
      createIsolatedInstanceId: () => isolatedInstanceId,
      createEnv: (extra) => ({
        PATH: '/usr/bin',
        TASKWRAITH_GEMINI_MCP_BRIDGE: 'inherited-helper',
        TASKWRAITH_MCP_SOCKET_PATH: '/tmp/inherited.sock',
        TASKWRAITH_MCP_BROKER_TOKEN: 'inherited-token',
        taskwraith_mcp_instance_epoch: 'inherited-epoch',
        TASKWRAITH_CUSTOM_INHERITED_SETTING: 'inherited-keep',
        ...extra
      })
    })

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        label: 'TaskWraith',
        command: {
          raw: OWN_EXE + ' --qa',
          argv: [OWN_EXE, '--qa'],
          cwd: workspacePath,
          longRunning: true,
          env: {
            TASKWRAITH_GEMINI_MCP_BRIDGE: 'target-helper',
            TASKWRAITH_MCP_SOCKET_PATH: '/tmp/target.sock',
            TASKWRAITH_MCP_BROKER_TOKEN: 'target-token',
            TASKWRAITH_MCP_INSTANCE_EPOCH: 'target-epoch',
            TASKWRAITH_MCP_BRIDGE_LOG_EPOCH: '19',
            TASKWRAITH_MCP_ISOLATED_INSTANCE_ID: 'target-isolated-profile',
            TASKWRAITH_PARENT_PROVIDER: 'cursor',
            TASKWRAITH_RUN_ID: 'target-run',
            TASKWRAITH_CHAT_ID: 'target-chat',
            TASKWRAITH_WORKSPACE_PATH: '/private/target-route-workspace',
            TASKWRAITH_MCP_SAFE_SUBSET: '1',
            TASKWRAITH_INSTANCE_ID: 'ambient-dev-profile',
            TASKWRAITH_RUNTIME_PROFILE_ID: 'target-runtime-profile',
            TASKWRAITH_CUSTOM_TARGET_SETTING: 'target-keep',
            VITE_PORT: '5173'
          }
        }
      })
    })

    expect(result.ok).toBe(true)
    const approval = fixture.approvals[0] as {
      preview: { envDeltas?: Record<string, string> }
    }
    expect(approval.preview.envDeltas).toEqual({
      TASKWRAITH_CUSTOM_TARGET_SETTING: 'target-keep',
      VITE_PORT: '5173'
    })
    const spawnedEnv = fixture.spawnProcess.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnedEnv.TASKWRAITH_CUSTOM_INHERITED_SETTING).toBe('inherited-keep')
    expect(spawnedEnv.TASKWRAITH_CUSTOM_TARGET_SETTING).toBe('target-keep')
    expect(spawnedEnv.TASKWRAITH_GEMINI_MCP_BRIDGE).toBeUndefined()
    expect(spawnedEnv.TASKWRAITH_MCP_SOCKET_PATH).toBeUndefined()
    expect(spawnedEnv.TASKWRAITH_PARENT_PROVIDER).toBeUndefined()
    expect(spawnedEnv.TASKWRAITH_RUNTIME_PROFILE_ID).toBeUndefined()
    expect(spawnedEnv.VITE_PORT).toBe('5173')
    expect(fixture.spawnProcess).toHaveBeenCalledWith(
      OWN_EXE,
      ['--qa', '--taskwraith-isolated-instance=' + isolatedInstanceId],
      expect.anything()
    )
    const persisted = new LaunchAttemptStore(storagePath).list()[0]
    expect(JSON.stringify(persisted)).not.toContain('target-helper')
    expect(JSON.stringify(persisted)).not.toContain('/tmp/target.sock')
    expect(JSON.stringify(persisted)).not.toContain('target-isolated-profile')
    expect(JSON.stringify(persisted)).not.toContain('/private/target-route-workspace')
  })

  it('keeps an unpackaged exact executable on the hard-refusal path', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-dev-'))
    const storagePath = await tempFile()
    const fixture = selfAwareFixture(storagePath, workspacePath)
    const devManager = new LaunchManager({
      store: new LaunchAttemptStore(storagePath),
      platform: 'darwin',
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      spawnProcess: fixture.spawnProcess,
      requestApproval: fixture.requestApproval,
      createEnv: (extra) => ({ PATH: '/usr/bin', ...extra }),
      appRootPath: () => OWN_ROOT,
      appExecutablePath: () => OWN_EXE,
      isPackagedApp: () => false,
      createIsolatedInstanceId: () => 'b'.repeat(32),
      killProcess: fixture.killProcess
    })

    const result = await devManager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: OWN_EXE,
          argv: [OWN_EXE],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/hard-refused/i) })
    expect(fixture.requestApproval).not.toHaveBeenCalled()
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
  })

  it('never mints or spawns an isolated self-launch when human approval is denied', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-denied-'))
    const storagePath = await tempFile()
    const mintIsolatedInstanceId = vi.fn(() => 'b'.repeat(32))
    const fixture = selfAwareFixture(storagePath, workspacePath, {
      createIsolatedInstanceId: mintIsolatedInstanceId
    })
    fixture.requestApproval.mockResolvedValueOnce(false)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        label: 'TaskWraith',
        command: {
          raw: `${OWN_EXE} --qa`,
          argv: [OWN_EXE, '--qa'],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'Launch denied by TaskWraith approval policy.'
    })
    expect(mintIsolatedInstanceId).not.toHaveBeenCalled()
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
  })

  it('also catches an electron-style launch of our own app root', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self2-'))
    const storagePath = await tempFile()
    const fixture = selfAwareFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: `npx electron ${OWN_ROOT}`,
          argv: ['npx', 'electron', OWN_ROOT],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/do not retry/i)
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
    expect(fixture.requestApproval).not.toHaveBeenCalled()
  })

  it('hard-refuses an open wrapper around this app bundle', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-open-'))
    const storagePath = await tempFile()
    const fixture = selfAwareFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: 'open -n /Applications/TaskWraith.app',
          argv: ['open', '-n', '/Applications/TaskWraith.app'],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/hard-refused/i)
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
    expect(fixture.requestApproval).not.toHaveBeenCalled()
  })

  it('does NOT block an unrelated project that merely mentions taskwraith', async () => {
    // The guard matches this install's real paths, not the product name, so a
    // rename cannot silently disable it and a lookalike path is not blocked.
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-other-'))
    const storagePath = await tempFile()
    const fixture = selfAwareFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: 'npm run dev --prefix ~/code/taskwraith-docs',
          argv: ['npm', 'run', 'dev', '--prefix', '~/code/taskwraith-docs'],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result.ok).toBe(true)
    expect(fixture.spawnProcess).toHaveBeenCalled()
  })

  it('is inert when the app paths are not injected', async () => {
    // Keeps the guard out of the way in any embedding that does not supply them.
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-inert-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: `${OWN_EXE} --qa`,
          argv: [OWN_EXE, '--qa'],
          cwd: workspacePath,
          longRunning: true
        }
      })
    })

    expect(result.ok).toBe(true)
  })
})

describe('LaunchManager', () => {
  it('starts approved argv targets with one-shot approval and durable state', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        git: {
          isRepo: true,
          repoRoot: workspacePath,
          branch: 'feature/run-button'
        },
        command: {
          raw: 'npm run dev',
          argv: ['npm', 'run', 'dev'],
          cwd: workspacePath,
          env: {
            NODE_ENV: 'development',
            VITE_PORT: '5173'
          },
          longRunning: true
        }
      }),
      chatId: 'chat-1'
    })

    expect(result.ok).toBe(true)
    expect(fixture.requestApproval).toHaveBeenCalledWith(
      null,
      'codex',
      'shellCommands',
      workspacePath,
      expect.objectContaining({
        method: 'launch/start',
        forcePrompt: true,
        preview: expect.objectContaining({
          platform: 'web',
          execution: 'long-running',
          shell: false,
          envDeltas: {
            NODE_ENV: 'development',
            VITE_PORT: '5173'
          }
        })
      })
    )
    expect(fixture.spawnProcess).toHaveBeenCalledWith(
      'npm',
      ['run', 'dev'],
      expect.objectContaining({
        cwd: workspacePath,
        shell: false,
        detached: true,
        windowsHide: true
      })
    )
    expect(fixture.spawnProcess.mock.calls[0]?.[2]?.env).toMatchObject({
      NODE_ENV: 'development',
      VITE_PORT: '5173',
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    })
    expect(fixture.tracked[0]).toMatchObject({
      pid: 4321,
      pgid: 4321,
      workspacePath,
      chatId: 'chat-1',
      provider: 'codex'
    })
    const persisted = new LaunchAttemptStore(storagePath).list()[0]
    expect(persisted).toMatchObject({
      status: 'running',
      pid: 4321,
      targetSnapshotHash: expect.any(String),
      commandRaw: 'npm run dev',
      argv: ['npm', 'run', 'dev'],
      git: {
        branch: 'feature/run-button'
      }
    })
    expect(fixture.lifecycleEvents).toEqual([
      expect.objectContaining({
        eventType: 'launch_started',
        summary: 'Launch started: npm run dev',
        attempt: expect.objectContaining({
          id: persisted.id,
          status: 'running',
          pid: 4321
        }),
        payload: {
          pid: 4321,
          pgid: 4321
        }
      })
    ])
  })

  it('binds launch authority to the exact child and releases only after close', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-lock-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)
    const bind = vi.fn(async () => {})
    const release = vi.fn(async () => {})

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: 'npm run dev',
          argv: ['npm', 'run', 'dev'],
          cwd: workspacePath,
          env: {
            TASKWRAITH_LOCK_OWNER_ID: 'forged-repository-owner'
          },
          longRunning: true
        }
      }),
      chatId: 'chat-1',
      runId: 'run-1',
      workspaceLockOwnerId: 'exact-owner-run-1',
      workspaceLockLifecycle: { bind, release }
    })

    expect(result).toMatchObject({ ok: true, attempt: { status: 'running', pid: 4321 } })
    expect(fixture.spawnGatedProcess.mock.calls[0]?.[2]?.env).toMatchObject({
      TASKWRAITH_LOCK_OWNER_ID: 'exact-owner-run-1'
    })
    expect(bind).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: result.attempt?.id,
        provider: 'codex',
        workspacePath,
        chatId: 'chat-1',
        runId: 'run-1',
        pid: 4321,
        workspaceLockOwnerId: 'exact-owner-run-1'
      })
    )
    expect(fixture.gatedStarts).toEqual([4_321])
    expect(release).not.toHaveBeenCalled()

    fixture.child.emit('close', 0, null)
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  })

  it('terminates and joins the exact child when workspace-lock binding fails', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-lock-fail-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)
    const release = vi.fn(async () => {})
    const start = fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath),
      runId: 'run-1',
      workspaceLockOwnerId: 'exact-owner-run-1',
      workspaceLockLifecycle: {
        bind: async () => {
          throw new Error('process birth receipt unavailable')
        },
        release
      }
    })

    await vi.waitFor(() => expect(fixture.killProcess).toHaveBeenCalledWith(4321, 4321))
    expect(release).not.toHaveBeenCalled()
    expect(fixture.gatedStarts).toEqual([])
    fixture.child.emit('close', null, 'SIGTERM')

    await expect(start).resolves.toMatchObject({
      ok: false,
      attempt: { status: 'failed' },
      error: expect.stringContaining('process birth receipt unavailable')
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('records a canonical birth receipt for the exact PID returned by spawn', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-receipt-'))
    const storagePath = await tempFile()
    const resolveProcessStartedAt = vi.fn(async (pid: number) => {
      expect(pid).toBe(8765)
      return 'procBSDInfo:1774843200123456'
    })
    const fixture = managerFixture(storagePath, workspacePath, { resolveProcessStartedAt })
    fixture.child.pid = 8765

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })

    expect(result).toMatchObject({
      ok: true,
      attempt: {
        pid: 8765,
        processStartedAt: 'procBSDInfo:1774843200123456',
        status: 'running'
      }
    })
    expect(resolveProcessStartedAt).toHaveBeenCalledTimes(1)
    expect(resolveProcessStartedAt).toHaveBeenCalledWith(8765)
    expect(new LaunchAttemptStore(storagePath).list()[0]).toMatchObject({
      pid: 8765,
      processStartedAt: 'procBSDInfo:1774843200123456'
    })
  })

  it.each([
    ['null receipt', async () => null],
    ['non-canonical receipt', async () => 'procBSDInfo:0001774843200123456'],
    ['resolver rejection', async () => Promise.reject(new Error('daemon unavailable'))]
  ])(
    'leaves a launch view-only when the birth receipt resolver returns %s',
    async (_label, resolve) => {
      const workspacePath = await fs.mkdtemp(
        path.join(os.tmpdir(), 'taskwraith-launch-receipt-none-')
      )
      const storagePath = await tempFile()
      const fixture = managerFixture(storagePath, workspacePath, {
        resolveProcessStartedAt: resolve
      })

      const result = await fixture.manager.startTarget({
        sender: null,
        provider: 'codex',
        target: target(workspacePath)
      })

      expect(result).toMatchObject({ ok: true, attempt: { status: 'running', pid: 4321 } })
      expect(result.attempt).not.toHaveProperty('processStartedAt')
      expect(new LaunchAttemptStore(storagePath).list()[0]).not.toHaveProperty('processStartedAt')
    }
  )

  it('does not resurrect an immediately exited child after receipt resolution', async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'taskwraith-launch-receipt-race-')
    )
    let enterResolver: (() => void) | undefined
    const resolverEntered = new Promise<void>((resolve) => {
      enterResolver = resolve
    })
    let settleReceipt: ((value: string | null) => void) | undefined
    const receipt = new Promise<string | null>((resolve) => {
      settleReceipt = resolve
    })
    const fixture = managerFixture(await tempFile(), workspacePath, {
      resolveProcessStartedAt: async () => {
        enterResolver?.()
        return receipt
      }
    })

    const starting = fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })
    await resolverEntered
    fixture.child.exitCode = 0
    fixture.child.emit('close', 0, null)
    settleReceipt?.('procBSDInfo:1774843200123456')

    const result = await starting
    expect(result).toMatchObject({ ok: true, attempt: { status: 'stopped', pid: 4321 } })
    expect(result.attempt).not.toHaveProperty('processStartedAt')
    expect(fixture.tracked).toEqual([])
    expect(fixture.untracked).toEqual([4321])
  })

  it('does not bind a receipt after exit is observable before the close event', async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'taskwraith-launch-receipt-exit-state-')
    )
    let enterResolver: (() => void) | undefined
    const resolverEntered = new Promise<void>((resolve) => {
      enterResolver = resolve
    })
    let settleReceipt: ((value: string | null) => void) | undefined
    const receipt = new Promise<string | null>((resolve) => {
      settleReceipt = resolve
    })
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath, {
      resolveProcessStartedAt: async () => {
        enterResolver?.()
        return receipt
      }
    })

    const starting = fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })
    await resolverEntered
    fixture.child.exitCode = 0
    settleReceipt?.('procBSDInfo:1774843200123456')

    const result = await starting
    expect(result).toMatchObject({ ok: true, attempt: { status: 'starting', pid: 4321 } })
    expect(result.attempt).not.toHaveProperty('processStartedAt')
    expect(fixture.tracked).toEqual([])
    expect(new LaunchAttemptStore(storagePath).list()[0]).not.toHaveProperty('processStartedAt')

    fixture.child.emit('close', 0, null)
    expect(new LaunchAttemptStore(storagePath).list()[0]).toMatchObject({
      status: 'stopped',
      pid: 4321,
      exitCode: 0
    })
  })

  it('persists bounded output and terminal state from the child process', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)
    const started = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })
    const attemptId = started.attempt?.id as string

    fixture.child.stdout.emit('data', 'ready on http://localhost:5173\n')
    fixture.child.emit('close', 0, null)

    const persisted = new LaunchAttemptStore(storagePath).get(attemptId)
    expect(persisted).toMatchObject({
      status: 'stopped',
      exitCode: 0,
      outputTail: 'ready on http://localhost:5173\n',
      detectedUrls: ['http://localhost:5173']
    })
    expect(fixture.untracked).toEqual([4321])
    expect(fixture.lifecycleEvents.at(-1)).toMatchObject({
      eventType: 'launch_stopped',
      summary: 'Launch completed: npm run dev',
      attempt: {
        id: attemptId,
        status: 'stopped',
        detectedUrls: ['http://localhost:5173']
      },
      payload: {
        exitCode: 0,
        signal: null
      }
    })
  })

  it('starts approved VS Code shell tasks through an explicit shell spawn', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        source: 'vscode-task',
        label: 'build web',
        subtitle: 'VS Code task',
        command: {
          raw: 'npm run build',
          cwd: workspacePath,
          longRunning: false,
          shell: true
        }
      })
    })

    expect(result.ok).toBe(true)
    expect(fixture.requestApproval).toHaveBeenCalledWith(
      null,
      'codex',
      'shellCommands',
      workspacePath,
      expect.objectContaining({
        preview: expect.objectContaining({
          source: 'vscode-task',
          command: 'npm run build',
          shell: true
        })
      })
    )
    expect(fixture.spawnProcess).toHaveBeenCalledWith(
      'npm run build',
      [],
      expect.objectContaining({
        cwd: workspacePath,
        shell: true
      })
    )
    const persisted = new LaunchAttemptStore(storagePath).list()[0]
    expect(persisted).toMatchObject({
      status: 'running',
      commandRaw: 'npm run build',
      argv: ['npm run build'],
      shell: true
    })
  })

  it('rejects renderer-tampered shell targets before approval', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)

    const result = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: 'npm run dev && rm -rf /',
          cwd: workspacePath,
          longRunning: true,
          shell: true
        }
      })
    })

    expect(result).toMatchObject({ ok: false })
    expect(fixture.requestApproval).not.toHaveBeenCalled()
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
  })

  it('does not collapse active targets with the same id across workspaces', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-a-'))
    const otherWorkspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'taskwraith-launch-workspace-b-')
    )
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)

    const first = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })
    const second = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(otherWorkspacePath)
    })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.attempt?.id).not.toBe(first.attempt?.id)
    expect(fixture.requestApproval).toHaveBeenCalledTimes(2)
    expect(fixture.spawnProcess).toHaveBeenCalledTimes(2)
  })

  it('stops only owned active attempts through the injected kill path', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)
    const started = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })

    const stopped = await fixture.manager.stopAttempt(started.attempt?.id as string)

    expect(stopped.ok).toBe(true)
    expect(stopped.attempt).toMatchObject({ status: 'cancelled' })
    expect(fixture.untracked).toEqual([4321])
    expect(fixture.lifecycleEvents.slice(-2)).toEqual([
      expect.objectContaining({
        eventType: 'launch_stop_requested',
        attempt: expect.objectContaining({ status: 'stopping' })
      }),
      expect.objectContaining({
        eventType: 'launch_cancelled',
        summary: 'Launch stopped by user: npm run dev',
        attempt: expect.objectContaining({ status: 'cancelled' })
      })
    ])
  })

  it('records stop failures in the launch lifecycle audit stream', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)
    fixture.killProcess.mockResolvedValueOnce({ ok: false, escalated: false })
    const started = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })

    const stopped = await fixture.manager.stopAttempt(started.attempt?.id as string)

    expect(stopped.ok).toBe(false)
    expect(stopped.attempt).toMatchObject({ status: 'failed' })
    expect(fixture.lifecycleEvents.slice(-2)).toEqual([
      expect.objectContaining({
        eventType: 'launch_stop_requested'
      }),
      expect.objectContaining({
        eventType: 'launch_stop_failed',
        summary: 'Launch stop failed: npm run dev',
        attempt: expect.objectContaining({ status: 'failed' })
      })
    ])
  })

  it('recovers active attempts as interrupted on startup', async () => {
    const storagePath = await tempFile()
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const store = new LaunchAttemptStore(storagePath)
    const lifecycleEvents: unknown[] = []
    store.save({
      schemaVersion: 1,
      id: 'attempt-1',
      targetId: 'target-1',
      targetLabel: 'npm run dev',
      targetSource: 'package-script',
      targetKind: 'dev-server',
      targetSnapshot: target(workspacePath),
      targetSnapshotHash: 'hash',
      provider: 'codex',
      workspacePath,
      cwd: workspacePath,
      commandRaw: 'npm run dev',
      argv: ['npm', 'run', 'dev'],
      status: 'running',
      startedAt: '2026-06-21T11:00:00.000Z',
      updatedAt: '2026-06-21T11:00:00.000Z',
      outputTail: '',
      outputTailBytes: 0,
      outputTruncated: false
    })

    new LaunchManager({
      store,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      requestApproval: vi.fn(),
      createEnv: (extra) => extra,
      recordLifecycleEvent: (event) => lifecycleEvents.push(event)
    })

    expect(store.get('attempt-1')).toMatchObject({
      status: 'interrupted',
      endedAt: '2026-06-21T12:00:00.000Z'
    })
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        eventType: 'launch_interrupted',
        summary: 'Launch interrupted after restart: npm run dev',
        attempt: expect.objectContaining({
          id: 'attempt-1',
          status: 'interrupted'
        })
      })
    ])
  })

  async function saveRecoveredAttempt(
    store: LaunchAttemptStore,
    workspacePath: string
  ): Promise<void> {
    store.save({
      schemaVersion: 1,
      id: 'attempt-recovered',
      targetId: 'target-1',
      targetLabel: 'npm run dev',
      targetSource: 'package-script',
      targetKind: 'dev-server',
      targetSnapshot: target(workspacePath),
      targetSnapshotHash: 'hash',
      provider: 'codex',
      workspacePath,
      cwd: workspacePath,
      commandRaw: 'npm run dev',
      argv: ['npm', 'run', 'dev'],
      pid: 9876,
      pgid: 9876,
      status: 'running',
      startedAt: '2026-06-21T11:00:00.000Z',
      updatedAt: '2026-06-21T11:00:00.000Z',
      outputTail: '',
      outputTailBytes: 0,
      outputTruncated: false
    })
  }

  it('stops a recovered attempt whose pid is still live this boot', async () => {
    const storagePath = await tempFile()
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const store = new LaunchAttemptStore(storagePath)
    await saveRecoveredAttempt(store, workspacePath)
    const killProcess = vi.fn(async () => ({ ok: true, escalated: false }))
    const untracked: number[] = []
    const manager = new LaunchManager({
      store,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      requestApproval: vi.fn(),
      createEnv: (extra) => extra,
      killProcess,
      untrackSpawn: (pid) => untracked.push(pid),
      // Booted before the attempt started, and the pid still exists → ours.
      bootTime: () => new Date('2026-06-21T10:00:00.000Z'),
      processExists: () => true
    })

    expect(store.get('attempt-recovered')).toMatchObject({ status: 'interrupted', pid: 9876 })

    const stopped = await manager.stopAttempt('attempt-recovered')

    expect(stopped.ok).toBe(true)
    expect(killProcess).toHaveBeenCalledWith(9876, 9876)
    expect(untracked).toEqual([9876])
    expect(store.get('attempt-recovered')).toMatchObject({ status: 'cancelled' })
  })

  it('never signals a recovered pid that predates the current boot', async () => {
    const storagePath = await tempFile()
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const store = new LaunchAttemptStore(storagePath)
    await saveRecoveredAttempt(store, workspacePath)
    const killProcess = vi.fn(async () => ({ ok: true, escalated: false }))
    const untracked: number[] = []
    const manager = new LaunchManager({
      store,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      requestApproval: vi.fn(),
      createEnv: (extra) => extra,
      killProcess,
      untrackSpawn: (pid) => untracked.push(pid),
      // Booted AFTER the attempt started → pid 9876 was recycled by the OS, so
      // even though some process now holds it, it is NOT ours.
      bootTime: () => new Date('2026-06-21T11:30:00.000Z'),
      processExists: () => true
    })

    const stopped = await manager.stopAttempt('attempt-recovered')

    expect(stopped.ok).toBe(true)
    expect(killProcess).not.toHaveBeenCalled()
    expect(untracked).toEqual([9876])
    expect(store.get('attempt-recovered')).toMatchObject({ status: 'stopped' })
    expect(store.get('attempt-recovered')?.pid).toBeUndefined()
  })

  it('never signals a recovered pid that no longer exists', async () => {
    const storagePath = await tempFile()
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const store = new LaunchAttemptStore(storagePath)
    await saveRecoveredAttempt(store, workspacePath)
    const killProcess = vi.fn(async () => ({ ok: true, escalated: false }))
    const manager = new LaunchManager({
      store,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      requestApproval: vi.fn(),
      createEnv: (extra) => extra,
      killProcess,
      bootTime: () => new Date('2026-06-21T10:00:00.000Z'),
      processExists: () => false
    })

    const stopped = await manager.stopAttempt('attempt-recovered')

    expect(stopped.ok).toBe(true)
    expect(killProcess).not.toHaveBeenCalled()
    expect(store.get('attempt-recovered')).toMatchObject({ status: 'stopped' })
  })

  it('rejects a concurrent second start for the same target while approval is pending', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)
    let resolveApproval: ((value: boolean) => void) | undefined
    fixture.requestApproval.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveApproval = resolve
        })
    )

    const first = fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })
    const second = await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath)
    })

    expect(second).toMatchObject({ ok: false })
    expect(second.error).toMatch(/already starting/i)

    resolveApproval?.(true)
    const firstResult = await first

    expect(firstResult.ok).toBe(true)
    expect(fixture.spawnProcess).toHaveBeenCalledTimes(1)
    expect(fixture.requestApproval).toHaveBeenCalledTimes(1)
  })

  it('strips library-injection env vars from discovered launch targets', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const storagePath = await tempFile()
    const fixture = managerFixture(storagePath, workspacePath)

    await fixture.manager.startTarget({
      sender: null,
      provider: 'codex',
      target: target(workspacePath, {
        command: {
          raw: 'npm run dev',
          argv: ['npm', 'run', 'dev'],
          cwd: workspacePath,
          longRunning: true,
          env: { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib', VITE_PORT: '5173' }
        }
      })
    })

    const preview = (fixture.approvals[0] as { preview: { envDeltas?: Record<string, string> } })
      .preview
    expect(preview.envDeltas).toEqual({ VITE_PORT: '5173' })
    const spawnedEnv = fixture.spawnProcess.mock.calls[0]?.[2]?.env as Record<string, string>
    expect(spawnedEnv.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(spawnedEnv.VITE_PORT).toBe('5173')
  })
})

describe('LaunchManager — adopting an agent-spawned process', () => {
  const HOST_PID = 500
  const SPAWNED_PID = 8123
  const RECEIPT = 'procBSDInfo:1774843200900000'

  async function adoptFixture(
    options: {
      ancestry?: (request: { leafPid: number; rootPid: number }) => Promise<unknown>
      startedAt?: (pid: number) => Promise<string | null>
      approve?: boolean
      protectedPids?: number[]
    } = {}
  ) {
    const storagePath = await tempFile()
    const workspacePath = path.dirname(storagePath)
    const approvals: unknown[] = []
    const manager = new LaunchManager({
      store: new LaunchAttemptStore(storagePath),
      platform: 'darwin',
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      requestApproval: vi.fn(async (_sender, _provider, _service, _workspace, request) => {
        approvals.push(request)
        return options.approve ?? true
      }),
      createEnv: (extra) => ({ PATH: '/usr/bin', ...extra }),
      resolveProcessStartedAt: options.startedAt ?? (async () => RECEIPT),
      hostProcessPid: () => HOST_PID,
      getHostProtectedPids: () => options.protectedPids ?? [HOST_PID],
      resolveProcessAncestry:
        options.ancestry ??
        (async () => ({
          rootPid: HOST_PID,
          rootProcessStartedAt: 'procBSDInfo:1774843200000001',
          leafPid: SPAWNED_PID,
          leafProcessStartedAt: RECEIPT,
          depth: 2,
          chain: []
        })),
      describeProcess: async () => ({ command: '/opt/app/MyApp --qa', cwd: workspacePath }),
      processExists: () => true
    })
    return { manager, workspacePath, approvals }
  }

  function adoptInput(workspacePath: string, overrides: Record<string, unknown> = {}) {
    return {
      sender: null,
      provider: 'claude' as const,
      workspacePath,
      pid: SPAWNED_PID,
      chatId: 'chat-a',
      runId: 'run-a',
      ...overrides
    }
  }

  it('adopts a process this run spawned so it can be driven', async () => {
    const { manager, workspacePath } = await adoptFixture()

    const result = await manager.adoptProcess(adoptInput(workspacePath))

    expect(result.ok).toBe(true)
    expect(result.attempt).toMatchObject({
      pid: SPAWNED_PID,
      processStartedAt: RECEIPT,
      status: 'running',
      chatId: 'chat-a',
      runId: 'run-a',
      adopted: true
    })
    // Killing a process group would reach the provider CLI that spawned it.
    expect(result.attempt?.pgid).toBeUndefined()
  })

  it('shows the human what they are adopting before it becomes drivable', async () => {
    const { manager, workspacePath, approvals } = await adoptFixture()

    await manager.adoptProcess(adoptInput(workspacePath))

    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({
      forcePrompt: true,
      preview: expect.objectContaining({
        kind: 'launch-adopt',
        pid: SPAWNED_PID,
        command: '/opt/app/MyApp --qa'
      })
    })
  })

  it('refuses a process the human did not approve', async () => {
    const { manager, workspacePath } = await adoptFixture({ approve: false })

    const result = await manager.adoptProcess(adoptInput(workspacePath))

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/approval/i)
  })

  it('refuses a process this TaskWraith instance did not spawn', async () => {
    // An app started via `open -a` is parented to launchd, not to us.
    const { manager, workspacePath } = await adoptFixture({ ancestry: async () => null })

    const result = await manager.adoptProcess(adoptInput(workspacePath))

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not.*started by|descend/i)
  })

  it('refuses a protected host process', async () => {
    const { manager, workspacePath, approvals } = await adoptFixture({
      protectedPids: [HOST_PID, SPAWNED_PID]
    })

    const result = await manager.adoptProcess(adoptInput(workspacePath))

    expect(result.ok).toBe(false)
    expect(approvals).toEqual([])
  })

  it('refuses adoption without a canonical birth receipt', async () => {
    const { manager, workspacePath } = await adoptFixture({ startedAt: async () => null })

    const result = await manager.adoptProcess(adoptInput(workspacePath))

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/receipt|identity/i)
  })

  it('requires an exact chat and run owner', async () => {
    const { manager, workspacePath } = await adoptFixture()

    for (const missing of [{ chatId: undefined }, { runId: undefined }]) {
      const result = await manager.adoptProcess(adoptInput(workspacePath, missing))
      expect(result.ok).toBe(false)
    }
  })

  it('refuses a dead process rather than adopting a recycled PID later', async () => {
    const { manager, workspacePath } = await adoptFixture()
    const result = await manager.adoptProcess(adoptInput(workspacePath, { pid: 0 }))
    expect(result.ok).toBe(false)
  })
})
