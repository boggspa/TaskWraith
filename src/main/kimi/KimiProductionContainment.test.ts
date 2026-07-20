import {
  mkdtemp,
  mkdir,
  chmod,
  lstat,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile
} from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryClearAdmissionGate } from '../HistoryClearAdmissionGate'
import {
  KIMI_ACP_PRODUCTION_POSTURE_VERSION,
  KIMI_SPAWN_AUTHORITY_REVOKED_MESSAGE,
  assertKimiSpawnAuthority,
  buildKimiContainedProcessEnv,
  buildKimiProductionAcpSnapshot,
  buildKimiProductionInitializeParams,
  buildKimiProductionSessionPlan,
  createJoinedKimiCleanup,
  finalizeKimiRunAfterCleanup,
  formatKimiProductionAcpDebugFrame,
  launchKimiProductionAcp,
  prepareKimiPrivateRunCwd,
  type KimiPrivateCwdFs
} from './KimiProductionContainment'

const cleanupRoots: string[] = []

const realFs: KimiPrivateCwdFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 })
  },
  mkdtemp,
  chmod,
  lstat,
  realpath,
  readdir,
  rm: (path) => rm(path, { recursive: true, force: true })
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('Kimi production ACP containment', () => {
  it('never reaches provider launch when the gateway is disabled or fails', async () => {
    const privateCwd = {
      cwd: '/private/empty',
      assertReadyForSpawn: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {})
    }
    const launch = vi.fn(() => ({ cancel: () => {} }))
    const snapshot = { appVersion: '1.8.4', prompt: 'work' }

    await expect(
      launchKimiProductionAcp({
        taskWraithMcpAdvertised: false,
        privateCwd,
        assertRuntimeReadyForSpawn: vi.fn(async () => '/admitted/kimi'),
        startGateway: vi.fn(async () => {
          throw new Error('must not run')
        }),
        snapshot,
        launch
      })
    ).rejects.toThrow('requires the governed TaskWraith HTTP MCP gateway')
    expect(launch).not.toHaveBeenCalled()

    await expect(
      launchKimiProductionAcp({
        taskWraithMcpAdvertised: true,
        privateCwd,
        assertRuntimeReadyForSpawn: vi.fn(async () => '/admitted/kimi'),
        startGateway: async () => {
          throw new Error('bridge failed')
        },
        snapshot,
        launch
      })
    ).rejects.toThrow('bridge failed')
    expect(launch).not.toHaveBeenCalled()
  })

  it('launches synchronously after the final private-cwd check with an exact gateway', async () => {
    const order: string[] = []
    const privateCwd = {
      cwd: '/private/empty',
      assertReadyForSpawn: async () => {
        order.push('cwd-check')
      },
      cleanup: async () => {
        order.push('cwd-cleanup')
      }
    }
    const result = await launchKimiProductionAcp({
      taskWraithMcpAdvertised: true,
      privateCwd,
      assertRuntimeReadyForSpawn: async () => {
        order.push('runtime-check')
        return '/admitted/kimi'
      },
      startGateway: async () => ({
        server: {
          name: 'taskwraith',
          type: 'http',
          url: 'http://127.0.0.1:1234/mcp',
          headers: [{ name: 'x-taskwraith-token', value: 'secret' }]
        },
        close: async () => {
          order.push('gateway-cleanup')
        }
      }),
      snapshot: { appVersion: '1.8.4', prompt: 'work' },
      launch: (snapshot, _cleanup, binaryPath) => {
        order.push('spawn')
        return `${binaryPath}:${snapshot.cwd}`
      }
    })

    expect(result.handle).toBe('/admitted/kimi:/private/empty')
    expect(order).toEqual(['cwd-check', 'runtime-check', 'spawn'])
    await result.cleanup()
    expect(order).toEqual(['cwd-check', 'runtime-check', 'spawn', 'cwd-cleanup', 'gateway-cleanup'])
  })

  it('does not spawn and joins cleanup when history revokes a run during admission', async () => {
    const gate = new HistoryClearAdmissionGate()
    const dispatchAuthority = {
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      persistenceRevision: 4
    }
    const dispatch = gate.reserveDispatch(dispatchAuthority)
    const runAuthority = gate.promoteDispatch(dispatch, dispatchAuthority)!
    let runActive = true
    const isAuthorized = (): boolean =>
      runActive &&
      gate.authorizeRunPersistence(runAuthority, {
        appChatId: 'chat-a',
        workspaceId: 'workspace-a'
      })

    let signalRuntimeCheck!: () => void
    const runtimeCheckStarted = new Promise<void>((resolve) => {
      signalRuntimeCheck = resolve
    })
    let releaseRuntimeCheck!: () => void
    const runtimeCheck = new Promise<void>((resolve) => {
      releaseRuntimeCheck = resolve
    })
    let signalGatewayCleanup!: () => void
    const gatewayCleanupStarted = new Promise<void>((resolve) => {
      signalGatewayCleanup = resolve
    })
    let releaseGatewayCleanup!: () => void
    const gatewayCleanup = new Promise<void>((resolve) => {
      releaseGatewayCleanup = resolve
    })
    const privateCleanup = vi.fn(async () => {})
    const gatewayClose = vi.fn(async () => {
      signalGatewayCleanup()
      await gatewayCleanup
    })
    const spawnProvider = vi.fn(() => ({ cancel: () => {} }))
    const launching = launchKimiProductionAcp({
      taskWraithMcpAdvertised: true,
      privateCwd: {
        cwd: '/private/empty',
        assertReadyForSpawn: vi.fn(async () => {}),
        cleanup: privateCleanup
      },
      assertRuntimeReadyForSpawn: async () => {
        signalRuntimeCheck()
        await runtimeCheck
        return '/admitted/kimi'
      },
      startGateway: async () => ({
        server: {
          name: 'taskwraith',
          type: 'http',
          url: 'http://127.0.0.1:1234/mcp',
          headers: [{ name: 'x-taskwraith-token', value: 'secret' }]
        },
        close: gatewayClose
      }),
      snapshot: { appVersion: '1.8.4', prompt: 'work' },
      launch: () => {
        assertKimiSpawnAuthority(isAuthorized)
        return spawnProvider()
      }
    })
    let launchSettled = false
    void launching.then(
      () => {
        launchSettled = true
      },
      () => {
        launchSettled = true
      }
    )

    await runtimeCheckStarted
    // Model the scoped prepare + exact RunManager terminalization that can land
    // while Kimi is awaiting runtime attestation.
    gate.beginChat('chat-a')
    runActive = false
    releaseRuntimeCheck()
    await gatewayCleanupStarted

    expect(spawnProvider).not.toHaveBeenCalled()
    expect(privateCleanup).toHaveBeenCalledTimes(1)
    expect(gatewayClose).toHaveBeenCalledTimes(1)
    expect(launchSettled).toBe(false)

    releaseGatewayCleanup()
    await expect(launching).rejects.toThrow(KIMI_SPAWN_AUTHORITY_REVOKED_MESSAGE)
    expect(launchSettled).toBe(true)
    gate.endChat('chat-a')
  })

  it('joins duplicate error/close terminal callbacks to one cleanup', async () => {
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const cleanup = createJoinedKimiCleanup(async () => {
      calls += 1
      await blocker
    })

    const fromError = cleanup()
    const fromClose = cleanup()
    expect(fromClose).toBe(fromError)
    expect(calls).toBe(1)
    let settled = false
    void fromClose.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await Promise.all([fromError, fromClose])
    expect(settled).toBe(true)
  })

  it('allows a failed private-cwd removal to be retried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-kimi-posture-'))
    cleanupRoots.push(root)
    const home = join(root, 'seat-home')
    await mkdir(home, { mode: 0o700 })
    let attempts = 0
    const retryingFs: KimiPrivateCwdFs = {
      ...realFs,
      rm: async (path) => {
        attempts += 1
        if (attempts === 1) throw new Error('injected removal failure')
        await rm(path, { recursive: true, force: true })
      }
    }
    const cwd = await prepareKimiPrivateRunCwd({ isolatedHome: home, fs: retryingFs })

    await expect(cwd.cleanup()).rejects.toThrow('injected removal failure')
    expect(await lstat(cwd.cwd)).toBeDefined()
    await cwd.cleanup()
    await expect(lstat(cwd.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(attempts).toBe(2)
  })

  it('redacts gateway authority, cwd, and prompt content from production debug output', () => {
    const bearer = 'UNIQUE_BEARER_SENTINEL'
    const workspace = '/UNIQUE/WORKSPACE/PATH'
    const prompt = 'UNIQUE_PROMPT_SENTINEL'
    const line = formatKimiProductionAcpDebugFrame('out', {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: {
        cwd: workspace,
        prompt,
        mcpServers: [
          {
            url: 'http://127.0.0.1:1234/mcp',
            headers: [{ name: 'Authorization', value: bearer }]
          }
        ]
      }
    })

    expect(line).toContain('session/new')
    expect(line).toContain('"rpcIdPresent":true')
    expect(line).not.toContain('"rpcId":2')
    expect(line).not.toContain(bearer)
    expect(line).not.toContain(workspace)
    expect(line).not.toContain(prompt)
  })

  it('removes inherited workspace cwd hints from the provider environment', () => {
    const injected = {
      PATH: '/bin',
      KIMI_CODE_HOME: '/private/home',
      RUNNER_TRACKING_ID: 'actions-orphan-reaper',
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'internal.example',
      PWD: '/real/workspace',
      OLDPWD: '/real',
      INIT_CWD: '/real/workspace',
      npm_config_local_prefix: '/real/workspace',
      TASKWRAITH_WORKSPACE_PATH: '/real/workspace',
      DYLD_INSERT_LIBRARIES: 'INJECT_DYLD',
      DYLD_LIBRARY_PATH: 'INJECT_DYLD_PATH',
      DYLD_FRAMEWORK_PATH: 'INJECT_DYLD_FRAMEWORK',
      LD_PRELOAD: 'INJECT_LD',
      LD_LIBRARY_PATH: 'INJECT_LD_PATH',
      NODE_OPTIONS: '--require INJECT_NODE',
      PYTHONPATH: 'INJECT_PYTHON',
      PYTHONHOME: 'INJECT_PYTHON_HOME',
      BASH_ENV: 'INJECT_BASH',
      ENV: 'INJECT_SHELL'
    }
    const contained = buildKimiContainedProcessEnv(injected, '/private/run')
    expect(contained).toMatchObject({
      PATH: '/bin',
      KIMI_CODE_HOME: '/private/home',
      RUNNER_TRACKING_ID: 'actions-orphan-reaper',
      HOME: '/private/home',
      USERPROFILE: '/private/home',
      PWD: '/private/run',
      TMPDIR: '/private/run'
    })
    expect(contained.NO_PROXY).toContain('internal.example')
    expect(contained.NO_PROXY).toContain('127.0.0.1')
    expect(contained.NO_PROXY).toContain('localhost')
    expect(contained.NO_PROXY).toContain('::1')
    expect(contained.no_proxy).toBe(contained.NO_PROXY)
    for (const sentinel of Object.values(injected).filter((value) => value.startsWith('INJECT_'))) {
      expect(JSON.stringify(contained)).not.toContain(sentinel)
    }
    expect(JSON.stringify(contained)).not.toContain('/real/workspace')
  })

  it('finishes terminal bookkeeping after a projection failure', async () => {
    const order: string[] = []
    await expect(
      finalizeKimiRunAfterCleanup({
        cleanup: async () => {
          order.push('cleanup')
        },
        projectTerminal: () => {
          order.push('projection')
          throw new Error('injected projection failure')
        },
        finish: () => {
          order.push('finish')
        }
      })
    ).rejects.toThrow('injected projection failure')
    expect(order).toEqual(['cleanup', 'projection', 'finish'])
  })

  it('projects a failed terminal and finishes after cleanup fails twice', async () => {
    const order: string[] = []
    await expect(
      finalizeKimiRunAfterCleanup({
        cleanup: async () => {
          order.push('cleanup')
          throw new Error('residual cleanup failure')
        },
        projectTerminal: (cleanupError) => {
          order.push(cleanupError ? 'failed-projection' : 'success-projection')
        },
        finish: () => {
          order.push('finish')
        }
      })
    ).rejects.toThrow('residual cleanup failure')
    expect(order).toEqual(['cleanup', 'cleanup', 'failed-projection', 'finish'])
  })

  it('allocates a private empty cwd unrelated to the workspace and cleans it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-kimi-posture-'))
    cleanupRoots.push(root)
    const home = join(root, 'seat-home')
    await mkdir(home, { mode: 0o700 })
    const cwd = await prepareKimiPrivateRunCwd({ isolatedHome: home, fs: realFs })

    expect(cwd.cwd.startsWith(join(home, 'runtime-cwd', 'run-'))).toBe(true)
    // Windows does not enforce POSIX 0700 bits; production already skips that check.
    if (process.platform !== 'win32') {
      expect((await lstat(cwd.cwd)).mode & 0o077).toBe(0)
    }
    expect(await readdir(cwd.cwd)).toEqual([])
    await cwd.assertReadyForSpawn()
    await cwd.cleanup()
    await expect(lstat(cwd.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed if project config or any other file appears before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-kimi-posture-'))
    cleanupRoots.push(root)
    const home = join(root, 'seat-home')
    await mkdir(home, { mode: 0o700 })
    const cwd = await prepareKimiPrivateRunCwd({ isolatedHome: home, fs: realFs })
    await mkdir(join(cwd.cwd, '.kimi-code'))
    await writeFile(join(cwd.cwd, '.kimi-code', 'mcp.json'), '{}')

    await expect(cwd.assertReadyForSpawn()).rejects.toThrow('modified before provider startup')
    await cwd.cleanup()
  })

  it('rejects a symlinked runtime root before allocating a cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-kimi-posture-'))
    cleanupRoots.push(root)
    const home = join(root, 'seat-home')
    const outside = join(root, 'outside')
    await mkdir(home, { mode: 0o700 })
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, join(home, 'runtime-cwd'))

    await expect(prepareKimiPrivateRunCwd({ isolatedHome: home, fs: realFs })).rejects.toThrow(
      'not a real directory'
    )
    expect(await readdir(outside)).toEqual([])
  })

  it('omits the path-based ACP client fs capability', () => {
    const params = buildKimiProductionInitializeParams('1.8.4')
    expect(params).toEqual({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'taskwraith', version: '1.8.4' }
    })
    expect(JSON.stringify(params)).not.toContain('readTextFile')
    expect(JSON.stringify(params)).not.toContain('writeTextFile')
  })

  it('resumes only an exact new-posture session', () => {
    expect(
      buildKimiProductionSessionPlan({
        prompt: 'slim',
        resumeFallbackPrompt: 'full',
        requestedResumeSessionId: 'session_safe',
        persistedPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
      })
    ).toEqual({ prompt: 'slim', resumeSessionId: 'session_safe', legacyResumeRejected: false })
  })

  it('rejects a legacy native resume and cold-starts with full context', () => {
    expect(
      buildKimiProductionSessionPlan({
        prompt: 'slim',
        resumeFallbackPrompt: 'full',
        requestedResumeSessionId: 'session_legacy',
        persistedPostureVersion: undefined
      })
    ).toEqual({ prompt: 'full', resumeSessionId: null, legacyResumeRejected: true })
  })

  it('builds the exact gateway-only production composition and rejects no gateway', () => {
    const gateway = {
      name: 'taskwraith',
      type: 'http',
      url: 'http://127.0.0.1:1234/mcp',
      headers: [{ name: 'x-taskwraith-token', value: 'secret' }]
    }
    const snapshot = buildKimiProductionAcpSnapshot({
      privateCwd: '/private/empty',
      gatewayServer: gateway,
      appVersion: '1.8.4',
      prompt: 'work'
    })
    expect(snapshot.cwd).toBe('/private/empty')
    expect(snapshot.mcpServers).toEqual([gateway])
    expect(snapshot.deniedNativeTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
        'FetchURL',
        'WebSearch',
        'AgentSwarm'
      ])
    )
    expect(() =>
      buildKimiProductionAcpSnapshot({
        privateCwd: '/private/empty',
        gatewayServer: null,
        appVersion: '1.8.4',
        prompt: 'work'
      })
    ).toThrow('requires a private cwd and TaskWraith HTTP gateway')
    expect(() =>
      buildKimiProductionAcpSnapshot({
        privateCwd: '/private/empty',
        gatewayServer: {},
        appVersion: '1.8.4',
        prompt: 'work'
      })
    ).toThrow('not an authenticated loopback HTTP server')
  })
})
