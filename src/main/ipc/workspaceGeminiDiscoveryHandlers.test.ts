import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerWorkspaceGeminiDiscoveryHandlers } from './workspaceGeminiDiscoveryHandlers'
import type {
  GeminiCommandDiscoveryRecord,
  GeminiMemoryDiscoveryRecord
} from '../gemini/GeminiDiscovery'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function createDeps(
  overrides: Partial<Parameters<typeof registerWorkspaceGeminiDiscoveryHandlers>[0]> = {}
) {
  return {
    requireRegisteredWorkspace: vi.fn((workspace: string) => `/registered${workspace}`),
    assertSenderScope: vi.fn(),
    discoverGeminiCommands: vi.fn(async () => [] as GeminiCommandDiscoveryRecord[]),
    discoverGeminiMemory: vi.fn(async () => [] as GeminiMemoryDiscoveryRecord[]),
    ...overrides
  }
}

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerWorkspaceGeminiDiscoveryHandlers', () => {
  it('validates the workspace path before discovering Gemini commands', async () => {
    const commands: GeminiCommandDiscoveryRecord[] = [
      {
        command: 'review',
        label: 'review',
        scope: 'workspace',
        sourcePath: '/repo/.gemini/commands/review.md'
      }
    ]
    const deps = createDeps({
      requireRegisteredWorkspace: vi.fn(() => '/repo/real'),
      discoverGeminiCommands: vi.fn(async () => commands)
    })
    registerWorkspaceGeminiDiscoveryHandlers(deps)

    await expect(handlerFor('discover-gemini-commands')({} as any, '/repo')).resolves.toBe(
      commands
    )
    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(deps.assertSenderScope).toHaveBeenCalledWith(expect.anything(), '/repo')
    expect(deps.discoverGeminiCommands).toHaveBeenCalledWith('/repo/real')
  })

  it('validates the workspace path before discovering Gemini memory files', async () => {
    const memory: GeminiMemoryDiscoveryRecord[] = [
      {
        id: 'workspace:GEMINI.md',
        scope: 'workspace',
        path: '/repo/GEMINI.md',
        displayPath: 'GEMINI.md'
      }
    ]
    const deps = createDeps({
      requireRegisteredWorkspace: vi.fn(() => '/repo/real'),
      discoverGeminiMemory: vi.fn(async () => memory)
    })
    registerWorkspaceGeminiDiscoveryHandlers(deps)

    await expect(handlerFor('discover-gemini-memory')({} as any, '/repo')).resolves.toBe(memory)
    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(deps.assertSenderScope).toHaveBeenCalledWith(expect.anything(), '/repo')
    expect(deps.discoverGeminiMemory).toHaveBeenCalledWith('/repo/real')
  })

  it('does not discover commands when workspace validation fails', async () => {
    const error = new Error('Workspace is not registered')
    const deps = createDeps({
      requireRegisteredWorkspace: vi.fn(() => {
        throw error
      })
    })
    registerWorkspaceGeminiDiscoveryHandlers(deps)

    await expect(handlerFor('discover-gemini-commands')({} as any, '/missing')).rejects.toThrow(
      error
    )
    expect(deps.discoverGeminiCommands).not.toHaveBeenCalled()
  })

  it('does not discover memory when workspace validation fails', async () => {
    const error = new Error('Workspace is not registered')
    const deps = createDeps({
      requireRegisteredWorkspace: vi.fn(() => {
        throw error
      })
    })
    registerWorkspaceGeminiDiscoveryHandlers(deps)

    await expect(handlerFor('discover-gemini-memory')({} as any, '/missing')).rejects.toThrow(
      error
    )
    expect(deps.discoverGeminiMemory).not.toHaveBeenCalled()
  })

  it.each(['discover-gemini-commands', 'discover-gemini-memory'])(
    'rejects another renderer workspace before %s',
    async (channel) => {
      const deps = createDeps({
        assertSenderScope: vi.fn(() => {
          throw new Error('wrong workspace owner')
        })
      })
      registerWorkspaceGeminiDiscoveryHandlers(deps)

      await expect(handlerFor(channel)({} as any, '/other')).rejects.toThrow(
        'wrong workspace owner'
      )
      expect(deps.discoverGeminiCommands).not.toHaveBeenCalled()
      expect(deps.discoverGeminiMemory).not.toHaveBeenCalled()
    }
  )
})
