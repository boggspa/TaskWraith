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

function managerFixture(storagePath: string, workspacePath: string) {
  const child = new FakeChild()
  const approvals: unknown[] = []
  const tracked: unknown[] = []
  const untracked: number[] = []
  const lifecycleEvents: unknown[] = []
  const spawnProcess = vi.fn(
    (_command: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess
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
    requestApproval,
    createEnv: (extra) => ({ PATH: '/usr/bin', ...extra }),
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
    spawnProcess,
    requestApproval,
    killProcess,
    workspacePath
  }
}

describe('LaunchManager — self-launch refusal', () => {
  /**
   * TaskWraith is uniquely self-hostile as a launch target: a packaged build
   * ignores the multi-instance lane (it is gated behind `!app.isPackaged`), so a
   * child copy hits the single-instance lock and quits in milliseconds. That is
   * indistinguishable from a crash to whatever started it, so a QA agent retries
   * forever. These pin the refusal AND the false-positive boundary — a guard that
   * blocks unrelated projects is worse than the loop it prevents.
   */
  const OWN_ROOT = '/Applications/TaskWraith.app/Contents/Resources/app.asar'
  const OWN_EXE = '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'

  function selfAwareFixture(storagePath: string, workspacePath: string) {
    const base = managerFixture(storagePath, workspacePath)
    return {
      ...base,
      manager: new LaunchManager({
        store: new LaunchAttemptStore(storagePath),
        platform: 'darwin',
        now: () => new Date('2026-06-21T12:00:00.000Z'),
        spawnProcess: base.spawnProcess,
        requestApproval: base.requestApproval,
        createEnv: (extra) => ({ PATH: '/usr/bin', ...extra }),
        appRootPath: () => OWN_ROOT,
        appExecutablePath: () => OWN_EXE,
        killProcess: base.killProcess
      })
    }
  }

  it('refuses to spawn a second copy of itself, and never reaches spawn or approval', async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-self-'))
    const storagePath = await tempFile()
    const fixture = selfAwareFixture(storagePath, workspacePath)

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

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/cannot launch a second copy of itself/)
    // The message has to tell an agent to stop, not just that something failed —
    // an unbounded retry loop is the actual symptom being fixed.
    expect(result.ok === false && result.error).toMatch(/do not retry/i)
    // Refused before the human is ever asked, and before anything is spawned.
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
    expect(fixture.requestApproval).not.toHaveBeenCalled()
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
    expect(fixture.spawnProcess).not.toHaveBeenCalled()
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
    const otherWorkspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-b-'))
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
