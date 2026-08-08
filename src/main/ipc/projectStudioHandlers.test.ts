import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { ProjectStudioCompanionMeta } from '../../shared/projectStudio'
import {
  registerProjectStudioHandlers,
  type ProjectStudioHandlerDeps
} from './projectStudioHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

const draftArtifact: ProjectStudioCompanionMeta = {
  schemaVersion: 1,
  id: 'draft-1',
  projectId: 'project-a',
  kind: 'briefing',
  status: 'draft',
  title: 'Q3 Research Briefing',
  slug: 'q3-research-briefing',
  relativePath:
    '.taskwraith/project-library/project-a/studio/briefing/q3-research-briefing-2026-08-08.md',
  sourceReferenceIds: ['ref-a'],
  chatId: 'chat-a',
  createdAt: 100,
  updatedAt: 110
}

function createDeps(overrides: Partial<ProjectStudioHandlerDeps> = {}): ProjectStudioHandlerDeps {
  return {
    assertSenderCanManageProjects: vi.fn(),
    generateDraft: vi.fn(async () => ({ ok: true as const, artifact: draftArtifact })),
    saveToLibrary: vi.fn(async () => ({
      ok: true as const,
      artifact: {
        ...draftArtifact,
        status: 'saved' as const,
        referenceId: 'ref-studio-draft-1',
        updatedAt: 120
      }
    })),
    discardDraft: vi.fn(async () => ({
      ok: true as const,
      artifact: {
        ...draftArtifact,
        status: 'discarded' as const,
        discardedAt: 130,
        updatedAt: 130
      }
    })),
    listArtifacts: vi.fn(async () => ({ ok: true as const, artifacts: [draftArtifact] })),
    ...overrides
  }
}

const fakeEvent = {} as IpcMainInvokeEvent

describe('registerProjectStudioHandlers', () => {
  it('registers the four studio channels and gates every call', async () => {
    const deps = createDeps()
    registerProjectStudioHandlers(deps)

    expect(mockedHandle.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [
        'projects:studio-discard',
        'projects:studio-generate',
        'projects:studio-list',
        'projects:studio-save'
      ].sort()
    )

    const generate = handlerFor('projects:studio-generate')
    const save = handlerFor('projects:studio-save')
    const discard = handlerFor('projects:studio-discard')
    const list = handlerFor('projects:studio-list')

    await generate(fakeEvent, {
      projectId: 'project-a',
      kind: 'briefing',
      referenceIds: ['ref-a'],
      title: 'Q3 Research Briefing',
      chatId: 'chat-a',
      workspacePath: '/tmp/ws'
    })
    await save(fakeEvent, {
      projectId: 'project-a',
      draftId: 'draft-1',
      title: 'Q3 Research Briefing'
    })
    await discard(fakeEvent, { projectId: 'project-a', draftId: 'draft-1' })
    await list(fakeEvent, { projectId: 'project-a' })

    expect(deps.assertSenderCanManageProjects).toHaveBeenCalledTimes(4)
    expect(deps.generateDraft).toHaveBeenCalledWith({
      projectId: 'project-a',
      kind: 'briefing',
      referenceIds: ['ref-a'],
      title: 'Q3 Research Briefing',
      chatId: 'chat-a',
      workspacePath: '/tmp/ws'
    })
    expect(deps.saveToLibrary).toHaveBeenCalledWith({
      projectId: 'project-a',
      draftId: 'draft-1',
      title: 'Q3 Research Briefing'
    })
    expect(deps.discardDraft).toHaveBeenCalledWith({
      projectId: 'project-a',
      draftId: 'draft-1'
    })
    expect(deps.listArtifacts).toHaveBeenCalledWith({ projectId: 'project-a' })
  })

  it('rejects malformed generate payloads before invoking the service', async () => {
    const deps = createDeps()
    registerProjectStudioHandlers(deps)
    const generate = handlerFor('projects:studio-generate')
    await expect(
      generate(fakeEvent, {
        projectId: 'project-a',
        kind: 'memo',
        referenceIds: ['ref-a'],
        chatId: 'chat-a',
        workspacePath: '/tmp/ws'
      })
    ).rejects.toThrow(/Studio kind/i)
    expect(deps.generateDraft).not.toHaveBeenCalled()
  })
})
