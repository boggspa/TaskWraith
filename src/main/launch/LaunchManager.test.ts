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

class FakeChild extends EventEmitter {
  pid = 4321
  stdout = new EventEmitter()
  stderr = new EventEmitter()
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

  it('can stop a recovered interrupted attempt through its persisted pid', async () => {
    const storagePath = await tempFile()
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-workspace-'))
    const store = new LaunchAttemptStore(storagePath)
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
    const killProcess = vi.fn(async () => ({ ok: true, escalated: false }))
    const untracked: number[] = []
    const manager = new LaunchManager({
      store,
      now: () => new Date('2026-06-21T12:00:00.000Z'),
      requestApproval: vi.fn(),
      createEnv: (extra) => extra,
      killProcess,
      untrackSpawn: (pid) => untracked.push(pid)
    })

    expect(store.get('attempt-recovered')).toMatchObject({ status: 'interrupted', pid: 9876 })

    const stopped = await manager.stopAttempt('attempt-recovered')

    expect(stopped.ok).toBe(true)
    expect(killProcess).toHaveBeenCalledWith(9876, 9876)
    expect(untracked).toEqual([9876])
    expect(store.get('attempt-recovered')).toMatchObject({ status: 'cancelled' })
  })
})
