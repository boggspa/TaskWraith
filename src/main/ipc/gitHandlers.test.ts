import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ChatRecord, ExternalPathGrant } from '../store/types'
import { registerGitHandlers, type GitHandlersDeps } from './gitHandlers'

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

function createGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-1',
    provider: 'codex',
    path: '/granted/repo',
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    createdAt: '2026-06-30T12:00:00.000Z',
    issuedBy: 'main',
    signature: 'sig',
    ...overrides
  } as ExternalPathGrant
}

function createChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    providerMetadata: {},
    ...overrides
  } as unknown as ChatRecord
}

function createDeps() {
  const deps = {
    getChats: vi.fn<GitHandlersDeps['getChats']>(() => []),
    externalPathGrantMetadataLists: vi.fn<GitHandlersDeps['externalPathGrantMetadataLists']>(
      (_chat: ChatRecord | null | undefined) => [] as ExternalPathGrant[]
    ),
    normalizeExternalPathGrants: vi.fn<GitHandlersDeps['normalizeExternalPathGrants']>(
      (grants?: ExternalPathGrant[]) => grants || []
    ),
    canonicalExternalGrantPath: vi.fn<GitHandlersDeps['canonicalExternalGrantPath']>(
      (_value: string) => null
    ),
    canonicalPath: vi.fn<GitHandlersDeps['canonicalPath']>((value: string) => value.trim()),
    findRegisteredWorkspace: vi.fn<GitHandlersDeps['findRegisteredWorkspace']>(
      (_workspacePath: string) => undefined
    ),
    resolvePath: vi.fn<GitHandlersDeps['resolvePath']>((value: string) => value),
    pathSeparator: '/',
    gitService: {
      snapshot: vi.fn<GitHandlersDeps['gitService']['snapshot']>(async (path: string) => ({
        ok: true,
        data: { requestedPath: path } as any
      })),
      stage: vi.fn<GitHandlersDeps['gitService']['stage']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      unstage: vi.fn<GitHandlersDeps['gitService']['unstage']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      commit: vi.fn<GitHandlersDeps['gitService']['commit']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      push: vi.fn<GitHandlersDeps['gitService']['push']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      pullRequestStatus: vi.fn<GitHandlersDeps['gitService']['pullRequestStatus']>(
        async (path: string) => ({ ok: true, data: { url: `status:${path}` } })
      ),
      pullRequestReadiness: vi.fn<GitHandlersDeps['gitService']['pullRequestReadiness']>(
        async (path: string) => ({ ok: true, data: { reason: `ready:${path}` } as any })
      ),
      createPullRequest: vi.fn<GitHandlersDeps['gitService']['createPullRequest']>(
        async () => ({ ok: true, data: { url: 'https://example.test/pr/1' } })
      )
    },
    openExternal: vi.fn<GitHandlersDeps['openExternal']>(async (_url: string) => undefined)
  } satisfies GitHandlersDeps

  return { deps }
}

describe('registerGitHandlers', () => {
  it('registers git and github IPC channels', () => {
    registerGitHandlers(createDeps().deps)

    expect(handlerFor('git:snapshot')).toBeTypeOf('function')
    expect(handlerFor('git:stage')).toBeTypeOf('function')
    expect(handlerFor('git:unstage')).toBeTypeOf('function')
    expect(handlerFor('git:commit')).toBeTypeOf('function')
    expect(handlerFor('git:push')).toBeTypeOf('function')
    expect(handlerFor('github:pr-status')).toBeTypeOf('function')
    expect(handlerFor('github:pr-readiness')).toBeTypeOf('function')
    expect(handlerFor('create-github-pr')).toBeTypeOf('function')
  })

  it('returns the required path error when payload has no repoPath or workspacePath', async () => {
    const { deps } = createDeps()
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')({}, {})).resolves.toEqual({
      ok: false,
      error: 'Repository path is required.'
    })
  })

  it('allows registered workspaces for snapshot and mutating actions', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')({}, { workspacePath: '/repo' })).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/repo' }
    })
    await expect(
      handlerFor('git:snapshot')({}, { workspacePath: '/workspace', repoPath: '  /preferred-repo  ' })
    ).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/preferred-repo' }
    })
    await expect(
      handlerFor('git:stage')({}, { workspacePath: '/repo', paths: ['a.ts'], all: true })
    ).resolves.toEqual({
      ok: true,
      data: {
        repoPath: '/repo',
        paths: ['a.ts'],
        all: true,
        update: undefined,
        patch: undefined
      }
    })
    expect(deps.gitService.stage).toHaveBeenCalledWith({
      repoPath: '/repo',
      paths: ['a.ts'],
      all: true,
      update: undefined,
      patch: undefined
    })
  })

  it('allows signed external grants only for git:snapshot and rejects mutating actions', async () => {
    const { deps } = createDeps()
    deps.getChats.mockReturnValue([createChat()])
    deps.externalPathGrantMetadataLists.mockReturnValue([createGrant()])
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')({}, { repoPath: '/granted/repo/subdir' })).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/granted/repo/subdir' }
    })

    await expect(handlerFor('git:stage')({}, { repoPath: '/granted/repo/subdir' })).resolves.toEqual({
      ok: false,
      error: 'Git actions are limited to registered workspaces.'
    })
  })

  it('preserves path normalization and directory grant boundary matching', async () => {
    const { deps } = createDeps()
    deps.getChats.mockReturnValue([createChat()])
    deps.externalPathGrantMetadataLists.mockReturnValue([
      createGrant({ path: '/granted/repo/' })
    ])
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')({}, { repoPath: '  /granted/repo/subdir/  ' })).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/granted/repo/subdir/' }
    })

    await expect(handlerFor('git:snapshot')({}, { repoPath: '/granted/repo-evil' })).resolves.toEqual({
      ok: false,
      error: 'Git inspection is limited to registered workspaces or signed external path grants.'
    })
  })

  it('create-github-pr preserves openExternal gating and success/raw result behavior', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    registerGitHandlers(deps)

    await expect(
      handlerFor('create-github-pr')({}, { workspacePath: '/repo', title: 'T', openInBrowser: true })
    ).resolves.toEqual({
      ok: true,
      url: 'https://example.test/pr/1'
    })
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.test/pr/1')

    deps.openExternal.mockClear()
    await handlerFor('create-github-pr')({}, { workspacePath: '/repo' })
    expect(deps.openExternal).toHaveBeenCalledWith('https://example.test/pr/1')

    deps.openExternal.mockClear()
    await handlerFor('create-github-pr')({}, { workspacePath: '/repo', openInBrowser: false })
    expect(deps.openExternal).not.toHaveBeenCalled()

    deps.gitService.createPullRequest.mockResolvedValueOnce({ ok: true, data: {} as any })
    await handlerFor('create-github-pr')({}, { workspacePath: '/repo' })
    expect(deps.openExternal).not.toHaveBeenCalled()

    deps.gitService.createPullRequest.mockResolvedValueOnce({ ok: false, error: 'failed' })
    await expect(handlerFor('create-github-pr')({}, { workspacePath: '/repo' })).resolves.toEqual({
      ok: false,
      error: 'failed'
    })
  })
})
