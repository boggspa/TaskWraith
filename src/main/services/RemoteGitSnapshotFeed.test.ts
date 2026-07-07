import { describe, expect, it } from 'vitest'
import type { GitRepositorySnapshot } from './GitService'
import type {
  GitSnapshotChangedPayload,
  GitSnapshotSubscribeResult,
  GitSnapshotSubscription
} from './GitSnapshotPublisher'
import { RemoteGitSnapshotFeed, type RemoteGitFeedWorkspace } from './RemoteGitSnapshotFeed'

function makeSnapshot(
  requestedPath: string,
  overrides: Partial<GitRepositorySnapshot> = {}
): GitRepositorySnapshot {
  return {
    requestedPath,
    repoRoot: requestedPath,
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 },
    ...overrides
  } as GitRepositorySnapshot
}

class FakePublisher {
  readonly active = new Map<string, GitSnapshotSubscription>()
  readonly subscribeCalls: string[] = []
  readonly unsubscribeCalls: string[] = []
  failingPaths = new Set<string>()

  async subscribe(subscription: GitSnapshotSubscription): Promise<GitSnapshotSubscribeResult> {
    this.subscribeCalls.push(subscription.subscriptionId)
    if (this.failingPaths.has(subscription.requestedPath)) {
      return { ok: false, error: 'not a git repository' }
    }
    this.active.set(subscription.subscriptionId, subscription)
    return {
      ok: true,
      data: {
        subscriptionId: subscription.subscriptionId,
        requestedPath: subscription.requestedPath,
        repoRoot: subscription.requestedPath,
        snapshot: makeSnapshot(subscription.requestedPath),
        generation: 1
      }
    }
  }

  unsubscribe(subscriptionId: string): void {
    this.unsubscribeCalls.push(subscriptionId)
    this.active.delete(subscriptionId)
  }

  emit(requestedPath: string, overrides: Partial<GitRepositorySnapshot> = {}): void {
    for (const subscription of this.active.values()) {
      if (subscription.requestedPath !== requestedPath) continue
      const payload: GitSnapshotChangedPayload = {
        subscriptionId: subscription.subscriptionId,
        requestedPath,
        repoRoot: requestedPath,
        snapshot: makeSnapshot(requestedPath, overrides),
        generation: 2,
        reason: 'filesystem'
      }
      subscription.send(payload)
    }
  }
}

interface Landed {
  workspaceId: string
  workspacePath: string
  snapshot: GitRepositorySnapshot
}

function makeFeed(options?: { now?: () => number; failingPaths?: string[] }) {
  const publisher = new FakePublisher()
  if (options?.failingPaths) publisher.failingPaths = new Set(options.failingPaths)
  const landed: Landed[] = []
  let workspaces: RemoteGitFeedWorkspace[] = []
  const feed = new RemoteGitSnapshotFeed({
    publisher,
    listWorkspaces: () => workspaces,
    onSnapshot: (workspaceId, workspacePath, snapshot) => {
      landed.push({ workspaceId, workspacePath, snapshot })
    },
    now: options?.now
  })
  return {
    publisher,
    landed,
    feed,
    setWorkspaces: (next: RemoteGitFeedWorkspace[]) => {
      workspaces = next
    }
  }
}

describe('RemoteGitSnapshotFeed', () => {
  it('holds no subscriptions while no phone is connected', async () => {
    const { publisher, landed, feed, setWorkspaces } = makeFeed()
    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-1' }])
    feed.reconcile()
    await feed.settled()
    expect(publisher.active.size).toBe(0)
    expect(landed).toEqual([])
  })

  it('subscribes allowlisted workspaces on connect and lands their initial snapshots', async () => {
    const { publisher, landed, feed, setWorkspaces } = makeFeed()
    setWorkspaces([
      { workspaceId: 'ws-1', workspacePath: '/repo-1' },
      { workspaceId: 'ws-2', workspacePath: '/repo-2' }
    ])
    feed.setConnectedDeviceCount(1)
    await feed.settled()
    expect(publisher.active.size).toBe(2)
    expect(landed.map((entry) => entry.workspaceId).sort()).toEqual(['ws-1', 'ws-2'])
    expect(landed[0].snapshot.branch).toBe('main')
  })

  it('forwards watcher recomputes into onSnapshot', async () => {
    const { publisher, landed, feed, setWorkspaces } = makeFeed()
    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-1' }])
    feed.setConnectedDeviceCount(1)
    await feed.settled()
    landed.length = 0

    publisher.emit('/repo-1', { branch: 'feature', clean: false })
    expect(landed).toHaveLength(1)
    expect(landed[0]).toMatchObject({
      workspaceId: 'ws-1',
      workspacePath: '/repo-1'
    })
    expect(landed[0].snapshot.branch).toBe('feature')
  })

  it('unsubscribes everything when the last phone disconnects and ignores late sends', async () => {
    const { publisher, landed, feed, setWorkspaces } = makeFeed()
    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-1' }])
    feed.setConnectedDeviceCount(2)
    await feed.settled()
    const subscription = Array.from(publisher.active.values())[0]

    feed.setConnectedDeviceCount(0)
    await feed.settled()
    expect(publisher.active.size).toBe(0)
    expect(publisher.unsubscribeCalls).toHaveLength(1)

    landed.length = 0
    // A send captured before the unsubscribe must be ignored.
    subscription.send({
      subscriptionId: subscription.subscriptionId,
      requestedPath: '/repo-1',
      repoRoot: '/repo-1',
      snapshot: makeSnapshot('/repo-1'),
      generation: 3,
      reason: 'filesystem'
    })
    expect(landed).toEqual([])
  })

  it('drops workspaces that leave the list on the next reconcile', async () => {
    const { publisher, feed, setWorkspaces } = makeFeed()
    setWorkspaces([
      { workspaceId: 'ws-1', workspacePath: '/repo-1' },
      { workspaceId: 'ws-2', workspacePath: '/repo-2' }
    ])
    feed.setConnectedDeviceCount(1)
    await feed.settled()
    expect(publisher.active.size).toBe(2)

    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-1' }])
    feed.reconcile()
    await feed.settled()
    expect(publisher.active.size).toBe(1)
    expect(Array.from(publisher.active.values())[0].requestedPath).toBe('/repo-1')
  })

  it('retries a failed subscribe only after the cooldown', async () => {
    let nowMs = 1_000_000
    const { publisher, feed, setWorkspaces } = makeFeed({
      now: () => nowMs,
      failingPaths: ['/repo-1']
    })
    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-1' }])
    feed.setConnectedDeviceCount(1)
    await feed.settled()
    expect(publisher.subscribeCalls).toHaveLength(1)
    expect(publisher.active.size).toBe(0)

    // Within the cooldown: no new attempt.
    nowMs += 30_000
    feed.reconcile()
    await feed.settled()
    expect(publisher.subscribeCalls).toHaveLength(1)

    // Past the cooldown (and the repo now exists): retried and retained.
    nowMs += 31_000
    publisher.failingPaths.clear()
    feed.reconcile()
    await feed.settled()
    expect(publisher.subscribeCalls).toHaveLength(2)
    expect(publisher.active.size).toBe(1)
  })

  it('resubscribes on a workspace path change and ignores stale-closure sends', async () => {
    const { publisher, landed, feed, setWorkspaces } = makeFeed()
    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-old' }])
    feed.setConnectedDeviceCount(1)
    await feed.settled()
    const staleSubscription = Array.from(publisher.active.values())[0]

    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-new' }])
    feed.reconcile()
    await feed.settled()
    expect(publisher.active.size).toBe(1)
    expect(Array.from(publisher.active.values())[0].requestedPath).toBe('/repo-new')

    landed.length = 0
    staleSubscription.send({
      subscriptionId: staleSubscription.subscriptionId,
      requestedPath: '/repo-old',
      repoRoot: '/repo-old',
      snapshot: makeSnapshot('/repo-old'),
      generation: 4,
      reason: 'filesystem'
    })
    expect(landed).toEqual([])

    publisher.emit('/repo-new')
    expect(landed).toHaveLength(1)
    expect(landed[0].workspacePath).toBe('/repo-new')
  })

  it('dispose unsubscribes and blocks further activity', async () => {
    const { publisher, landed, feed, setWorkspaces } = makeFeed()
    setWorkspaces([{ workspaceId: 'ws-1', workspacePath: '/repo-1' }])
    feed.setConnectedDeviceCount(1)
    await feed.settled()
    landed.length = 0

    feed.dispose()
    expect(publisher.active.size).toBe(0)

    feed.setConnectedDeviceCount(1)
    await feed.settled()
    expect(publisher.active.size).toBe(0)
    expect(landed).toEqual([])
  })
})
