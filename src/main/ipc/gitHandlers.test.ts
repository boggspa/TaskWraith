import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { GitRepositorySnapshot } from '../services/GitService'
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
    getChat: vi.fn<GitHandlersDeps['getChat']>(() => undefined),
    executableExternalPathGrantsForChat: vi.fn<
      GitHandlersDeps['executableExternalPathGrantsForChat']
    >(
      (_chat: ChatRecord | null | undefined) => [] as ExternalPathGrant[]
    ),
    canonicalExternalGrantPath: vi.fn<GitHandlersDeps['canonicalExternalGrantPath']>(
      (_value: string) => null
    ),
    canonicalPath: vi.fn<GitHandlersDeps['canonicalPath']>((value: string) => value.trim()),
    findRegisteredWorkspace: vi.fn<GitHandlersDeps['findRegisteredWorkspace']>(
      (_workspacePath: string) => undefined
    ),
    gitRepositoryRootForPath: vi.fn<GitHandlersDeps['gitRepositoryRootForPath']>(
      (workspacePath) => workspacePath
    ),
    externalGitRepositoryRootIsSelfContained: vi.fn<
      GitHandlersDeps['externalGitRepositoryRootIsSelfContained']
    >(() => true),
    resolvePath: vi.fn<GitHandlersDeps['resolvePath']>((value: string) => value),
    pathSeparator: '/',
    gitService: {
      snapshot: vi.fn<GitHandlersDeps['gitService']['snapshot']>(async (path: string) => ({
        ok: true,
        data: { requestedPath: path } as any
      })),
      unpushedCommits: vi.fn<GitHandlersDeps['gitService']['unpushedCommits']>(
        async (path: string) => ({
          ok: true,
          data: {
            repoRoot: path,
            branch: 'main',
            comparison: 'upstream',
            observedAt: '2026-08-12T00:00:00.000Z',
            commits: []
          }
        })
      ),
      pullRequestWorkspace: vi.fn<GitHandlersDeps['gitService']['pullRequestWorkspace']>(
        async (path: string) => ({
          ok: true,
          data: {
            repoRoot: path,
            available: true,
            defaultBaseBranch: 'master',
            pullRequests: [],
            warnings: []
          }
        })
      ),
      createCommitGroupPullRequest: vi.fn<
        GitHandlersDeps['gitService']['createCommitGroupPullRequest']
      >(async (input) => ({
        ok: true,
        data: {
          branch: input.branch,
          baseBranch: input.baseBranch,
          commitHashes: input.commits,
          headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pullRequest: {
            number: 42,
            url: 'https://example.test/pr/42',
            state: 'OPEN',
            headRefName: input.branch,
            baseRefName: input.baseBranch
          },
          warnings: []
        }
      })),
      managePullRequest: vi.fn<GitHandlersDeps['gitService']['managePullRequest']>(
        async (input) => ({
          ok: true,
          data: {
            pullRequest: {
              number: input.pullRequestNumber,
              url: `https://example.test/pr/${input.pullRequestNumber}`,
              state: input.lifecycle.action === 'close' ? 'CLOSED' : 'OPEN'
            },
            warnings: []
          }
        })
      ),
      workspaceStats: vi.fn<GitHandlersDeps['gitService']['workspaceStats']>(
        async (path: string) => ({
          ok: true,
          data: {
            repoRoot: path,
            observedAt: '2026-08-03T19:00:00.000Z',
            coherent: true,
            totalCommits: 1
          } as any
        })
      ),
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
      ),
      ciStatus: vi.fn<GitHandlersDeps['gitService']['ciStatus']>(async (input) => ({
        ok: true,
        data: {
          status: 'passed',
          binding: { branch: input.branch, commitSha: input.commitSha },
          checks: [],
          runs: [],
          failedLogs: []
        } as any
      }))
    },
    workProvenanceService: {
      query: vi.fn<GitHandlersDeps['workProvenanceService']['query']>(async (path: string) => ({
        available: true,
        stale: false,
        repository: { root: path },
        workItems: []
      }) as any)
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
    openSafeShellTarget: vi.fn<GitHandlersDeps['openSafeShellTarget']>(
      async (_url: unknown) => ({ ok: true })
    ),
    assertSenderScope: vi.fn<GitHandlersDeps['assertSenderScope']>()
  } satisfies GitHandlersDeps

  return { deps }
}

describe('registerGitHandlers', () => {
  it('registers git and github IPC channels', () => {
    registerGitHandlers(createDeps().deps)

    expect(handlerFor('git:snapshot')).toBeTypeOf('function')
    expect(handlerFor('git:unpushed-commits')).toBeTypeOf('function')
    expect(handlerFor('github:pr-workspace')).toBeTypeOf('function')
    expect(handlerFor('github:create-commit-group-pr')).toBeTypeOf('function')
    expect(handlerFor('github:manage-pr')).toBeTypeOf('function')
    expect(handlerFor('git:workspace-stats')).toBeTypeOf('function')
    expect(handlerFor('git:work-provenance')).toBeTypeOf('function')
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
    expect(handlerFor('github:ci-status')).toBeTypeOf('function')
    expect(handlerFor('create-github-pr')).toBeTypeOf('function')
  })

  it('returns the required path error when payload has no repoPath or workspacePath', async () => {
    const { deps } = createDeps()
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')({}, {})).resolves.toEqual({
      ok: false,
      error: 'Repository path is required.'
    })
    expect(deps.canonicalPath).not.toHaveBeenCalled()
    expect(deps.gitRepositoryRootForPath).not.toHaveBeenCalled()
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
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
      handlerFor('git:unpushed-commits')({}, { workspacePath: '/repo' })
    ).resolves.toEqual({
      ok: true,
      data: {
        repoRoot: '/repo',
        branch: 'main',
        comparison: 'upstream',
        observedAt: '2026-08-12T00:00:00.000Z',
        commits: []
      }
    })
    expect(deps.gitService.unpushedCommits).toHaveBeenCalledWith('/repo', undefined)
    await handlerFor('git:unpushed-commits')(
      {},
      { workspacePath: '/repo', page: { offset: 50, limit: 25 } }
    )
    expect(deps.gitService.unpushedCommits).toHaveBeenLastCalledWith('/repo', {
      offset: 50,
      limit: 25
    })
    await expect(
      handlerFor('git:workspace-stats')({}, { workspacePath: '/repo', chatId: 'chat-1' })
    ).resolves.toEqual({
      ok: true,
      data: {
        repoRoot: '/repo',
        observedAt: '2026-08-03T19:00:00.000Z',
        coherent: true,
        totalCommits: 1
      }
    })
    expect(deps.gitService.workspaceStats).toHaveBeenCalledWith('/repo')
    await expect(
      handlerFor('git:work-provenance')({}, { workspacePath: '/repo', chatId: 'chat-1' })
    ).resolves.toEqual({
      ok: true,
      data: {
        available: true,
        stale: false,
        repository: { root: '/repo' },
        workItems: []
      }
    })
    expect(deps.workProvenanceService.query).toHaveBeenCalledWith('/repo')
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

  it('routes detailed snapshots through the injected utility-process reader', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    const gitSnapshot = vi.fn(async (path: string) => ({
      ok: true as const,
      data: { requestedPath: path } as GitRepositorySnapshot
    }))
    registerGitHandlers({ ...deps, gitSnapshot })

    await expect(
      handlerFor('git:snapshot')({}, { workspacePath: '/repo' })
    ).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/repo' }
    })
    expect(gitSnapshot).toHaveBeenCalledWith('/repo')
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
  })

  it('resolves Workspace Stats only to a linked worktree under an authorized workspace', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockImplementation((path: string) =>
      path === '/repo' ? { id: 'ws-1' } : undefined
    )
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

    await handlerFor('git:workspace-stats')({}, {
      workspacePath: '/repo',
      worktreePath: '/repo-worktrees/feature'
    })

    expect(deps.gitService.listWorktrees).toHaveBeenCalledWith('/repo')
    expect(deps.gitService.workspaceStats).toHaveBeenCalledWith('/repo-worktrees/feature')

    await handlerFor('git:work-provenance')({}, {
      workspacePath: '/repo',
      worktreePath: '/repo-worktrees/feature'
    })
    expect(deps.workProvenanceService.query).toHaveBeenCalledWith('/repo-worktrees/feature')

    await expect(
      handlerFor('git:workspace-stats')({}, {
        workspacePath: '/repo',
        worktreePath: '/tmp/not-a-linked-worktree'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Selected path is not a linked worktree for this repository.'
    })
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

  it('allows mutating git actions for signed write-granted external repos', async () => {
    const { deps } = createDeps()
    const grant = createGrant({ path: '/granted/repo', access: 'write' })
    const chat = createChat()
    deps.getChat.mockReturnValue(chat)
    deps.executableExternalPathGrantsForChat.mockReturnValue([grant])
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:create-branch')(
        {},
        { repoPath: '/granted/repo', chatId: 'chat-1', branch: 'feature/new' }
      )
    ).resolves.toEqual({
      ok: true,
      snapshot: { repoPath: '/granted/repo', branch: 'feature/new', from: undefined }
    })
    await expect(
      handlerFor('git:stage')({}, { repoPath: '/granted/repo', chatId: 'chat-1', all: true })
    ).resolves.toEqual({
      ok: true,
      data: {
        repoPath: '/granted/repo',
        paths: undefined,
        all: true,
        update: undefined,
        patch: undefined
      }
    })
    await expect(
      handlerFor('create-github-pr')(
        {},
        { repoPath: '/granted/repo', chatId: 'chat-1', title: 'Ship it' }
      )
    ).resolves.toEqual({
      ok: true,
      url: 'https://example.test/pr/1'
    })
    expect(deps.gitService.createBranch).toHaveBeenCalledWith({
      repoPath: '/granted/repo',
      branch: 'feature/new',
      from: undefined
    })
    expect(deps.gitService.stage).toHaveBeenCalledWith({
      repoPath: '/granted/repo',
      paths: undefined,
      all: true,
      update: undefined,
      patch: undefined
    })
    expect(deps.gitService.createPullRequest).toHaveBeenCalledWith({
      repoPath: '/granted/repo',
      title: 'Ship it',
      body: undefined,
      draft: undefined
    })
  })

  it('keeps signed read-granted external repos inspection-only', async () => {
    const { deps } = createDeps()
    const grant = createGrant({ path: '/granted/repo', access: 'read' })
    const chat = createChat()
    deps.getChat.mockReturnValue(chat)
    deps.executableExternalPathGrantsForChat.mockReturnValue([grant])
    registerGitHandlers(deps)

    await expect(handlerFor('git:list-branches')(
      {},
      { repoPath: '/granted/repo', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: true,
      branches: [{ name: 'main', isCurrent: true }],
      currentBranch: 'main'
    })
    await expect(
      handlerFor('git:stage')({}, { repoPath: '/granted/repo', chatId: 'chat-1', all: true })
    ).resolves.toEqual({
      ok: false,
      error: 'Git actions require a signed external write grant for this repository.',
      errorCode: 'git_scope_external_write_grant_required'
    })
    expect(deps.gitService.stage).not.toHaveBeenCalled()
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
      handlerFor('git:unsubscribe-snapshot')({ sender }, { subscriptionId: 'sub-1' })
    ).resolves.toEqual({ ok: true })
    expect(deps.gitSnapshotPublisher.unsubscribe).toHaveBeenCalledWith('sub-1')
  })

  it('revalidates a live subscription without probing the Git root again', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    const sender = {
      id: 10,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:subscribe-snapshot')(
        { sender },
        { workspacePath: '/repo', subscriptionId: 'sub-no-reprobe' }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(deps.gitRepositoryRootForPath).toHaveBeenCalledTimes(1)

    const subscription = vi.mocked(deps.gitSnapshotPublisher!.subscribe).mock.calls[0][0]
    deps.gitRepositoryRootForPath.mockImplementation(() => {
      throw new Error('Git root must stay bound after subscribe.')
    })
    subscription.send({
      subscriptionId: 'sub-no-reprobe',
      requestedPath: '/repo',
      repoRoot: '/repo',
      snapshot: { requestedPath: '/repo', repoRoot: '/repo' } as GitRepositorySnapshot,
      generation: 2,
      reason: 'filesystem'
    })

    expect(sender.send).toHaveBeenCalledWith(
      'git:snapshot-changed',
      expect.objectContaining({ subscriptionId: 'sub-no-reprobe', repoRoot: '/repo' })
    )
    expect(deps.gitRepositoryRootForPath).toHaveBeenCalledTimes(1)
  })

  it('cleans up a live subscription when renderer scope revalidation throws', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    const sender = {
      id: 11,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:subscribe-snapshot')(
        { sender },
        { workspacePath: '/repo', subscriptionId: 'sub-scope-revoked' }
      )
    ).resolves.toMatchObject({ ok: true })
    const subscription = vi.mocked(deps.gitSnapshotPublisher!.subscribe).mock.calls[0][0]
    deps.assertSenderScope.mockImplementationOnce(() => {
      throw new Error('Renderer workspace scope denied.')
    })

    expect(() =>
      subscription.send({
        subscriptionId: 'sub-scope-revoked',
        requestedPath: '/repo',
        repoRoot: '/repo',
        snapshot: { requestedPath: '/repo', repoRoot: '/repo' } as GitRepositorySnapshot,
        generation: 2,
        reason: 'filesystem'
      })
    ).not.toThrow()
    expect(sender.send).not.toHaveBeenCalled()
    expect(deps.gitSnapshotPublisher!.unsubscribe).toHaveBeenCalledWith('sub-scope-revoked')
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('binds Git requests and live snapshot subscriptions to the invoking renderer', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    const owner = {
      id: 17,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    const attacker = { ...owner, id: 18 }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')(
        { sender: owner },
        { workspacePath: '/repo', chatId: 'chat-1' }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      { sender: owner },
      { capability: 'git', chatId: 'chat-1', workspacePath: '/repo' }
    )

    await expect(
      handlerFor('git:subscribe-snapshot')(
        { sender: owner },
        { workspacePath: '/repo', chatId: 'chat-1', subscriptionId: 'owned-sub' }
      )
    ).resolves.toMatchObject({ ok: true })
    await expect(
      handlerFor('git:unsubscribe-snapshot')(
        { sender: attacker },
        { subscriptionId: 'owned-sub' }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Git snapshot subscription id belongs to another renderer.'
    })
    expect(deps.gitSnapshotPublisher.unsubscribe).not.toHaveBeenCalledWith('owned-sub')

    await expect(
      handlerFor('git:unsubscribe-snapshot')(
        { sender: owner },
        { subscriptionId: 'owned-sub' }
      )
    ).resolves.toEqual({ ok: true })
    expect(deps.gitSnapshotPublisher.unsubscribe).toHaveBeenCalledWith('owned-sub')
  })

  it('fails closed before invoking Git when the renderer scope check rejects', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    deps.assertSenderScope.mockImplementationOnce(() => {
      throw new Error('Renderer workspace scope denied.')
    })
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')(
        { sender: { id: 22 } },
        { workspacePath: '/repo', chatId: 'chat-1' }
      )
    ).rejects.toThrow('Renderer workspace scope denied.')
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
  })

  it('closes an external snapshot subscription when its originating chat loses the grant', async () => {
    const { deps } = createDeps()
    const chat = createChat()
    deps.getChat.mockReturnValue(chat)
    deps.executableExternalPathGrantsForChat.mockReturnValue([createGrant()])
    const sender = {
      id: 8,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:subscribe-snapshot')(
        { sender },
        { repoPath: '/granted/repo', chatId: 'chat-1', subscriptionId: 'sub-external' }
      )
    ).resolves.toMatchObject({ ok: true })

    const subscription = vi.mocked(deps.gitSnapshotPublisher!.subscribe).mock.calls[0][0]
    deps.executableExternalPathGrantsForChat.mockReturnValue([])
    subscription.send({
      subscriptionId: 'sub-external',
      requestedPath: '/granted/repo',
      repoRoot: '/granted/repo',
      snapshot: {
        requestedPath: '/granted/repo',
        repoRoot: '/granted/repo'
      } as GitRepositorySnapshot,
      generation: 2,
      reason: 'filesystem'
    })

    expect(sender.send).not.toHaveBeenCalled()
    expect(deps.gitSnapshotPublisher!.unsubscribe).toHaveBeenCalledWith('sub-external')
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(deps.externalGitRepositoryRootIsSelfContained).toHaveBeenCalledTimes(3)
  })

  it('closes an external snapshot subscription when its self-contained Git marker changes', async () => {
    const { deps } = createDeps()
    const chat = createChat()
    deps.getChat.mockReturnValue(chat)
    deps.executableExternalPathGrantsForChat.mockReturnValue([createGrant()])
    const sender = {
      id: 12,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:subscribe-snapshot')(
        { sender },
        { repoPath: '/granted/repo', chatId: 'chat-1', subscriptionId: 'sub-marker' }
      )
    ).resolves.toMatchObject({ ok: true })

    const subscription = vi.mocked(deps.gitSnapshotPublisher!.subscribe).mock.calls[0][0]
    deps.externalGitRepositoryRootIsSelfContained.mockReturnValue(false)
    subscription.send({
      subscriptionId: 'sub-marker',
      requestedPath: '/granted/repo',
      repoRoot: '/granted/repo',
      snapshot: {
        requestedPath: '/granted/repo',
        repoRoot: '/granted/repo'
      } as GitRepositorySnapshot,
      generation: 2,
      reason: 'filesystem'
    })

    expect(sender.send).not.toHaveBeenCalled()
    expect(deps.gitSnapshotPublisher!.unsubscribe).toHaveBeenCalledWith('sub-marker')
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('rejects an initial external snapshot when its grant is revoked while subscribe is pending', async () => {
    const { deps } = createDeps()
    const chat = createChat()
    deps.getChat.mockReturnValue(chat)
    deps.executableExternalPathGrantsForChat.mockReturnValue([createGrant()])
    let resolveSubscribe!: (value: {
      ok: true
      data: {
        subscriptionId: string
        requestedPath: string
        repoRoot: string
        snapshot: GitRepositorySnapshot
        generation: number
      }
    }) => void
    deps.gitSnapshotPublisher!.subscribe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        })
    )
    const sender = {
      id: 9,
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      once: vi.fn(),
      removeListener: vi.fn()
    }
    registerGitHandlers(deps)

    const pending = handlerFor('git:subscribe-snapshot')(
      { sender },
      { repoPath: '/granted/repo', chatId: 'chat-1', subscriptionId: 'sub-revoked' }
    ) as Promise<unknown>
    expect(deps.gitSnapshotPublisher!.subscribe).toHaveBeenCalledTimes(1)

    deps.executableExternalPathGrantsForChat.mockReturnValue([])
    resolveSubscribe({
      ok: true,
      data: {
        subscriptionId: 'sub-revoked',
        requestedPath: '/granted/repo',
        repoRoot: '/granted/repo',
        snapshot: {
          requestedPath: '/granted/repo',
          repoRoot: '/granted/repo'
        } as GitRepositorySnapshot,
        generation: 1
      }
    })

    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'Git snapshot authorization changed while the subscription was starting.'
    })
    expect(sender.send).not.toHaveBeenCalled()
    expect(deps.gitSnapshotPublisher!.unsubscribe).toHaveBeenCalledWith('sub-revoked')
    expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('allows signed external grants for read-only git/PR inspection and rejects mutating actions', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([createGrant()])
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')(
      {},
      { repoPath: '/granted/repo', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/granted/repo' }
    })
    await expect(handlerFor('github:pr-status')(
      {},
      { repoPath: '/granted/repo', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: true,
      data: { url: 'status:/granted/repo' }
    })
    await expect(handlerFor('github:pr-readiness')(
      {},
      { repoPath: '/granted/repo', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: true,
      data: { reason: 'ready:/granted/repo' }
    })

    await expect(handlerFor('git:stage')(
      {},
      { repoPath: '/granted/repo', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: false,
      error: 'Git actions require a signed external write grant for this repository.',
      errorCode: 'git_scope_external_write_grant_required'
    })
  })

  it('requires the originating chat for an external-repository grant', async () => {
    const { deps } = createDeps()
    const chatA = createChat({ appChatId: 'chat-a' })
    deps.getChat.mockImplementation((chatId) => (chatId === 'chat-a' ? chatA : undefined))
    deps.executableExternalPathGrantsForChat.mockImplementation((chat) =>
      chat?.appChatId === 'chat-a' ? [createGrant({ chatId: 'chat-a' })] : []
    )
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')({}, { repoPath: '/granted/repo', chatId: 'chat-a' })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      handlerFor('git:snapshot')({}, { repoPath: '/granted/repo', chatId: 'chat-b' })
    ).resolves.toEqual({
      ok: false,
      error:
        'Git inspection for an external repository requires an originating chat with a signed path grant.',
      errorCode: 'git_scope_external_chat_required'
    })
    await expect(
      handlerFor('git:snapshot')({}, { repoPath: '/granted/repo' })
    ).resolves.toEqual({
      ok: false,
      error:
        'Git inspection for an external repository requires an originating chat with a signed path grant.',
      errorCode: 'git_scope_external_chat_required'
    })
  })

  it('resolves ci-status through the read grant and forwards the pr/branch selectors', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([createGrant()])
    registerGitHandlers(deps)

    await expect(
      handlerFor('github:ci-status')(
        {},
        {
          repoPath: '/granted/repo',
          chatId: 'chat-1',
          pr: 75,
          branch: 'feat/x',
          includeFailedLogs: true
        }
      )
    ).resolves.toMatchObject({ ok: true, data: { status: 'passed' } })
    expect(deps.gitService.ciStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/granted/repo',
        pr: 75,
        branch: 'feat/x',
        includeFailedLogs: true
      })
    )
  })

  it('rejects ci-status for a path with no registered workspace or signed grant', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(undefined)
    registerGitHandlers(deps)

    await expect(
      handlerFor('github:ci-status')({}, { repoPath: '/not/granted' })
    ).resolves.toEqual({
      ok: false,
      error:
        'Git inspection for an external repository requires an originating chat with a signed path grant.',
      errorCode: 'git_scope_external_chat_required'
    })
    expect(deps.gitService.ciStatus).not.toHaveBeenCalled()
  })

  it('requires an external Git target to be the repository root', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([
      createGrant({ path: '/granted/repo/' })
    ])
    deps.gitRepositoryRootForPath.mockImplementation((path) =>
      path === '/granted/repo/' ? path : '/granted/repo/'
    )
    registerGitHandlers(deps)

    await expect(handlerFor('git:snapshot')(
      {},
      { repoPath: '  /granted/repo/  ', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/granted/repo/' }
    })
    expect(deps.canonicalPath).toHaveBeenCalledWith('/granted/repo/')
    expect(deps.canonicalExternalGrantPath).toHaveBeenCalledWith('/granted/repo/')

    await expect(handlerFor('git:snapshot')(
      {},
      { repoPath: '/granted/repo/subdir', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: false,
      error: 'Git inspection must target the external repository root, not a nested path.',
      errorCode: 'git_scope_external_root_required'
    })
    expect(deps.gitService.snapshot).toHaveBeenCalledTimes(1)

    await expect(handlerFor('git:snapshot')(
      {},
      { repoPath: '/granted/repo-evil', chatId: 'chat-1' }
    )).resolves.toEqual({
      ok: false,
      error: 'Git inspection must target the external repository root, not a nested path.',
      errorCode: 'git_scope_external_root_required'
    })
  })

  it('rejects an external repository subdirectory before invoking the Git service', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([
      createGrant({ path: '/granted/repo' })
    ])
    deps.gitRepositoryRootForPath.mockReturnValue('/granted/repo')
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')(
        {},
        { repoPath: '/granted/repo/subdir', chatId: 'chat-1' }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Git inspection must target the external repository root, not a nested path.',
      errorCode: 'git_scope_external_root_required'
    })
    expect(deps.getChat).not.toHaveBeenCalled()
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
  })

  it('rejects an external .git indirection before consulting its chat grant', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([
      createGrant({ path: '/granted/worktree' })
    ])
    deps.gitRepositoryRootForPath.mockReturnValue('/granted/worktree')
    deps.externalGitRepositoryRootIsSelfContained.mockReturnValue(false)
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')(
        {},
        { repoPath: '/granted/worktree', chatId: 'chat-1' }
      )
    ).resolves.toEqual({
      ok: false,
      error:
        'Git inspection requires a self-contained .git directory at the external repository root.',
      errorCode: 'git_scope_external_repository_not_self_contained'
    })
    expect(deps.externalGitRepositoryRootIsSelfContained).toHaveBeenCalledWith(
      '/granted/worktree'
    )
    expect(deps.getChat).not.toHaveBeenCalled()
    expect(deps.executableExternalPathGrantsForChat).not.toHaveBeenCalled()
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
  })

  it('does not apply the external .git directory restriction to a registered worktree', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-worktree' })
    deps.gitRepositoryRootForPath.mockReturnValue('/registered/worktree')
    deps.externalGitRepositoryRootIsSelfContained.mockReturnValue(false)
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')({}, { workspacePath: '/registered/worktree' })
    ).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/registered/worktree' }
    })
    expect(deps.externalGitRepositoryRootIsSelfContained).not.toHaveBeenCalled()
    expect(deps.gitService.snapshot).toHaveBeenCalledWith('/registered/worktree')
  })

  it('rejects a file-kind external grant for Git inspection and mutation', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([
      createGrant({ kind: 'file', access: 'write' })
    ])
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')({}, { repoPath: '/granted/repo', chatId: 'chat-1' })
    ).resolves.toEqual({
      ok: false,
      error: 'Git inspection requires a signed external read grant for this repository.',
      errorCode: 'git_scope_external_read_grant_required'
    })
    await expect(
      handlerFor('git:stage')(
        {},
        { repoPath: '/granted/repo', chatId: 'chat-1', all: true }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Git actions require a signed external write grant for this repository.',
      errorCode: 'git_scope_external_write_grant_required'
    })
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
    expect(deps.gitService.stage).not.toHaveBeenCalled()
  })

  it('does not retarget a signed directory grant through a later symlink replacement', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([
      createGrant({ path: '/signed/repository' })
    ])
    deps.canonicalExternalGrantPath.mockImplementation((path) =>
      path === '/alias/repository' || path === '/signed/repository'
        ? '/redirected/repository'
        : null
    )
    deps.gitRepositoryRootForPath.mockReturnValue('/redirected/repository')
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')(
        {},
        { repoPath: '/alias/repository', chatId: 'chat-1' }
      )
    ).resolves.toEqual({
      ok: false,
      error: 'Git inspection requires a signed external read grant for this repository.',
      errorCode: 'git_scope_external_read_grant_required'
    })
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
  })

  it('rejects a registered nested workspace before invoking the Git service', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockImplementation((path) =>
      path === '/repo/packages/app' ? { id: 'ws-app' } : undefined
    )
    deps.gitRepositoryRootForPath.mockReturnValue('/repo')
    registerGitHandlers(deps)

    for (const channel of ['git:snapshot', 'git:workspace-stats', 'git:work-provenance']) {
      await expect(
        handlerFor(channel)({}, { workspacePath: '/repo/packages/app' })
      ).resolves.toEqual({
        ok: false,
        error:
          'Git inspection will not widen this registered workspace to a different repository root.',
        errorCode: 'git_scope_registered_root_mismatch'
      })
    }
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
    expect(deps.gitService.workspaceStats).not.toHaveBeenCalled()
    expect(deps.workProvenanceService.query).not.toHaveBeenCalled()
  })

  it('identifies a failed registered-root probe before running stats or provenance', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-signed' })
    deps.gitRepositoryRootForPath.mockReturnValue(null)
    registerGitHandlers(deps)

    for (const channel of ['git:snapshot', 'git:workspace-stats', 'git:work-provenance']) {
      await expect(
        handlerFor(channel)({}, { workspacePath: '/signed/repository' })
      ).resolves.toEqual({
        ok: false,
        error: 'Git repository root could not be resolved for this registered workspace.',
        errorCode: 'git_scope_registered_root_unresolved'
      })
    }
    expect(deps.gitService.snapshot).not.toHaveBeenCalled()
    expect(deps.gitService.workspaceStats).not.toHaveBeenCalled()
    expect(deps.workProvenanceService.query).not.toHaveBeenCalled()
  })

  it('identifies an unresolved external repository root before consulting grants', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.gitRepositoryRootForPath.mockReturnValue(null)
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:workspace-stats')({}, { repoPath: '/external/repository', chatId: 'chat-1' })
    ).resolves.toEqual({
      ok: false,
      error: 'Git repository root could not be resolved for this external path.',
      errorCode: 'git_scope_external_root_unresolved'
    })
    expect(deps.getChat).not.toHaveBeenCalled()
    expect(deps.executableExternalPathGrantsForChat).not.toHaveBeenCalled()
    expect(deps.gitService.workspaceStats).not.toHaveBeenCalled()
  })

  it('denies every external worktree action without invoking worktree services', async () => {
    const { deps } = createDeps()
    deps.getChat.mockReturnValue(createChat())
    deps.executableExternalPathGrantsForChat.mockReturnValue([
      createGrant({ access: 'write' })
    ])
    registerGitHandlers(deps)
    const target = { repoPath: '/granted/repo', chatId: 'chat-1' }

    await expect(handlerFor('git:list-worktrees')({}, target)).resolves.toEqual({
      ok: false,
      worktrees: [],
      error: 'Worktree actions are limited to registered workspace roots.'
    })
    await expect(
      handlerFor('git:create-worktree')({}, {
        ...target,
        name: 'feature',
        path: '/outside/feature'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Worktree actions are limited to registered workspace roots.'
    })
    await expect(
      handlerFor('git:remove-worktree')({}, {
        ...target,
        path: '/outside/feature',
        force: true
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Worktree actions are limited to registered workspace roots.'
    })
    await expect(
      handlerFor('git:select-worktree')({}, { ...target, path: '/outside/feature' })
    ).resolves.toEqual({
      ok: false,
      error: 'Worktree actions are limited to registered workspace roots.'
    })

    expect(deps.gitService.listWorktrees).not.toHaveBeenCalled()
    expect(deps.gitService.createWorktree).not.toHaveBeenCalled()
    expect(deps.gitService.removeWorktree).not.toHaveBeenCalled()
    expect(deps.gitService.selectWorktree).not.toHaveBeenCalled()
    expect(deps.gitSnapshotPublisher!.publishSnapshot).not.toHaveBeenCalled()
  })

  it('accepts a registered symlink through its lexical workspace identity', async () => {
    const { deps } = createDeps()
    deps.canonicalPath.mockImplementation((path) => path.trim())
    deps.canonicalExternalGrantPath.mockImplementation((path) =>
      path.trim() === '/linked/repo' ? '/real/repo' : null
    )
    deps.findRegisteredWorkspace.mockImplementation((path) =>
      path === '/linked/repo' ? { id: 'ws-linked' } : undefined
    )
    deps.gitRepositoryRootForPath.mockReturnValue('/real/repo')
    registerGitHandlers(deps)

    await expect(
      handlerFor('git:snapshot')({}, { workspacePath: '/linked/repo' })
    ).resolves.toEqual({
      ok: true,
      data: { requestedPath: '/real/repo' }
    })
    expect(deps.findRegisteredWorkspace).toHaveBeenNthCalledWith(1, '/linked/repo')
    expect(deps.gitService.snapshot).toHaveBeenCalledWith('/real/repo')
  })

  it('create-github-pr preserves safe shell-open gating and success/raw result behavior', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    registerGitHandlers(deps)

    await expect(
      handlerFor('create-github-pr')({}, { workspacePath: '/repo', title: 'T', openInBrowser: true })
    ).resolves.toEqual({
      ok: true,
      url: 'https://example.test/pr/1'
    })
    expect(deps.openSafeShellTarget).toHaveBeenCalledWith('https://example.test/pr/1')

    deps.openSafeShellTarget.mockClear()
    await handlerFor('create-github-pr')({}, { workspacePath: '/repo' })
    expect(deps.openSafeShellTarget).toHaveBeenCalledWith('https://example.test/pr/1')

    deps.openSafeShellTarget.mockClear()
    await handlerFor('create-github-pr')({}, { workspacePath: '/repo', openInBrowser: false })
    expect(deps.openSafeShellTarget).not.toHaveBeenCalled()

    deps.gitService.createPullRequest.mockResolvedValueOnce({ ok: true, data: {} as any })
    await handlerFor('create-github-pr')({}, { workspacePath: '/repo' })
    expect(deps.openSafeShellTarget).not.toHaveBeenCalled()

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
    deps.openSafeShellTarget.mockImplementationOnce(async () => {
      events.push('open-external')
      return { ok: true }
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

  it('audits commit-group creation and manual PR lifecycle actions', async () => {
    const { deps } = createDeps()
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-1' })
    deps.externalPublishReceipts = {
      begin: vi.fn(async (input) => ({
        schemaVersion: 1,
        id: `receipt-${input.action}`,
        requestedAt: '2026-08-12T00:00:00.000Z',
        ...input
      }) as any),
      complete: vi.fn(async () => null)
    }
    registerGitHandlers(deps)

    await expect(
      handlerFor('github:pr-workspace')({}, { workspacePath: '/repo' })
    ).resolves.toMatchObject({
      ok: true,
      data: { available: true, defaultBaseBranch: 'master' }
    })
    await expect(
      handlerFor('github:create-commit-group-pr')({}, {
        workspacePath: '/repo',
        commits: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        branch: 'pr/focused',
        baseBranch: 'master',
        title: 'Focused PR',
        draft: true,
        openInBrowser: true
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { branch: 'pr/focused', pullRequest: { number: 42 } }
    })
    expect(deps.gitService.createCommitGroupPullRequest).toHaveBeenCalledWith({
      repoPath: '/repo',
      commits: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      branch: 'pr/focused',
      baseBranch: 'master',
      title: 'Focused PR',
      draft: true
    })
    expect(deps.openSafeShellTarget).toHaveBeenCalledWith('https://example.test/pr/42')

    await expect(
      handlerFor('github:manage-pr')({}, {
        workspacePath: '/repo',
        pullRequestNumber: 42,
        lifecycle: {
          action: 'merge',
          strategy: 'squash',
          expectedHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }
      })
    ).resolves.toMatchObject({ ok: true, data: { pullRequest: { number: 42 } } })
    expect(deps.gitService.managePullRequest).toHaveBeenCalledWith({
      repoPath: '/repo',
      pullRequestNumber: 42,
      lifecycle: {
        action: 'merge',
        strategy: 'squash',
        expectedHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }
    })
    expect(deps.externalPublishReceipts.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'githubManagePr',
        metadata: {
          pullRequestNumber: 42,
          lifecycleAction: 'merge',
          strategy: 'squash'
        }
      })
    )
    expect(deps.externalPublishReceipts.complete).toHaveBeenCalledTimes(2)

    await expect(
      handlerFor('github:manage-pr')({}, {
        workspacePath: '/repo',
        pullRequestNumber: 42,
        lifecycle: { action: 'merge', strategy: 'explode' }
      })
    ).resolves.toEqual({ ok: false, error: 'Choose a valid pull request action.' })
    expect(deps.gitService.managePullRequest).toHaveBeenCalledTimes(1)
  })
})
