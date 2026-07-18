import { describe, expect, it } from 'vitest'

import {
  createProjectRegistry,
  type ProjectRegistry,
  type ProjectRegistryState
} from './ProjectRegistry'
import { applyProjectOp, type Project, type ProjectOp } from '../../shared/projects'

interface Harness {
  registry: ProjectRegistry
  files: Map<string, unknown>
  writes: () => number
  changes: ProjectRegistryState[]
}

function buildHarness(seedFile?: unknown): Harness {
  const files = new Map<string, unknown>()
  if (seedFile !== undefined) files.set('projects.json', seedFile)
  let writeCount = 0
  const changes: ProjectRegistryState[] = []
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
  registry.setChangeListener((state) => changes.push(state))
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

describe('ProjectRegistry home-chat claims', () => {
  function harnessWithProjects(): Harness {
    const harness = buildHarness()
    harness.registry.applyOp(createOp('project-a', 'Alpha'))
    harness.registry.applyOp(createOp('project-b', 'Beta'))
    return harness
  }

  it('claims a home chat and adds membership in one write', () => {
    const harness = harnessWithProjects()
    const before = harness.writes()
    const result = harness.registry.setHomeChat('project-a', 'chat-home')
    expect(result.changed).toBe(true)
    expect(harness.writes()).toBe(before + 1)
    expect(result.workProfiles).toEqual([
      expect.objectContaining({ projectId: 'project-a', homeChatId: 'chat-home' })
    ])
    expect(result.projects.find((p) => p.id === 'project-a')?.memberChatIds).toContain('chat-home')
    expect(harness.changes.at(-1)?.workProfiles).toHaveLength(1)
  })

  it('is idempotent for an already-claimed home', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-home')
    const before = harness.writes()
    const result = harness.registry.setHomeChat('project-a', 'chat-home')
    expect(result.changed).toBe(false)
    expect(harness.writes()).toBe(before)
  })

  it('enforces one home per chat across projects', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-home')
    expect(() => harness.registry.setHomeChat('project-b', 'chat-home')).toThrow(
      'Chat is already the home of another project.'
    )
    expect(() => harness.registry.setHomeChat('missing', 'chat-x')).toThrow('Project not found.')
    expect(() => harness.registry.setHomeChat('project-b', '   ')).toThrow('Chat id is required.')
  })

  it('re-homing a project replaces its claim and keeps prior membership', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-old')
    const result = harness.registry.setHomeChat('project-a', 'chat-new')
    expect(result.workProfiles).toEqual([
      expect.objectContaining({ projectId: 'project-a', homeChatId: 'chat-new' })
    ])
    const project = result.projects.find((p) => p.id === 'project-a')
    expect(project?.memberChatIds).toEqual(['chat-old', 'chat-new'])
  })

  it('clears a claim without touching membership and no-ops when nothing is claimed', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-home')
    const cleared = harness.registry.setHomeChat('project-a', null)
    expect(cleared.changed).toBe(true)
    expect(cleared.workProfiles).toEqual([])
    expect(cleared.projects.find((p) => p.id === 'project-a')?.memberChatIds).toContain(
      'chat-home'
    )
    expect(harness.registry.setHomeChat('project-a', null).changed).toBe(false)
  })

  it('drops orphaned profiles when the project is deleted', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-home')
    const result = harness.registry.applyOp({ kind: 'delete', projectId: 'project-a' })
    expect(result.workProfiles).toEqual([])
  })

  it('clears the claim when the home chat leaves the project or is deleted everywhere', () => {
    const removed = harnessWithProjects()
    removed.registry.setHomeChat('project-a', 'chat-home')
    const afterRemove = removed.registry.applyOp({
      kind: 'remove-chat',
      projectId: 'project-a',
      chatId: 'chat-home',
      now: 60
    })
    expect(afterRemove.workProfiles).toEqual([])
    expect(afterRemove.changed).toBe(true)

    const everywhere = harnessWithProjects()
    everywhere.registry.setHomeChat('project-b', 'chat-shared')
    const afterEverywhere = everywhere.registry.applyOp({
      kind: 'remove-chat-everywhere',
      chatId: 'chat-shared',
      now: 70
    })
    expect(afterEverywhere.workProfiles).toEqual([])
  })

  it('stores references, drops them with their project, and round-trips instances', () => {
    const harness = harnessWithProjects()
    const added = harness.registry.applyReferenceOp({
      kind: 'add-reference',
      id: 'ref-1',
      projectId: 'project-a',
      referenceKind: 'url',
      locator: 'https://docs.example.com/spec',
      now: 50
    })
    expect(added.changed).toBe(true)
    expect(added.references[0]).toMatchObject({ title: 'docs.example.com' })
    expect(harness.changes.at(-1)?.references).toHaveLength(1)

    const verified = harness.registry.applyReferenceOp({
      kind: 'record-reference-verification',
      id: 'ref-1',
      status: 'ok',
      now: 60
    })
    expect(verified.references[0].lastVerified).toEqual({ at: 60, status: 'ok' })
    expect(harness.registry.getReferences()).toHaveLength(1)

    const afterDelete = harness.registry.applyOp({ kind: 'delete', projectId: 'project-a' })
    expect(afterDelete.references).toEqual([])
    expect(afterDelete.changed).toBe(true)
  })

  it('rejects reference ops against unknown projects or ids without corrupting state', () => {
    const harness = harnessWithProjects()
    expect(() =>
      harness.registry.applyReferenceOp({
        kind: 'add-reference',
        id: 'ref-x',
        projectId: 'missing',
        referenceKind: 'file',
        locator: '/a.md',
        now: 1
      })
    ).toThrow('Project not found.')
    expect(() =>
      harness.registry.applyReferenceOp({ kind: 'remove-reference', id: 'ref-x' })
    ).toThrow('Reference not found.')
    expect(harness.registry.getReferences()).toEqual([])
  })

  it('upserts and clears user-authored profile fields without touching the claim', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-home')

    const withFields = harness.registry.setWorkProfileFields('project-a', {
      brief: '  Ship the Work surface  ',
      preferredWorkspaceId: 'ws-1'
    })
    expect(withFields.changed).toBe(true)
    expect(withFields.workProfiles).toEqual([
      expect.objectContaining({
        projectId: 'project-a',
        homeChatId: 'chat-home',
        brief: '  Ship the Work surface  '.slice(0, 4000),
        preferredWorkspaceId: 'ws-1'
      })
    ])

    const unchanged = harness.registry.setWorkProfileFields('project-a', { brief: withFields.workProfiles[0].brief })
    expect(unchanged.changed).toBe(false)

    const cleared = harness.registry.setWorkProfileFields('project-a', {
      brief: null,
      preferredWorkspaceId: null
    })
    expect(cleared.workProfiles).toEqual([
      expect.objectContaining({ projectId: 'project-a', homeChatId: 'chat-home' })
    ])
    expect(cleared.workProfiles[0].brief).toBeUndefined()
    expect(cleared.workProfiles[0].preferredWorkspaceId).toBeUndefined()
  })

  it('drops a profile emptied of every semantic field and validates inputs', () => {
    const harness = harnessWithProjects()
    harness.registry.setWorkProfileFields('project-a', { brief: 'Something' })
    const emptied = harness.registry.setWorkProfileFields('project-a', { brief: null })
    expect(emptied.workProfiles).toEqual([])

    expect(() => harness.registry.setWorkProfileFields('missing', { brief: 'x' })).toThrow(
      'Project not found.'
    )
    expect(() => harness.registry.setWorkProfileFields('project-a', {})).toThrow(
      'No profile update provided.'
    )
    const noProfileNoop = harness.registry.setWorkProfileFields('project-a', { brief: null })
    expect(noProfileNoop.changed).toBe(false)
  })

  it('persists claims across registry instances and heals duplicate claims on read', () => {
    const harness = harnessWithProjects()
    harness.registry.setHomeChat('project-a', 'chat-home')
    const reopened = createProjectRegistry({
      filePath: 'projects.json',
      readJson: <T>(filePath: string, defaultData: T): T =>
        harness.files.has(filePath) ? (harness.files.get(filePath) as T) : defaultData,
      writeJson: () => {},
      now: () => 9999
    })
    expect(reopened.getWorkProfiles()).toEqual([
      expect.objectContaining({ projectId: 'project-a', homeChatId: 'chat-home' })
    ])

    // Hand-corrupted duplicate claim: the second profile loses its home.
    const file = harness.files.get('projects.json') as { workProfiles: unknown[] }
    file.workProfiles.push({ projectId: 'project-b', homeChatId: 'chat-home', updatedAt: 1 })
    expect(reopened.getWorkProfiles()).toEqual([
      expect.objectContaining({ projectId: 'project-a', homeChatId: 'chat-home' })
    ])
  })
})
