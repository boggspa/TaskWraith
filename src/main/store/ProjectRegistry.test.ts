import { describe, expect, it } from 'vitest'

import { createProjectRegistry, type ProjectRegistry } from './ProjectRegistry'
import { applyProjectOp, type Project, type ProjectOp } from '../../shared/projects'

interface Harness {
  registry: ProjectRegistry
  files: Map<string, unknown>
  writes: () => number
  changes: Project[][]
}

function buildHarness(seedFile?: unknown): Harness {
  const files = new Map<string, unknown>()
  if (seedFile !== undefined) files.set('projects.json', seedFile)
  let writeCount = 0
  const changes: Project[][] = []
  let tick = 1000
  const registry = createProjectRegistry({
    filePath: 'projects.json',
    readJson: <T>(filePath: string, defaultData: T): T =>
      files.has(filePath) ? (files.get(filePath) as T) : defaultData,
    writeJson: (filePath, data) => {
      writeCount += 1
      // Round-trip through JSON like the real writer so non-serializable
      // state would be caught here too.
      files.set(filePath, JSON.parse(JSON.stringify(data)))
    },
    now: () => ++tick
  })
  registry.setChangeListener((projects) => changes.push(projects))
  return { registry, files, writes: () => writeCount, changes }
}

const createOp = (id: string, name: string, extra: Partial<ProjectOp & { kind: 'create' }> = {}): ProjectOp => ({
  kind: 'create',
  input: { name },
  id,
  now: 50,
  defaultHue: 120,
  ...extra
})

describe('ProjectRegistry applyOp', () => {
  it('persists changes, notifies the listener, and returns authoritative state', () => {
    const harness = buildHarness()
    const result = harness.registry.applyOp(createOp('project-a', 'Alpha'))
    expect(result.changed).toBe(true)
    expect(result.projects).toHaveLength(1)
    expect(harness.writes()).toBe(1)
    expect(harness.changes).toHaveLength(1)
    expect(harness.registry.getProjects()[0]).toMatchObject({ id: 'project-a', name: 'Alpha' })
  })

  it('skips persistence and notification for no-op mutations', () => {
    const harness = buildHarness()
    harness.registry.applyOp(createOp('project-a', 'Alpha'))
    const before = harness.writes()
    const result = harness.registry.applyOp({
      kind: 'rename',
      projectId: 'project-a',
      name: 'Alpha',
      now: 60
    })
    expect(result.changed).toBe(false)
    expect(harness.writes()).toBe(before)
    expect(harness.changes).toHaveLength(1)
  })

  it('propagates validation errors without corrupting state', () => {
    const harness = buildHarness()
    harness.registry.applyOp(createOp('project-a', 'Alpha'))
    expect(() =>
      harness.registry.applyOp({ kind: 'rename', projectId: 'missing', name: 'X', now: 60 })
    ).toThrow('Project not found.')
    expect(harness.registry.getProjects()).toHaveLength(1)
  })

  it('matches a renderer-side optimistic apply op-for-op', () => {
    const script: ProjectOp[] = [
      createOp('project-a', 'Alpha'),
      createOp('project-b', 'Beta'),
      { kind: 'add-chat', projectId: 'project-a', chatId: 'chat-1', now: 60 },
      { kind: 'move', projectId: 'project-b', parentId: 'project-a', now: 70 },
      { kind: 'set-icon-hue', projectId: 'project-b', patch: { hue: 12 }, now: 80 }
    ]
    const harness = buildHarness()
    let optimistic: Project[] = []
    for (const op of script) {
      optimistic = applyProjectOp(optimistic, op).projects
      harness.registry.applyOp(op)
    }
    expect(harness.registry.getProjects()).toEqual(optimistic)
  })
})

describe('ProjectRegistry envelope resilience', () => {
  it('returns an empty list for a missing file', () => {
    expect(buildHarness().registry.getProjects()).toEqual([])
  })

  it('degrades unrecognizable envelopes to an empty registry', () => {
    expect(buildHarness('garbage').registry.getProjects()).toEqual([])
    expect(buildHarness(42).registry.getProjects()).toEqual([])
  })

  it('adopts a bare-array file and heals malformed records via shared migration', () => {
    const harness = buildHarness([
      { schemaVersion: 1, id: 'keep', name: 'Keep' },
      { schemaVersion: 1, id: '', name: 'Dropped' }
    ])
    const projects = harness.registry.getProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: 'keep', name: 'Keep', schemaVersion: 1 })
  })

  it('drops a malformed legacyImport marker instead of trusting it', () => {
    const harness = buildHarness({
      schemaVersion: 1,
      projects: [],
      legacyImport: { importedAt: 'yesterday' }
    })
    expect(harness.registry.getLegacyImportMarker()).toBeNull()
  })
})

describe('ProjectRegistry legacy import', () => {
  const legacyPayload = JSON.stringify([
    {
      schemaVersion: 1,
      id: 'legacy-a',
      name: 'Legacy A',
      icon: { iconKind: 'seed', seed: 'legacy-a' },
      hue: 10,
      parentId: null,
      order: 1,
      memberChatIds: ['chat-1'],
      createdAt: 1,
      updatedAt: 2
    },
    { schemaVersion: 1, id: '', name: 'Invalid record' }
  ])

  it('imports once, records the marker, and is idempotent afterwards', () => {
    const harness = buildHarness()
    const first = harness.registry.importLegacyProjects(legacyPayload)
    expect(first.status).toBe('imported')
    expect(first.importedCount).toBe(1)
    expect(first.marker.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(harness.registry.getProjects()).toHaveLength(1)
    expect(harness.changes).toHaveLength(1)

    const second = harness.registry.importLegacyProjects(legacyPayload)
    expect(second.status).toBe('already-imported')
    expect(second.importedCount).toBe(1)
    expect(harness.registry.getProjects()).toHaveLength(1)
    expect(harness.changes).toHaveLength(1)
  })

  it('never re-imports after an op created registry-native records', () => {
    const harness = buildHarness()
    harness.registry.importLegacyProjects(legacyPayload)
    harness.registry.applyOp(createOp('project-new', 'Native'))
    const again = harness.registry.importLegacyProjects(legacyPayload)
    expect(again.status).toBe('already-imported')
    expect(harness.registry.getProjects()).toHaveLength(2)
  })

  it('keeps registry-native records on id collision during import', () => {
    const harness = buildHarness()
    harness.registry.applyOp(createOp('legacy-a', 'Native wins'))
    const result = harness.registry.importLegacyProjects(legacyPayload)
    expect(result.status).toBe('imported')
    expect(result.importedCount).toBe(0)
    const projects = harness.registry.getProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].name).toBe('Native wins')
  })

  it('records a terminal marker for empty and missing payloads', () => {
    const missing = buildHarness().registry.importLegacyProjects(null)
    expect(missing.status).toBe('nothing-to-import')
    expect(missing.importedCount).toBe(0)

    const empty = buildHarness().registry.importLegacyProjects('[]')
    expect(empty.status).toBe('nothing-to-import')
    expect(empty.marker.status).toBe('nothing-to-import')
  })

  it('records a terminal marker for unparseable payloads so the handshake ends', () => {
    const harness = buildHarness()
    const result = harness.registry.importLegacyProjects('{not json')
    expect(result.status).toBe('invalid-payload')
    expect(result.importedCount).toBe(0)
    expect(harness.registry.getLegacyImportMarker()?.status).toBe('invalid-payload')
    expect(harness.registry.importLegacyProjects('[]').status).toBe('already-imported')
  })
})
