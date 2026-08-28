import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostWorkspaceRecordUpsertInput } from './HostWorkspaceRecordCommand'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('../store/index').AppStore
  profilePath: string
  workspacesPath: string
  upserts: HostWorkspaceRecordUpsertInput[]
  removed: string[]
  clears: number
  port: {
    upsertWorkspaceRecord: ReturnType<typeof vi.fn>
    removeWorkspaceRecord: ReturnType<typeof vi.fn>
    clearWorkspaceRecords: ReturnType<typeof vi.fn>
  }
}

interface WorkspaceSeed {
  id: string
  path: string
  displayName?: string
  createdAt?: number
  lastOpenedAt?: number
  pinned?: boolean
  realPath?: string
  branch?: string
}

async function importStoreWithHostOwnedGate(seeds: WorkspaceSeed[]): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-workspace-wiring-'))
  profiles.push(profilePath)
  const workspacesPath = join(profilePath, 'workspaces.json')
  const records = seeds.map((seed) => ({
    id: seed.id,
    path: seed.path,
    displayName: seed.displayName ?? seed.path,
    createdAt: seed.createdAt ?? 1,
    lastOpenedAt: seed.lastOpenedAt ?? 1,
    pinned: seed.pinned ?? false,
    ...(seed.realPath ? { realPath: seed.realPath } : {}),
    ...(seed.branch ? { branch: seed.branch } : {})
  }))
  writeFileSync(workspacesPath, JSON.stringify(records))
  chmodSync(workspacesPath, 0o600)
  vi.resetModules()
  const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
    await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  configureHostStoreRuntime({
    profilePath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { AppStore } = await import('../store/index')
  const { legacyStoreWriterGate } = await import('../store/LegacyStoreWriterGate')
  if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
  if (
    !legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
  ) {
    throw new Error('test gate did not become host-owned')
  }
  const upserts: HostWorkspaceRecordUpsertInput[] = []
  const removed: string[] = []
  const clears: { count: number } = { count: 0 }
  // Faithful Host-mimicking port: applies the real upsertWorkspaceRecord
  // semantics to the tmp workspaces.json — id-keyed merge, dedup by realPath,
  // omitted optionals preserved, and realPath computed HOST-side (realpath,
  // so /var/... canonicalizes to /private/var/... exactly like production on
  // macOS), proving the read-back adoption rather than a caller-asserted value.
  const { realpathSync } = await import('node:fs')
  const port = {
    upsertWorkspaceRecord: vi.fn(async (input: HostWorkspaceRecordUpsertInput) => {
      upserts.push(input)
      const current = existsSync(workspacesPath)
        ? (JSON.parse(readFileSync(workspacesPath, 'utf8')) as Array<Record<string, unknown>>)
        : []
      const realPath = realpathSync(input.path)
      if (
        current.some(
          (workspace) => workspace.id !== input.workspaceId && workspace.realPath === realPath
        )
      ) {
        throw new Error('Workspace path is already registered')
      }
      const existing = current.find((workspace) => workspace.id === input.workspaceId)
      const next = {
        ...(existing ?? {}),
        id: input.workspaceId,
        path: input.path,
        realPath,
        displayName: input.displayName,
        createdAt: input.createdAt,
        lastOpenedAt: input.lastOpenedAt,
        pinned: input.pinned,
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.geminiWorktree !== undefined ? { geminiWorktree: input.geminiWorktree } : {})
      }
      const updated = existing
        ? current.map((workspace) => (workspace.id === input.workspaceId ? next : workspace))
        : [...current, next]
      writeFileSync(workspacesPath, JSON.stringify(updated))
      chmodSync(workspacesPath, 0o600)
      return {} as never
    }),
    removeWorkspaceRecord: vi.fn(async (workspaceId: string) => {
      removed.push(workspaceId)
      const current = existsSync(workspacesPath)
        ? (JSON.parse(readFileSync(workspacesPath, 'utf8')) as Array<Record<string, unknown>>)
        : []
      const next = current.filter((workspace) => workspace.id !== workspaceId)
      writeFileSync(workspacesPath, JSON.stringify(next))
      chmodSync(workspacesPath, 0o600)
      return { removed: next.length !== current.length } as never
    }),
    clearWorkspaceRecords: vi.fn(async () => {
      clears.count += 1
      const current = existsSync(workspacesPath)
        ? (JSON.parse(readFileSync(workspacesPath, 'utf8')) as Array<Record<string, unknown>>)
        : []
      writeFileSync(workspacesPath, JSON.stringify([]))
      chmodSync(workspacesPath, 0o600)
      return { cleared: current.length > 0 } as never
    })
  }
  if (typeof AppStore.setHostWorkspaceRecordPortForTests === 'function') {
    AppStore.setHostWorkspaceRecordPortForTests(port)
  }
  return { AppStore, profilePath, workspacesPath, upserts, removed, clears: clears.count, port }
}

function tmpWorkspaceDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  profiles.push(directory)
  return directory
}

describe('HostWorkspaceWiring', () => {
  it('pins the pre-fix failure: the legacy workspace writes throw on the Host-owned gate', async () => {
    const pinDir = tmpWorkspaceDir('taskwraith-workspace-legacy-red-pin-')
    const { AppStore } = await importStoreWithHostOwnedGate([{ id: 'ws-red', path: pinDir }])
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-legacy-red-')
    const { LegacyStoreWriterGateClosedError } = await import('../store/LegacyStoreWriterGate')
    // This is exactly the user's bug on the workspaces family, reproduced at
    // HEAD: every one of the four legacy write paths throws out of writeJson's
    // legacy admission once the gate is Host-owned. The ViaHost variants below
    // are the route out; this pin keeps the failure mode documented.
    expect(() => AppStore.addOrUpdateWorkspace(workspaceDir)).toThrow(
      LegacyStoreWriterGateClosedError
    )
    expect(() => AppStore.removeWorkspace('ws-any')).toThrow(LegacyStoreWriterGateClosedError)
    expect(() => AppStore.clearWorkspaces()).toThrow(LegacyStoreWriterGateClosedError)
    expect(() => AppStore.pinWorkspaceRealPath('ws-red', pinDir, pinDir)).toThrow(
      LegacyStoreWriterGateClosedError
    )
  })

  it('(a) routes addOrUpdateWorkspace through the Host when the gate is Host-owned and adopts the Host realPath', async () => {
    const { AppStore, upserts } = await importStoreWithHostOwnedGate([])
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-add-')
    // RED-first evidence: at HEAD 379e2dd2e this call threw
    // LegacyStoreWriterGateClosedError synchronously out of writeJson's
    // legacy admission. It must now travel via workspace.record.upsert.
    const added = await AppStore.addOrUpdateWorkspaceViaHost(workspaceDir, { pinned: true })
    expect(upserts).toHaveLength(1)
    const [input] = upserts
    expect(input.path).toBe(workspaceDir)
    expect(input.displayName).toBeTruthy()
    expect(input.pinned).toBe(true)
    expect(added.path).toBe(workspaceDir)
    // The sharp point: the Host computes realPath itself (on macOS /var ->
    // /private/var), and Desktop adopts that authoritative value via read-back
    // rather than asserting its own.
    expect(added.realPath).toBeTruthy()
    expect(AppStore.getWorkspaces().find((w) => w.id === added.id)?.realPath).toBe(added.realPath)
  })

  it('(b) routes removeWorkspace through the Host', async () => {
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-remove-')
    const { AppStore, removed } = await importStoreWithHostOwnedGate([
      { id: 'ws-remove', path: workspaceDir }
    ])
    await AppStore.removeWorkspaceViaHost('ws-remove')
    expect(removed).toEqual(['ws-remove'])
    expect(AppStore.getWorkspaces()).toEqual([])
  })

  it('(c) routes clearWorkspaces through the Host', async () => {
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-clear-')
    const { AppStore, port } = await importStoreWithHostOwnedGate([
      { id: 'ws-clear', path: workspaceDir }
    ])
    await AppStore.clearWorkspacesViaHost()
    expect(port.clearWorkspaceRecords).toHaveBeenCalledOnce()
    expect(AppStore.getWorkspaces()).toEqual([])
  })

  it('(d) startup reconciliation pins realpaths through the Host and makes a refusal visible without failing startup', async () => {
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-pin-')
    const { AppStore, profilePath, upserts } = await importStoreWithHostOwnedGate([
      { id: 'ws-pin', path: workspaceDir }
    ])
    const { WorkspaceService } = await import('../services/WorkspaceService')
    const service = new WorkspaceService({
      appStore: AppStore as never,
      allowlist: {
        list: () => [],
        upsert: (entry) => entry as never,
        remove: () => false,
        clear: () => undefined
      },
      canonicalPath: (value) => value,
      resolveRealDirectory: async (value) => value,
      selectDirectory: async () => null,
      checkTrust: () => ({ trusted: true }) as never
    })
    const log = vi.fn()
    const pinned = await service.reconcileWorkspaceRealPaths(log)
    expect(pinned).toBe(1)
    expect(upserts).toHaveLength(1)
    expect(upserts[0].workspaceId).toBe('ws-pin')
    expect(AppStore.getWorkspaces().find((w) => w.id === 'ws-pin')?.realPath).toBeTruthy()
    void profilePath
  })

  it('(d2) a refused startup pin is logged and reconciliation completes instead of throwing', async () => {
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-pin-refused-')
    const { AppStore, port } = await importStoreWithHostOwnedGate([
      { id: 'ws-refused', path: workspaceDir }
    ])
    port.upsertWorkspaceRecord.mockRejectedValueOnce(new Error('Host socket closed'))
    const { WorkspaceService } = await import('../services/WorkspaceService')
    const service = new WorkspaceService({
      appStore: AppStore as never,
      allowlist: {
        list: () => [],
        upsert: (entry) => entry as never,
        remove: () => false,
        clear: () => undefined
      },
      canonicalPath: (value) => value,
      resolveRealDirectory: async (value) => value,
      selectDirectory: async () => null,
      checkTrust: () => ({ trusted: true }) as never
    })
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const pinned = await service.reconcileWorkspaceRealPaths()
      // Nothing was pinned, startup did not fail — and the refusal is VISIBLE
      // rather than swallowed like the pre-fix catch.
      expect(pinned).toBe(0)
      expect(consoleWarn).toHaveBeenCalled()
      const report = consoleWarn.mock.calls.flat().join(' ')
      expect(report).toContain('ws-refused')
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it('(e) routes the native folder-picker selection through the Host (sidebar add-workspace)', async () => {
    const workspaceDir = tmpWorkspaceDir('taskwraith-workspace-native-')
    const { AppStore, upserts } = await importStoreWithHostOwnedGate([])
    const { WorkspaceService } = await import('../services/WorkspaceService')
    const service = new WorkspaceService({
      appStore: AppStore as never,
      allowlist: {
        list: () => [],
        upsert: (entry) => entry as never,
        remove: () => false,
        clear: () => undefined
      },
      canonicalPath: (value) => value,
      resolveRealDirectory: async (value) => value,
      selectDirectory: async () => null,
      checkTrust: () => ({ trusted: true }) as never
    })
    // Review2's residual: this exact path threw LegacyStoreWriterGateClosedError
    // at HEAD for the sidebar + / Settings "add workspace" button.
    const added = await service.addWorkspaceFromNativeSelection(workspaceDir)
    expect(upserts).toHaveLength(1)
    const [input] = upserts
    expect(input.path).toBe(workspaceDir)
    // The caller-asserted realPath is stripped at the wire; the Host computes
    // it and the returned record adopts the Host's value via read-back.
    expect('realPath' in input).toBe(false)
    expect(added.realPath).toBeTruthy()
    expect(AppStore.getWorkspaces().find((w) => w.id === added.id)?.realPath).toBe(added.realPath)
  })
})
