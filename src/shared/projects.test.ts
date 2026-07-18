import { describe, expect, it } from 'vitest'

import {
  applyAddChatToProject,
  applyCreateProject,
  applyDeleteProject,
  applyMoveProject,
  applyProjectOp,
  applyProjectReferenceOp,
  applyRemoveChatFromAllProjects,
  applyRenameProject,
  applyReorderProject,
  applySetProjectIconAndHue,
  defaultProjectReferenceTitle,
  migrateProjectReferences,
  migrateProjectWorkProfiles,
  migrateProjects,
  parseProjectOp,
  parseProjectReferenceOp,
  sortProjectsForDisplay,
  type Project,
  type ProjectOp,
  type ProjectReferenceOp
} from './projects'

const seed = (id: string, now = 1000, defaultHue = 120) => ({ id, now, defaultHue })

function buildThreeRoots(): Project[] {
  let projects: Project[] = []
  projects = applyCreateProject(projects, { name: 'Alpha' }, seed('project-a')).projects
  projects = applyCreateProject(projects, { name: 'Beta' }, seed('project-b')).projects
  projects = applyCreateProject(projects, { name: 'Gamma' }, seed('project-c')).projects
  return projects
}

describe('apply functions', () => {
  it('creates with explicit seed data only — id, timestamps, and default hue all come from the op', () => {
    const { projects, project } = applyCreateProject(
      [],
      { name: '  Seeded  ' },
      { id: 'project-x', now: 4242, defaultHue: 301 }
    )
    expect(project).toMatchObject({
      schemaVersion: 1,
      id: 'project-x',
      name: 'Seeded',
      hue: 301,
      order: 1,
      createdAt: 4242,
      updatedAt: 4242
    })
    expect(projects).toHaveLength(1)
  })

  it('prefers an explicit input hue over the seed default, including hue 0', () => {
    const explicit = applyCreateProject([], { name: 'A', hue: 42 }, seed('project-a')).project
    expect(explicit.hue).toBe(42)
    const zero = applyCreateProject([], { name: 'B', hue: 0 }, seed('project-b')).project
    expect(zero.hue).toBe(0)
  })

  it('signals no-ops by returning the same array reference', () => {
    const projects = buildThreeRoots()
    const renamed = applyRenameProject(projects, 'project-a', 'Alpha', 2000)
    expect(renamed.projects).toBe(projects)

    const withChat = applyAddChatToProject(projects, 'project-a', 'chat-1', 2000)
    const again = applyAddChatToProject(withChat.projects, 'project-a', 'chat-1', 3000)
    expect(again.projects).toBe(withChat.projects)

    const samePlace = applyReorderProject(projects, 'project-a', 1, 2000)
    expect(samePlace.projects).toBe(projects)

    const sameParent = applyMoveProject(projects, 'project-a', null, undefined, 2000)
    expect(sameParent.projects).toBe(projects)

    const noMembers = applyRemoveChatFromAllProjects(projects, 'chat-none', 2000)
    expect(noMembers.projects).toBe(projects)
    expect(noMembers.changedCount).toBe(0)
  })

  it('deletes a project plus every descendant and reindexes the remaining siblings', () => {
    let projects = buildThreeRoots()
    projects = applyCreateProject(
      projects,
      { name: 'Child', parentId: 'project-b' },
      seed('project-child')
    ).projects
    projects = applyCreateProject(
      projects,
      { name: 'Grandchild', parentId: 'project-child' },
      seed('project-grandchild')
    ).projects

    const next = applyDeleteProject(projects, 'project-b')
    expect(next.map((project) => project.id).sort()).toEqual(['project-a', 'project-c'])
    const roots = sortProjectsForDisplay(next)
    expect(roots.map((project) => project.order)).toEqual([1, 2])
  })

  it('preserves the historical validation errors', () => {
    const projects = buildThreeRoots()
    expect(() => applyCreateProject([], { name: '   ' }, seed('project-x'))).toThrow(
      'Project name is required.'
    )
    expect(() =>
      applyCreateProject([], { name: 'Orphan', parentId: 'missing' }, seed('project-x'))
    ).toThrow('Parent project not found.')
    expect(() => applyRenameProject(projects, 'missing', 'Name', 1)).toThrow('Project not found.')
    expect(() => applyReorderProject(projects, 'project-a', Number.NaN, 1)).toThrow(
      'Invalid order.'
    )
    expect(() => applySetProjectIconAndHue(projects, 'project-a', {}, 1)).toThrow(
      'No update provided for icon or hue.'
    )
    expect(() => applyAddChatToProject(projects, 'project-a', '   ', 1)).toThrow(
      'Chat id is required.'
    )

    let nested = applyCreateProject(
      projects,
      { name: 'Child', parentId: 'project-a' },
      seed('project-child')
    ).projects
    nested = applyCreateProject(
      nested,
      { name: 'Grandchild', parentId: 'project-child' },
      seed('project-grandchild')
    ).projects
    expect(() =>
      applyMoveProject(nested, 'project-a', 'project-grandchild', undefined, 1)
    ).toThrow('Cannot move a project into its own descendant.')
  })
})

describe('applyProjectOp determinism', () => {
  const script: ProjectOp[] = [
    { kind: 'create', input: { name: 'Alpha' }, id: 'project-a', now: 100, defaultHue: 10 },
    { kind: 'create', input: { name: 'Beta' }, id: 'project-b', now: 110, defaultHue: 20 },
    {
      kind: 'create',
      input: { name: 'Child', parentId: 'project-a' },
      id: 'project-child',
      now: 120,
      defaultHue: 30
    },
    { kind: 'rename', projectId: 'project-b', name: 'Beta Renamed', now: 130 },
    { kind: 'add-chat', projectId: 'project-a', chatId: 'chat-1', now: 140 },
    { kind: 'add-chat', projectId: 'project-child', chatId: 'chat-1', now: 150 },
    { kind: 'reorder', projectId: 'project-b', order: 1, now: 160 },
    { kind: 'move', projectId: 'project-child', parentId: null, order: 2, now: 170 },
    { kind: 'set-icon-hue', projectId: 'project-a', patch: { hue: 200 }, now: 180 },
    { kind: 'remove-chat-everywhere', chatId: 'chat-1', now: 190 }
  ]

  function replay(): Project[] {
    let projects: Project[] = []
    for (const op of script) {
      projects = applyProjectOp(projects, op).projects
    }
    return projects
  }

  it('replays an op script to an identical state — the optimistic/authoritative contract', () => {
    expect(replay()).toEqual(replay())
  })

  it('reports changed=false for no-op ops so callers skip persist/broadcast', () => {
    const projects = replay()
    expect(applyProjectOp(projects, script[3]).changed).toBe(false)
    expect(
      applyProjectOp(projects, { kind: 'remove-chat-everywhere', chatId: 'chat-1', now: 500 })
        .changed
    ).toBe(false)
    expect(
      applyProjectOp(projects, { kind: 'rename', projectId: 'project-a', name: 'Renamed', now: 500 })
        .changed
    ).toBe(true)
  })
})

describe('parseProjectOp', () => {
  it('round-trips every op kind', () => {
    const ops: ProjectOp[] = [
      { kind: 'create', input: { name: 'A' }, id: 'project-a', now: 1, defaultHue: 2 },
      { kind: 'rename', projectId: 'p', name: 'B', now: 1 },
      { kind: 'delete', projectId: 'p' },
      { kind: 'reorder', projectId: 'p', order: 2, now: 1 },
      { kind: 'move', projectId: 'p', parentId: null, order: 1, now: 1 },
      { kind: 'move', projectId: 'p', parentId: 'q', now: 1 },
      { kind: 'set-icon-hue', projectId: 'p', patch: { hue: 3 }, now: 1 },
      { kind: 'add-chat', projectId: 'p', chatId: 'c', now: 1 },
      { kind: 'remove-chat', projectId: 'p', chatId: 'c', now: 1 },
      { kind: 'remove-chat-everywhere', chatId: 'c', now: 1 }
    ]
    for (const op of ops) {
      expect(parseProjectOp(JSON.parse(JSON.stringify(op)))).toEqual(op)
    }
  })

  it('rejects malformed payloads instead of letting apply TypeError', () => {
    expect(parseProjectOp(null)).toBeNull()
    expect(parseProjectOp('create')).toBeNull()
    expect(parseProjectOp({ kind: 'unknown-op' })).toBeNull()
    expect(parseProjectOp({ kind: 'create', input: { name: 7 }, id: 'x', now: 1, defaultHue: 1 })
    ).toBeNull()
    expect(parseProjectOp({ kind: 'create', input: null, id: 'x', now: 1, defaultHue: 1 })).toBeNull()
    expect(parseProjectOp({ kind: 'rename', projectId: 'p', name: 'B', now: 'soon' })).toBeNull()
    expect(parseProjectOp({ kind: 'reorder', projectId: 'p', order: 'first', now: 1 })).toBeNull()
    expect(parseProjectOp({ kind: 'move', projectId: 'p', parentId: 7, now: 1 })).toBeNull()
    expect(parseProjectOp({ kind: 'set-icon-hue', projectId: 'p', patch: null, now: 1 })).toBeNull()
    expect(parseProjectOp({ kind: 'add-chat', projectId: '', chatId: 'c', now: 1 })).toBeNull()
    expect(parseProjectOp({ kind: 'remove-chat-everywhere', chatId: 7, now: 1 })).toBeNull()
  })

  it('keeps NaN order parseable for reorder so apply can throw its stable Invalid order error', () => {
    // Finiteness is validated before existence (historical order), so NaN
    // throws 'Invalid order.' even for an unknown project id.
    const parsed = parseProjectOp({ kind: 'reorder', projectId: 'p', order: Number.NaN, now: 1 })
    expect(parsed).not.toBeNull()
    expect(() => applyProjectOp(buildThreeRoots(), parsed!)).toThrow('Invalid order.')
  })
})

describe('migrateProjectWorkProfiles', () => {
  const validIds = new Set(['project-a', 'project-b'])

  it('keeps known fields, seeds missing timestamps, and drops empty or orphaned profiles', () => {
    const migrated = migrateProjectWorkProfiles(
      [
        {
          projectId: 'project-a',
          homeChatId: '  chat-1  ',
          brief: 'Ship the Work surface',
          preferredWorkspaceId: 'ws-1'
        },
        { projectId: 'project-b', updatedAt: 42 },
        { projectId: 'project-gone', homeChatId: 'chat-2' },
        { projectId: 'project-b' },
        'garbage',
        null
      ],
      validIds,
      777
    )
    expect(migrated).toEqual([
      {
        projectId: 'project-a',
        homeChatId: 'chat-1',
        brief: 'Ship the Work surface',
        preferredWorkspaceId: 'ws-1',
        updatedAt: 777
      }
    ])
  })

  it('deduplicates by projectId and heals duplicate home claims deterministically', () => {
    const migrated = migrateProjectWorkProfiles(
      [
        { projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 1 },
        { projectId: 'project-a', homeChatId: 'chat-other', updatedAt: 2 },
        { projectId: 'project-b', homeChatId: 'chat-1', brief: 'keeps brief', updatedAt: 3 }
      ],
      validIds,
      9
    )
    expect(migrated).toEqual([
      { projectId: 'project-a', homeChatId: 'chat-1', updatedAt: 1 },
      { projectId: 'project-b', brief: 'keeps brief', updatedAt: 3 }
    ])
  })
})

describe('project references', () => {
  const projects = buildThreeRoots()
  const addOp = (overrides: Partial<ProjectReferenceOp & { kind: 'add-reference' }> = {}): ProjectReferenceOp => ({
    kind: 'add-reference',
    id: 'ref-1',
    projectId: 'project-a',
    referenceKind: 'file',
    locator: '/repo/docs/spec.md',
    now: 100,
    ...overrides
  })

  it('derives titles from path segments and URL hostnames', () => {
    expect(defaultProjectReferenceTitle('file', '/repo/docs/spec.md')).toBe('spec.md')
    expect(defaultProjectReferenceTitle('folder', '/repo/docs/')).toBe('docs')
    expect(defaultProjectReferenceTitle('url', 'https://docs.example.com/page')).toBe(
      'docs.example.com'
    )
    expect(defaultProjectReferenceTitle('url', 'not a url')).toBe('not a url')
  })

  it('adds with defaults, is idempotent per (project, kind, locator), and validates', () => {
    const { references, changed } = applyProjectReferenceOp([], projects, addOp())
    expect(changed).toBe(true)
    expect(references[0]).toMatchObject({
      id: 'ref-1',
      kind: 'file',
      title: 'spec.md',
      contextPolicy: 'available',
      provenance: { addedBy: 'user', addedAt: 100 }
    })

    const again = applyProjectReferenceOp(references, projects, addOp({ id: 'ref-2' }))
    expect(again.changed).toBe(false)
    expect(again.references).toBe(references)

    expect(() =>
      applyProjectReferenceOp([], projects, addOp({ projectId: 'missing' }))
    ).toThrow('Project not found.')
    expect(() => applyProjectReferenceOp([], projects, addOp({ locator: '   ' }))).toThrow(
      'Reference locator is required.'
    )
  })

  it('updates title/contextPolicy, removes, and records verification', () => {
    let references = applyProjectReferenceOp([], projects, addOp()).references
    references = applyProjectReferenceOp(references, projects, {
      kind: 'update-reference',
      id: 'ref-1',
      patch: { title: 'The Spec', contextPolicy: 'off' },
      now: 200
    }).references
    expect(references[0]).toMatchObject({ title: 'The Spec', contextPolicy: 'off', updatedAt: 200 })

    const noop = applyProjectReferenceOp(references, projects, {
      kind: 'update-reference',
      id: 'ref-1',
      patch: { title: 'The Spec' },
      now: 300
    })
    expect(noop.changed).toBe(false)

    references = applyProjectReferenceOp(references, projects, {
      kind: 'record-reference-verification',
      id: 'ref-1',
      status: 'missing',
      now: 400
    }).references
    expect(references[0].lastVerified).toEqual({ at: 400, status: 'missing' })

    const removed = applyProjectReferenceOp(references, projects, {
      kind: 'remove-reference',
      id: 'ref-1'
    })
    expect(removed.references).toEqual([])
    expect(() =>
      applyProjectReferenceOp(removed.references, projects, { kind: 'remove-reference', id: 'ref-1' })
    ).toThrow('Reference not found.')
  })

  it('round-trips ops through the parser and rejects malformed payloads', () => {
    const ops: ProjectReferenceOp[] = [
      addOp(),
      { kind: 'update-reference', id: 'ref-1', patch: { contextPolicy: 'off' }, now: 1 },
      { kind: 'remove-reference', id: 'ref-1' },
      { kind: 'record-reference-verification', id: 'ref-1', status: 'ok', now: 1 }
    ]
    for (const op of ops) {
      expect(parseProjectReferenceOp(JSON.parse(JSON.stringify(op)))).toEqual(op)
    }
    expect(parseProjectReferenceOp({ kind: 'add-reference', id: 'x' })).toBeNull()
    expect(
      parseProjectReferenceOp({ ...addOp(), referenceKind: 'connector' })
    ).toBeNull()
    expect(
      parseProjectReferenceOp({ kind: 'update-reference', id: 'x', patch: { contextPolicy: 'pinned' }, now: 1 })
    ).toBeNull()
    expect(
      parseProjectReferenceOp({ kind: 'record-reference-verification', id: 'x', status: 'gone', now: 1 })
    ).toBeNull()
  })

  it('migrates references with referential integrity and dedupe', () => {
    const migrated = migrateProjectReferences(
      [
        { id: 'ref-1', projectId: 'project-a', kind: 'file', locator: '/a.md' },
        { id: 'ref-1', projectId: 'project-a', kind: 'file', locator: '/dup.md' },
        { id: 'ref-2', projectId: 'project-gone', kind: 'file', locator: '/b.md' },
        { id: 'ref-3', projectId: 'project-a', kind: 'connector', locator: '/c.md' },
        { id: 'ref-4', projectId: 'project-a', kind: 'url', locator: 'https://x.dev', contextPolicy: 'off', lastVerified: { at: 5, status: 'ok' } }
      ] as unknown[],
      new Set(['project-a']),
      900
    )
    expect(migrated.map((reference) => reference.id)).toEqual(['ref-1', 'ref-4'])
    expect(migrated[0]).toMatchObject({ title: 'a.md', contextPolicy: 'available', updatedAt: 900 })
    expect(migrated[1]).toMatchObject({
      contextPolicy: 'off',
      lastVerified: { at: 5, status: 'ok' }
    })
  })
})

describe('migrateProjects', () => {
  it('seeds missing timestamps from the caller-supplied now', () => {
    const migrated = migrateProjects(
      [{ id: 'p1', name: 'Recovered' }, { id: 'p2', name: 'Dated', createdAt: 5, updatedAt: 9 }],
      777
    )
    expect(migrated[0]).toMatchObject({ createdAt: 777, updatedAt: 777 })
    expect(migrated[1]).toMatchObject({ createdAt: 5, updatedAt: 9 })
  })

  it('normalizes future-versioned records into the V1 shape and drops invalid or duplicate ids', () => {
    const migrated = migrateProjects(
      [
        {
          schemaVersion: 999,
          id: 'future',
          name: '  Future  ',
          hue: 725,
          order: 2.8,
          memberChatIds: [' chat-1 ', 'chat-1', '', 'chat-2']
        },
        { schemaVersion: 1, id: '', name: 'No id' },
        { schemaVersion: 1, id: 'future', name: 'Duplicate' }
      ],
      10
    )
    expect(migrated).toHaveLength(1)
    expect(migrated[0]).toMatchObject({
      schemaVersion: 1,
      id: 'future',
      name: 'Future',
      hue: 5,
      order: 3,
      memberChatIds: ['chat-1', 'chat-2']
    })
  })
})
