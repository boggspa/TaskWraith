import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerProjectHandlers, type ProjectHandlerDeps } from './projectHandlers'
import type { ProjectOp } from '../../shared/projects'

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

function createDeps() {
  const marker = {
    importedAt: 1,
    sourceHash: 'hash',
    importedCount: 2,
    status: 'imported' as const
  }
  const deps: ProjectHandlerDeps = {
    getProjects: vi.fn(() => []),
    getWorkProfiles: vi.fn(() => [{ projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 9 }]),
    getLegacyImportMarker: vi.fn(() => marker),
    applyProjectOp: vi.fn((op: ProjectOp) => ({
      projects: [],
      workProfiles: [],
      changed: op.kind !== 'delete'
    })),
    setProjectHomeChat: vi.fn(() => ({ projects: [], workProfiles: [], changed: true })),
    chatExists: vi.fn((chatId: string) => chatId !== 'chat-missing'),
    importLegacyProjects: vi.fn((rawJson: string | null) => ({
      status: rawJson === null ? ('nothing-to-import' as const) : ('imported' as const),
      importedCount: 0,
      marker
    })),
    assertSenderCanManageProjects: vi.fn()
  }
  return { deps, marker }
}

describe('registerProjectHandlers', () => {
  it('registers the four project channels', () => {
    registerProjectHandlers(createDeps().deps)
    expect(handlerFor('projects:snapshot')).toBeTypeOf('function')
    expect(handlerFor('projects:apply-op')).toBeTypeOf('function')
    expect(handlerFor('projects:set-home-chat')).toBeTypeOf('function')
    expect(handlerFor('projects:import-legacy')).toBeTypeOf('function')
  })

  it('guards every channel with the sender assertion', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    handlerFor('projects:snapshot')({})
    handlerFor('projects:apply-op')({}, { kind: 'delete', projectId: 'p' })
    handlerFor('projects:set-home-chat')({}, 'project-a', 'chat-1')
    handlerFor('projects:import-legacy')({}, null)
    expect(deps.assertSenderCanManageProjects).toHaveBeenCalledTimes(4)
  })

  it('returns projects, work profiles, and the import marker as the snapshot', () => {
    const { deps, marker } = createDeps()
    registerProjectHandlers(deps)
    expect(handlerFor('projects:snapshot')({})).toEqual({
      projects: [],
      workProfiles: [{ projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 9 }],
      legacyImportMarker: marker
    })
  })

  it('validates home-chat claims and gates them on chat existence', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    const handler = handlerFor('projects:set-home-chat')

    expect(handler({}, 'project-a', '  chat-1  ')).toEqual({
      projects: [],
      workProfiles: [],
      changed: true
    })
    expect(deps.setProjectHomeChat).toHaveBeenCalledWith('project-a', 'chat-1')

    handler({}, 'project-a', null)
    expect(deps.setProjectHomeChat).toHaveBeenCalledWith('project-a', null)
    handler({}, 'project-a', undefined)
    expect(deps.setProjectHomeChat).toHaveBeenLastCalledWith('project-a', null)

    expect(() => handler({}, '', 'chat-1')).toThrow('Project id is required.')
    expect(() => handler({}, 'project-a', 42)).toThrow('Malformed chat id.')
    expect(() => handler({}, 'project-a', '   ')).toThrow('Chat id is required.')
    expect(() => handler({}, 'project-a', 'chat-missing')).toThrow('Chat not found.')
    expect(deps.setProjectHomeChat).toHaveBeenCalledTimes(3)
  })

  it('parses ops before applying and rejects malformed payloads', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)

    const op: ProjectOp = { kind: 'rename', projectId: 'p', name: 'Next', now: 5 }
    expect(handlerFor('projects:apply-op')({}, op)).toEqual({
      projects: [],
      workProfiles: [],
      changed: true
    })
    expect(deps.applyProjectOp).toHaveBeenCalledWith(op)

    expect(() => handlerFor('projects:apply-op')({}, { kind: 'rename', projectId: 'p' })).toThrow(
      'Malformed project operation.'
    )
    expect(deps.applyProjectOp).toHaveBeenCalledTimes(1)
  })

  it('coerces non-string import payloads to null', () => {
    const { deps } = createDeps()
    registerProjectHandlers(deps)
    handlerFor('projects:import-legacy')({}, 42)
    expect(deps.importLegacyProjects).toHaveBeenCalledWith(null)
    handlerFor('projects:import-legacy')({}, '[]')
    expect(deps.importLegacyProjects).toHaveBeenCalledWith('[]')
  })
})
