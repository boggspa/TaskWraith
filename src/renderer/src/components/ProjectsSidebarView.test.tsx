import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Install the fake window (localStorage + preload bridge) before the facade
// module loads — same harness as projectsStore.test.ts. The view reads the
// facade's in-memory snapshot, which these tests seed synchronously through
// the captured projects-changed broadcast callback (registration happens
// synchronously inside ensureInitialized, before any await).
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
  const broadcast: { cb: ((state: unknown) => void) | null } = { cb: null }
  const api = {
    getProjectsSnapshot: vi.fn(),
    applyProjectOp: vi.fn(),
    setProjectHomeChat: vi.fn(),
    importLegacyProjects: vi.fn(),
    onProjectsChanged: vi.fn()
  }
  ;(globalThis as unknown as { window: unknown }).window = { localStorage, api }
  return { store, api, broadcast }
})

import type { ChatRecord } from '../../../main/store/types'
import { listProjects, resetProjectsStoreForTests, type Project } from '../lib/projectsStore'
import { ProjectsSidebarView, normalizeProjectCreateName } from './ProjectsSidebarView'

function projectRecord(id: string, name: string, memberChatIds: string[]): Project {
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

function chatRecord(appChatId: string, title: string): ChatRecord {
  return {
    appChatId,
    title,
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    messages: []
  } as unknown as ChatRecord
}

/** Seed the facade's in-memory snapshot synchronously via the broadcast. */
function seedStore(projects: Project[], workProfiles: unknown[]): void {
  listProjects() // kicks ensureInitialized, which registers the broadcast cb
  expect(fake.broadcast.cb).toBeTypeOf('function')
  fake.broadcast.cb?.({ projects, workProfiles })
}

beforeEach(() => {
  resetProjectsStoreForTests()
  fake.store.clear()
  fake.broadcast.cb = null
  fake.api.getProjectsSnapshot.mockReset()
  fake.api.onProjectsChanged.mockReset()
  fake.api.getProjectsSnapshot.mockImplementation(async () => ({
    projects: [],
    workProfiles: [],
    legacyImportMarker: null
  }))
  fake.api.onProjectsChanged.mockImplementation((cb: (state: unknown) => void) => {
    fake.broadcast.cb = cb
    return () => {
      fake.broadcast.cb = null
    }
  })
})

describe('ProjectsSidebarView references', () => {
  const referenceRecord = {
    id: 'ref-1',
    projectId: 'project-a',
    kind: 'file' as const,
    locator: '/repo/docs/spec.md',
    title: 'spec.md',
    provenance: { addedBy: 'user' as const, addedAt: 1 },
    contextPolicy: 'available' as const,
    lastVerified: { at: 5, status: 'missing' as const },
    updatedAt: 1
  }

  it('renders the selected project library with availability, policy, and actions', () => {
    seedStore(
      [projectRecord('project-a', 'Alpha', [])],
      [],
    )
    fake.broadcast.cb?.({
      projects: [projectRecord('project-a', 'Alpha', [])],
      workProfiles: [],
      references: [
        referenceRecord,
        {
          ...referenceRecord,
          id: 'ref-2',
          kind: 'url' as const,
          locator: 'https://docs.example.com',
          title: 'docs.example.com',
          contextPolicy: 'off' as const,
          lastVerified: undefined
        }
      ]
    })

    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
        initialSelectedProjectId="project-a"
      />
    )

    expect(html).toContain('sidebar-project-references')
    expect(html).toContain('spec.md')
    expect(html).toContain('sidebar-project-reference-dot missing')
    expect(html).toContain('title="Add file reference"')
    expect(html).toContain('title="Add folder reference"')
    expect(html).toContain('title="Add link reference"')
    expect(html).toContain('aria-label="Verify spec.md"')
    expect(html).toContain('aria-label="Remove spec.md"')
    // URL rows carry the Off state and never offer Verify.
    expect(html).toContain('is-off')
    expect(html).not.toContain('aria-label="Verify docs.example.com"')
    // Without the host handler there is no dock-library affordance to render.
    expect(html).not.toContain('title="Open reference library"')
  })

  it('renders the profile brief and preferred-workspace rows with stored values', () => {
    seedStore([projectRecord('project-a', 'Alpha', [])], [])
    fake.broadcast.cb?.({
      projects: [projectRecord('project-a', 'Alpha', [])],
      workProfiles: [
        {
          projectId: 'project-a',
          brief: 'Ship the Work surface end-to-end.',
          preferredWorkspaceId: 'ws-2',
          updatedAt: 5
        }
      ],
      references: []
    })
    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
        workspaces={[
          { id: 'ws-1', path: '/repos/one', displayName: 'One', createdAt: 1, lastOpenedAt: 1, pinned: false },
          { id: 'ws-2', path: '/repos/two', displayName: 'Two', createdAt: 1, lastOpenedAt: 1, pinned: false }
        ]}
        initialSelectedProjectId="project-a"
      />
    )
    expect(html).toContain('Home workspace')
    expect(html).toContain('<option value="ws-2" selected="">Two</option>')
    expect(html).toContain('Ship the Work surface end-to-end.')
    expect(html).toContain('Never sent to agents automatically.')
  })

  it('links to the References dock when the host provides the library handler', () => {
    seedStore([projectRecord('project-a', 'Alpha', [])], [])
    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
        onOpenReferencesLibrary={() => undefined}
        initialSelectedProjectId="project-a"
      />
    )
    expect(html).toContain('title="Open reference library"')
    expect(html).toContain('aria-label="Open Alpha reference library"')
  })

  it('shows the no-access empty state for a library-less project', () => {
    seedStore([projectRecord('project-a', 'Alpha', [])], [])
    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
        initialSelectedProjectId="project-a"
      />
    )
    expect(html).toContain('References grant no access.')
  })
})

describe('ProjectsSidebarView', () => {
  it('normalizes inline project creation names before writing to the store', () => {
    expect(normalizeProjectCreateName('  Client Work  ')).toBe('Client Work')
    expect(normalizeProjectCreateName('   ')).toBeNull()
  })

  it('renders the Projects header with the standard sidebar chevron hook', () => {
    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
      />
    )

    expect(html).toContain('sidebar-projects-header')
    expect(html).toContain('sidebar-tree-chevron is-expanded')
    expect(html).toContain('<h4 class="sidebar-section-title">Projects</h4>')
    expect(html).toContain('class="sidebar-section-header-action sidebar-project-create"')
    expect(html).toContain('class="sidebar-project-create-large"')
  })

  it('marks the home member and offers set/clear and Open Project Home actions', () => {
    seedStore(
      [projectRecord('project-a', 'Alpha', ['chat-home', 'chat-other'])],
      [{ projectId: 'project-a', homeChatId: 'chat-home', updatedAt: 5 }]
    )
    // Expand the project so member rows render.
    fake.store.set(
      'taskwraith-sidebar-expanded-project-ids',
      JSON.stringify(['project-a'])
    )

    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[chatRecord('chat-home', 'Home Thread'), chatRecord('chat-other', 'Other Thread')]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
      />
    )

    expect(html).toContain('sidebar-project-home-chip')
    expect(html).toContain('title="Open Project Home"')
    expect(html).toContain('title="Clear Project Home"')
    expect(html).toContain('title="Set as Project Home"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Open Alpha Project Home"')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-codex')
  })

  it('offers Start Project Home on unhomed projects when the host provides the handler', () => {
    seedStore([projectRecord('project-a', 'Alpha', [])], [])
    const html = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
        onStartProjectHome={() => undefined}
      />
    )
    expect(html).toContain('title="Start Project Home"')
    expect(html).toContain('aria-label="Start Alpha Project Home"')
    expect(html).not.toContain('title="Open Project Home"')
  })

  it('omits Open Project Home when the project has no claim or the home chat is unavailable', () => {
    seedStore([projectRecord('project-a', 'Alpha', ['chat-other'])], [])
    const noClaim = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[chatRecord('chat-other', 'Other Thread')]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
      />
    )
    expect(noClaim).not.toContain('title="Open Project Home"')

    resetProjectsStoreForTests()
    fake.broadcast.cb = null
    seedStore(
      [projectRecord('project-b', 'Beta', ['chat-gone'])],
      [{ projectId: 'project-b', homeChatId: 'chat-gone', updatedAt: 5 }]
    )
    const homeChatMissing = renderToStaticMarkup(
      <ProjectsSidebarView
        chats={[]}
        currentChat={null}
        searchQuery=""
        isSearchActive={false}
        onSelectChat={() => undefined}
      />
    )
    expect(homeChatMissing).not.toContain('title="Open Project Home"')
  })
})
