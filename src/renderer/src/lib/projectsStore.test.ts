import { beforeEach, describe, expect, it, vi } from 'vitest'

// Install the fake window (localStorage + preload bridge) before importing the
// store module, matching the pattern used across renderer store tests. The
// facade is a sync API over async IPC, so the api fns are vi.fn mocks whose
// per-test implementations are primed in beforeEach.
const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    }
  }
  const broadcast: { cb: ((projects: unknown) => void) | null } = { cb: null }
  const api = {
    getProjectsSnapshot: vi.fn(),
    applyProjectOp: vi.fn(),
    setProjectHomeChat: vi.fn(),
    applyProjectReferenceOp: vi.fn(),
    verifyProjectReference: vi.fn(),
    importLegacyProjects: vi.fn(),
    onProjectsChanged: vi.fn()
  }
  const fakeWindow = { localStorage, api }
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  return { store, localStorage, api, broadcast, fakeWindow }
})

import {
  addChatToProject,
  addProjectReference,
  createProject,
  getProjectWorkProfile,
  listProjects,
  listProjectReferences,
  listProjectWorkProfiles,
  PROJECTS_STORAGE_KEY,
  removeChatFromAllProjects,
  renameProject,
  resetProjectsStoreForTests,
  setProjectHomeChat,
  subscribeProjects,
  verifyProjectReference,
  whenProjectsStoreReady,
  type Project
} from './projectsStore'

function legacyRecord(id: string, name: string, memberChatIds: string[] = []): Project {
  return {
    schemaVersion: 1,
    id,
    name,
    icon: { iconKind: 'seed', seed: id },
    hue: 10,
    parentId: null,
    order: 1,
    memberChatIds,
    createdAt: 1,
    updatedAt: 2
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  resetProjectsStoreForTests()
  fake.store.clear()
  fake.broadcast.cb = null
  fake.api.getProjectsSnapshot.mockReset()
  fake.api.applyProjectOp.mockReset()
  fake.api.setProjectHomeChat.mockReset()
  fake.api.importLegacyProjects.mockReset()
  fake.api.onProjectsChanged.mockReset()
  fake.api.getProjectsSnapshot.mockImplementation(async () => ({
    projects: [],
    workProfiles: [],
    legacyImportMarker: null
  }))
  fake.api.applyProjectOp.mockImplementation(async () => ({ projects: [], changed: true }))
  fake.api.setProjectHomeChat.mockImplementation(async () => ({
    projects: [],
    workProfiles: [],
    changed: true
  }))
  fake.api.applyProjectReferenceOp.mockImplementation(async () => ({
    projects: [],
    workProfiles: [],
    references: [],
    changed: true
  }))
  fake.api.verifyProjectReference.mockImplementation(async () => ({
    projects: [],
    workProfiles: [],
    references: [],
    changed: true
  }))
  fake.api.importLegacyProjects.mockImplementation(async () => ({
    status: 'imported',
    importedCount: 0,
    marker: { importedAt: 1, sourceHash: 'x', importedCount: 0, status: 'imported' }
  }))
  fake.api.onProjectsChanged.mockImplementation((cb: (projects: unknown) => void) => {
    fake.broadcast.cb = cb
    return () => {
      fake.broadcast.cb = null
    }
  })
})

describe('projectsStore hydration', () => {
  it('hydrates from the main snapshot and serves it synchronously afterwards', async () => {
    fake.api.getProjectsSnapshot.mockImplementation(async () => ({
      projects: [legacyRecord('project-main', 'From Main')],
      legacyImportMarker: null
    }))
    const listener = vi.fn()
    subscribeProjects(listener)
    await whenProjectsStoreReady()
    expect(listProjects().map((project) => project.id)).toEqual(['project-main'])
    expect(listener).toHaveBeenCalled()
  })

  it('adopts projects-changed broadcasts when no ops are in flight', async () => {
    await whenProjectsStoreReady()
    expect(fake.broadcast.cb).toBeTypeOf('function')
    fake.broadcast.cb?.([legacyRecord('project-b', 'Broadcast')])
    expect(listProjects().map((project) => project.name)).toEqual(['Broadcast'])
  })
})

describe('projectsStore optimistic mutations', () => {
  it('applies locally first and dispatches the twin op to main', async () => {
    await whenProjectsStoreReady()
    const project = createProject({ name: 'Alpha' })
    expect(listProjects().map((entry) => entry.id)).toEqual([project.id])
    expect(fake.api.applyProjectOp).toHaveBeenCalledTimes(1)
    const op = fake.api.applyProjectOp.mock.calls[0][0]
    expect(op).toMatchObject({ kind: 'create', id: project.id, input: { name: 'Alpha' } })
    expect(op.now).toBe(project.createdAt)
  })

  it('skips IPC for no-op mutations', async () => {
    await whenProjectsStoreReady()
    const project = createProject({ name: 'Alpha' })
    fake.api.applyProjectOp.mockClear()
    renameProject(project.id, 'Alpha')
    expect(fake.api.applyProjectOp).not.toHaveBeenCalled()
    addChatToProject(project.id, 'chat-1')
    fake.api.applyProjectOp.mockClear()
    addChatToProject(project.id, 'chat-1')
    expect(fake.api.applyProjectOp).not.toHaveBeenCalled()
  })

  it('throws validation errors synchronously without dispatching', async () => {
    await whenProjectsStoreReady()
    expect(() => createProject({ name: '   ' })).toThrow('Project name is required.')
    expect(() => renameProject('missing', 'Name')).toThrow('Project not found.')
    expect(fake.api.applyProjectOp).not.toHaveBeenCalled()
  })

  it('resyncs from a fresh snapshot when main rejects an op', async () => {
    await whenProjectsStoreReady()
    const rejection = deferred<{ projects: Project[]; changed: boolean }>()
    fake.api.applyProjectOp.mockImplementation(() => rejection.promise)
    const created = createProject({ name: 'Doomed' })
    expect(listProjects().map((project) => project.id)).toEqual([created.id])

    fake.api.getProjectsSnapshot.mockImplementation(async () => ({
      projects: [legacyRecord('project-authoritative', 'Authoritative')],
      legacyImportMarker: null
    }))
    rejection.reject(new Error('Project not found.'))
    await vi.waitFor(() => {
      expect(listProjects().map((project) => project.id)).toEqual(['project-authoritative'])
    })
  })

  it('defers broadcast adoption while an op is in flight', async () => {
    await whenProjectsStoreReady()
    const settle = deferred<{ projects: Project[]; changed: boolean }>()
    fake.api.applyProjectOp.mockImplementation(() => settle.promise)
    const created = createProject({ name: 'Alpha' })

    // A stale broadcast (e.g. from the import path) must not rewind the
    // optimistic create while its op is still in flight.
    fake.broadcast.cb?.([])
    expect(listProjects().map((project) => project.id)).toEqual([created.id])

    settle.resolve({
      projects: [legacyRecord(created.id, 'Alpha')],
      changed: true
    })
    await vi.waitFor(() => {
      expect(listProjects().map((project) => project.id)).toEqual([created.id])
    })
  })

  it('always dispatches chat-deletion reconciliation, even as a local no-op', async () => {
    await whenProjectsStoreReady()
    const changed = removeChatFromAllProjects('chat-unknown')
    expect(changed).toBe(0)
    expect(fake.api.applyProjectOp).toHaveBeenCalledTimes(1)
    expect(fake.api.applyProjectOp.mock.calls[0][0]).toMatchObject({
      kind: 'remove-chat-everywhere',
      chatId: 'chat-unknown'
    })
  })
})

describe('projectsStore work profiles', () => {
  it('hydrates profiles from the snapshot and adopts them from state broadcasts', async () => {
    fake.api.getProjectsSnapshot.mockImplementation(async () => ({
      projects: [legacyRecord('project-a', 'Alpha', ['chat-1'])],
      workProfiles: [{ projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 5 }],
      legacyImportMarker: null
    }))
    await whenProjectsStoreReady()
    expect(getProjectWorkProfile('project-a')).toEqual({
      projectId: 'project-a',
      homeChatId: 'chat-1',
      updatedAt: 5
    })

    fake.broadcast.cb?.({
      projects: [legacyRecord('project-a', 'Alpha', ['chat-1'])],
      workProfiles: []
    })
    expect(listProjectWorkProfiles()).toEqual([])
  })

  it('drops profiles whose project vanished from the adopted payload', async () => {
    await whenProjectsStoreReady()
    fake.broadcast.cb?.({
      projects: [],
      workProfiles: [{ projectId: 'project-gone', homeChatId: 'chat-1', updatedAt: 5 }]
    })
    expect(listProjectWorkProfiles()).toEqual([])
  })

  it('claims a home chat through main and adopts the authoritative result', async () => {
    await whenProjectsStoreReady()
    fake.api.setProjectHomeChat.mockImplementation(async () => ({
      projects: [legacyRecord('project-a', 'Alpha', ['chat-1'])],
      workProfiles: [{ projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 6 }],
      changed: true
    }))
    await setProjectHomeChat('project-a', 'chat-1')
    expect(fake.api.setProjectHomeChat).toHaveBeenCalledWith('project-a', 'chat-1')
    expect(getProjectWorkProfile('project-a')?.homeChatId).toBe('chat-1')
    expect(listProjects().map((project) => project.id)).toEqual(['project-a'])
  })

  it('propagates claim rejections to the caller', async () => {
    await whenProjectsStoreReady()
    fake.api.setProjectHomeChat.mockImplementation(async () => {
      throw new Error('Chat is already the home of another project.')
    })
    await expect(setProjectHomeChat('project-a', 'chat-1')).rejects.toThrow(
      'Chat is already the home of another project.'
    )
    expect(listProjectWorkProfiles()).toEqual([])
  })
})

describe('projectsStore references', () => {
  const referenceRecord = {
    id: 'ref-1',
    projectId: 'project-a',
    kind: 'file' as const,
    locator: '/repo/spec.md',
    title: 'spec.md',
    provenance: { addedBy: 'user' as const, addedAt: 1 },
    contextPolicy: 'available' as const,
    updatedAt: 1
  }

  it('hydrates references and serves per-project filtered reads', async () => {
    fake.api.getProjectsSnapshot.mockImplementation(async () => ({
      projects: [legacyRecord('project-a', 'Alpha'), legacyRecord('project-b', 'Beta')],
      workProfiles: [],
      references: [referenceRecord, { ...referenceRecord, id: 'ref-2', projectId: 'project-b' }],
      legacyImportMarker: null
    }))
    await whenProjectsStoreReady()
    expect(listProjectReferences()).toHaveLength(2)
    expect(listProjectReferences('project-a').map((reference) => reference.id)).toEqual(['ref-1'])
  })

  it('adds a reference through main with generated id seeds and adopts the result', async () => {
    fake.api.getProjectsSnapshot.mockImplementation(async () => ({
      projects: [legacyRecord('project-a', 'Alpha')],
      workProfiles: [],
      references: [],
      legacyImportMarker: null
    }))
    await whenProjectsStoreReady()
    fake.api.applyProjectReferenceOp.mockImplementation(async (op: { id: string }) => ({
      projects: [legacyRecord('project-a', 'Alpha')],
      workProfiles: [],
      references: [{ ...referenceRecord, id: op.id }],
      changed: true
    }))
    await addProjectReference({ projectId: 'project-a', kind: 'file', locator: '/repo/spec.md' })
    const op = fake.api.applyProjectReferenceOp.mock.calls[0][0]
    expect(op).toMatchObject({
      kind: 'add-reference',
      projectId: 'project-a',
      referenceKind: 'file',
      locator: '/repo/spec.md'
    })
    expect(op.id).toMatch(/^ref-/)
    expect(listProjectReferences('project-a')).toHaveLength(1)
  })

  it('adopts verification results and propagates rejections', async () => {
    await whenProjectsStoreReady()
    fake.api.verifyProjectReference.mockImplementation(async () => {
      throw new Error('URL references cannot be verified automatically.')
    })
    await expect(verifyProjectReference('ref-x')).rejects.toThrow(
      'URL references cannot be verified automatically.'
    )
  })
})

describe('projectsStore legacy migration handshake', () => {
  const legacyPayload = JSON.stringify([legacyRecord('legacy-a', 'Legacy A', ['chat-1'])])

  it('imports the legacy payload and tombstones ONLY after the ack', async () => {
    fake.store.set(PROJECTS_STORAGE_KEY, legacyPayload)
    const importGate = deferred<unknown>()
    fake.api.importLegacyProjects.mockImplementation(() => importGate.promise)

    listProjects() // kick hydration
    await vi.waitFor(() => {
      expect(fake.api.importLegacyProjects).toHaveBeenCalledWith(legacyPayload)
    })
    // Ack not yet received: the raw payload must survive.
    expect(fake.store.get(PROJECTS_STORAGE_KEY)).toBe(legacyPayload)

    importGate.resolve({
      status: 'imported',
      importedCount: 1,
      marker: { importedAt: 1, sourceHash: 'x', importedCount: 1, status: 'imported' }
    })
    await whenProjectsStoreReady()
    const raw = fake.store.get(PROJECTS_STORAGE_KEY)
    expect(raw).toBeDefined()
    expect(JSON.parse(raw as string)).toMatchObject({ migratedToMain: true })
    // Post-import refetch pulls the authoritative merge.
    expect(fake.api.getProjectsSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('skips the import and just tombstones when main already holds the marker', async () => {
    fake.store.set(PROJECTS_STORAGE_KEY, legacyPayload)
    fake.api.getProjectsSnapshot.mockImplementation(async () => ({
      projects: [],
      legacyImportMarker: { importedAt: 1, sourceHash: 'x', importedCount: 1, status: 'imported' }
    }))
    await whenProjectsStoreReady()
    expect(fake.api.importLegacyProjects).not.toHaveBeenCalled()
    expect(JSON.parse(fake.store.get(PROJECTS_STORAGE_KEY) as string)).toMatchObject({
      migratedToMain: true
    })
  })

  it('leaves the legacy payload untouched when the import invoke fails', async () => {
    fake.store.set(PROJECTS_STORAGE_KEY, legacyPayload)
    fake.api.importLegacyProjects.mockImplementation(async () => {
      throw new Error('main unavailable')
    })
    await whenProjectsStoreReady()
    expect(fake.store.get(PROJECTS_STORAGE_KEY)).toBe(legacyPayload)
  })

  it('does nothing on a fresh install and ignores an existing tombstone', async () => {
    await whenProjectsStoreReady()
    expect(fake.api.importLegacyProjects).not.toHaveBeenCalled()
    expect(fake.store.has(PROJECTS_STORAGE_KEY)).toBe(false)

    resetProjectsStoreForTests()
    const tombstone = JSON.stringify({ schemaVersion: 1, migratedToMain: true, migratedAt: 5 })
    fake.store.set(PROJECTS_STORAGE_KEY, tombstone)
    await whenProjectsStoreReady()
    expect(fake.api.importLegacyProjects).not.toHaveBeenCalled()
    expect(fake.store.get(PROJECTS_STORAGE_KEY)).toBe(tombstone)
  })
})

describe('projectsStore without a preload bridge', () => {
  it('degrades to a pure in-memory store for headless renders', async () => {
    const windowRef = fake.fakeWindow as { api?: unknown }
    const savedApi = windowRef.api
    try {
      delete windowRef.api
      resetProjectsStoreForTests()
      const project = createProject({ name: 'Headless' })
      expect(listProjects().map((entry) => entry.id)).toEqual([project.id])
      await whenProjectsStoreReady()
    } finally {
      windowRef.api = savedApi
    }
  })
})
