import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceService,
  type WorkspaceAllowlistStore,
  type WorkspaceServiceDeps,
  type WorkspaceServiceStore
} from './WorkspaceService'
import type { RemoteWorkspaceEntry } from '../RemoteWorkspaceAllowlist'
import type { WorkspaceRecord } from '../store/types'

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'workspace-1',
    path: '/repo',
    displayName: 'repo',
    createdAt: 1,
    lastOpenedAt: 1,
    pinned: false,
    ...overrides
  }
}

function makeAllowlistEntry(overrides: Partial<RemoteWorkspaceEntry> = {}): RemoteWorkspaceEntry {
  return {
    workspaceId: 'workspace-1',
    path: '/repo',
    mode: 'read-write',
    allowedProviders: ['gemini', 'codex'],
    allowedApprovalModes: ['default', 'plan'],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  }
}

function makeStore(overrides: Partial<WorkspaceServiceStore> = {}): WorkspaceServiceStore {
  return {
    getWorkspaces: vi.fn(() => [makeWorkspace()]),
    addOrUpdateWorkspace: vi.fn((workspacePath: string, partial?: Partial<WorkspaceRecord>) =>
      makeWorkspace({ path: workspacePath, ...partial })
    ),
    pinWorkspaceRealPath: vi.fn((workspaceId, expectedPath, realPath) =>
      makeWorkspace({ id: workspaceId, path: expectedPath, realPath })
    ),
    removeWorkspace: vi.fn(),
    clearWorkspaces: vi.fn(),
    ...overrides
  }
}

function makeAllowlist(overrides: Partial<WorkspaceAllowlistStore> = {}): WorkspaceAllowlistStore {
  return {
    list: vi.fn(() => [makeAllowlistEntry()]),
    upsert: vi.fn((entry) => makeAllowlistEntry(entry)),
    remove: vi.fn(() => true),
    clear: vi.fn(),
    ...overrides
  }
}

function makeDeps(overrides: Partial<WorkspaceServiceDeps> = {}): {
  deps: WorkspaceServiceDeps
  store: WorkspaceServiceStore
  allowlist: WorkspaceAllowlistStore
} {
  const store = makeStore()
  const allowlist = makeAllowlist()
  const deps: WorkspaceServiceDeps = {
    appStore: store,
    allowlist,
    canonicalPath: vi.fn((value: string) => value.replace('/input', '/repo')),
    resolveRealDirectory: vi.fn(async (value: string) =>
      value.replace('/input', '/real/repo').replace('/repo', '/real/repo')
    ),
    selectDirectory: vi.fn(async () => '/input'),
    checkTrust: vi.fn(() => ({ status: 'trusted' as const })),
    ...overrides
  }
  return { deps, store: deps.appStore, allowlist: deps.allowlist }
}

describe('WorkspaceService', () => {
  it('returns workspaces from the injected store', () => {
    const { deps, store } = makeDeps()
    const service = new WorkspaceService(deps)
    expect(service.getWorkspaces()).toEqual([makeWorkspace()])
    expect(store.getWorkspaces).toHaveBeenCalledTimes(1)
  })

  it('updates only registered workspaces and sanitizes partial fields', () => {
    const { deps, store } = makeDeps()
    const service = new WorkspaceService(deps)
    const workspace = service.addOrUpdateWorkspace('/input', {
      displayName: 'Renamed',
      branch: 'main',
      pinned: true,
      notes: 'ignored',
      realPath: '/attacker/controlled',
      geminiWorktree: {
        enabled: true,
        name: 'feature'
      }
    })
    expect(workspace.path).toBe('/repo')
    expect(store.addOrUpdateWorkspace).toHaveBeenCalledWith('/repo', {
      displayName: 'Renamed',
      branch: 'main',
      pinned: true,
      geminiWorktree: {
        enabled: true,
        name: 'feature'
      }
    })
  })

  it('preserves the original unregistered workspace error', () => {
    const store = makeStore({ getWorkspaces: vi.fn(() => []) })
    const { deps } = makeDeps({ appStore: store })
    const service = new WorkspaceService(deps)
    expect(() => service.addOrUpdateWorkspace('/input')).toThrow(
      'Workspace must be selected through TaskWraith before it can be used.'
    )
    expect(store.addOrUpdateWorkspace).not.toHaveBeenCalled()
  })

  it('selectWorkspace returns null when the native picker has no path', async () => {
    const { deps, store } = makeDeps({
      selectDirectory: vi.fn(async () => null)
    })
    const service = new WorkspaceService(deps)
    await expect(service.selectWorkspace()).resolves.toBeNull()
    expect(store.addOrUpdateWorkspace).not.toHaveBeenCalled()
  })

  it('selectWorkspace registers a safe native selection', async () => {
    const { deps, store } = makeDeps()
    const service = new WorkspaceService(deps)
    await expect(service.selectWorkspace()).resolves.toEqual(
      makeWorkspace({ path: '/repo', realPath: '/real/repo' })
    )
    expect(store.addOrUpdateWorkspace).toHaveBeenCalledWith('/repo', {
      realPath: '/real/repo'
    })
  })

  it('rejects a native selection when the filesystem target is not a directory', async () => {
    const { deps, store } = makeDeps({
      resolveRealDirectory: vi.fn(async () => {
        throw new Error('Workspace must resolve to a directory.')
      })
    })
    const service = new WorkspaceService(deps)
    await expect(service.selectWorkspace()).rejects.toThrow(
      'Workspace must resolve to a directory.'
    )
    expect(store.addOrUpdateWorkspace).not.toHaveBeenCalled()
  })

  it('rejects filesystem roots when registering native selections', async () => {
    const { deps, store } = makeDeps({
      canonicalPath: vi.fn(() => '/')
    })
    const service = new WorkspaceService(deps)
    await expect(service.selectWorkspace()).rejects.toThrow(
      'Filesystem roots cannot be registered as workspaces.'
    )
    expect(store.addOrUpdateWorkspace).not.toHaveBeenCalled()
  })

  describe('workspace real-target reconciliation', () => {
    it('pins only direct legacy directory paths', async () => {
      const direct = makeWorkspace({ id: 'direct', path: '/repo/direct' })
      const symlink = makeWorkspace({ id: 'symlink', path: '/repo/link' })
      const missing = makeWorkspace({ id: 'missing', path: '/repo/missing' })
      const store = makeStore({
        getWorkspaces: vi.fn(() => [direct, symlink, missing]),
        pinWorkspaceRealPath: vi.fn((id, expectedPath, realPath) =>
          makeWorkspace({ id, path: expectedPath, realPath })
        )
      })
      const { deps } = makeDeps({
        appStore: store,
        canonicalPath: vi.fn((value: string) => value),
        resolveRealDirectory: vi.fn(async (value: string) => {
          if (value === direct.path) return direct.path
          if (value === symlink.path) return '/repo/target'
          throw new Error('missing')
        })
      })
      const log = vi.fn()

      await expect(new WorkspaceService(deps).reconcileWorkspaceRealPaths(log)).resolves.toBe(1)
      expect(store.pinWorkspaceRealPath).toHaveBeenCalledTimes(1)
      expect(store.pinWorkspaceRealPath).toHaveBeenCalledWith(direct.id, direct.path, direct.path)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('pinned direct'))
    })

    it('never inspects or repairs an existing pin', async () => {
      const pinned = makeWorkspace({
        id: 'pinned',
        path: '/repo/lexical',
        realPath: '/repo/old-target'
      })
      const store = makeStore({ getWorkspaces: vi.fn(() => [pinned]) })
      const { deps } = makeDeps({ appStore: store })

      await expect(new WorkspaceService(deps).reconcileWorkspaceRealPaths()).resolves.toBe(0)
      expect(deps.resolveRealDirectory).not.toHaveBeenCalled()
      expect(store.pinWorkspaceRealPath).not.toHaveBeenCalled()
    })

    it('does not count a stale compare-and-set race as an adopted pin', async () => {
      const direct = makeWorkspace({ id: 'direct', path: '/repo/direct' })
      const store = makeStore({
        getWorkspaces: vi.fn(() => [direct]),
        pinWorkspaceRealPath: vi.fn(() => null)
      })
      const { deps } = makeDeps({
        appStore: store,
        canonicalPath: vi.fn((value: string) => value),
        resolveRealDirectory: vi.fn(async (value: string) => value)
      })

      await expect(new WorkspaceService(deps).reconcileWorkspaceRealPaths()).resolves.toBe(0)
      expect(store.pinWorkspaceRealPath).toHaveBeenCalledTimes(1)
    })
  })

  it('validates and upserts remote allowlist entries with the original shape', () => {
    const { deps, allowlist } = makeDeps()
    const service = new WorkspaceService(deps)
    const result = service.upsertRemoteAllowlist({
      workspaceId: 'workspace-1',
      path: '/repo',
      mode: 'read-only',
      allowedProviders: ['gemini'],
      allowedApprovalModes: ['default'],
      expiresAt: 100
    })
    expect(result.mode).toBe('read-only')
    expect(allowlist.upsert).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      path: '/repo',
      mode: 'read-only',
      allowedProviders: ['gemini'],
      allowedApprovalModes: ['default'],
      expiresAt: 100
    })
  })

  it('passes explicit remote allowlist capability grants through', () => {
    const { deps, allowlist } = makeDeps()
    const service = new WorkspaceService(deps)
    service.upsertRemoteAllowlist({
      workspaceId: 'workspace-1',
      path: '/repo',
      mode: 'read-only',
      capabilities: ['monitor', 'approve'],
      allowedProviders: ['gemini'],
      allowedApprovalModes: ['default']
    })
    expect(allowlist.upsert).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      path: '/repo',
      mode: 'read-only',
      capabilities: ['monitor', 'approve'],
      allowedProviders: ['gemini'],
      allowedApprovalModes: ['default'],
      expiresAt: undefined
    })
  })

  it('keeps remote allowlist validation error messages stable', () => {
    const { deps, allowlist } = makeDeps()
    const service = new WorkspaceService(deps)
    expect(() =>
      service.upsertRemoteAllowlist({
        workspaceId: 'workspace-1',
        path: '/repo',
        mode: 'bad' as 'read-only',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
    ).toThrow("bridge-allowlist-upsert: mode must be 'read-only' or 'read-write' (got 'bad')")
    expect(() =>
      service.upsertRemoteAllowlist({
        workspaceId: 'workspace-1',
        path: '/repo',
        mode: 'read-only',
        capabilities: ['not-real' as never],
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
    ).toThrow('bridge-allowlist-upsert: capabilities must be RemoteWorkspaceCapability[]')
    expect(() =>
      service.upsertRemoteAllowlist({
        workspaceId: 'workspace-1',
        path: '/repo',
        mode: 'read-only',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default'],
        expiresAt: 0
      })
    ).toThrow('bridge-allowlist-upsert: expiresAt must be a positive number (ms since epoch)')
    expect(allowlist.upsert).not.toHaveBeenCalled()
  })

  it('removes and clears remote allowlist entries through stable IPC return values', () => {
    const { deps, allowlist } = makeDeps()
    const service = new WorkspaceService(deps)
    expect(service.removeRemoteAllowlist('workspace-1')).toBe(true)
    expect(allowlist.remove).toHaveBeenCalledWith('workspace-1')
    expect(service.clearRemoteAllowlist()).toBe(true)
    expect(allowlist.clear).toHaveBeenCalledTimes(1)
  })

  it('checks trust only after the workspace is registered', () => {
    const { deps } = makeDeps()
    const service = new WorkspaceService(deps)
    expect(service.checkTrust('/input')).toEqual({ status: 'trusted' })
    expect(deps.checkTrust).toHaveBeenCalledWith('/repo')
  })

  describe('allowlist identifier resolution', () => {
    const realWorkspaces = [
      makeWorkspace({ id: 'uuid-1', displayName: 'Test 1', path: '/Users/x/Test 1' }),
      makeWorkspace({ id: 'uuid-2', displayName: 'Test 2', path: '/Users/x/Test 2' }),
      makeWorkspace({ id: 'uuid-3', displayName: 'Dup', path: '/Users/x/dup-a' }),
      makeWorkspace({ id: 'uuid-4', displayName: 'Dup', path: '/Users/x/dup-b' })
    ]
    const resolutionDeps = (): ReturnType<typeof makeDeps> =>
      makeDeps({
        appStore: makeStore({ getWorkspaces: vi.fn(() => realWorkspaces) }),
        canonicalPath: vi.fn((value: string) => value)
      })
    const upsertInput = (
      workspaceId: string,
      path: string
    ): Parameters<WorkspaceService['upsertRemoteAllowlist']>[0] => ({
      workspaceId,
      path,
      mode: 'read-write',
      allowedProviders: ['gemini'],
      allowedApprovalModes: ['default']
    })

    it('resolves a quoted path + display-name id to the real workspace uuid', () => {
      const { deps, allowlist } = resolutionDeps()
      new WorkspaceService(deps).upsertRemoteAllowlist(upsertInput('Test 1', "'/Users/x/Test 1'"))
      expect(allowlist.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'uuid-1', path: '/Users/x/Test 1' })
      )
    })

    it('resolves by unique displayName when the path matches nothing', () => {
      const { deps, allowlist } = resolutionDeps()
      new WorkspaceService(deps).upsertRemoteAllowlist(upsertInput('Test 2', '/wrong/path'))
      expect(allowlist.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'uuid-2', path: '/Users/x/Test 2' })
      )
    })

    it('keeps unresolvable + ambiguous-name input as-is (trimmed, unquoted)', () => {
      const { deps, allowlist } = resolutionDeps()
      const service = new WorkspaceService(deps)
      service.upsertRemoteAllowlist(upsertInput(' custom-id ', '"/missing/path"'))
      expect(allowlist.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'custom-id', path: '/missing/path' })
      )
      service.upsertRemoteAllowlist(upsertInput('Dup', '/missing/elsewhere'))
      expect(allowlist.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: 'Dup', path: '/missing/elsewhere' })
      )
    })

    it('reconcileRemoteAllowlist repairs hand-typed entries and leaves the rest', () => {
      const { deps, allowlist } = resolutionDeps()
      const entries = [
        makeAllowlistEntry({
          workspaceId: 'Test 1',
          path: "'/Users/x/Test 1'",
          allowedProviders: ['gemini', 'claude'],
          expiresAt: 999
        }),
        makeAllowlistEntry({ workspaceId: 'uuid-2', path: '/Users/x/Test 2' }),
        makeAllowlistEntry({ workspaceId: 'nope', path: '/nope' })
      ]
      ;(allowlist.list as ReturnType<typeof vi.fn>).mockReturnValue(entries)
      const log = vi.fn()
      const repaired = new WorkspaceService(deps).reconcileRemoteAllowlist(log)
      expect(repaired).toBe(1)
      expect(allowlist.remove).toHaveBeenCalledWith('Test 1')
      expect(allowlist.upsert).toHaveBeenCalledTimes(1)
      expect(allowlist.upsert).toHaveBeenCalledWith({
        workspaceId: 'uuid-1',
        path: '/Users/x/Test 1',
        mode: 'read-write',
        capabilities: [
          'monitor',
          'approve',
          'answer',
          'cancel',
          'startTurn',
          'diffReview',
          'steer'
        ],
        allowedProviders: ['gemini', 'claude'],
        allowedApprovalModes: ['default', 'plan'],
        expiresAt: 999
      })
      expect(log).toHaveBeenCalledWith(expect.stringContaining("'Test 1' → uuid-1"))
    })
  })
})
