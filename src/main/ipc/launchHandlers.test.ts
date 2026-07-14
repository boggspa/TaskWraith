import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { discoverLaunchTargets } from '../launchTargets/discovery'
import type { LaunchAttempt } from '../launch/types'
import type { LaunchTarget } from '../launchTargets/types'
import {
  parseLaunchStartInput,
  parseLaunchStopInput,
  registerLaunchHandlers,
  type LaunchHandlerDeps
} from './launchHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../launchTargets/discovery', () => ({
  discoverLaunchTargets: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedDiscoverLaunchTargets = vi.mocked(discoverLaunchTargets)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedDiscoverLaunchTargets.mockReset()
})

function launchTarget(overrides: Partial<LaunchTarget> = {}): LaunchTarget {
  return {
    id: 'target-1',
    label: 'Test target',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1',
    source: 'package-script',
    kind: 'dev-server',
    platform: 'node',
    confidence: 1,
    command: {
      raw: 'npm run dev',
      argv: ['npm', 'run', 'dev'],
      cwd: '/Test 1',
      longRunning: true
    },
    evidence: [],
    blockers: [],
    ...overrides
  }
}

function launchAttempt(overrides: Partial<LaunchAttempt> = {}): LaunchAttempt {
  const target = launchTarget()
  return {
    schemaVersion: 1,
    id: 'attempt-1',
    targetId: target.id,
    targetLabel: target.label,
    targetSource: target.source,
    targetKind: target.kind,
    targetSnapshot: target,
    targetSnapshotHash: 'hash',
    provider: 'codex',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1',
    cwd: '/Test 1',
    commandRaw: 'npm run dev',
    argv: ['npm', 'run', 'dev'],
    status: 'running',
    startedAt: 't0',
    updatedAt: 't1',
    outputTail: '',
    outputTailBytes: 0,
    outputTruncated: false,
    chatId: 'chat-test-1',
    ...overrides
  }
}

function launchHandlerDeps(overrides: Partial<LaunchHandlerDeps> = {}): LaunchHandlerDeps {
  return {
    launchManager: {
      snapshot: vi.fn(() => ({ sampledAt: 't1', attempts: [] })),
      startTarget: vi.fn(),
      stopAttempt: vi.fn()
    } as any,
    resolveSenderLaunchScope: () => ({ kind: 'main' }),
    workspacePathsEqual: (left, right) => left === right,
    requireRegisteredWorkspace: (workspacePath) => workspacePath,
    findWorkspaceId: () => undefined,
    localServersSnapshot: () => ({ servers: [] }),
    platform: 'darwin',
    ...overrides
  }
}

describe('launch IPC parsers', () => {
  it('accepts launch-start payloads with optional chat and run ids', () => {
    expect(
      parseLaunchStartInput({
        workspacePath: '/repo',
        targetId: 'target-1',
        provider: 'codex',
        chatId: 'chat-1',
        runId: 'run-1'
      })
    ).toEqual({
      workspacePath: '/repo',
      targetId: 'target-1',
      provider: 'codex',
      chatId: 'chat-1',
      runId: 'run-1'
    })
  })

  it('rejects malformed launch-start payloads before discovery', () => {
    expect(() => parseLaunchStartInput(null)).toThrow('launch-start input is required.')
    expect(() =>
      parseLaunchStartInput({ workspacePath: '', targetId: 'target-1', provider: 'codex' })
    ).toThrow('workspacePath is required.')
    expect(() =>
      parseLaunchStartInput({ workspacePath: '/repo', targetId: 'target-1', provider: 'bad' })
    ).toThrow('provider is invalid.')
  })

  it('accepts and rejects launch-stop payloads by attempt id shape', () => {
    expect(parseLaunchStopInput({ attemptId: 'attempt-1' })).toEqual({ attemptId: 'attempt-1' })
    expect(() => parseLaunchStopInput(undefined)).toThrow('launch-stop input is required.')
    expect(() => parseLaunchStopInput({ attemptId: ' ' })).toThrow('attemptId is required.')
  })
})

describe('registerLaunchHandlers', () => {
  it('registers launch target discovery through the launch registrar', async () => {
    mockedDiscoverLaunchTargets.mockResolvedValue({
      workspacePath: '/repo/real',
      workspaceId: 'workspace-1',
      sampledAt: '2026-06-27T12:00:00.000Z',
      targets: [],
      platform: 'darwin',
      detectionAvailable: true
    })
    registerLaunchHandlers({
      launchManager: {
        snapshot: vi.fn(),
        startTarget: vi.fn(),
        stopAttempt: vi.fn()
      } as any,
      resolveSenderLaunchScope: () => ({ kind: 'main' }),
      workspacePathsEqual: (left, right) => left === right,
      requireRegisteredWorkspace: vi.fn(() => '/repo/real'),
      findWorkspaceId: vi.fn(() => 'workspace-1'),
      localServersSnapshot: vi.fn(() => ({
        servers: [
          {
            pid: 123,
            id: '123',
            name: 'npm run dev',
            command: 'npm run dev',
            cwd: '/repo/real',
            ports: [5173],
            startedAt: '2026-06-27T11:00:00.000Z',
            origin: 'detected' as const
          }
        ]
      })),
      platform: 'darwin'
    })

    const snapshotHandler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'launch-targets-snapshot'
    )?.[1]
    expect(snapshotHandler).toBeTypeOf('function')

    await expect(snapshotHandler?.({} as any, '/repo')).resolves.toEqual({
      workspacePath: '/repo/real',
      workspaceId: 'workspace-1',
      sampledAt: '2026-06-27T12:00:00.000Z',
      targets: [],
      platform: 'darwin',
      detectionAvailable: true
    })
    expect(mockedDiscoverLaunchTargets).toHaveBeenCalledWith({
      workspacePath: '/repo/real',
      workspaceId: 'workspace-1',
      localServers: [
        {
          pid: 123,
          id: '123',
          name: 'npm run dev',
          command: 'npm run dev',
          cwd: '/repo/real',
          ports: [5173],
          startedAt: '2026-06-27T11:00:00.000Z',
          origin: 'detected' as const
        }
      ],
      platform: 'darwin'
    })
  })

  it('rejects launch target discovery without a workspace path string', () => {
    registerLaunchHandlers({
      launchManager: {
        snapshot: vi.fn(),
        startTarget: vi.fn(),
        stopAttempt: vi.fn()
      } as any,
      resolveSenderLaunchScope: () => ({ kind: 'main' }),
      workspacePathsEqual: (left, right) => left === right,
      requireRegisteredWorkspace: vi.fn(),
      findWorkspaceId: vi.fn(),
      localServersSnapshot: vi.fn(() => ({ servers: [] })),
      platform: 'darwin'
    })
    const snapshotHandler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'launch-targets-snapshot'
    )?.[1]

    expect(() => snapshotHandler?.({} as any, undefined)).toThrow('Workspace path is required.')
  })

  it('filters persisted launch attempts to the owning chat and workspace for a popout', () => {
    const own = launchAttempt()
    const otherChat = launchAttempt({ id: 'attempt-other-chat', chatId: 'chat-test-1b' })
    const otherWorkspace = launchAttempt({
      id: 'attempt-test-3',
      workspaceId: 'workspace-test-3',
      workspacePath: '/Test 3'
    })

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot: vi.fn(() => ({
            sampledAt: 't1',
            attempts: [own, otherChat, otherWorkspace]
          })),
          startTarget: vi.fn(),
          stopAttempt: vi.fn()
        } as any,
        resolveSenderLaunchScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        })
      })
    )

    const handler = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'launch-attempts-snapshot'
    )?.[1]
    expect(handler?.({} as any)).toEqual({ sampledAt: 't1', attempts: [own] })
  })

  it('denies Test 1 popout target discovery and start requests for Test 3', async () => {
    const startTarget = vi.fn()
    const requireRegisteredWorkspace = vi.fn((workspacePath: string) => workspacePath)

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot: vi.fn(() => ({ sampledAt: 't1', attempts: [] })),
          startTarget,
          stopAttempt: vi.fn()
        } as any,
        resolveSenderLaunchScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        }),
        requireRegisteredWorkspace
      })
    )

    const targets = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'launch-targets-snapshot'
    )?.[1]
    const start = mockedHandle.mock.calls.find(([channel]) => channel === 'launch-start')?.[1]

    expect(() => targets?.({} as any, '/Test 3')).toThrow(
      'Launch data is unavailable to this renderer.'
    )
    await expect(
      start?.({ sender: {} } as any, {
        workspacePath: '/Test 3',
        targetId: 'target-test-3',
        provider: 'codex',
        chatId: 'chat-test-3'
      })
    ).rejects.toThrow('Launch data is unavailable to this renderer.')
    expect(mockedDiscoverLaunchTargets).not.toHaveBeenCalled()
    expect(startTarget).not.toHaveBeenCalled()
  })

  it('forces a popout launch start onto its owner chat', async () => {
    const target = launchTarget()
    const ownAttempt = launchAttempt()
    const startTarget = vi.fn(async () => ({ ok: true, attempt: ownAttempt }))
    mockedDiscoverLaunchTargets.mockResolvedValue({
      workspacePath: '/Test 1',
      workspaceId: 'workspace-test-1',
      sampledAt: 't1',
      targets: [target],
      platform: 'darwin',
      detectionAvailable: true
    })

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot: vi.fn(() => ({ sampledAt: 't1', attempts: [] })),
          startTarget,
          stopAttempt: vi.fn()
        } as any,
        resolveSenderLaunchScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        }),
        findWorkspaceId: () => 'workspace-test-1'
      })
    )

    const start = mockedHandle.mock.calls.find(([channel]) => channel === 'launch-start')?.[1]
    await expect(
      start?.({ sender: { id: 17 } } as any, {
        workspacePath: '/Test 1',
        targetId: target.id,
        provider: 'codex'
      })
    ).resolves.toEqual({ ok: true, attempt: ownAttempt })
    expect(startTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: { id: 17 },
        provider: 'codex',
        target,
        chatId: 'chat-test-1'
      })
    )
  })

  it('denies a popout launch start that names another chat in the same workspace', async () => {
    const startTarget = vi.fn()

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot: vi.fn(() => ({ sampledAt: 't1', attempts: [] })),
          startTarget,
          stopAttempt: vi.fn()
        } as any,
        resolveSenderLaunchScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        })
      })
    )

    const start = mockedHandle.mock.calls.find(([channel]) => channel === 'launch-start')?.[1]
    await expect(
      start?.({ sender: {} } as any, {
        workspacePath: '/Test 1',
        targetId: 'target-1',
        provider: 'codex',
        chatId: 'chat-test-1b'
      })
    ).rejects.toThrow('Launch data is unavailable to this renderer.')
    expect(mockedDiscoverLaunchTargets).not.toHaveBeenCalled()
    expect(startTarget).not.toHaveBeenCalled()
  })

  it('denies a popout from adopting another chat\'s active launch attempt', async () => {
    const target = launchTarget()
    const foreignAttempt = launchAttempt({ id: 'attempt-foreign', chatId: 'chat-test-3' })
    const startTarget = vi.fn()
    mockedDiscoverLaunchTargets.mockResolvedValue({
      workspacePath: '/Test 1',
      workspaceId: 'workspace-test-1',
      sampledAt: 't1',
      targets: [target],
      platform: 'darwin',
      detectionAvailable: true
    })

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot: vi.fn(() => ({ sampledAt: 't1', attempts: [foreignAttempt] })),
          startTarget,
          stopAttempt: vi.fn()
        } as any,
        resolveSenderLaunchScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        })
      })
    )

    const start = mockedHandle.mock.calls.find(([channel]) => channel === 'launch-start')?.[1]
    await expect(
      start?.({ sender: {} } as any, {
        workspacePath: '/Test 1',
        targetId: target.id,
        provider: 'codex'
      })
    ).rejects.toThrow('Launch data is unavailable to this renderer.')
    expect(startTarget).not.toHaveBeenCalled()
  })

  it('allows an owner to stop its launch attempt and denies a foreign attempt', async () => {
    const own = launchAttempt()
    const foreign = launchAttempt({ id: 'attempt-foreign', chatId: 'chat-test-3' })
    const snapshot = vi.fn(() => ({ sampledAt: 't1', attempts: [own, foreign] }))
    const stopAttempt = vi.fn(async (attemptId: string) => ({
      ok: true,
      attempt: attemptId === own.id ? own : foreign
    }))

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot,
          startTarget: vi.fn(),
          stopAttempt
        } as any,
        resolveSenderLaunchScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        })
      })
    )

    const stop = mockedHandle.mock.calls.find(([channel]) => channel === 'launch-stop')?.[1]
    await expect(stop?.({} as any, { attemptId: own.id })).resolves.toEqual({
      ok: true,
      attempt: own
    })
    await expect(stop?.({} as any, { attemptId: foreign.id })).rejects.toThrow(
      'Launch data is unavailable to this renderer.'
    )
    expect(stopAttempt).toHaveBeenCalledTimes(1)
    expect(stopAttempt).toHaveBeenCalledWith(own.id)
  })

  it('keeps main-renderer launch snapshots and stop behavior unrestricted', async () => {
    const foreign = launchAttempt({ id: 'attempt-test-3', chatId: 'chat-test-3' })
    const stopAttempt = vi.fn(async () => ({ ok: true, attempt: foreign }))

    registerLaunchHandlers(
      launchHandlerDeps({
        launchManager: {
          snapshot: vi.fn(() => ({ sampledAt: 't1', attempts: [foreign] })),
          startTarget: vi.fn(),
          stopAttempt
        } as any
      })
    )

    const snapshot = mockedHandle.mock.calls.find(
      ([channel]) => channel === 'launch-attempts-snapshot'
    )?.[1]
    const stop = mockedHandle.mock.calls.find(([channel]) => channel === 'launch-stop')?.[1]
    expect(snapshot?.({} as any)).toEqual({ sampledAt: 't1', attempts: [foreign] })
    await expect(stop?.({} as any, { attemptId: foreign.id })).resolves.toEqual({
      ok: true,
      attempt: foreign
    })
    expect(stopAttempt).toHaveBeenCalledWith(foreign.id)
  })
})
