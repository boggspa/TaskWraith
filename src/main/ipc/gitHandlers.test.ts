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
      listBranches: vi.fn<GitHandlersDeps['gitService']['listBranches']>(async (path: string) => ({
        ok: true,
        data: {
          repoRoot: path,
          currentBranch: 'main',
          branches: [{ name: 'main', isCurrent: true }]
        }
      })),
      checkoutBranch: vi.fn<GitHandlersDeps['gitService']['checkoutBranch']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      createBranch: vi.fn<GitHandlersDeps['gitService']['createBranch']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      listWorktrees: vi.fn<GitHandlersDeps['gitService']['listWorktrees']>(async (path: string) => ({
        ok: true,
        data: {
          repoRoot: path,
          worktrees: [{ path, branch: 'main', isCurrent: true }]
        }
      })),
      createWorktree: vi.fn<GitHandlersDeps['gitService']['createWorktree']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      removeWorktree: vi.fn<GitHandlersDeps['gitService']['removeWorktree']>(async (input) => ({
        ok: true,
        data: input as any
      })),
      selectWorktree: vi.fn<GitHandlersDeps['gitService']['selectWorktree']>(async (input) => ({
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
    gitSnapshotPublisher: {
      subscribe: vi.fn<NonNullable<GitHandlersDeps['gitSnapshotPublisher']>['subscribe']>(
        async (subscription) => ({
          ok: true,
          data: {
            subscriptionId: subscription.subscriptionId,
            requestedPath: subscription.requestedPath,
            repoRoot: subscription.requestedPath,
            snapshot: { requestedPath: subscription.requestedPath, repoRoot: subscription.requestedPath } as any,
            generation: 1
          }
        })
      ),
      unsubscribe: vi.fn<NonNullable<GitHandlersDeps['gitSnapshotPublisher']>['unsubscribe']>(),
      unsubscribeWebContents:
        vi.fn<NonNullable<GitHandlersDeps['gitSnapshotPublisher']>['unsubscribeWebContents']>(),
      invalidatePath:
        vi.fn<NonNullable<GitHandlersDeps['gitSnapshotPublisher']>['invalidatePath']>(),
      publishSnapshot:
        vi.fn<NonNullable<GitHandlersDeps['gitSnapshotPublisher']>['publishSnapshot']>()
    },
    externalPublishReceipts: undefined as GitHandlersDeps['externalPublishReceipts'],
    openExternal: vi.fn<GitHandlersDeps['openExternal']>(async (_url: string) => undefined)
  } satisfies GitHandlersDeps

  return { deps }
}

describe('registerGitHandlers', () => {
  it('registers git and github IPC channels', () => {
    registerGitHandlers(createDeps().deps)

    expect(handlerFor('git:snapshot')).toBeTypeOf('function')
    expect(handlerFor('git:subscribe-snapshot')).toBeTypeOf('function')
    expect(handlerFor('git:unsubscribe-snapshot')).toBeTypeOf('function')
    expect(handlerFor('git:invalidate-snapshot')).toBeTypeOf('function')
    expect(handlerFor('git:stage')).toBeTypeOf('function')
    expect(handlerFor('git:unstage')).toBeTypeOf('function')
    expect(handlerFor('git:commit')).toBeTypeOf('function')
    expect(handlerFor('git:push')).toBeTypeOf('function')
    expect(handlerFor('git:list-branches')).toBeTypeOf('function')
    expect(handlerFor('git:checkout-branch')).toBeTypeOf('function')
    expect(handlerFor('git:create-branch')).toBeTypeOf('function')
    expect(handlerFor('git:list-worktrees')).toBeTypeOf('function')
    expect(handlerFor('git:create-worktree')).toBeTypeOf('function')
    expect(handlerFor('git:remove-worktree')).toBeTypeOf('function')
    expect(handlerFor('git:select-worktree')).toBeTypeOf('function')
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
    expect(deps.gitSnapshotPublisher.publishSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/repo' }),
      'git-action'
    )
  })

  it('exposes branch list and registered branch mutations', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    registerGitHandlers(deps)

    await expect(handlerFor('git:list-branches')({}, { workspacePath: '/repo' })).resolves.toEqual({
      ok: true,
      branches: [{ name: 'main', isCurrent: true }],
      currentBranch: 'main'
    })
    await expect(
      handlerFor('git:create-branch')({}, { workspacePath: '/repo', branch: 'feature/new', from: 'main' })
    ).resolves.toEqual({
      ok: true,
      snapshot: { repoPath: '/repo', branch: 'feature/new', from: 'main' }
    })
    await expect(
      handlerFor('git:checkout-branch')({}, { workspacePath: '/repo', branch: 'feature/new' })
    ).resolves.toEqual({
      ok: true,
      snapshot: { repoPath: '/repo', branch: 'feature/new' }
    })
    expect(deps.gitService.createBranch).toHaveBeenCalledWith({
      repoPath: '/repo',
      branch: 'feature/new',
      from: 'main'
    })
    expect(deps.gitSnapshotPublisher.publishSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature/new' }),
      'git-action'
    )
  })

  it('selects only linked worktrees for a registered repository', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    deps.gitService.listWorktrees.mockResolvedValue({
      ok: true,
      data: {
        repoRoot: '/repo',
        worktrees: [
          { path: '/repo', branch: 'main', isCurrent: true },
          { path: '/repo-worktrees/feature', branch: 'feature', isCurrent: false }
        ]
      }
    })
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:select-worktree')({}, {
        workspacePath: '/repo',
        path: '/repo-worktrees/feature'
      })
    ).resolves.toEqual({
      ok: true,
      snapshot: { repoPath: '/repo', path: '/repo-worktrees/feature' }
    })
    await expect(
      handlerFor('git:select-worktree')({}, { workspacePath: '/repo', path: '/tmp/not-linked' })
    ).resolves.toEqual({
      ok: false,
      error: 'Selected path is not a linked worktree for this repository.'
    })
    expect(deps.gitService.selectWorktree).toHaveBeenCalledTimes(1)
  })

  it('subscribes and invalidates live snapshots through the same read scope', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    const sender = {
      id: 7,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:subscribe-snapshot')({ sender }, { workspacePath: '/repo', subscriptionId: 'sub-1' })
    ).resolves.toEqual({
      ok: true,
      data: {
        subscriptionId: 'sub-1',
        requestedPath: '/repo',
        repoRoot: '/repo',
        snapshot: { requestedPath: '/repo', repoRoot: '/repo' },
        generation: 1
      }
    })
    expect(deps.gitSnapshotPublisher.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub-1',
        requestedPath: '/repo',
        webContentsId: 7
      })
    )

    await expect(
      handlerFor('git:invalidate-snapshot')({}, { workspacePath: '/repo', reason: 'run-diff' })
    ).resolves.toEqual({ ok: true })
    expect(deps.gitSnapshotPublisher.invalidatePath).toHaveBeenCalledWith('/repo', 'run-diff')

    await expect(
      handlerFor('git:unsubscribe-snapshot')({}, { subscriptionId: 'sub-1' })
    ).resolves.toEqual({ ok: true })
    expect(deps.gitSnapshotPublisher.unsubscribe).toHaveBeenCalledWith('sub-1')
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

  it('records an external-publish receipt before desktop git push side effects', async () => {
    const { deps } = createDeps()
    const events: string[] = []
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    deps.gitService.push.mockImplementationOnce(async (input) => {
      events.push('push')
      return {
        ok: true,
        data: { ...input, commit: 'abc123' } as any
      }
    })
    deps.externalPublishReceipts = {
      begin: vi.fn(async (input) => {
        events.push('begin')
        return {
          schemaVersion: 1,
          id: 'receipt-push',
          requestedAt: '2026-07-03T00:00:00.000Z',
          ...input
        } as any
      }),
      complete: vi.fn(async (input) => {
        events.push(`complete:${input.outcome}:${input.commitSha}`)
        return null
      })
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:push')({}, { workspacePath: '/repo', remote: 'origin', setUpstream: true })
    ).resolves.toEqual({
      ok: true,
      data: { repoPath: '/repo', remote: 'origin', setUpstream: true, commit: 'abc123' }
    })

    expect(events).toEqual(['begin', 'push', 'complete:completed:abc123'])
    expect(deps.externalPublishReceipts.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'desktop-ui',
        action: 'gitPush',
        decision: 'allowed',
        repoPath: '/repo',
        remote: 'origin',
        setUpstream: true
      })
    )
    expect(deps.gitSnapshotPublisher.publishSnapshot).toHaveBeenCalled()
  })

  it('blocks desktop git push when the external-publish receipt denies it', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    deps.externalPublishReceipts = {
      begin: vi.fn(async (input) => ({
        schemaVersion: 1,
        id: 'receipt-deny',
        requestedAt: '2026-07-03T00:00:00.000Z',
        ...input,
        decision: 'denied',
        reason: 'External publishing is blocked by policy.'
      }) as any),
      complete: vi.fn()
    }
    registerGitHandlers(deps)

    await expect(handlerFor('git:push')({}, { workspacePath: '/repo' })).resolves.toEqual({
      ok: false,
      error: 'External publishing is blocked by policy.'
    })

    expect(deps.gitService.push).not.toHaveBeenCalled()
    expect(deps.externalPublishReceipts.complete).not.toHaveBeenCalled()
    expect(deps.gitSnapshotPublisher.publishSnapshot).not.toHaveBeenCalled()
  })

  it('records PR receipt completion before opening the browser', async () => {
    const { deps } = createDeps()
    const events: string[] = []
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    deps.gitService.createPullRequest.mockImplementationOnce(async () => {
      events.push('create-pr')
      return { ok: true, data: { url: 'https://example.test/pr/1' } }
    })
    deps.openExternal.mockImplementationOnce(async () => {
      events.push('open-external')
    })
    deps.externalPublishReceipts = {
      begin: vi.fn(async (input) => {
        events.push('begin')
        return {
          schemaVersion: 1,
          id: 'receipt-pr',
          requestedAt: '2026-07-03T00:00:00.000Z',
          ...input
        } as any
      }),
      complete: vi.fn(async (input) => {
        events.push(`complete:${input.outcome}:${input.prUrl}`)
        return null
      })
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('create-github-pr')({}, { workspacePath: '/repo', title: 'Ship it' })
    ).resolves.toEqual({
      ok: true,
      url: 'https://example.test/pr/1'
    })

    expect(events).toEqual([
      'begin',
      'create-pr',
      'complete:completed:https://example.test/pr/1',
      'open-external'
    ])
    expect(deps.externalPublishReceipts.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'desktop-ui',
        action: 'githubCreatePr',
        decision: 'allowed',
        title: 'Ship it'
      })
    )
  })
})
