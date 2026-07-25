import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const broadcast: { cb: ((state: unknown) => void) | null } = { cb: null }
  const api = {
    getProjectsSnapshot: vi.fn(),
    applyProjectOp: vi.fn(),
    applyProjectReferenceOp: vi.fn(),
    importLegacyProjects: vi.fn(),
    onProjectsChanged: vi.fn()
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
  projectReferenceProposalViewsFromUnknown
} from './ProjectReferencesDockPanel'

beforeEach(() => {
  resetProjectsStoreForTests()
  fake.broadcast.cb = null
  fake.api.getProjectsSnapshot.mockReset()
  fake.api.onProjectsChanged.mockReset()
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
