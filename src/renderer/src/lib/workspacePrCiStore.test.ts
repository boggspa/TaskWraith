import { describe, expect, it, vi } from 'vitest'
import type {
  GitCiStatusSummary,
  GitPrSummary,
  GitRepositorySnapshot
} from '../../../main/services/GitService'
import {
  WorkspacePrCiRefresher,
  WorkspacePrCiStore,
  gitPrStatusRefreshKey,
  type WorkspacePrCiApi
} from './workspacePrCiStore'

function snapshot(requestedPath: string, branch: string, commit = 'abc123'): GitRepositorySnapshot {
  return {
    requestedPath,
    repoRoot: requestedPath,
    branch,
    commit,
    detached: false,
    upstream: 'origin/main',
    remoteName: 'origin',
    remoteUrl: 'https://example.test/repo.git',
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 }
  }
}

const pr = (number: number, over: Partial<GitPrSummary> = {}): GitPrSummary => ({
  number,
  state: 'OPEN',
  headRefOid: `oid-${number}`,
  ...over
})

const ci = (status: GitCiStatusSummary['status']): GitCiStatusSummary =>
  ({ status }) as GitCiStatusSummary

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush the promise chains the refresher builds off resolved fetches. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type PrResult = { ok?: boolean; data?: GitPrSummary | null } | null | undefined
type CiResult = { ok?: boolean; data?: GitCiStatusSummary | null } | null | undefined

function makeApi(): {
  api: WorkspacePrCiApi
  prCalls: Array<Deferred<PrResult>>
  ciCalls: Array<Deferred<CiResult>>
  githubPrStatus: ReturnType<typeof vi.fn>
  githubCiStatus: ReturnType<typeof vi.fn>
} {
  const prCalls: Array<Deferred<PrResult>> = []
  const ciCalls: Array<Deferred<CiResult>> = []
  const githubPrStatus = vi.fn(() => {
    const request = deferred<PrResult>()
    prCalls.push(request)
    return request.promise
  })
  const githubCiStatus = vi.fn(() => {
    const request = deferred<CiResult>()
    ciCalls.push(request)
    return request.promise
  })
  return { api: { githubPrStatus, githubCiStatus }, prCalls, ciCalls, githubPrStatus, githubCiStatus }
}

describe('WorkspacePrCiStore', () => {
  it('notifies only subscribers that own the updated path', () => {
    const store = new WorkspacePrCiStore()
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe('/one', first)
    store.subscribe('/two', second)

    expect(store.setPr('/one', pr(41))).toBe(true)
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
  })

  it('normalizes path aliases to one partition', () => {
    const store = new WorkspacePrCiStore()
    const summary = pr(7)
    store.setPr('/Test 2', summary)
    expect(store.get('/Test 2/')?.pr).toBe(summary)
  })

  it('skips notify for a same-reference PR refresh and a null-to-null write', () => {
    const store = new WorkspacePrCiStore()
    const listener = vi.fn()
    store.subscribe('/repo', listener)
    expect(store.setPr('/repo', null)).toBe(false)
    const summary = pr(41)
    store.setPr('/repo', summary)
    listener.mockClear()
    expect(store.setPr('/repo', summary)).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps cached CI across a same-number PR refresh and drops it on a PR change', () => {
    const store = new WorkspacePrCiStore()
    store.setPr('/repo', pr(41))
    store.setCi('/repo', ci('passed'))
    expect(store.get('/repo')?.ci?.status).toBe('passed')

    store.setPr('/repo', pr(41, { headRefOid: 'oid-fresh' }))
    expect(store.get('/repo')?.ci?.status).toBe('passed')

    store.setPr('/repo', pr(52))
    expect(store.get('/repo')?.ci).toBeNull()
  })

  it('drops CI writes for a path without a PR', () => {
    const store = new WorkspacePrCiStore()
    expect(store.setCi('/repo', ci('passed'))).toBe(false)
    expect(store.get('/repo')).toBeNull()
  })

  it('retain drops paths no longer visible and notifies them', () => {
    const store = new WorkspacePrCiStore()
    const listener = vi.fn()
    store.setPr('/one', pr(1))
    store.setPr('/two', pr(2))
    store.subscribe('/two', listener)

    expect(store.retain(['/one'])).toBe(true)
    expect(store.get('/one')?.pr?.number).toBe(1)
    expect(store.get('/two')).toBeNull()
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('WorkspacePrCiRefresher', () => {
  function makeRefresher(initialSnapshot: GitRepositorySnapshot | null) {
    const store = new WorkspacePrCiStore()
    const holder = { snapshot: initialSnapshot }
    const fixture = makeApi()
    const refresher = new WorkspacePrCiRefresher(
      store,
      () => holder.snapshot,
      () => fixture.api
    )
    return { store, holder, refresher, ...fixture }
  }

  it('clears the rollup and skips the fetch when the snapshot has no PR key', () => {
    const { store, refresher, githubPrStatus } = makeRefresher(null)
    store.setPr('/repo', pr(41))
    refresher.refresh('/repo')
    expect(githubPrStatus).not.toHaveBeenCalled()
    expect(store.get('/repo')?.pr).toBeNull()
  })

  it('fetches the PR with the raw path, then chains the CI summary', async () => {
    const { store, refresher, prCalls, ciCalls, githubPrStatus, githubCiStatus } = makeRefresher(
      snapshot('/Repo One', 'main')
    )
    refresher.refresh('/Repo One')
    expect(githubPrStatus).toHaveBeenCalledWith({ workspacePath: '/Repo One' })
    prCalls[0].resolve({ ok: true, data: pr(41) })
    await settle()
    expect(store.get('/Repo One')?.pr?.number).toBe(41)
    expect(githubCiStatus).toHaveBeenCalledWith({ workspacePath: '/Repo One' })
    ciCalls[0].resolve({ ok: true, data: ci('pending') })
    await settle()
    expect(store.get('/Repo One')?.ci?.status).toBe('pending')
  })

  it('dedupes the PR fetch while the snapshot-derived key is unchanged', async () => {
    const { refresher, prCalls, githubPrStatus } = makeRefresher(snapshot('/repo', 'main'))
    refresher.refresh('/repo')
    prCalls[0].resolve({ ok: true, data: pr(41) })
    await settle()
    refresher.refresh('/repo')
    expect(githubPrStatus).toHaveBeenCalledTimes(1)
  })

  it('forceCi refetches the CI summary without a new PR fetch', async () => {
    const { refresher, prCalls, ciCalls, githubPrStatus, githubCiStatus } = makeRefresher(
      snapshot('/repo', 'main')
    )
    refresher.refresh('/repo')
    prCalls[0].resolve({ ok: true, data: pr(41) })
    await settle()
    ciCalls[0].resolve({ ok: true, data: ci('pending') })
    await settle()

    refresher.refresh('/repo', { forceCi: true })
    expect(githubPrStatus).toHaveBeenCalledTimes(1)
    expect(githubCiStatus).toHaveBeenCalledTimes(2)
  })

  it('skips the CI chain entirely when the workspace has no open PR', async () => {
    const { store, refresher, prCalls, githubCiStatus } = makeRefresher(snapshot('/repo', 'main'))
    refresher.refresh('/repo')
    prCalls[0].resolve({ ok: true, data: null })
    await settle()
    expect(store.get('/repo')).toBeNull()
    expect(githubCiStatus).not.toHaveBeenCalled()
  })

  it('clears the PR on a failed fetch result', async () => {
    const { store, refresher, prCalls } = makeRefresher(snapshot('/repo', 'main'))
    const stale = pr(9)
    store.setPr('/repo', stale)
    refresher.refresh('/repo')
    prCalls[0].resolve({ ok: false })
    await settle()
    expect(store.get('/repo')?.pr).toBeNull()
  })

  it('discards a late PR response after the refresh key moved on', async () => {
    const { store, holder, refresher, prCalls } = makeRefresher(snapshot('/repo', 'main', 'c1'))
    refresher.refresh('/repo')
    holder.snapshot = snapshot('/repo', 'main', 'c2')
    refresher.refresh('/repo')
    expect(prCalls).toHaveLength(2)

    prCalls[1].resolve({ ok: true, data: pr(52) })
    await settle()
    prCalls[0].resolve({ ok: true, data: pr(41) })
    await settle()
    expect(store.get('/repo')?.pr?.number).toBe(52)
  })

  it('discards a late PR response after retain dropped the path', async () => {
    const { store, refresher, prCalls } = makeRefresher(snapshot('/repo', 'main'))
    refresher.refresh('/repo')
    refresher.retain([])
    prCalls[0].resolve({ ok: true, data: pr(41) })
    await settle()
    expect(store.get('/repo')).toBeNull()
  })

  it('holds one CI request in flight per path', async () => {
    const { refresher, prCalls, githubCiStatus } = makeRefresher(snapshot('/repo', 'main'))
    refresher.refresh('/repo')
    prCalls[0].resolve({ ok: true, data: pr(41) })
    await settle()
    expect(githubCiStatus).toHaveBeenCalledTimes(1)

    refresher.refresh('/repo', { forceCi: true })
    expect(githubCiStatus).toHaveBeenCalledTimes(1)
  })
})

describe('gitPrStatusRefreshKey', () => {
  it('requires a remote URL and changes with the commit', () => {
    expect(gitPrStatusRefreshKey(null)).toBeNull()
    expect(gitPrStatusRefreshKey({ ...snapshot('/repo', 'main'), remoteUrl: '' })).toBeNull()
    const first = gitPrStatusRefreshKey(snapshot('/repo', 'main', 'c1'))
    const second = gitPrStatusRefreshKey(snapshot('/repo', 'main', 'c2'))
    expect(first).toBeTruthy()
    expect(first).not.toEqual(second)
  })
})
