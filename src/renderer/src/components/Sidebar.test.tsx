import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChatRecord,
  WorkflowDefinition,
  WorkspaceBoardDefinition,
  WorkspaceRecord
} from '../../../main/store/types'
import {
  Sidebar,
  SidebarSettingsMenu,
  DevicesFooterPopover,
  ApprovalsFooterPopover,
  SharesFooterPopover,
  getSharedChatCreateOptions,
  sidebarChatRowPropsAreEqual,
  sidebarCompactChatRowPropsAreEqual,
  type SharedChatCreateVariant,
  type WorkspaceBoardCreateInput
} from './Sidebar'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import type { AgentApprovalRequest } from '../lib/agentApprovalTypes'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'

const COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY = 'taskwraith-sidebar-collapsed-sections'
const COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY =
  'taskwraith-sidebar-collapsed-sections-default-version'
const COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION = 'recents-open-v1'
const SIDEBAR_ACTIVE_TAB_STORAGE_KEY = 'taskwraith-sidebar-active-tab'

// Mirrors SIDEBAR_SECTION_IDS in Sidebar.tsx. The sidebar defaults every section
// except Recents to collapsed for new users, so tests that assert on child rows
// opt the relevant section(s) open the way a user would by clicking the header.
// Persisting a non-empty collapsed list also bypasses the new-user default
// migration, pinning exactly these sections open.
const SIDEBAR_SECTION_IDS = [
  'workflows',
  'workspace-boards',
  'pinned',
  'recents',
  'git',
  'ensembles',
  'workspaces',
  'chats',
  'shared'
] as const
function collapseSectionsExcept(...expanded: string[]): string {
  return JSON.stringify(SIDEBAR_SECTION_IDS.filter((id) => !expanded.includes(id)))
}

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'ws-1',
    path: '/repo',
    displayName: 'Repo',
    lastOpenedAt: 1,
    createdAt: 1,
    pinned: false,
    ...overrides
  }
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'parent-1',
    scope: 'workspace',
    provider: 'gemini',
    title: 'Parent thread',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  const now = '2026-06-07T20:00:00.000Z'
  return {
    id: 'workflow-1',
    name: 'Audit loop',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    enabled: true,
    trigger: {
      kind: 'interval',
      intervalMs: 15 * 60_000,
      startAt: now,
      timezone: 'Europe/London'
    },
    template: {
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId: 'parent-1',
      provider: 'codex',
      prompt: 'Review the current diff.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: []
    },
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'skip',
    limits: {
      maxRunsPerDay: 24,
      maxConsecutiveFailures: 3
    },
    nextRunAt: '2026-06-07T20:15:00.000Z',
    lastStatus: 'queued',
    failureStreak: 0,
    history: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function makeWorkspaceBoard(
  overrides: Partial<WorkspaceBoardDefinition> = {}
): WorkspaceBoardDefinition {
  const now = '2026-06-29T00:00:00.000Z'
  return {
    id: 'board-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    name: 'Release board',
    columns: [
      { id: 'inbox', name: 'Inbox', sortOrder: 0 },
      { id: 'ready', name: 'Ready', sortOrder: 1 }
    ],
    createdAt: now,
    updatedAt: now,
    activity: [],
    ...overrides
  }
}

function stubSidebarStorage(values: Record<string, string>) {
  const store = new Map(Object.entries(values))
  if (
    store.has(COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY) &&
    !store.has(COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY)
  ) {
    store.set(
      COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY,
      COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION
    )
  }
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    })
  })
}

function renderSidebar(
  chats: ChatRecord[],
  options: {
    activeChatId?: string | null
    ensembleModeEnabled?: boolean
    workflows?: WorkflowDefinition[]
    workspaceBoards?: WorkspaceBoardDefinition[]
    activeWorkspaceBoardId?: string | null
    workspaces?: WorkspaceRecord[]
    currentWorkspace?: WorkspaceRecord | null
    onCreateWorkflow?: (workspace?: WorkspaceRecord) => void
    onCreateWorkspaceBoard?: (input?: WorkspaceBoardCreateInput) => void
    onOpenWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
    onRenameWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
    onDuplicateWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
    onTogglePinWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
    onArchiveWorkspaceBoard?: (boardId: string) => void
    onRestoreWorkspaceBoard?: (boardId: string) => void
    onDeleteWorkspaceBoard?: (boardId: string) => void
    onCreateSharedChat?: (variant: SharedChatCreateVariant) => void
    collaboratingChatIds?: Set<string>
    initialExpandedSubThreadParentIds?: string[]
    pendingAgentApprovalByChatId?: Record<string, AgentApprovalRequest | null>
    pendingAgentQuestionsByChatId?: ComponentProps<typeof Sidebar>['pendingAgentQuestionsByChatId']
    hasConnectedCollaborator?: boolean
    onRenameChat?: (chatId: string, nextTitle: string) => void
    onTogglePinChat?: (chatId: string) => void
    onToggleArchiveChat?: (chatId: string, nextArchived: boolean) => void
    onDeleteChat?: (chatId: string) => void
    onOpenInMultiview?: (chat: ChatRecord) => void
    runningChatIds?: string[]
    updateSnapshot?: UpdateStateSnapshot | null
    onQuickUpdate?: () => void
    activeChatIdentityTicker?: string | null
    onSetChatHiddenFromMainList?: (chatId: string, hidden: boolean) => void
    onClearChatGitWorkflow?: (chatId: string) => void
  } = {}
) {
  const workspace = makeWorkspace()
  const workspaces = options.workspaces ?? [workspace]
  const currentWorkspace = options.currentWorkspace === undefined ? workspace : options.currentWorkspace
  return renderToStaticMarkup(
    <Sidebar
      workspaces={workspaces}
      currentWorkspace={currentWorkspace}
      chats={chats}
      currentChat={chats[0] ?? null}
      activeChatId={options.activeChatId}
      usageSummary={[]}
      runningChatIds={options.runningChatIds ?? []}
      workflows={options.workflows}
      workspaceBoards={options.workspaceBoards}
      activeWorkspaceBoardId={options.activeWorkspaceBoardId}
      collaboratingChatIds={options.collaboratingChatIds}
      initialExpandedSubThreadParentIds={options.initialExpandedSubThreadParentIds}
      pendingAgentApprovalByChatId={options.pendingAgentApprovalByChatId}
      pendingAgentQuestionsByChatId={options.pendingAgentQuestionsByChatId}
      hasConnectedCollaborator={options.hasConnectedCollaborator}
      onSelectWorkspace={() => {}}
      onRemoveWorkspace={() => {}}
      onSelectWorkspaceDialog={() => {}}
      onNewChat={() => {}}
      onNewGlobalChat={() => {}}
      onNewEnsemble={() => {}}
      ensembleModeEnabled={options.ensembleModeEnabled}
      onSelectChat={() => {}}
      onOpenSettings={() => {}}
      onCreateWorkflow={options.onCreateWorkflow}
      onCreateWorkspaceBoard={options.onCreateWorkspaceBoard}
      onOpenWorkspaceBoard={options.onOpenWorkspaceBoard}
      onRenameWorkspaceBoard={options.onRenameWorkspaceBoard}
      onDuplicateWorkspaceBoard={options.onDuplicateWorkspaceBoard}
      onTogglePinWorkspaceBoard={options.onTogglePinWorkspaceBoard}
      onArchiveWorkspaceBoard={options.onArchiveWorkspaceBoard}
      onRestoreWorkspaceBoard={options.onRestoreWorkspaceBoard}
      onDeleteWorkspaceBoard={options.onDeleteWorkspaceBoard}
      onCreateSharedChat={options.onCreateSharedChat}
      onRenameChat={options.onRenameChat}
      onTogglePinChat={options.onTogglePinChat}
      onToggleArchiveChat={options.onToggleArchiveChat}
      onDeleteChat={options.onDeleteChat}
      onOpenInMultiview={options.onOpenInMultiview}
      updateSnapshot={options.updateSnapshot}
      onQuickUpdate={options.onQuickUpdate}
      activeChatIdentityTicker={options.activeChatIdentityTicker}
      onSetChatHiddenFromMainList={options.onSetChatHiddenFromMainList}
      onClearChatGitWorkflow={options.onClearChatGitWorkflow}
    />
  )
}

function makeApproval(overrides: Partial<AgentApprovalRequest> = {}): AgentApprovalRequest {
  return {
    id: 'approval-1',
    provider: 'codex',
    method: 'shell',
    title: 'Run a command',
    body: 'ls -la',
    actions: ['accept', 'decline'],
    ...overrides
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Sidebar settings quick menu', () => {
  it('includes the ChatGPT composer shell beside the other provider shells', () => {
    const html = renderToStaticMarkup(
      <SidebarSettingsMenu
        pane="composer"
        setPane={() => undefined}
        onOpenSettings={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(html).toContain('ChatGPT shell')
    expect(html.indexOf('Codex shell')).toBeLessThan(html.indexOf('ChatGPT shell'))
    expect(html.indexOf('ChatGPT shell')).toBeLessThan(html.indexOf('Claude shell'))
  })
})

describe('Sidebar masthead', () => {
  it('renders the update pill inside the fixed top-chrome band, above the masthead', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], {
      updateSnapshot: {
        status: 'downloading',
        enabled: true,
        channel: 'stable',
        latestVersion: '1.9.0',
        downloadProgress: {
          bytesPerSecond: 10,
          delta: 1,
          percent: 42.4,
          transferred: 42,
          total: 100
        }
      },
      onQuickUpdate: () => {}
    })

    const bandIndex = html.indexOf('sidebar-top-chrome')
    const pillRowIndex = html.indexOf('sidebar-update-pill-row')
    const mastheadIndex = html.indexOf('sidebar-masthead')
    expect(bandIndex).toBeGreaterThanOrEqual(0)
    // The pill row opens AFTER the band wrapper (i.e. inside it) and BEFORE the
    // masthead. Rendered as a sibling above the band it sat on the raw
    // slider-opacity sidebar surface and read as a gap in the fixed chrome.
    expect(pillRowIndex).toBeGreaterThan(bandIndex)
    expect(mastheadIndex).toBeGreaterThan(pillRowIndex)
    expect(html).toContain('42%')
  })

  it('uses the inline monoline TaskWraith mark', () => {
    stubSidebarStorage({})

    const html = renderSidebar([])
    const masthead = html.slice(html.indexOf('sidebar-masthead'))

    expect(masthead).toContain('sidebar-product-ghost-monoline')
    expect(masthead).toContain('ghost-guy-mark-monoline-title')
    expect(masthead).not.toContain('taskwraith-brand-ghost')
  })

  it('omits the secondary scope title for General chats', () => {
    stubSidebarStorage({})

    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'global-chat',
          scope: 'global',
          workspaceId: undefined,
          workspacePath: undefined,
          title: 'General'
        })
      ],
      { currentWorkspace: null }
    )
    const masthead = html.slice(html.indexOf('sidebar-masthead'), html.indexOf('sidebar-masthead-stats'))

    expect(masthead).toContain('TaskWraith')
    expect(masthead).not.toContain('General chats')
  })
})

describe('Sidebar primary views', () => {
  const workspacePinned = makeChat({
    appChatId: 'workspace-pinned',
    title: 'Workspace pinned',
    pinned: true,
    updatedAt: 4
  })
  const workspaceRecent = makeChat({
    appChatId: 'workspace-recent',
    title: 'Workspace recent',
    updatedAt: 3
  })
  const globalPinned = makeChat({
    appChatId: 'global-pinned',
    scope: 'global',
    workspaceId: undefined,
    workspacePath: undefined,
    title: 'Global pinned',
    pinned: true,
    updatedAt: 2
  })
  const globalRecent = makeChat({
    appChatId: 'global-recent',
    scope: 'global',
    workspaceId: undefined,
    workspacePath: undefined,
    title: 'Global recent',
    updatedAt: 1
  })
  const mixedChats = [workspacePinned, workspaceRecent, globalPinned, globalRecent]

  it('renders Chat, Code, and Work in primary-mode order', () => {
    stubSidebarStorage({})

    const html = renderSidebar([workspaceRecent])
    const chatTabIndex = html.indexOf('id="sidebar-chat-tab"')
    const codeTabIndex = html.indexOf('id="sidebar-threads-tab"')
    const projectsTabIndex = html.indexOf('id="sidebar-projects-tab"')

    expect(chatTabIndex).toBeGreaterThanOrEqual(0)
    expect(chatTabIndex).toBeLessThan(codeTabIndex)
    expect(codeTabIndex).toBeLessThan(projectsTabIndex)
    expect(html).toContain('>Chat</button>')
    expect(html).toContain('>Code</button>')
    // Label is "Work"; the tab id stays 'projects' (see SIDEBAR_ACTIVE_TABS).
    expect(html).toContain('>Work</button>')
  })

  it('keeps workspace pinned and recent chats in Code only', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept(
        'pinned',
        'recents',
        'workspaces',
        'chats'
      )
    })

    const html = renderSidebar(mixedChats)

    expect(html).toContain('id="sidebar-threads-panel"')
    expect(html).toContain('Workspace pinned')
    expect(html).toContain('Workspace recent')
    expect(html).not.toContain('Global pinned')
    expect(html).not.toContain('Global recent')
    expect(html).not.toContain('sidebar-chats-section')
  })

  it('gives Chat its own global pinned and recent lists', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept(
        'pinned',
        'recents',
        'workspaces',
        'chats'
      )
    })

    const html = renderSidebar(mixedChats, { activeChatId: 'global-recent' })

    expect(html).toContain('id="sidebar-chat-panel"')
    expect(html).toContain('Global pinned')
    expect(html).toContain('Global recent')
    expect(html).not.toContain('Workspace pinned')
    expect(html).not.toContain('Workspace recent')
    expect(html).not.toContain('sidebar-workspace-scroll')
  })

  it('fronts Chat for a selected General chat even when Code was persisted', () => {
    stubSidebarStorage({ [SIDEBAR_ACTIVE_TAB_STORAGE_KEY]: 'threads' })

    const html = renderSidebar(mixedChats, { activeChatId: 'global-recent' })

    expect(html).toContain('id="sidebar-chat-panel"')
    expect(html).toContain('id="sidebar-chat-tab"')
    expect(html).toContain('aria-selected="true" aria-controls="sidebar-chat-panel"')
  })

  it('does not eject a General chat selection from persisted Projects', () => {
    stubSidebarStorage({ [SIDEBAR_ACTIVE_TAB_STORAGE_KEY]: 'projects' })

    const html = renderSidebar(mixedChats, { activeChatId: 'global-recent' })

    expect(html).toContain('id="sidebar-projects-panel"')
    expect(html).toContain('aria-selected="true" aria-controls="sidebar-projects-panel"')
  })

  it('uses surface-specific stats and search language', () => {
    stubSidebarStorage({})

    const codeHtml = renderSidebar(mixedChats)
    const chatHtml = renderSidebar(mixedChats, { activeChatId: 'global-recent' })

    expect(codeHtml).toContain('1 workspace')
    expect(codeHtml).toContain('2 threads')
    expect(codeHtml).toContain('placeholder="Search workspaces &amp; threads"')
    expect(chatHtml).toContain('2 chats')
    expect(chatHtml).not.toContain('1 workspace')
    expect(chatHtml).toContain('placeholder="Search chats"')
  })
})

describe('Sidebar active chat override', () => {
  it('marks activeChatId as selected before currentChat catches up', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar(
      [
        makeChat({ provider: 'gemini', title: 'Current thread' }),
        makeChat({
          appChatId: 'clicked-thread',
          provider: 'codex',
          title: 'Clicked thread',
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { activeChatId: 'clicked-thread' }
    )

    expect(html).toContain('provider-codex active')
    expect(html).not.toContain('provider-gemini active')
  })
})

describe('Sidebar startup hygiene', () => {
  it('keeps Recents expanded by default for quick return navigation', () => {
    stubSidebarStorage({})

    const html = renderSidebar([
      makeChat({ appChatId: 'recent-1', title: 'Recently active thread', updatedAt: 3 })
    ])

    const recentsBlock = html.slice(html.indexOf('sidebar-recents-section'))
    expect(recentsBlock).toContain('Recently active thread')
  })

  it('starts with only the active workspace tree expanded', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const firstWorkspace = makeWorkspace({
      id: 'ws-1',
      path: '/repo-one',
      displayName: 'Repo One',
      lastOpenedAt: 10
    })
    const activeWorkspace = makeWorkspace({
      id: 'ws-2',
      path: '/repo-two',
      displayName: 'Repo Two',
      lastOpenedAt: 20
    })

    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'first-workspace-chat',
          title: 'Older workspace chat',
          workspaceId: 'ws-1',
          workspacePath: '/repo-one',
          updatedAt: 4
        }),
        makeChat({
          appChatId: 'active-workspace-chat',
          title: 'Active workspace chat',
          workspaceId: 'ws-2',
          workspacePath: '/repo-two',
          updatedAt: 5
        })
      ],
      {
        workspaces: [firstWorkspace, activeWorkspace],
        currentWorkspace: activeWorkspace
      }
    )

    expect(html).toContain('Active workspace chat')
    expect(html).not.toContain('Older workspace chat')
  })
})

describe('sidebar row memo comparators', () => {
  const noop = () => {}
  const chatA = makeChat({ appChatId: 'a' })
  const chatB = makeChat({ appChatId: 'b' })

  const fullBase = {
    chat: chatA,
    variant: 'workspace' as const,
    surfaceId: 'workspace-ws-1-a',
    isSelected: false,
    isRunning: false,
    needsInput: false,
    isEditing: false,
    isCollaborating: false,
    subThreadCount: 0,
    liveSubThreadCount: 0,
    subThreadsExpanded: false,
    query: '',
    onSelect: noop,
    onRowKeyDown: noop,
    onToggleSubThreads: noop,
    onStartRename: noop,
    onSubmitRename: noop,
    onCancelRename: noop,
    buildMenuItems: () => []
  }

  it('SidebarChatRow: ignores function-prop identity but reacts to every data prop', () => {
    // Only the (recreated-each-render) function props differ → skip re-render.
    expect(
      sidebarChatRowPropsAreEqual(fullBase, {
        ...fullBase,
        onSelect: () => {},
        onRowKeyDown: () => {},
        buildMenuItems: () => []
      })
    ).toBe(true)

    // A changed chat OBJECT (the streaming crux) → must re-render.
    expect(sidebarChatRowPropsAreEqual(fullBase, { ...fullBase, chat: chatB })).toBe(false)

    // Every mutable primitive flips the comparator.
    for (const patch of [
      { variant: 'global' as const },
      { surfaceId: 'global-a' },
      { isSelected: true },
      { isRunning: true },
      { needsInput: true },
      { isEditing: true },
      { isCollaborating: true },
      { subThreadCount: 1 },
      { liveSubThreadCount: 1 },
      { subThreadsExpanded: true },
      { query: 'x' }
    ]) {
      expect(sidebarChatRowPropsAreEqual(fullBase, { ...fullBase, ...patch })).toBe(false)
    }
  })

  it('SidebarCompactChatRow: ignores function props, reacts to data + drag proxies', () => {
    const compactBase = {
      chat: chatA,
      variant: 'recents' as const,
      surfaceId: 'recent-a',
      isSelected: false,
      isRunning: false,
      needsInput: false,
      isEditing: false,
      query: '',
      draggable: true,
      isDragging: false,
      onSelect: noop,
      onStartRename: noop,
      onSubmitRename: noop,
      onCancelRename: noop,
      buildMenuItems: () => []
    }
    expect(
      sidebarCompactChatRowPropsAreEqual(compactBase, { ...compactBase, onSelect: () => {} })
    ).toBe(true)
    expect(sidebarCompactChatRowPropsAreEqual(compactBase, { ...compactBase, chat: chatB })).toBe(
      false
    )
    for (const patch of [
      { variant: 'pinned' as const },
      { isSelected: true },
      { isRunning: true },
      { needsInput: true },
      { isEditing: true },
      { draggable: false },
      { isDragging: true },
      { query: 'x' }
    ]) {
      expect(sidebarCompactChatRowPropsAreEqual(compactBase, { ...compactBase, ...patch })).toBe(
        false
      )
    }
  })
})

describe('Sidebar chat row markup', () => {
  it('keeps chat rows out of native buttons so rename inputs are valid in every section', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept(
        'pinned',
        'recents',
        'ensembles',
        'workspaces',
        'chats',
        'shared'
      )
    })

    const chats = [
      makeChat({ appChatId: 'workspace-1', title: 'Workspace thread', updatedAt: 10 }),
      makeChat({
        appChatId: 'pinned-1',
        title: 'Pinned thread',
        pinned: true,
        updatedAt: 9
      }),
      makeChat({
        appChatId: 'ensemble-1',
        chatKind: 'ensemble',
        title: 'Ensemble thread',
        provider: 'codex',
        updatedAt: 8
      }),
      makeChat({
        appChatId: 'global-1',
        scope: 'global',
        title: 'Global thread',
        workspaceId: undefined,
        workspacePath: undefined,
        updatedAt: 7
      }),
      makeChat({
        appChatId: 'shared-1',
        title: 'Shared thread',
        updatedAt: 6
      }),
      makeChat({
        appChatId: 'child-1',
        title: 'Child thread',
        parentChatId: 'workspace-1',
        updatedAt: 5
      })
    ]
    const html = renderSidebar(chats, {
      collaboratingChatIds: new Set(['shared-1']),
      initialExpandedSubThreadParentIds: ['workspace-1'],
      onRenameChat: () => {},
      onTogglePinChat: () => {}
    })

    expect(html).not.toMatch(/<button[^>]*class="[^"]*sidebar-chat-item/)
    expect(html).toMatch(/<div role="button"[^>]*class="[^"]*sidebar-chat-item/)
    expect(html).toContain('Workspace thread')
    expect(html).toContain('Pinned thread')
    expect(html).toContain('Ensemble thread')
    expect(html).not.toContain('Global thread')
    expect(html).toContain('Shared thread')
    expect(html).toContain('Child thread')

    const workspaceTitleIndex = html.indexOf('sidebar-chat-title">Workspace thread')
    expect(workspaceTitleIndex).toBeGreaterThanOrEqual(0)
    const workspaceIdentityContext = html.slice(
      Math.max(0, workspaceTitleIndex - 1_000),
      workspaceTitleIndex
    )
    expect(workspaceIdentityContext).toContain('data-provider-logo="gemini"')
    expect(workspaceIdentityContext).toContain('<img class="provider-brand-logo-image')
    expect(workspaceIdentityContext).not.toContain('provider-glyph-gemini')

    const chatHtml = renderSidebar(chats, { activeChatId: 'global-1' })
    expect(chatHtml).toMatch(/<div role="button"[^>]*class="[^"]*sidebar-chat-item/)
    expect(chatHtml).toContain('Global thread')
    expect(chatHtml).not.toContain('Workspace thread')
  })
})

describe('Sidebar workflows', () => {
  it('renders an enabled quick-create button beside the Workflows header', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], { onCreateWorkflow: () => {} })

    expect(html).toContain('sidebar-workflows-section')
    expect(html).toContain('sidebar-workflow-create')
    expect(html).toContain('aria-label="New workflow"')
    expect(html).not.toContain('sidebar-workflow-create" disabled=""')
  })

  it('keeps workflow quick-create enabled from General chats by targeting the latest workspace', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], {
      currentWorkspace: null,
      workspaces: [
        makeWorkspace({ id: 'old', displayName: 'Old Repo', lastOpenedAt: 1 }),
        makeWorkspace({ id: 'new', displayName: 'New Repo', lastOpenedAt: 5 })
      ],
      onCreateWorkflow: () => {}
    })

    expect(html).toContain('sidebar-workflow-create')
    expect(html).toContain('New workflow in New Repo')
    expect(html).not.toContain('sidebar-workflow-create" disabled=""')
  })

  it('renders workflow cadence and status in the Workflows section', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workflows')
    })

    const html = renderSidebar([], { workflows: [makeWorkflow()] })

    expect(html).toContain('Workflows')
    expect(html).toContain('Audit loop')
    expect(html).toContain('Every 15m')
    expect(html).toContain('Queued')
    expect(html).toContain('provider-codex')
  })
})

describe('Sidebar workspace boards', () => {
  it('renders a workspace board section with create affordance', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], { onCreateWorkspaceBoard: () => {} })

    expect(html).toContain('Workspace Boards')
    expect(html).toContain('sidebar-workspace-board-create')
    expect(html).toContain('aria-label="New workspace board"')
  })

  it('keeps board creation available when a workspace exists but none is active', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], {
      currentWorkspace: null,
      onCreateWorkspaceBoard: () => {}
    })

    expect(html).toContain('sidebar-workspace-board-create')
    expect(html).not.toContain('sidebar-workspace-board-create" disabled=""')
  })

  it('disables board creation only when there are no workspaces', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], {
      workspaces: [],
      currentWorkspace: null,
      onCreateWorkspaceBoard: () => {}
    })

    expect(html).toContain('sidebar-workspace-board-create" disabled=""')
  })

  it('renders board rows without chat drag affordances', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspace-boards')
    })

    const html = renderSidebar([], {
      workspaceBoards: [makeWorkspaceBoard()],
      activeWorkspaceBoardId: 'board-1',
      onOpenWorkspaceBoard: () => {},
      onRenameWorkspaceBoard: () => {},
      onDuplicateWorkspaceBoard: () => {},
      onTogglePinWorkspaceBoard: () => {},
      onArchiveWorkspaceBoard: () => {},
      onDeleteWorkspaceBoard: () => {}
    })

    expect(html).toContain('Release board')
    expect(html).toContain('sidebar-workspace-board-item active')
    expect(html).toContain('aria-label="Workspace board actions"')
    expect(html).toContain('sidebar-overflow-menu')
    expect(html).not.toContain('sidebar-workspace-board-actions')
    expect(html).not.toContain('application/x-taskwraith-chat-id')
  })

  it('sorts pinned boards first and marks their metadata', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspace-boards')
    })

    const html = renderSidebar([], {
      workspaceBoards: [
        makeWorkspaceBoard({
          id: 'board-1',
          name: 'Recent board',
          updatedAt: '2026-06-29T12:00:00.000Z'
        }),
        makeWorkspaceBoard({
          id: 'board-2',
          name: 'Pinned board',
          pinned: true,
          updatedAt: '2026-06-28T12:00:00.000Z'
        })
      ],
      onOpenWorkspaceBoard: () => {}
    })

    expect(html.indexOf('Pinned board')).toBeLessThan(html.indexOf('Recent board'))
    expect(html).toContain('Pinned · Repo')
  })

  it('renders boards from any known workspace in the shared board section', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspace-boards')
    })

    const otherWorkspace = makeWorkspace({
      id: 'ws-2',
      path: '/other',
      displayName: 'Other Repo'
    })
    const html = renderSidebar([], {
      workspaces: [makeWorkspace(), otherWorkspace],
      workspaceBoards: [
        makeWorkspaceBoard({
          id: 'board-2',
          workspaceId: 'ws-2',
          workspacePath: '/other',
          name: 'Other board'
        })
      ],
      onOpenWorkspaceBoard: () => {}
    })

    expect(html).toContain('Other board')
    expect(html).toContain('Other Repo')
  })

  it('renders archived boards with a restore action', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspace-boards')
    })

    const html = renderSidebar([], {
      workspaceBoards: [
        makeWorkspaceBoard({
          id: 'board-archived',
          name: 'Archived board',
          archived: true
        })
      ],
      onRestoreWorkspaceBoard: () => {},
      onDeleteWorkspaceBoard: () => {}
    })

    expect(html).toContain('Archived board')
    expect(html).toContain('Archived · Repo')
    expect(html).toContain('Archived workspace board actions')
  })
})

describe('Sidebar shared chat create options', () => {
  it('offers explicit shared chat variants with availability constraints', () => {
    expect(
      getSharedChatCreateOptions({ hasWorkspace: true, ensembleModeEnabled: true }).map(
        ({ variant, label, disabled }) => ({ variant, label, disabled })
      )
    ).toEqual([
      { variant: 'global', label: 'People Chat (General)', disabled: false },
      { variant: 'workspace', label: 'People Chat (Workspace)', disabled: false }
    ])

    expect(
      getSharedChatCreateOptions({ hasWorkspace: false, ensembleModeEnabled: false }).map(
        ({ variant, disabled }) => ({ variant, disabled })
      )
    ).toEqual([
      { variant: 'global', disabled: false },
      { variant: 'workspace', disabled: true }
    ])
  })

  it('renders the Shared section launcher as a variant chooser', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('shared')
    })

    const html = renderSidebar([], { onCreateSharedChat: () => {} })

    expect(html).toContain('sidebar-shared-section')
    expect(html).toContain('aria-label="Choose shared chat type"')
  })

  it('renders shared chats with the standard chat row action affordance', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('shared')
    })

    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'shared-1',
          provider: 'codex',
          title: 'Shared planning thread'
        })
      ],
      {
        collaboratingChatIds: new Set(['shared-1']),
        onRenameChat: () => {},
        onTogglePinChat: () => {},
        onToggleArchiveChat: () => {},
        onDeleteChat: () => {},
        onOpenInMultiview: () => {}
      }
    )

    expect(html).toContain('Shared planning thread')
    expect(html).toContain('sidebar-shared-chat-item')
    expect(html).toContain('People have access')
    expect(html).toContain('aria-label="People chat actions"')
    expect(html).toContain('sidebar-overflow-menu')
  })

  it('hides archived shared chats from the Shared section', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('shared')
    })

    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'archived-shared-1',
          title: 'Archived shared thread',
          archived: true
        })
      ],
      { collaboratingChatIds: new Set(['archived-shared-1']) }
    )

    expect(html).not.toContain('Archived shared thread')
    expect(html).toContain('No shared chats')
  })
})

describe('Sidebar sub-thread collapse', () => {
  it('keeps sub-thread children collapsed by default', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar([
      makeChat(),
      makeChat({
        appChatId: 'child-1',
        provider: 'codex',
        title: 'Child thread',
        parentChatId: 'parent-1',
        createdAt: 2,
        updatedAt: 2
      })
    ])

    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('sidebar-chat-children')
    expect(html).not.toContain('Child thread')
  })

  it('renders sub-thread children after an explicit branch expansion', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const childIdentity = assignAgentIdentityFromSeed('child-1')

    const html = renderSidebar(
      [
        makeChat(),
        makeChat({
          appChatId: 'child-1',
          provider: 'codex',
          title: 'Child thread',
          parentChatId: 'parent-1',
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { initialExpandedSubThreadParentIds: ['parent-1'] }
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('sidebar-chat-children')
    expect(html).toContain(childIdentity.name)
    expect(html).toContain('sidebar-sub-thread-identicon')
    expect(html).toContain('Gemini delegated to Codex')
  })

  it('labels fan-out side-chat children distinctly in the sidebar', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar(
      [
        makeChat(),
        makeChat({
          appChatId: 'fan-out-side-1',
          provider: 'gemini',
          chatKind: 'ensemble',
          title: 'Parallel side branch',
          parentChatId: 'parent-1',
          parentChatRelation: 'sideChat',
          sideChatContext: {
            createdAt: 2,
            mode: 'fanOut',
            lifecycleState: 'active',
            transcriptVisibility: 'none'
          },
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { initialExpandedSubThreadParentIds: ['parent-1'] }
    )

    expect(html).toContain('Parallel side branch')
    expect(html).toContain('Fan-out side chat')
    expect(html).toContain('Parallel fan-out')
    expect(html).toContain('Isolated context')
    expect(html).toContain('Gemini parallel fan-out')
  })

  it('shows participant and context metadata for side-chat children', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const sideChatIdentity = assignAgentIdentityFromSeed('parent-1:reviewer-codex')
    const html = renderSidebar(
      [
        makeChat(),
        makeChat({
          appChatId: 'reviewer-side-1',
          provider: 'codex',
          title: 'Reviewer branch',
          parentChatId: 'parent-1',
          parentChatRelation: 'sideChat',
          sideChatContext: {
            createdAt: 2,
            mode: 'singleProvider',
            lifecycleState: 'closed',
            originMessageId: 'message-1',
            transcriptVisibility: 'selected'
          },
          providerMetadata: {
            sideChatSelectedParticipantId: 'reviewer-codex',
            sideChatSelectedParticipantRole: 'Reviewer'
          },
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { initialExpandedSubThreadParentIds: ['parent-1'] }
    )

    expect(html).toContain('Reviewer branch')
    expect(html).toContain('Isolated side chat')
    expect(html).toContain('Participant: Reviewer')
    expect(html).toContain('Seeded from selected message')
    expect(html).toContain('Gemini dedicated branch to Reviewer')
    expect(html).toContain(sideChatIdentity.name)
    expect(html).toContain('sidebar-sub-thread-identicon')
    expect(html).toContain('Closed')
  })

  it('renders plain same-provider side-chat children without a subagent identity', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar(
      [
        makeChat({
          provider: 'codex',
          title: 'Codex parent'
        }),
        makeChat({
          appChatId: 'plain-side-1',
          provider: 'codex',
          title: 'Side Codex chat',
          parentChatId: 'parent-1',
          parentChatRelation: 'sideChat',
          sideChatContext: {
            createdAt: 2,
            mode: 'singleProvider',
            lifecycleState: 'closed',
            transcriptVisibility: 'none'
          },
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { initialExpandedSubThreadParentIds: ['parent-1'] }
    )

    expect(html).toContain('Side Codex chat')
    expect(html).toContain('Isolated sidecar')
    expect(html).toContain('Codex isolated side chat')
    expect(html).not.toContain('Codex side branch to Codex')
    expect(html).not.toContain('sidebar-sub-thread-identicon')
  })

  it('labels run-result seeded side-chat children explicitly', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar(
      [
        makeChat(),
        makeChat({
          appChatId: 'run-seeded-side-1',
          provider: 'claude',
          title: 'Run follow-up',
          parentChatId: 'parent-1',
          parentChatRelation: 'sideChat',
          sideChatContext: {
            createdAt: 2,
            mode: 'singleProvider',
            lifecycleState: 'active',
            originRunId: 'run-1',
            transcriptVisibility: 'snapshot'
          },
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { initialExpandedSubThreadParentIds: ['parent-1'] }
    )

    expect(html).toContain('Run follow-up')
    expect(html).toContain('Seeded from run result')
  })

  it('labels copied parent snapshots for isolated side-chat children', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar(
      [
        makeChat(),
        makeChat({
          appChatId: 'snapshot-side-1',
          provider: 'claude',
          title: 'Snapshot sidecar',
          parentChatId: 'parent-1',
          parentChatRelation: 'sideChat',
          sideChatContext: {
            createdAt: 2,
            mode: 'singleProvider',
            lifecycleState: 'active',
            transcriptVisibility: 'snapshot'
          },
          createdAt: 2,
          updatedAt: 2
        })
      ],
      { initialExpandedSubThreadParentIds: ['parent-1'] }
    )

    expect(html).toContain('Snapshot sidecar')
    expect(html).toContain('Copied parent snapshot')
    expect(html).not.toContain('Seeded from run result')
  })

  it('hides sub-thread children when the parent branch has not been expanded', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar([
      makeChat(),
      makeChat({
        appChatId: 'child-1',
        provider: 'codex',
        title: 'Child thread',
        parentChatId: 'parent-1',
        createdAt: 2,
        updatedAt: 2
      })
    ])

    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('sidebar-chat-children')
  })
})

describe('Sidebar ensembles section', () => {
  it('renders a quick-create button beside the Ensembles header', () => {
    stubSidebarStorage({})

    const html = renderSidebar([])

    expect(html).toContain('sidebar-ensembles-section')
    expect(html).toContain('sidebar-ensemble-create')
    expect(html).toContain('aria-label="New Ensemble"')
  })

  it('uses the canonical Ensemble glyph in the empty state without SF Symbol paint rules', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('ensembles')
    })

    const html = renderSidebar([])
    const emptyState = html.slice(
      html.indexOf('sidebar-ensembles-empty'),
      html.indexOf('sidebar-ensembles-empty-copy')
    )

    expect(emptyState).toContain('sidebar-ensemble-symbol-icon')
    expect(emptyState).toContain('provider-glyph-ensemble')
    expect(emptyState).toContain('data-brand="antigravity"')
    expect(emptyState).not.toContain('sf-symbol-icon')
  })

  it('hides the Ensembles section when Ensemble Mode is disabled', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], { ensembleModeEnabled: false })

    expect(html).not.toContain('sidebar-ensembles-section')
    expect(html).not.toContain('sidebar-ensemble-create')
  })

  it('uses the ensemble provider glyph in ensemble, pinned, and recent chat rows', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept(
        'pinned',
        'recents',
        'ensembles'
      )
    })

    const html = renderSidebar([
      makeChat({
        appChatId: 'ensemble-1',
        chatKind: 'ensemble',
        title: 'Workspace ensemble',
        provider: 'codex',
        createdAt: 3,
        updatedAt: 3
      }),
      makeChat({
        appChatId: 'pinned-ensemble-1',
        chatKind: 'ensemble',
        title: 'Pinned ensemble',
        provider: 'claude',
        pinned: true,
        createdAt: 4,
        updatedAt: 4
      })
    ])

    expect(html).toContain('sidebar-ensemble-item')
    expect(html).toContain('sidebar-pinned-item')
    // 1.0.7 — three ensemble glyphs now: the unpinned ensemble renders in BOTH
    // the Ensembles section AND Recents (Recents includes ensembles as of
    // 1.0.7), plus the pinned ensemble in the Pinned section. Pinned ensembles
    // are excluded from Recents by selectRecentChats, so only the unpinned one
    // dual-surfaces.
    expect(
      (html.match(/class="provider-glyph provider-glyph-ensemble(?:\s|")/g) || []).length
    ).toBe(3)
    expect(html).not.toContain('sidebar-provider-dot-ensemble')
  })

  it('uses official provider marks instead of monoline glyphs in Pinned and Recents', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('pinned', 'recents')
    })

    const html = renderSidebar([
      makeChat({
        appChatId: 'pinned-codex',
        title: 'Pinned Codex',
        provider: 'codex',
        pinned: true,
        createdAt: 2,
        updatedAt: 2
      }),
      makeChat({
        appChatId: 'recent-ollama',
        title: 'Recent Ollama',
        provider: 'ollama',
        createdAt: 3,
        updatedAt: 3
      })
    ])

    const pinnedBlock = html.slice(
      html.indexOf('sidebar-pinned-section'),
      html.indexOf('sidebar-recents-section')
    )
    const recentsBlock = html.slice(html.indexOf('sidebar-recents-section'))

    expect(pinnedBlock).toContain('data-provider-logo="codex"')
    expect(pinnedBlock).not.toContain('provider-glyph-codex')
    expect(recentsBlock).toContain('data-provider-logo="ollama"')
    expect(recentsBlock).not.toContain('provider-glyph-ollama')
    expect(html).not.toContain('sidebar-provider-dot')
  })

  it('1.0.7 — surfaces an unpinned ensemble chat in the Recents section', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })

    const html = renderSidebar([
      makeChat({ appChatId: 'solo-1', title: 'Solo', updatedAt: 2 }),
      makeChat({
        appChatId: 'ensemble-recent',
        chatKind: 'ensemble',
        title: 'Recent ensemble',
        provider: 'codex',
        updatedAt: 5
      })
    ])

    // The ensemble chat (most recently updated) appears as a Recents item, not
    // only in the Ensembles section.
    expect(html).toContain('sidebar-recents-item')
    const recentsBlock = html.slice(html.indexOf('sidebar-recents-section'))
    expect(recentsBlock).toContain('Recent ensemble')
  })

  it('dual-lists workspace-scoped ensembles under Workspaces and Ensembles', () => {
    stubSidebarStorage({
      [SIDEBAR_ACTIVE_TAB_STORAGE_KEY]: 'threads',
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept(
        'workspaces',
        'ensembles'
      )
    })

    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'solo-ws',
          title: 'Solo workspace chat',
          updatedAt: 2
        }),
        makeChat({
          appChatId: 'ensemble-ws',
          chatKind: 'ensemble',
          title: 'Workspace ensemble under group',
          provider: 'codex',
          updatedAt: 5
        }),
        makeChat({
          appChatId: 'ensemble-global',
          chatKind: 'ensemble',
          scope: 'global',
          // Even if a workspaceId were present, global scope must not bucket.
          workspaceId: 'ws-1',
          workspacePath: '/repo',
          title: 'Global ensemble stays global',
          provider: 'claude',
          updatedAt: 4
        })
      ],
      { ensembleModeEnabled: true }
    )

    expect(html).toContain('sidebar-workspace-group')
    expect(html).toContain('sidebar-ensembles-section')

    // Ensembles section renders above Workspaces in the hierarchy.
    const ensemblesSection = html.slice(
      html.indexOf('sidebar-ensembles-section'),
      html.indexOf('sidebar-workspace-list')
    )
    const workspacesSection = html.slice(html.indexOf('sidebar-workspace-list'))

    expect(workspacesSection).toContain('Workspace ensemble under group')
    expect(workspacesSection).toContain('Solo workspace chat')
    expect(workspacesSection).not.toContain('Global ensemble stays global')
    expect(ensemblesSection).toContain('Workspace ensemble under group')
    // Global ensembles belong on the Chat tab surface, not Code/Workspaces.
    expect(ensemblesSection).not.toContain('Global ensemble stays global')

    stubSidebarStorage({
      [SIDEBAR_ACTIVE_TAB_STORAGE_KEY]: 'threads',
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const disabledHtml = renderSidebar(
      [
        makeChat({
          appChatId: 'ensemble-ws-disabled',
          chatKind: 'ensemble',
          title: 'Hidden when ensemble mode off',
          provider: 'codex',
          updatedAt: 5
        })
      ],
      { ensembleModeEnabled: false }
    )
    const disabledWorkspaces = disabledHtml.includes('sidebar-workspace-list')
      ? disabledHtml.slice(disabledHtml.indexOf('sidebar-workspace-list'))
      : ''
    expect(disabledWorkspaces).not.toContain('Hidden when ensemble mode off')
    expect(disabledHtml).not.toContain('sidebar-ensembles-section')
  })
})

describe('Sidebar Chats section', () => {
  it('keeps the Chats header visible while hiding global chats when collapsed', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: JSON.stringify(['chats', 'recents'])
    })

    const html = renderSidebar([
      makeChat({
        appChatId: 'global-1',
        scope: 'global',
        title: 'Global thread',
        workspaceId: undefined,
        workspacePath: undefined
      })
    ])

    expect(html).toContain('Expand Chats')
    expect(html).toContain('New general chat')
    expect(html).not.toContain('Global thread')
  })
})

describe('Sidebar list truncation', () => {
  function globalChat(n: number): ChatRecord {
    return makeChat({
      appChatId: `global-${n}`,
      scope: 'global',
      title: `Global thread ${n}`,
      workspaceId: undefined,
      workspacePath: undefined,
      updatedAt: n
    })
  }

  it('caps a long section at the preview limit and offers a "Show more" toggle', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('chats')
    })

    const html = renderSidebar(Array.from({ length: 7 }, (_, i) => globalChat(i + 1)))

    // Only the first 5 rows render; the other 2 hide behind the toggle.
    expect(html.match(/sidebar-global-chat-item/g) ?? []).toHaveLength(5)
    expect(html).toContain('sidebar-show-more')
    expect(html).toContain('Show 2 more')
  })

  it('renders no "Show more" when a section fits within the preview limit', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('chats')
    })

    const html = renderSidebar(Array.from({ length: 5 }, (_, i) => globalChat(i + 1)))

    expect(html.match(/sidebar-global-chat-item/g) ?? []).toHaveLength(5)
    expect(html).not.toContain('sidebar-show-more')
  })
})

describe('Sidebar running indicator', () => {
  function globalChat(): ChatRecord {
    return makeChat({
      appChatId: 'global-1',
      scope: 'global',
      title: 'Busy thread',
      workspaceId: undefined,
      workspacePath: undefined
    })
  }

  it('marks a running chat with the pulsing ghost, never the retired busy dot', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('chats')
    })

    const running = renderSidebar([globalChat()], { runningChatIds: ['global-1'] })
    expect(running).toContain('sidebar-chat-running')
    expect(running).not.toContain('sidebar-chat-busy')

    const idle = renderSidebar([globalChat()], { runningChatIds: [] })
    expect(idle).not.toContain('sidebar-chat-running')
  })

  it('shows the ghost + aria-busy in Pinned, which previously had no running cue', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('pinned')
    })

    const html = renderSidebar([makeChat({ appChatId: 'p1', pinned: true, title: 'Pinned run' })], {
      runningChatIds: ['p1']
    })
    expect(html).toContain('sidebar-chat-running')
    expect(html).toContain('aria-busy')
  })
})

describe('Sidebar footer controls', () => {
  it('renders the Approvals and Shares control buttons', () => {
    const html = renderSidebar([makeChat()])
    expect(html).toContain('aria-label="Approvals"')
    expect(html).toContain('aria-label="People"')
  })

  it('glows the Approvals button red only while an approval is pending', () => {
    // glow-red is unique to the Approvals button, so presence/absence of the
    // class unambiguously reflects the pending-approval signal.
    const idle = renderSidebar([makeChat()])
    expect(idle).not.toContain('glow-red')

    const pending = renderSidebar([makeChat()], {
      pendingAgentApprovalByChatId: { 'parent-1': makeApproval() }
    })
    expect(pending).toContain('glow-red')
  })

  it('glows the Approvals button red while an agent question is pending', () => {
    const pending = renderSidebar([makeChat()], {
      pendingAgentQuestionsByChatId: {
        'parent-1': [
          {
            questionId: 'q-1',
            appRunId: 'run-1',
            messageId: 'agent-question-q-1',
            provider: 'claude',
            question: 'Use Postgres?',
            options: ['Yes', 'No'],
            askedAt: 1
          }
        ]
      }
    })
    expect(pending).toContain('glow-red')
    expect(pending).toContain('Needs input')
  })

  it('ignores cleared (null) approval entries for the red glow', () => {
    // usePerChatState deletes keys on reset, but guard against a lingering null
    // still suppressing the glow.
    const html = renderSidebar([makeChat()], {
      pendingAgentApprovalByChatId: { 'parent-1': null }
    })
    expect(html).not.toContain('glow-red')
  })

  it('glows the Shares button yellow only when a collaborator is connected', () => {
    // Sharing alone does NOT glow — the glow is the precise "someone's actually
    // here" signal, driven by a live collaborator session.
    const sharingButEmpty = renderSidebar([makeChat()], {
      collaboratingChatIds: new Set(['parent-1'])
    })
    expect(sharingButEmpty).not.toContain('glow-yellow')

    const connected = renderSidebar([makeChat()], {
      collaboratingChatIds: new Set(['parent-1']),
      hasConnectedCollaborator: true
    })
    expect(connected).toContain('glow-yellow')
  })
})

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    iphoneIdentityPubKey: 'key-1',
    pairId: 'pair-1',
    controllerDisplayName: "Chris's iPhone",
    pairedAt: '2026-06-25T00:00:00.000Z',
    connected: true,
    ...overrides
  }
}

describe('DevicesFooterPopover', () => {
  it('shows an empty state with no paired devices', () => {
    const html = renderToStaticMarkup(
      <DevicesFooterPopover devices={[]} onOpenSettings={() => {}} />
    )
    expect(html).toContain('No paired devices')
    expect(html).toContain('Manage devices')
  })

  it('renders a connected device with a lit LED and a Connected label', () => {
    const html = renderToStaticMarkup(
      <DevicesFooterPopover devices={[makeDevice()]} onOpenSettings={() => {}} />
    )
    expect(html).toContain("Chris&#x27;s iPhone")
    expect(html).toContain('sidebar-footer-led is-on')
    expect(html).toContain('Connected')
  })

  it('renders a disconnected device as Idle with an unlit LED', () => {
    const html = renderToStaticMarkup(
      <DevicesFooterPopover
        devices={[makeDevice({ connected: false, controllerDisplayName: 'iPad' })]}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('iPad')
    expect(html).toContain('Idle')
    // The LED span is present but without the is-on modifier.
    expect(html).toContain('class="sidebar-footer-led"')
  })

  it('caps the list at five devices and surfaces the overflow count', () => {
    const devices = Array.from({ length: 7 }, (_, index) =>
      makeDevice({ iphoneIdentityPubKey: `key-${index}`, controllerDisplayName: `Device ${index}` })
    )
    const html = renderToStaticMarkup(
      <DevicesFooterPopover devices={devices} onOpenSettings={() => {}} />
    )
    expect(html).toContain('Device 4')
    expect(html).not.toContain('Device 5')
    expect(html).toContain('+2 more')
  })
})

describe('ApprovalsFooterPopover', () => {
  // Note: the recent-resolved list is fetched in an effect, which does not run
  // under renderToStaticMarkup (no jsdom in this suite), so these cover the
  // synchronous pending-list rendering only.
  it('shows an empty state with no pending approvals', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover pendingApprovals={[]} onOpenSettings={() => {}} />
    )
    expect(html).toContain('No pending approvals or questions')
    expect(html).toContain('Approvals &amp; Grants')
  })

  it('lists pending agent questions with answer options', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={[]}
        pendingQuestions={[
          {
            chatId: 'parent-1',
            question: {
              questionId: 'q-1',
              appRunId: 'run-1',
              messageId: 'agent-question-q-1',
              provider: 'claude',
              question: 'Use Postgres?',
              options: ['Yes', 'No'],
              askedAt: 1
            }
          }
        ]}
        resolveChatTitle={() => 'Auth rewrite'}
        onJumpToChat={() => {}}
        onAnswerQuestion={() => {}}
        onDismissQuestion={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Needs your input')
    expect(html).toContain('Questions')
    expect(html).toContain('Use Postgres?')
    expect(html).toContain('Claude')
    expect(html).toContain('Auth rewrite')
    expect(html).toContain('Yes')
    expect(html).toContain('No')
    expect(html).toContain('Skip')
  })

  it('lists pending approvals with a pending LED, title and provider', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={[
          { chatId: 'parent-1', approval: makeApproval({ title: 'Write a file', provider: 'codex' }) }
        ]}
        onJumpToChat={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Write a file')
    expect(html).toContain('sidebar-footer-led is-pending')
    expect(html).toContain('Codex')
    expect(html).toContain('aria-label="Write a file, Codex, open thread"')
    // A filing chatId + onJumpToChat present → the row is a clickable button.
    // (The chatId is the map key, so it's present even when the approval's own
    // appChatId is undefined — the previous appChatId-only gate dropped those.)
    expect(html).toContain('sidebar-footer-approval-row is-clickable')
  })

  it('stays clickable when the approval has no own appChatId but a filing chatId', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={[{ chatId: 'parent-1', approval: makeApproval({ appChatId: undefined }) }]}
        onJumpToChat={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('sidebar-footer-approval-row is-clickable')
  })

  it('renders inline approval actions when a response handler is provided', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={[
          {
            chatId: 'parent-1',
            approval: makeApproval({
              title: 'Approve shell command',
              actions: ['accept', 'acceptForSession', 'decline']
            })
          }
        ]}
        onJumpToChat={() => {}}
        onRespondApproval={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Approve')
    expect(html).toContain('Always Allow')
    expect(html).toContain('Deny')
    expect(html).toContain('Actions for Approve shell command')
  })

  it('requires in-task review before canvas_eval can be approved', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={[
          {
            chatId: 'parent-1',
            approval: makeApproval({
              title: 'Approve canvas eval',
              actions: ['accept', 'decline'],
              preview: {
                toolName: 'mcp__taskwraith__canvas_eval',
                params: { script: 'document.cookie' }
              }
            })
          }
        ]}
        onJumpToChat={() => {}}
        onRespondApproval={() => {}}
        onOpenSettings={() => {}}
      />
    )

    expect(html).toContain('Review the exact script in the task before approving.')
    expect(html).not.toContain('class="sidebar-footer-approval-action is-approve"')
    expect(html).toContain('class="sidebar-footer-approval-action is-deny"')
  })

  it('renders a non-clickable row when no jump handler is provided', () => {
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={[{ chatId: 'parent-1', approval: makeApproval() }]}
        onOpenSettings={() => {}}
      />
    )
    expect(html).not.toContain('is-clickable')
  })

  it('caps the pending list at six and surfaces the overflow count', () => {
    const approvals = Array.from({ length: 8 }, (_, index) => ({
      chatId: 'parent-1',
      approval: makeApproval({ id: `a-${index}`, title: `Approval ${index}` })
    }))
    const html = renderToStaticMarkup(
      <ApprovalsFooterPopover
        pendingApprovals={approvals}
        onJumpToChat={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Approval 5')
    expect(html).not.toContain('Approval 6')
    expect(html).toContain('+2 more pending')
  })
})

function makeShare(overrides: Record<string, unknown> = {}) {
  return {
    shareId: 'share-1',
    chatId: 'parent-1',
    mode: 'comments' as const,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextSequence: 1,
    participants: [
      {
        collaboratorId: 'c-1',
        displayName: 'Alex',
        publicKeyId: 'ed25519:alex',
        status: 'active' as const,
        joinedAt: 2
      }
    ],
    invites: [],
    idempotency: {},
    ...overrides
  }
}

describe('SharesFooterPopover', () => {
  it('shows an empty state with no active shares', () => {
    const html = renderToStaticMarkup(
      <SharesFooterPopover shares={[]} onOpenSettings={() => {}} />
    )
    expect(html).toContain('No active shares')
    expect(html).toContain('Manage shares')
  })

  it('renders a share with its resolved title, mode and active count', () => {
    const html = renderToStaticMarkup(
      <SharesFooterPopover
        shares={[makeShare()]}
        resolveChatTitle={() => 'Design review'}
        onJumpToChat={() => {}}
        onRevokeShare={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Design review')
    expect(html).toContain('Comments')
    expect(html).toContain('1 active')
    expect(html).toContain('Stop')
    expect(html).toContain('is-clickable')
  })

  it('labels a read-only share and shows awaiting state with no active members', () => {
    const html = renderToStaticMarkup(
      <SharesFooterPopover
        shares={[makeShare({ mode: 'readOnly', participants: [] })]}
        resolveChatTitle={() => 'Spec'}
        onJumpToChat={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Read-only')
    expect(html).toContain('Awaiting collaborator')
  })

  it('omits the Stop button when no revoke handler is supplied', () => {
    const html = renderToStaticMarkup(
      <SharesFooterPopover
        shares={[makeShare()]}
        resolveChatTitle={() => 'Design review'}
        onOpenSettings={() => {}}
      />
    )
    expect(html).not.toContain('sidebar-footer-share-revoke')
  })

  it('marks share rows as live when the chat has a connected collaborator session', () => {
    const html = renderToStaticMarkup(
      <SharesFooterPopover
        shares={[makeShare()]}
        resolveChatTitle={() => 'Design review'}
        connectedShareChatIds={new Set(['parent-1'])}
        onJumpToChat={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Design review')
    expect(html).toContain('Live')
  })
})

describe('git workflow markers', () => {
  const merged = { state: 'merged' as const, prNumber: 12, updatedAt: 40 }
  const open = { state: 'open' as const, prNumber: 9, updatedAt: 30 }

  it('renders the per-row git icon beside the provider logo and the Git section groups', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents', 'git')
    })

    const html = renderSidebar([
      makeChat({ appChatId: 'merged-thread', title: 'Merged thread', gitWorkflow: merged }),
      makeChat({ appChatId: 'open-thread', title: 'Open thread', gitWorkflow: open }),
      makeChat({ appChatId: 'plain-thread', title: 'Plain thread' })
    ])

    expect(html).toContain('sidebar-git-workflow-icon state-merged')
    expect(html).toContain('sidebar-git-workflow-icon state-open')
    expect(html).toContain('Git: PR #12 merged')
    // Section chrome: header + only the non-empty subheaders. Bound the slice
    // at Recents (rendered after the Git section in DOM order) so assertions
    // don't leak into other sections' rows.
    const gitSection = html.slice(
      html.indexOf('sidebar-git-section'),
      html.indexOf('sidebar-recents-section')
    )
    expect(gitSection).toContain('sidebar-git-subheader')
    expect(gitSection).toContain('PRs')
    expect(gitSection).toContain('Merged')
    expect(gitSection).not.toContain('>Pushed<')
    expect(gitSection).not.toContain('>Closed<')
    // The marker-less chat stays out of the Git section.
    expect(gitSection).not.toContain('Plain thread')
  })

  it('keeps the Git header pill present with an empty state when nothing is tagged', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents', 'git')
    })

    const html = renderSidebar([makeChat({ appChatId: 'plain-thread', title: 'Plain thread' })])

    const gitSection = html.slice(
      html.indexOf('sidebar-git-section'),
      html.indexOf('sidebar-recents-section')
    )
    // The header pill is a permanent resident (same chrome as the others)…
    expect(gitSection).toContain('sidebar-section-header-toggle')
    expect(gitSection).toContain('>Git<')
    // …with no zero badge, no state groups, and the expanded empty state.
    expect(gitSection).not.toContain('sidebar-section-count')
    expect(gitSection).not.toContain('sidebar-git-subheader')
    expect(gitSection).toContain('No git workflows yet')
  })

  it('hiddenFromMainList drops a chat from Recents but keeps its Git entry', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents', 'git')
    })

    const html = renderSidebar([
      makeChat({
        appChatId: 'shipped-thread',
        title: 'Shipped thread',
        gitWorkflow: merged,
        hiddenFromMainList: true
      }),
      makeChat({ appChatId: 'other-thread', title: 'Other thread' })
    ])

    const gitSectionIndex = html.indexOf('sidebar-git-section')
    expect(gitSectionIndex).toBeGreaterThanOrEqual(0)
    // The Git section keeps the hidden chat reachable…
    const gitSection = html.slice(gitSectionIndex, html.indexOf('sidebar-recents-section'))
    expect(gitSection).toContain('Shipped thread')
    // …while Recents (rendered after the Git section in DOM order) drops it.
    const recents = html.slice(html.indexOf('sidebar-recents-section'))
    expect(recents).toContain('Other thread')
    expect(recents).not.toContain('Shipped thread')
  })

  it('cycles the ACTIVE row label through the workspace/branch identity ticker', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })

    const html = renderSidebar(
      [
        makeChat({ appChatId: 'active-thread', title: 'Active thread' }),
        makeChat({ appChatId: 'idle-thread', title: 'Idle thread' })
      ],
      { activeChatId: 'active-thread', activeChatIdentityTicker: 'TaskWraith/master' }
    )

    expect(html).toContain('sidebar-title-ticker')
    expect(html).toContain('TaskWraith/master')
    // Exactly one row gets the ticker — the active one.
    expect(html.split('sidebar-title-ticker-strip').length - 1).toBe(1)
  })

  it('renders no ticker without an identity string', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })

    const html = renderSidebar([makeChat({ appChatId: 'active-thread', title: 'Active thread' })], {
      activeChatId: 'active-thread'
    })

    expect(html).not.toContain('sidebar-title-ticker')
  })
})
