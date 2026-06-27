import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { discoverLaunchTargets } from '../launchTargets/discovery'
import { parseLaunchStartInput, parseLaunchStopInput, registerLaunchHandlers } from './launchHandlers'

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
})
