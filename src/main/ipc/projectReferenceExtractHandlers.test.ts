import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { ProjectReferenceExtract } from '../../shared/projectReferenceExtract'
import {
  registerProjectReferenceExtractHandlers,
  type ProjectReferenceExtractHandlerDeps
} from './projectReferenceExtractHandlers'

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

const readyExtract: ProjectReferenceExtract = {
  schemaVersion: 1,
  id: 'extract-1',
  projectId: 'project-a',
  referenceId: 'ref-1',
  kind: 'url-html',
  status: 'ready',
  consent: { at: 1, actor: 'user', scope: 'this-reference' },
  source: { locator: 'https://example.com/a' },
  text: {
    charCount: 11,
    truncated: false,
    artifactSha256: 'a'.repeat(64)
  },
  createdAt: 1,
  updatedAt: 2
}

function createDeps(
  overrides: Partial<ProjectReferenceExtractHandlerDeps> = {}
): ProjectReferenceExtractHandlerDeps {
  return {
    assertSenderCanManageProjects: vi.fn(),
    requestExtract: vi.fn(async () => ({ ok: true as const, extract: readyExtract })),
    getActiveExtract: vi.fn(() => readyExtract),
    revokeExtract: vi.fn(() => ({
      ok: true as const,
      extract: { ...readyExtract, status: 'revoked' as const, revokedAt: 3, updatedAt: 3 }
    })),
    readExtractText: vi.fn(() => 'hello world'),
    ...overrides
  }
}

const fakeEvent = {} as IpcMainInvokeEvent

describe('registerProjectReferenceExtractHandlers', () => {
  it('registers the four extract channels and gates every call', async () => {
    const deps = createDeps()
    registerProjectReferenceExtractHandlers(deps)

    expect(mockedHandle.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [
        'projects:extract-reference',
        'projects:get-reference-extract',
        'projects:read-reference-extract-text',
        'projects:revoke-reference-extract'
      ].sort()
    )

    const extract = handlerFor('projects:extract-reference')
    const get = handlerFor('projects:get-reference-extract')
    const revoke = handlerFor('projects:revoke-reference-extract')
    const read = handlerFor('projects:read-reference-extract-text')

    await extract(fakeEvent, {
      projectId: 'project-a',
      referenceId: 'ref-1',
      consent: { at: 1, actor: 'user', scope: 'this-reference' }
    })
    get(fakeEvent, { projectId: 'project-a', referenceId: 'ref-1' })
    revoke(fakeEvent, { extractId: 'extract-1' })
    read(fakeEvent, { extractId: 'extract-1', maxChars: 5 })

    expect(deps.assertSenderCanManageProjects).toHaveBeenCalledTimes(4)
    expect(deps.requestExtract).toHaveBeenCalledWith({
      projectId: 'project-a',
      referenceId: 'ref-1',
      consent: { at: 1, actor: 'user', scope: 'this-reference' }
    })
    expect(deps.getActiveExtract).toHaveBeenCalledWith('project-a', 'ref-1')
    expect(deps.revokeExtract).toHaveBeenCalledWith('extract-1')
    expect(deps.readExtractText).toHaveBeenCalledWith('extract-1')
  })

  it('bounds read-reference-extract-text to the requested maxChars', () => {
    const deps = createDeps({
      readExtractText: vi.fn(() => 'abcdefghij')
    })
    registerProjectReferenceExtractHandlers(deps)
    const read = handlerFor('projects:read-reference-extract-text')
    const result = read(fakeEvent, { extractId: 'extract-1', maxChars: 4 })
    expect(result).toEqual({
      ok: true,
      text: 'abcd',
      truncated: true,
      charCount: 10
    })
  })

  it('rejects malformed extract requests before calling the service', async () => {
    const deps = createDeps()
    registerProjectReferenceExtractHandlers(deps)
    const extract = handlerFor('projects:extract-reference')
    await expect(
      extract(fakeEvent, { projectId: 'project-a', referenceId: 'ref-1' })
    ).rejects.toThrow(/consent/i)
    expect(deps.requestExtract).not.toHaveBeenCalled()
  })
})
