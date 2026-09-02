import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  resolveSidebarFooterPopoverPortalPosition,
  resolveSidebarSettingsMenuPortalPosition,
  DevicesFooterPopover,
  ApprovalsFooterPopover,
  sidebarChatRowPropsAreEqual,
  sidebarCompactChatRowPropsAreEqual,
  type WorkspaceBoardCreateInput
} from './Sidebar'
import { CollapsedSidebarCornerPill } from './CollapsedSidebarCornerPill'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import type { AgentApprovalRequest } from '../lib/agentApprovalTypes'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'
import {
  SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY,
  SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY,
  loadOrSeedSidebarSuccessInkEpoch,
  projectSidebarTerminalOutcome
} from '../lib/sidebarTerminalOutcome'

const COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY = 'taskwraith-sidebar-collapsed-sections'
const COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY =
  'taskwraith-sidebar-collapsed-sections-default-version'
const COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION = 'hierarchy-disclosures-v2'
const EXPANDED_WORKSPACE_IDS_STORAGE_KEY = 'taskwraith-sidebar-expanded-workspaces'
const SIDEBAR_ACTIVE_TAB_STORAGE_KEY = 'taskwraith-sidebar-active-tab'

// Mirrors SIDEBAR_SECTION_IDS in Sidebar.tsx. The sidebar defaults every section
// except Recents to collapsed for new users, so tests that assert on child rows
// opt the relevant section(s) open the way a user would by clicking the header.
// Persisting a non-empty collapsed list also bypasses the new-user default
// migration, pinning exactly these sections open.
const SIDEBAR_SECTION_IDS = [
  'active-runs',
  'local-servers',
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
  // Established install by default: the success-ink epoch is already seeded
  // and long past, so settled fixtures read as post-upgrade results. Tests
  // that exercise the FIRST launch after upgrading set it themselves.
  if (!store.has(SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY)) {
    store.set(SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY, '1')
  }
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
    collaboratingChatIds?: Set<string>
    initialExpandedSubThreadParentIds?: string[]
    pendingAgentApprovalByChatId?: Record<string, AgentApprovalRequest | null>
    pendingApprovalQueueByChatId?: Record<string, AgentApprovalRequest[]>
    activeChatIdentityTicker?: string | null
    activeChatIdentityBranch?: string | null
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
    activeChatIdentityGitIndicators?: string | null
    onSetChatHiddenFromMainList?: (chatId: string, hidden: boolean) => void
    onClearChatGitWorkflow?: (chatId: string) => void
  } = {}
) {
  const workspace = makeWorkspace()
  const workspaces = options.workspaces ?? [workspace]
  const currentWorkspace =
    options.currentWorkspace === undefined ? workspace : options.currentWorkspace
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
      pendingApprovalQueueByChatId={options.pendingApprovalQueueByChatId}
      activeChatIdentityTicker={options.activeChatIdentityTicker}
      activeChatIdentityBranch={options.activeChatIdentityBranch}
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
      onRenameChat={options.onRenameChat}
      onTogglePinChat={options.onTogglePinChat}
      onToggleArchiveChat={options.onToggleArchiveChat}
      onDeleteChat={options.onDeleteChat}
      onOpenInMultiview={options.onOpenInMultiview}
      updateSnapshot={options.updateSnapshot}
      onQuickUpdate={options.onQuickUpdate}
      activeChatIdentityGitIndicators={options.activeChatIdentityGitIndicators}
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

  it('does not offer a user-defined tool-call theme', () => {
    const html = renderToStaticMarkup(
      <SidebarSettingsMenu
        pane="themes"
        setPane={() => undefined}
        onOpenSettings={() => undefined}
        onClose={() => undefined}
      />
    )

    expect(html).not.toContain('Tool Call Theme')
  })

  it('keeps the portaled menu above its footer trigger and within the viewport', () => {
    expect(
      resolveSidebarSettingsMenuPortalPosition({ left: 0, top: 900 }, { width: 1280, height: 980 })
    ).toEqual({ position: 'fixed', left: 8, bottom: 88 })

    expect(
      resolveSidebarSettingsMenuPortalPosition(
        { left: 1200, top: 600 },
        { width: 1280, height: 800 }
      )
    ).toEqual({ position: 'fixed', left: 1012, bottom: 208 })
  })

  it('keeps portaled footer popovers beside either trigger surface and inside the viewport', () => {
    const anchor = { left: 14, right: 61, top: 780, bottom: 940 }

    expect(
      resolveSidebarFooterPopoverPortalPosition(
        anchor,
        { width: 1280, height: 980 },
        {
          placement: 'above',
          popoverWidth: 280
        }
      )
    ).toEqual({ position: 'fixed', left: 14, bottom: 208 })

    expect(
      resolveSidebarFooterPopoverPortalPosition(
        anchor,
        { width: 430, height: 980 },
        {
          placement: 'side',
          popoverWidth: 420
        }
      )
    ).toEqual({ position: 'fixed', left: 8, bottom: 40 })
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
    const masthead = html.slice(
      html.indexOf('sidebar-masthead'),
      html.indexOf('sidebar-masthead-stats')
    )

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

describe('Sidebar identity ticker git tones', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/01-sidebar.css'),
    'utf8'
  )
  const block = (selector: string): string => {
    const start = css.indexOf(selector)
    if (start < 0) return ''
    const open = css.indexOf('{', start)
    return css.slice(start, css.indexOf('}', open) + 1)
  }

  it('paints the commits-ahead count in the composer workspace row gold', () => {
    const ahead = block('.sidebar-git-indicator.tone-idle {')
    expect(ahead).toContain('#ffc248')
    expect(ahead).not.toContain('var(--sidebar-text-secondary)')
    // Same deepened value the composer switches to on light chrome.
    expect(css.replace(/\s+/g, ' ')).toContain(
      "[data-theme='alabaster']) .sidebar-git-indicator.tone-idle { color: #c38b00;"
    )
  })

  it('tints only the branch half of the identity, never the repo name', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar([makeChat({ appChatId: 'sel', title: 'Selected thread' })], {
      activeChatId: 'sel',
      activeChatIdentityTicker: 'TaskWraith/master',
      activeChatIdentityBranch: 'master'
    })
    // main/master -> blue, matching the composer's git-tone-main.
    expect(html).toContain('sidebar-title-ticker-branch git-tone-main')
    // The repo name sits OUTSIDE the tinted span.
    expect(html).toContain('TaskWraith/<span')
  })

  it('reads the branch kind the way the composer does', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    // A branch may itself contain "/" — the split must come from the supplied
    // branch, not from cutting the joined string at the first slash.
    const html = renderSidebar([makeChat({ appChatId: 'sel', title: 'Selected thread' })], {
      activeChatId: 'sel',
      activeChatIdentityTicker: 'TaskWraith/feat/ticker-tones',
      activeChatIdentityBranch: 'feat/ticker-tones'
    })
    expect(html).toContain('git-tone-feature')
    expect(html).toContain('feat/ticker-tones</span>')
    expect(html).toContain('TaskWraith/<span')
  })

  it('leaves the face plain when the halves disagree, rather than mis-slicing', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar([makeChat({ appChatId: 'sel', title: 'Selected thread' })], {
      activeChatId: 'sel',
      activeChatIdentityTicker: 'TaskWraith/master',
      activeChatIdentityBranch: 'something-else'
    })
    expect(html).not.toContain('sidebar-title-ticker-branch')
    expect(html).toContain('TaskWraith/master')
  })

  it('uses the exact composer hues, so the two surfaces cannot drift', () => {
    const composer = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/css/07-composer-shells.css'),
      'utf8'
    )
    const composerAhead = composer.slice(
      composer.indexOf('.git-status-ahead {'),
      composer.indexOf('}', composer.indexOf('.git-status-ahead {')) + 1
    )
    expect(composerAhead).toContain('#ffc248')
    expect(composer).toContain('#c38b00')
    // Branch palette too: every tone the sidebar paints must exist in the
    // composer with the same value, or the same branch reads as two colours.
    for (const [tone, dark, light] of [
      ['main', '#4b84ff', '#1a5ceb'],
      ['feature', '#a78bfa', '#6d4fe0'],
      ['fix', '#f0a35a', '#c0660f'],
      ['release', '#6ddfa8', null]
    ] as const) {
      expect(block(`.sidebar-title-ticker-branch.git-tone-${tone} {`)).toContain(dark)
      expect(composer).toContain(dark)
      if (light) {
        expect(css).toContain(light)
        expect(composer).toContain(light)
      }
    }
  })
})

describe('Sidebar workspace running indicator', () => {
  it('pulses the thread ghost on a workspace whose thread is running', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const workspace = makeWorkspace({ id: 'ws-busy', displayName: 'Busy Repo' })
    const html = renderSidebar(
      [makeChat({ appChatId: 'busy-thread', title: 'Busy thread', workspaceId: 'ws-busy' })],
      { workspaces: [workspace], runningChatIds: ['busy-thread'] }
    )

    const rowStart = html.indexOf('sidebar-workspace-item')
    const rowEnd = html.indexOf('sidebar-workspace-group', rowStart + 1)
    const row = html.slice(rowStart, rowEnd > 0 ? rowEnd : undefined)
    // Same mark the thread rows use, not a second "busy" vocabulary.
    expect(row).toContain('sidebar-chat-running')
    // The ghost is aria-hidden, and this row's accessible name is its text
    // content, so the state needs a text node of its own.
    expect(row).toContain('Task running in this workspace')
    // The dot it replaced is gone from the markup AND the stylesheets.
    expect(html).not.toContain('sidebar-workspace-running-dot')
  })

  it('leaves a workspace with no running thread unmarked', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const html = renderSidebar(
      [makeChat({ appChatId: 'idle-thread', title: 'Idle thread', workspaceId: 'ws-idle' })],
      { workspaces: [makeWorkspace({ id: 'ws-idle', displayName: 'Idle Repo' })] }
    )
    expect(html).not.toContain('Task running in this workspace')
  })

  it('retired the dot from every stylesheet that styled it', () => {
    for (const file of [
      'src/renderer/src/assets/css/05-polish-fx-layouts.css',
      'src/renderer/src/assets/css/06-component-panels-modals.css'
    ]) {
      const css = readFileSync(join(process.cwd(), file), 'utf8')
      expect(css).not.toContain('sidebar-workspace-running-dot')
    }
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

  it('restores the Active Runs disclosure from the shared section state', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })

    const html = renderSidebar([])

    expect(html).toContain('title="Expand Active Runs"')
    expect(html).not.toContain('sidebar-active-runs-empty')
  })

  it('preserves a legacy all-expanded preference during the disclosure-state migration', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: '[]',
      [COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY]: 'recents-open-v1'
    })

    const html = renderSidebar([])

    expect(html).toContain('title="Collapse Active Runs"')
    expect(html).toContain('title="Collapse Workspaces"')
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

  it('restores an explicitly collapsed workspace tree across sidebar remounts', () => {
    const activeWorkspace = makeWorkspace({
      id: 'ws-2',
      path: '/repo-two',
      displayName: 'Repo Two',
      lastOpenedAt: 20
    })
    const activeChat = makeChat({
      appChatId: 'active-workspace-chat',
      title: 'Active workspace chat',
      workspaceId: 'ws-2',
      workspacePath: '/repo-two',
      updatedAt: 5
    })
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces'),
      [EXPANDED_WORKSPACE_IDS_STORAGE_KEY]: '[]'
    })

    const collapsedHtml = renderSidebar([activeChat], {
      workspaces: [activeWorkspace],
      currentWorkspace: activeWorkspace
    })

    expect(collapsedHtml).toContain('aria-label="Expand chats"')
    expect(collapsedHtml).not.toContain('Active workspace chat')

    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces'),
      [EXPANDED_WORKSPACE_IDS_STORAGE_KEY]: JSON.stringify(['ws-2'])
    })
    const expandedHtml = renderSidebar([activeChat], {
      workspaces: [activeWorkspace],
      currentWorkspace: activeWorkspace
    })

    expect(expandedHtml).toContain('aria-label="Collapse chats"')
    expect(expandedHtml).toContain('Active workspace chat')
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
    rowTone: null,
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
      { rowTone: 'success' as const },
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
      rowTone: null,
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
      { rowTone: 'failure' as const },
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

  it('keeps memoized chat rows wired to the latest navigation closure', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/Sidebar.tsx'),
      'utf8'
    )
    const selection = source.slice(
      source.indexOf('const latestOnSelectChatRef ='),
      source.indexOf('const selectedTerminalOutcome =')
    )
    expect(selection).toContain('useLayoutEffect(() => {')
    expect(selection).toContain('latestOnSelectChatRef.current = onSelectChat')
    expect(selection).toContain('latestOnSelectChatRef.current(chat)')
    expect(selection).not.toContain('onSelectChat(chat)')
    expect(selection).toContain('[acknowledgeChatTerminalOutcome]')
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

describe('Sidebar Channels section', () => {
  it('titles the section Channels with no dedicated creation launcher', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('shared')
    })

    const html = renderSidebar([])

    expect(html).toContain('sidebar-shared-section')
    expect(html).toContain('>Channels</h4>')
    expect(html).not.toContain('Choose People chat type')
    expect(html).not.toContain('People Chat (General)')
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
    expect(html).toContain('Channel members have access')
    expect(html).toContain('aria-label="Channel actions"')
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
    expect(html).toContain('No channels yet')
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
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces', 'ensembles')
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

  it('orders ensembles by stable recency instead of thrashing updatedAt', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('ensembles')
    })

    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'active-old',
          chatKind: 'ensemble',
          title: 'Older active ensemble',
          provider: 'codex',
          createdAt: 100,
          updatedAt: 500
        }),
        makeChat({
          appChatId: 'recent-new',
          chatKind: 'ensemble',
          title: 'Newer ensemble',
          provider: 'claude',
          createdAt: 200,
          updatedAt: 100
        })
      ],
      { ensembleModeEnabled: true }
    )

    const ensemblesSection = html.slice(
      html.indexOf('sidebar-ensembles-section'),
      html.indexOf('sidebar-workspace-list')
    )

    // If order followed updatedAt, the thrashing "older" ensemble would be
    // first. Stable recency puts the newer-created ensemble on top.
    expect(ensemblesSection.indexOf('Newer ensemble')).toBeLessThan(
      ensemblesSection.indexOf('Older active ensemble')
    )
  })

  it('keeps ensemble order stable when updatedAt races on active runs', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('ensembles')
    })

    const olderActive = makeChat({
      appChatId: 'older-active',
      chatKind: 'ensemble',
      title: 'Older active ensemble',
      provider: 'codex',
      createdAt: 100,
      updatedAt: 500,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'prompt one',
          timestamp: '2026-08-10T10:00:00.000Z'
        }
      ]
    })
    const newerQuiet = makeChat({
      appChatId: 'newer-quiet',
      chatKind: 'ensemble',
      title: 'Newer quiet ensemble',
      provider: 'claude',
      createdAt: 300,
      updatedAt: 100,
      messages: [
        {
          id: 'm2',
          role: 'user',
          content: 'prompt two',
          timestamp: '2026-08-10T12:00:00.000Z'
        }
      ]
    })

    // Pass the chats in updatedAt-descending order (mimicking AppStore/getChats
    // and mergeChatRecord), then flip updatedAt on a second render to simulate
    // the quieter ensemble getting a write stamp while the active one streams.
    const htmlFirst = renderSidebar([olderActive, newerQuiet], {
      ensembleModeEnabled: true
    })
    const htmlSecond = renderSidebar(
      [
        { ...olderActive, updatedAt: 500 },
        { ...newerQuiet, updatedAt: 700 }
      ],
      { ensembleModeEnabled: true }
    )

    const sectionFirst = htmlFirst.slice(
      htmlFirst.indexOf('sidebar-ensembles-section'),
      htmlFirst.indexOf('sidebar-workspace-list')
    )
    const sectionSecond = htmlSecond.slice(
      htmlSecond.indexOf('sidebar-ensembles-section'),
      htmlSecond.indexOf('sidebar-workspace-list')
    )

    // The newer-quiet ensemble has the later user message, so it should stay
    // first even after its updatedAt jumps past the older active ensemble.
    expect(sectionFirst.indexOf('Newer quiet ensemble')).toBeLessThan(
      sectionFirst.indexOf('Older active ensemble')
    )
    expect(sectionSecond.indexOf('Newer quiet ensemble')).toBeLessThan(
      sectionSecond.indexOf('Older active ensemble')
    )
  })

  it('does not thrash ensemble order across many updatedAt stamps', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('ensembles')
    })

    const baseChats: ChatRecord[] = [
      makeChat({
        appChatId: 'ensemble-a',
        chatKind: 'ensemble',
        title: 'Ensemble A',
        provider: 'codex',
        createdAt: 100,
        updatedAt: 100,
        messages: [
          {
            id: 'm-a',
            role: 'user',
            content: 'a',
            timestamp: '2026-08-10T09:00:00.000Z'
          }
        ]
      }),
      makeChat({
        appChatId: 'ensemble-b',
        chatKind: 'ensemble',
        title: 'Ensemble B',
        provider: 'claude',
        createdAt: 200,
        updatedAt: 200,
        messages: [
          {
            id: 'm-b',
            role: 'user',
            content: 'b',
            timestamp: '2026-08-10T10:00:00.000Z'
          }
        ]
      }),
      makeChat({
        appChatId: 'ensemble-c',
        chatKind: 'ensemble',
        title: 'Ensemble C',
        provider: 'gemini',
        createdAt: 300,
        updatedAt: 300,
        messages: [
          {
            id: 'm-c',
            role: 'user',
            content: 'c',
            timestamp: '2026-08-10T08:00:00.000Z'
          }
        ]
      })
    ]

    let order: string | null = null
    for (let i = 0; i < 20; i++) {
      const chats = baseChats.map((chat) => ({
        ...chat,
        updatedAt: Math.floor(Math.random() * 10000)
      }))
      const html = renderSidebar(chats, { ensembleModeEnabled: true })
      const section = html.slice(
        html.indexOf('sidebar-ensembles-section'),
        html.indexOf('sidebar-workspace-list')
      )
      const currentOrder = ['Ensemble A', 'Ensemble B', 'Ensemble C']
        .map((title) => section.indexOf(title))
        .join(',')
      if (order === null) {
        order = currentOrder
      } else {
        expect(currentOrder).toBe(order)
      }
    }
  })

  it('keeps pinned ensembles stable in the Pinned section when updatedAt races', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('pinned')
    })

    const olderActive = makeChat({
      appChatId: 'pinned-older-active',
      chatKind: 'ensemble',
      title: 'Pinned older active ensemble',
      provider: 'codex',
      pinned: true,
      createdAt: 100,
      updatedAt: 500,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'prompt one',
          timestamp: '2026-08-10T10:00:00.000Z'
        }
      ]
    })
    const newerQuiet = makeChat({
      appChatId: 'pinned-newer-quiet',
      chatKind: 'ensemble',
      title: 'Pinned newer quiet ensemble',
      provider: 'claude',
      pinned: true,
      createdAt: 300,
      updatedAt: 100,
      messages: [
        {
          id: 'm2',
          role: 'user',
          content: 'prompt two',
          timestamp: '2026-08-10T12:00:00.000Z'
        }
      ]
    })

    const html = renderSidebar([olderActive, newerQuiet], {
      ensembleModeEnabled: true
    })

    const pinnedSection = html.slice(
      html.indexOf('sidebar-pinned-section'),
      html.indexOf('sidebar-recents-section')
    )

    expect(pinnedSection.indexOf('Pinned newer quiet ensemble')).toBeLessThan(
      pinnedSection.indexOf('Pinned older active ensemble')
    )
  })

  it('keeps workspace ensembles stable in their workspace group when updatedAt races', () => {
    stubSidebarStorage({
      [SIDEBAR_ACTIVE_TAB_STORAGE_KEY]: 'threads',
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const olderActive = makeChat({
      appChatId: 'ws-older-active',
      chatKind: 'ensemble',
      title: 'Workspace older active ensemble',
      provider: 'codex',
      createdAt: 100,
      updatedAt: 500,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'prompt one',
          timestamp: '2026-08-10T10:00:00.000Z'
        }
      ]
    })
    const newerQuiet = makeChat({
      appChatId: 'ws-newer-quiet',
      chatKind: 'ensemble',
      title: 'Workspace newer quiet ensemble',
      provider: 'claude',
      createdAt: 300,
      updatedAt: 100,
      messages: [
        {
          id: 'm2',
          role: 'user',
          content: 'prompt two',
          timestamp: '2026-08-10T12:00:00.000Z'
        }
      ]
    })

    const html = renderSidebar([olderActive, newerQuiet], {
      ensembleModeEnabled: true
    })

    const workspacesSection = html.slice(html.indexOf('sidebar-workspace-list'))

    expect(workspacesSection.indexOf('Workspace newer quiet ensemble')).toBeLessThan(
      workspacesSection.indexOf('Workspace older active ensemble')
    )
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

describe('Sidebar unread terminal outcome accent', () => {
  const startedAt = '2026-08-03T20:00:00.000Z'
  const endedAt = '2026-08-03T20:05:00.000Z'
  const finishedRun = (
    runId: string,
    status: 'success' | 'failed' = 'success',
    exitCode = status === 'success' ? 0 : 1
  ) => ({ runId, startedAt, endedAt, status, exitCode })

  it('renders configured success/failure title hooks while leaving non-terminal titles ordinary', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'success-thread',
          title: 'Succeeded thread',
          updatedAt: 4,
          runs: [finishedRun('success-run')]
        }),
        makeChat({
          appChatId: 'failed-thread',
          title: 'Failed thread',
          updatedAt: 3,
          runs: [finishedRun('failed-run', 'failed')]
        }),
        makeChat({
          appChatId: 'non-terminal-thread',
          title: 'Still ordinary',
          updatedAt: 2,
          runs: [{ runId: 'active-run', startedAt, status: 'running' }]
        }),
        makeChat({ appChatId: 'viewer', title: 'Viewer', updatedAt: 1 })
      ],
      { activeChatId: 'viewer' }
    )

    expect(html).toContain('sidebar-terminal-outcome-success')
    expect(html).toContain('sidebar-terminal-outcome-failure')
    expect(html).toContain('Succeeded thread, completed successfully, unread')
    expect(html).toContain('Failed thread, blocked or failed, unread')
    const ordinaryTitle = html.indexOf('Still ordinary')
    const ordinaryRow = html.lastIndexOf('<div role="button"', ordinaryTitle)
    expect(html.slice(ordinaryRow, ordinaryTitle)).not.toContain('sidebar-terminal-outcome-')
  })

  it('shows completed-goal green when its actual terminal run failed', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const completedGoalChat = makeChat({
      appChatId: 'goal-thread',
      title: 'Goal won',
      updatedAt: 2,
      activeGoal: {
        id: 'goal-1',
        objective: 'Ship it',
        objectiveSource: 'user',
        status: 'completed',
        mode: 'codex_native',
        provider: 'codex',
        createdAt: startedAt,
        updatedAt: endedAt,
        completedAt: endedAt
      },
      runs: [{ ...finishedRun('mixed-run', 'failed'), activeGoalId: 'goal-1' }]
    })
    const html = renderSidebar(
      [completedGoalChat, makeChat({ appChatId: 'viewer', updatedAt: 1 })],
      { activeChatId: 'viewer' }
    )
    const titleIndex = html.indexOf('Goal won')
    const rowIndex = html.lastIndexOf('<div role="button"', titleIndex)
    const rowPrefix = html.slice(rowIndex, titleIndex)

    expect(rowPrefix).toContain('sidebar-terminal-outcome-success')
    expect(rowPrefix).not.toContain('sidebar-terminal-outcome-failure')
    expect(completedGoalChat.runs[0].status).toBe('failed')
  })

  it('suppresses the accent for selected, running, or already-acknowledged fingerprints', () => {
    const completed = makeChat({
      appChatId: 'done-thread',
      title: 'Already seen',
      updatedAt: 2,
      runs: [finishedRun('done-run')]
    })
    const viewer = makeChat({ appChatId: 'viewer', updatedAt: 1 })

    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(renderSidebar([completed, viewer], { activeChatId: 'done-thread' })).not.toContain(
      'sidebar-terminal-outcome-success'
    )

    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(
      renderSidebar([completed, viewer], {
        activeChatId: 'viewer',
        runningChatIds: ['done-thread']
      })
    ).not.toContain('sidebar-terminal-outcome-success')

    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(
      renderSidebar([completed, viewer], {
        activeChatId: 'viewer',
        pendingAgentQuestionsByChatId: {
          'done-thread': [
            {
              questionId: 'question-1',
              appRunId: 'done-run',
              messageId: 'question-message-1',
              provider: 'codex',
              question: 'Which option?',
              options: ['A', 'B'],
              askedAt: 1
            }
          ]
        }
      })
    ).not.toContain('sidebar-terminal-outcome-success')

    const outcome = projectSidebarTerminalOutcome(completed)!
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents'),
      [SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY]: JSON.stringify({
        'done-thread': outcome.fingerprint
      })
    })
    expect(renderSidebar([completed, viewer], { activeChatId: 'viewer' })).not.toContain(
      'sidebar-terminal-outcome-success'
    )
  })
})

describe('Sidebar success-ink epoch (first launch after upgrading)', () => {
  const settledRun = (endedAt: string) => ({
    runId: 'run-1',
    startedAt: '2026-08-03T20:00:00.000Z',
    endedAt,
    status: 'success' as const,
    exitCode: 0
  })
  const failedRun = (endedAt: string) => ({
    runId: 'run-2',
    startedAt: '2026-08-03T20:00:00.000Z',
    endedAt,
    status: 'failed' as const,
    exitCode: 1
  })
  const EPOCH = Date.parse('2026-08-05T00:00:00.000Z')
  const BEFORE = '2026-08-04T12:00:00.000Z'
  const AFTER = '2026-08-05T12:00:00.000Z'

  it('withholds green from work that had already finished before the upgrade', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents'),
      [SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY]: String(EPOCH)
    })
    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'old-success',
          title: 'Old success',
          updatedAt: 3,
          runs: [settledRun(BEFORE)]
        }),
        makeChat({ appChatId: 'viewer', updatedAt: 1 })
      ],
      { activeChatId: 'viewer' }
    )
    // Upgrading must not light a year of finished work green at once.
    expect(html).not.toContain('sidebar-terminal-outcome-success')
    expect(html).toContain('Old success')
  })

  it('still flags an old FAILURE — unfinished business the user may never have seen', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents'),
      [SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY]: String(EPOCH)
    })
    expect(
      renderSidebar(
        [
          makeChat({
            appChatId: 'old-failure',
            title: 'Old failure',
            updatedAt: 3,
            runs: [failedRun(BEFORE)]
          }),
          makeChat({ appChatId: 'viewer', updatedAt: 1 })
        ],
        { activeChatId: 'viewer' }
      )
    ).toContain('sidebar-terminal-outcome-failure')
  })

  it('greens a result that settled after the upgrade, on any thread', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents'),
      [SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY]: String(EPOCH)
    })
    // Per-RESULT, not per-thread: this thread is ancient, its newest run is
    // not, so it reads like any other fresh success.
    expect(
      renderSidebar(
        [
          makeChat({
            appChatId: 'revived',
            title: 'Revived thread',
            createdAt: 1,
            updatedAt: 2,
            runs: [settledRun(AFTER)]
          }),
          makeChat({ appChatId: 'viewer', updatedAt: 1 })
        ],
        { activeChatId: 'viewer' }
      )
    ).toContain('sidebar-terminal-outcome-success')
  })

  it('seeds the epoch on first read and never moves it again', () => {
    const setItem = vi.fn()
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        setItem(key, value)
        store.set(key, value)
      }
    }
    expect(loadOrSeedSidebarSuccessInkEpoch(1_000, storage)).toBe(1_000)
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_SUCCESS_INK_EPOCH_STORAGE_KEY, '1000')
    // A later launch reads the seed back rather than re-stamping "now",
    // otherwise every launch would re-hide the previous session's results.
    expect(loadOrSeedSidebarSuccessInkEpoch(9_999, storage)).toBe(1_000)
    expect(setItem).toHaveBeenCalledTimes(1)
  })
})

describe('Sidebar run-status chips are retired', () => {
  const runs = {
    failed: {
      runId: 'boom',
      startedAt: '2026-08-05T10:00:00.000Z',
      endedAt: '2026-08-05T10:05:00.000Z',
      status: 'failed' as const,
      exitCode: 1
    },
    sleeping: { runId: 'nap', startedAt: '2026-08-05T10:00:00.000Z', status: 'sleeping' }
  }

  it('shows no status chip for a failed, running or sleeping thread', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'a',
          title: 'Failed thread',
          workspaceId: 'ws-1',
          runs: [runs.failed]
        }),
        makeChat({ appChatId: 'b', title: 'Busy thread', workspaceId: 'ws-1' }),
        makeChat({
          appChatId: 'c',
          title: 'Napping thread',
          workspaceId: 'ws-1',
          runs: [runs.sleeping]
        })
      ],
      {
        workspaces: [makeWorkspace({ id: 'ws-1' })],
        currentWorkspace: makeWorkspace({ id: 'ws-1' }),
        runningChatIds: ['b']
      }
    )

    // The ink and the ghost carry all of this now.
    expect(html).not.toContain('sidebar-run-status tone-danger')
    expect(html).not.toContain('sidebar-run-status tone-running')
    expect(html).not.toContain('sidebar-compact-needs-input')
    expect(html).not.toContain('>Failed<')
    expect(html).not.toContain('>Running<')
    expect(html).not.toContain('Needs input')
  })

  it('keeps the identity chips — those were never run state', () => {
    // Source-region: the muted chips live on sub-thread / ensemble / search
    // rows whose render paths need a lot of scaffolding to reach, and the
    // claim under test is "the removal did not over-reach" — that the muted
    // idiom (WHAT a row is) survived while the run-state idiom (how its run
    // went) did not.
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/Sidebar.tsx'),
      'utf8'
    )
    expect(source).toContain('sidebar-run-status tone-muted')
    expect(source).not.toContain('tone-running')
    expect(source).not.toContain('sidebar-compact-needs-input')
    expect(source).not.toContain('Needs input')
    // The status vocabulary itself stays — it still feeds the aria labels.
    expect(source).toContain('sidebarChatRunStatusText')
  })

  it('still announces run state to screen readers — the ink is visual-only', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'a',
          title: 'Failed thread',
          workspaceId: 'ws-1',
          runs: [runs.failed]
        })
      ],
      {
        workspaces: [makeWorkspace({ id: 'ws-1' })],
        currentWorkspace: makeWorkspace({ id: 'ws-1' })
      }
    )
    expect(html).toContain('Failed')
    expect(html).toMatch(/aria-label="[^"]*Failed/)
  })
})

describe('Sidebar failure ink persistence', () => {
  const failedRun = {
    runId: 'boom',
    startedAt: '2026-08-05T10:00:00.000Z',
    endedAt: '2026-08-05T10:05:00.000Z',
    status: 'failed' as const,
    exitCode: 1
  }
  const broken = () =>
    makeChat({ appChatId: 'broken', title: 'Broken thread', updatedAt: 2, runs: [failedRun] })

  it('keeps red after the outcome has been acknowledged — reading it does not fix it', () => {
    const outcome = projectSidebarTerminalOutcome(broken())!
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents'),
      [SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY]: JSON.stringify({ broken: outcome.fingerprint })
    })
    expect(
      renderSidebar([broken(), makeChat({ appChatId: 'viewer', updatedAt: 1 })], {
        activeChatId: 'viewer'
      })
    ).toContain('sidebar-terminal-outcome-failure')
  })

  it('still retires GREEN on acknowledgement — success is news, failure is a condition', () => {
    const ok = makeChat({
      appChatId: 'fine',
      title: 'Fine thread',
      updatedAt: 2,
      runs: [{ ...failedRun, runId: 'ok', status: 'success' as const, exitCode: 0 }]
    })
    const outcome = projectSidebarTerminalOutcome(ok)!
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents'),
      [SIDEBAR_TERMINAL_OUTCOME_ACK_STORAGE_KEY]: JSON.stringify({ fine: outcome.fingerprint })
    })
    expect(
      renderSidebar([ok, makeChat({ appChatId: 'viewer', updatedAt: 1 })], {
        activeChatId: 'viewer'
      })
    ).not.toContain('sidebar-terminal-outcome-success')
  })

  it('is superseded by a later successful run rather than lingering', () => {
    const recovered = makeChat({
      appChatId: 'broken',
      title: 'Recovered thread',
      updatedAt: 3,
      runs: [
        failedRun,
        {
          runId: 'fixed',
          startedAt: '2026-08-05T11:00:00.000Z',
          endedAt: '2026-08-05T11:05:00.000Z',
          status: 'success' as const,
          exitCode: 0
        }
      ]
    })
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar([recovered, makeChat({ appChatId: 'viewer', updatedAt: 1 })], {
      activeChatId: 'viewer'
    })
    expect(html).toContain('sidebar-terminal-outcome-success')
    expect(html).not.toContain('sidebar-terminal-outcome-failure')
  })
})

describe('Sidebar sleeping accent', () => {
  const sleepingRun = { runId: 'nap', startedAt: '2026-08-05T10:00:00.000Z', status: 'sleeping' }

  it('inks a thread whose run is asleep, without needing acknowledgement', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'napping',
          title: 'Napping thread',
          updatedAt: 2,
          runs: [sleepingRun]
        }),
        makeChat({ appChatId: 'viewer', updatedAt: 1 })
      ],
      { activeChatId: 'viewer' }
    )
    expect(html).toContain('sidebar-attention-sleeping')
    // Not an outcome — a sleeping run has not settled anything.
    expect(html).not.toContain('sidebar-terminal-outcome-success')
    expect(html).not.toContain('sidebar-terminal-outcome-failure')
  })

  it('yields to waiting — a person outranks a clock', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar(
      [
        makeChat({
          appChatId: 'napping',
          title: 'Napping thread',
          updatedAt: 2,
          runs: [sleepingRun]
        }),
        makeChat({ appChatId: 'viewer', updatedAt: 1 })
      ],
      {
        activeChatId: 'viewer',
        pendingAgentQuestionsByChatId: {
          napping: [
            {
              questionId: 'q1',
              appRunId: 'nap',
              messageId: 'm1',
              provider: 'codex',
              question: 'Which?',
              options: ['A'],
              askedAt: 1
            }
          ]
        }
      }
    )
    expect(html).toContain('sidebar-attention-waiting')
    expect(html).not.toContain('sidebar-attention-sleeping')
  })
})

describe('Sidebar waiting-on-you accent', () => {
  const question = (questionId: string) => ({
    questionId,
    appRunId: 'run-1',
    messageId: `message-${questionId}`,
    provider: 'codex' as const,
    question: 'Which option?',
    options: ['A', 'B'],
    askedAt: 1
  })
  const approval = makeApproval()

  it('paints an amber accent on a thread parked on an unanswered question', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar(
      [
        makeChat({ appChatId: 'asking-thread', title: 'Asking thread', updatedAt: 2 }),
        makeChat({ appChatId: 'viewer', title: 'Viewer', updatedAt: 1 })
      ],
      {
        activeChatId: 'viewer',
        pendingAgentQuestionsByChatId: { 'asking-thread': [question('q-1')] }
      }
    )

    expect(html).toContain('sidebar-attention-waiting')
    expect(html).toContain('Asking thread')
  })

  it('paints the same accent for a thread blocked on an approval', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const queued = renderSidebar(
      [
        makeChat({ appChatId: 'gated-thread', title: 'Gated thread', updatedAt: 2 }),
        makeChat({ appChatId: 'viewer', updatedAt: 1 })
      ],
      {
        activeChatId: 'viewer',
        pendingAgentApprovalByChatId: { 'gated-thread': approval }
      }
    )
    expect(queued).toContain('sidebar-attention-waiting')

    // Approvals stacked behind the head count too — the thread is still parked.
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(
      renderSidebar(
        [
          makeChat({ appChatId: 'gated-thread', title: 'Gated thread', updatedAt: 2 }),
          makeChat({ appChatId: 'viewer', updatedAt: 1 })
        ],
        {
          activeChatId: 'viewer',
          pendingApprovalQueueByChatId: { 'gated-thread': [approval] }
        }
      )
    ).toContain('sidebar-attention-waiting')
  })

  it('survives the running gate that suppresses settled outcome ink', () => {
    // The run is BLOCKED on the user, not finished — the gate that hides
    // outcome accents on working threads must not hide this one.
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(
      renderSidebar(
        [
          makeChat({ appChatId: 'busy-thread', title: 'Busy thread', updatedAt: 2 }),
          makeChat({ appChatId: 'viewer', updatedAt: 1 })
        ],
        {
          activeChatId: 'viewer',
          runningChatIds: ['busy-thread'],
          pendingAgentQuestionsByChatId: { 'busy-thread': [question('q-1')] }
        }
      )
    ).toContain('sidebar-attention-waiting')
  })

  it('stays off the selected thread, whose modal is already on screen', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(
      renderSidebar(
        [makeChat({ appChatId: 'asking-thread', title: 'Asking thread', updatedAt: 2 })],
        {
          activeChatId: 'asking-thread',
          pendingAgentQuestionsByChatId: { 'asking-thread': [question('q-1')] }
        }
      )
    ).not.toContain('sidebar-attention-waiting')
  })

  it('clears itself once nothing is pending — no acknowledgement needed', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    expect(
      renderSidebar(
        [
          makeChat({ appChatId: 'asking-thread', title: 'Asking thread', updatedAt: 2 }),
          makeChat({ appChatId: 'viewer', updatedAt: 1 })
        ],
        { activeChatId: 'viewer', pendingAgentQuestionsByChatId: { 'asking-thread': [] } }
      )
    ).not.toContain('sidebar-attention-waiting')
  })

  it('outranks an unread settled outcome on the same thread', () => {
    const settledButAsking = makeChat({
      appChatId: 'both-thread',
      title: 'Both thread',
      updatedAt: 2,
      runs: [
        {
          runId: 'done-run',
          startedAt: '2026-08-03T20:00:00.000Z',
          endedAt: '2026-08-03T20:05:00.000Z',
          status: 'success',
          exitCode: 0
        }
      ]
    })
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })
    const html = renderSidebar(
      [settledButAsking, makeChat({ appChatId: 'viewer', updatedAt: 1 })],
      {
        activeChatId: 'viewer',
        pendingAgentQuestionsByChatId: { 'both-thread': [question('q-1')] }
      }
    )

    expect(html).toContain('sidebar-attention-waiting')
    expect(html).not.toContain('sidebar-terminal-outcome-success')
  })
})

describe('Sidebar footer controls', () => {
  it('renders the Approvals control without the retired People button', () => {
    const html = renderSidebar([makeChat()])
    expect(html).toContain('aria-label="Approvals"')
    expect(html).not.toContain('aria-label="People"')
  })

  it('glows the Approvals button yellow only while an approval is pending', () => {
    // glow-yellow is unique to the Approvals button, so presence/absence of the
    // class unambiguously reflects the pending-approval signal.
    const idle = renderSidebar([makeChat()])
    expect(idle).not.toContain('glow-yellow')

    const pending = renderSidebar([makeChat()], {
      pendingAgentApprovalByChatId: { 'parent-1': makeApproval() }
    })
    expect(pending).toContain('glow-yellow')
    expect(pending).not.toContain('glow-red')
  })

  it('glows the Approvals button yellow while an agent question is pending', () => {
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
    expect(pending).toContain('glow-yellow')
    expect(pending).not.toContain('glow-red')
    // This test's subject is the Approvals BUTTON. It used to also assert the
    // row's "Needs input" chip; that chip is retired, and the row-ink path a
    // pending question now takes has its own coverage in "Sidebar
    // waiting-on-you accent".
  })

  it('ignores cleared (null) approval entries for the yellow glow', () => {
    // usePerChatState deletes keys on reset, but guard against a lingering null
    // still suppressing the glow.
    const html = renderSidebar([makeChat()], {
      pendingAgentApprovalByChatId: { 'parent-1': null }
    })
    expect(html).not.toContain('glow-yellow')
  })

  it('keeps the collapsed-sidebar Approvals control on the same yellow attention state', () => {
    const renderCollapsed = (
      attention: Pick<
        ComponentProps<typeof CollapsedSidebarCornerPill>,
        'pendingAgentApprovalByChatId' | 'pendingAgentQuestionsByChatId'
      >
    ) =>
      renderToStaticMarkup(
        <CollapsedSidebarCornerPill
          chats={[makeChat()]}
          onSelectChat={() => {}}
          onOpenSettings={() => {}}
          onOpenSettingsTab={() => {}}
          {...attention}
        />
      )

    const approval = renderCollapsed({
      pendingAgentApprovalByChatId: { 'parent-1': makeApproval() }
    })
    const question = renderCollapsed({
      pendingAgentQuestionsByChatId: {
        'parent-1': [
          {
            questionId: 'q-collapsed',
            appRunId: 'run-1',
            messageId: 'agent-question-q-collapsed',
            provider: 'codex',
            question: 'Which option?',
            options: ['A', 'B'],
            askedAt: 1
          }
        ]
      }
    })

    expect(approval).toContain('glow-yellow')
    expect(question).toContain('glow-yellow')
    expect(approval).not.toContain('glow-red')
    expect(question).not.toContain('glow-red')
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
    expect(html).toContain('Chris&#x27;s iPhone')
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
          {
            chatId: 'parent-1',
            approval: makeApproval({ title: 'Write a file', provider: 'codex' })
          }
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
        pendingApprovals={[
          { chatId: 'parent-1', approval: makeApproval({ appChatId: undefined }) }
        ]}
        onJumpToChat={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('sidebar-footer-approval-row is-clickable')
  })

  it('keeps broader approval scopes in the task where their exact review is visible', () => {
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
    expect(html).not.toContain('Always Allow')
    expect(html).toContain('Open the task to review broader approval options.')
    expect(html).toContain('This grant ends when the run ends.')
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

  // Git status icons ride the right of the identity face — see
  // lib/sidebarGitIndicators.ts for the model.
  it('renders the git status strip on the identity face of the ACTIVE row', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })

    const html = renderSidebar(
      [
        makeChat({ appChatId: 'active-thread', title: 'Active thread' }),
        makeChat({ appChatId: 'idle-thread', title: 'Idle thread' })
      ],
      {
        activeChatId: 'active-thread',
        activeChatIdentityTicker: 'TaskWraith/tw-tui',
        activeChatIdentityGitIndicators: 'pushed:|pr-open:14|pr-merged:10:own'
      }
    )

    expect(html).toContain('sidebar-git-indicators')
    expect(html).toContain('sidebar-git-indicator kind-pushed tone-synced')
    expect(html).toContain('sidebar-git-indicator kind-pr-open tone-open')
    // Merged is purple, never green — the tone name carries that.
    expect(html).toContain('sidebar-git-indicator kind-pr-merged tone-merged')
    expect(html).toContain('title="this thread&#x27;s PR #10 merged"')
    // Only the active row gets a strip.
    expect(html.split('sidebar-git-indicators').length - 1).toBe(1)
  })

  it('renders no strip when the active chat has no git state (e.g. detached)', () => {
    stubSidebarStorage({
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('recents')
    })

    const html = renderSidebar([makeChat({ appChatId: 'active-thread', title: 'Active thread' })], {
      activeChatId: 'active-thread',
      activeChatIdentityTicker: 'TaskWraith/tw-tui',
      activeChatIdentityGitIndicators: null
    })

    expect(html).toContain('sidebar-title-ticker')
    expect(html).not.toContain('sidebar-git-indicators')
  })
})
