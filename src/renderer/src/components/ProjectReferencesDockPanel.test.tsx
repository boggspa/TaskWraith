import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const broadcast: { cb: ((state: unknown) => void) | null } = { cb: null }
  const api = {
    getProjectsSnapshot: vi.fn(),
    applyProjectOp: vi.fn(),
    applyProjectReferenceOp: vi.fn(),
    importLegacyProjects: vi.fn(),
    onProjectsChanged: vi.fn(),
    getPathForFile: vi.fn()
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined
    },
    api
  }
  return { api, broadcast }
})

import { listProjects, resetProjectsStoreForTests } from '../lib/projectsStore'
import {
  ProjectReferenceSuggestions,
  ProjectReferencesDockPanel,
  projectReferenceProposalViewsFromUnknown,
  resolveDockDroppedFilePath,
  shouldHandleProjectReferencesDockPaste
} from './ProjectReferencesDockPanel'

beforeEach(() => {
  resetProjectsStoreForTests()
  fake.broadcast.cb = null
  fake.api.getProjectsSnapshot.mockReset()
  fake.api.onProjectsChanged.mockReset()
  fake.api.getPathForFile.mockReset()
  fake.api.getProjectsSnapshot.mockResolvedValue({
    projects: [],
    workProfiles: [],
    references: [],
    legacyImportMarker: null
  })
  fake.api.onProjectsChanged.mockImplementation((cb: (state: unknown) => void) => {
    fake.broadcast.cb = cb
    return () => {
      fake.broadcast.cb = null
    }
  })
})

it('renders the selected Project library without implying access', () => {
  listProjects()
  fake.broadcast.cb?.({
    projects: [
      {
        schemaVersion: 1,
        id: 'project-a',
        name: 'Alpha',
        icon: { iconKind: 'seed', seed: 'a' },
        hue: 1,
        parentId: null,
        order: 1,
        memberChatIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    workProfiles: [],
    references: [
      {
        id: 'ref-a',
        projectId: 'project-a',
        kind: 'file',
        locator: '/tmp/spec.docx',
        title: 'spec.docx',
        provenance: { addedBy: 'user', addedAt: 1 },
        contextPolicy: 'available',
        lastVerified: { at: 2, status: 'ok' },
        updatedAt: 2
      }
    ]
  })

  const html = renderToStaticMarkup(
    <ProjectReferencesDockPanel projectId="project-a" onClose={() => undefined} />
  )

  expect(html).toContain('Project library')
  expect(html).toContain('<h3>Alpha</h3>')
  expect(html).toContain('Catalogue only until you choose Use next')
  expect(html).toContain('spec.docx')
  expect(html).toContain('Available when last verified')
  // No Office affordance without the resolver/open plumbing.
  expect(html).not.toContain('Open in the Office editor')
})

it('offers Open in Office only for file references resolvable inside the workspace', () => {
  const seed = (): void => {
    listProjects()
    fake.broadcast.cb?.({
      projects: [
        {
          schemaVersion: 1,
          id: 'project-a',
          name: 'Alpha',
          icon: { iconKind: 'seed', seed: 'a' },
          hue: 1,
          parentId: null,
          order: 1,
          memberChatIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      workProfiles: [],
      references: [
        {
          id: 'ref-inside',
          projectId: 'project-a',
          kind: 'file',
          locator: '/ws/docs/spec.docx',
          title: 'spec.docx',
          provenance: { addedBy: 'user', addedAt: 1 },
          contextPolicy: 'available',
          updatedAt: 2
        },
        {
          id: 'ref-outside',
          projectId: 'project-a',
          kind: 'file',
          locator: '/elsewhere/other.docx',
          title: 'other.docx',
          provenance: { addedBy: 'user', addedAt: 1 },
          contextPolicy: 'available',
          updatedAt: 2
        }
      ]
    })
  }

  seed()
  const html = renderToStaticMarkup(
    <ProjectReferencesDockPanel
      projectId="project-a"
      onClose={() => undefined}
      resolveOfficeTarget={(locator) =>
        locator.startsWith('/ws/')
          ? { path: locator.slice('/ws/'.length), external: false }
          : { path: locator, external: true }
      }
      onOpenInOffice={() => undefined}
    />
  )
  // Both references offer Office; the out-of-workspace one is marked as
  // needing consent (ellipsis label + "asks for access first" tooltip).
  expect(html.match(/Open in the Office editor/g)).toHaveLength(2)
  expect(html.match(/asks for access first/g)).toHaveLength(1)
  expect(html).toContain('>Office…<')
  expect(html).toContain('>Office<')
})

it('renders agent suggestions as explicitly untrusted inert catalogue candidates', () => {
  const html = renderToStaticMarkup(
    <ProjectReferenceSuggestions
      proposals={[
        {
          proposalId: 'proposal-a',
          projectId: 'project-a',
          candidate: {
            kind: 'url',
            locator: 'https://example.test/reference',
            title: 'External brief'
          },
          reason: 'Useful background for the next review.',
          proposedAt: 1,
          provider: 'codex',
          runId: 'run-a'
        }
      ]}
      loading={false}
      unsupported={false}
      error={null}
      actingProposalId={null}
      onReview={() => undefined}
    />
  )

  expect(html).toContain('Agent suggestions')
  expect(html).toContain('Untrusted agent suggestions.')
  expect(html).toContain('catalogue metadata only')
  expect(html).toContain('https://example.test/reference')
  expect(html).toContain('Proposed by codex')
  expect(html).toContain('Add to library')
  expect(html).toContain('Reject')
  expect(html).not.toMatch(/<a(?:\s|>)/)
  expect(html).not.toContain('href=')
})

it('accepts only complete proposals for the active Project', () => {
  const proposals = projectReferenceProposalViewsFromUnknown(
    [
      {
        proposalId: 'proposal-a',
        projectId: 'project-a',
        candidate: { kind: 'file', locator: '/tmp/brief.docx', title: 'brief.docx' },
        proposedAt: 1,
        provider: 'claude',
        runId: 'run-a'
      },
      {
        proposalId: 'proposal-b',
        projectId: 'project-b',
        candidate: { kind: 'url', locator: 'https://example.test', title: 'Elsewhere' },
        proposedAt: 2,
        runId: 'run-b'
      },
      {
        proposalId: 'proposal-c',
        projectId: 'project-a',
        candidate: { kind: 'unsupported', locator: '/tmp/nope', title: 'Nope' },
        runId: 'run-c'
      }
    ],
    'project-a'
  )

  expect(proposals).toEqual([
    {
      proposalId: 'proposal-a',
      projectId: 'project-a',
      candidate: { kind: 'file', locator: '/tmp/brief.docx', title: 'brief.docx' },
      proposedAt: 1,
      provider: 'claude',
      runId: 'run-a'
    }
  ])
})

it('offers a + GitHub toolbar control and empty-state ingest hints', () => {
  listProjects()
  fake.broadcast.cb?.({
    projects: [
      {
        schemaVersion: 1,
        id: 'project-a',
        name: 'Alpha',
        icon: { iconKind: 'seed', seed: 'a' },
        hue: 1,
        parentId: null,
        order: 1,
        memberChatIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    workProfiles: [],
    references: []
  })

  const html = renderToStaticMarkup(
    <ProjectReferencesDockPanel projectId="project-a" onClose={() => undefined} />
  )

  expect(html).toContain('+ GitHub')
  expect(html).toMatch(/drop|paste|GitHub/i)
  expect(html).toContain('Drop files')
})

it('renders agent-claimed preview snippets without treating them as proof', () => {
  const html = renderToStaticMarkup(
    <ProjectReferenceSuggestions
      proposals={[
        {
          proposalId: 'proposal-a',
          projectId: 'project-a',
          candidate: {
            kind: 'url',
            locator: 'https://example.test/reference',
            title: 'External brief'
          },
          reason: 'Useful background for the next review.',
          previewSnippet: 'A short quote from an already-fetched page.',
          previewSource: 'web_fetch',
          proposedAt: 1,
          provider: 'codex',
          runId: 'run-a'
        }
      ]}
      loading={false}
      unsupported={false}
      error={null}
      actingProposalId={null}
      onReview={() => undefined}
    />
  )

  expect(html).toContain('A short quote from an already-fetched page.')
  expect(html).toContain('Agent-claimed · web_fetch')
  expect(html).not.toContain('From web_fetch')
})

it('parses optional preview fields and ignores orphan halves', () => {
  const proposals = projectReferenceProposalViewsFromUnknown(
    [
      {
        proposalId: 'proposal-a',
        projectId: 'project-a',
        candidate: { kind: 'url', locator: 'https://example.test', title: 'Brief' },
        previewSnippet: 'Claimed quote',
        previewSource: 'web_search',
        proposedAt: 1,
        runId: 'run-a'
      },
      {
        proposalId: 'proposal-b',
        projectId: 'project-a',
        candidate: { kind: 'file', locator: '/tmp/a.md', title: 'a.md' },
        previewSnippet: 'orphan snippet',
        proposedAt: 2,
        runId: 'run-b'
      },
      {
        proposalId: 'proposal-c',
        projectId: 'project-a',
        candidate: { kind: 'file', locator: '/tmp/b.md', title: 'b.md' },
        previewSource: 'not-a-real-source',
        previewSnippet: 'bad source',
        proposedAt: 3,
        runId: 'run-c'
      }
    ],
    'project-a'
  )

  expect(proposals).toEqual([
    {
      proposalId: 'proposal-a',
      projectId: 'project-a',
      candidate: { kind: 'url', locator: 'https://example.test', title: 'Brief' },
      previewSnippet: 'Claimed quote',
      previewSource: 'web_search',
      proposedAt: 1,
      runId: 'run-a'
    },
    {
      proposalId: 'proposal-b',
      projectId: 'project-a',
      candidate: { kind: 'file', locator: '/tmp/a.md', title: 'a.md' },
      proposedAt: 2,
      runId: 'run-b'
    },
    {
      proposalId: 'proposal-c',
      projectId: 'project-a',
      candidate: { kind: 'file', locator: '/tmp/b.md', title: 'b.md' },
      proposedAt: 3,
      runId: 'run-c'
    }
  ])
})

it('resolves dropped file paths via getPathForFile with File.path fallback', () => {
  const getPathForFile = vi.fn(() => '/bridged/drop.md')
  fake.api.getPathForFile = getPathForFile

  expect(resolveDockDroppedFilePath({ name: 'drop.md' } as File)).toBe('/bridged/drop.md')
  expect(getPathForFile).toHaveBeenCalledTimes(1)

  expect(
    resolveDockDroppedFilePath({ name: 'legacy.md', path: '/legacy/path.md' } as File & {
      path: string
    })
  ).toBe('/legacy/path.md')
})

it('accepts paste only on the dock surface outside editable/composer targets', () => {
  const dock = { closest: (sel: string) => (sel.includes('project-references-dock') ? {} : null) }
  const composerChild = {
    closest: (sel: string) => (sel.includes('composer') ? {} : null)
  }
  const outside = { closest: () => null }

  expect(
    shouldHandleProjectReferencesDockPaste({
      eventTarget: dock as unknown as EventTarget,
      activeElement: null
    })
  ).toBe(true)

  expect(
    shouldHandleProjectReferencesDockPaste({
      eventTarget: outside as unknown as EventTarget,
      activeElement: null
    })
  ).toBe(false)

  expect(
    shouldHandleProjectReferencesDockPaste({
      eventTarget: dock as unknown as EventTarget,
      activeElement: { tagName: 'TEXTAREA' } as unknown as Element
    })
  ).toBe(false)

  expect(
    shouldHandleProjectReferencesDockPaste({
      eventTarget: composerChild as unknown as EventTarget,
      activeElement: null
    })
  ).toBe(false)
})
