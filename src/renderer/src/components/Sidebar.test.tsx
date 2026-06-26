import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord, WorkflowDefinition, WorkspaceRecord } from '../../../main/store/types'
import { Sidebar } from './Sidebar'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import type { AgentApprovalRequest } from '../lib/agentApprovalTypes'

const EXPANDED_WORKSPACES_STORAGE_KEY = 'taskwraith-sidebar-expanded-workspace-ids'
const COLLAPSED_SUB_THREAD_PARENTS_STORAGE_KEY = 'taskwraith-sidebar-collapsed-sub-thread-parent-ids'
const COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY = 'taskwraith-sidebar-collapsed-sections'

// Mirrors SIDEBAR_SECTION_IDS in Sidebar.tsx. The sidebar defaults every section
// to collapsed for new users (ec5bcad, "all-collapsed-v1"), so tests that assert
// on child rows opt the relevant section(s) open the way a user would by clicking
// the header. Persisting a non-empty collapsed list also bypasses the new-user
// default migration, pinning exactly these sections open.
const SIDEBAR_SECTION_IDS = [
  'workflows',
  'pinned',
  'recents',
  'ensembles',
  'workspaces',
  'chats'
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

function stubSidebarStorage(values: Record<string, string>) {
  const store = new Map(Object.entries(values))
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
    onCreateWorkflow?: () => void
    collaboratingChatIds?: Set<string>
    pendingAgentApprovalByChatId?: Record<string, AgentApprovalRequest | null>
  } = {}
) {
  const workspace = makeWorkspace()
  return renderToStaticMarkup(
    <Sidebar
      workspaces={[workspace]}
      currentWorkspace={workspace}
      chats={chats}
      currentChat={chats[0] ?? null}
      activeChatId={options.activeChatId}
      usageSummary={[]}
      runningChatIds={[]}
      workflows={options.workflows}
      collaboratingChatIds={options.collaboratingChatIds}
      pendingAgentApprovalByChatId={options.pendingAgentApprovalByChatId}
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

describe('Sidebar masthead', () => {
  it('uses the inline monoline TaskWraith mark', () => {
    stubSidebarStorage({})

    const html = renderSidebar([])
    const masthead = html.slice(html.indexOf('sidebar-masthead'))

    expect(masthead).toContain('sidebar-product-ghost-monoline')
    expect(masthead).toContain('ghost-guy-mark-monoline-title')
    expect(masthead).not.toContain('taskwraith-brand-ghost')
  })
})

describe('Sidebar active chat override', () => {
  it('marks activeChatId as selected before currentChat catches up', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
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

describe('Sidebar workflows', () => {
  it('renders an enabled quick-create button beside the Workflows header', () => {
    stubSidebarStorage({})

    const html = renderSidebar([], { onCreateWorkflow: () => {} })

    expect(html).toContain('sidebar-workflows-section')
    expect(html).toContain('sidebar-workflow-create')
    expect(html).toContain('aria-label="New workflow"')
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

describe('Sidebar sub-thread collapse', () => {
  it('renders sub-thread children expanded by default', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })
    const childIdentity = assignAgentIdentityFromSeed('child-1')

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

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('sidebar-chat-children')
    expect(html).toContain(childIdentity.name)
    expect(html).toContain('sidebar-sub-thread-identicon')
    expect(html).toContain('Gemini delegated to Codex')
  })

  it('labels fan-out side-chat children distinctly in the sidebar', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar([
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
    ])

    expect(html).toContain('Parallel side branch')
    expect(html).toContain('Fan-out side chat')
    expect(html).toContain('Parallel fan-out')
    expect(html).toContain('Isolated context')
    expect(html).toContain('Gemini parallel fan-out')
  })

  it('shows participant and context metadata for side-chat children', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const sideChatIdentity = assignAgentIdentityFromSeed('parent-1:reviewer-codex')
    const html = renderSidebar([
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
    ])

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
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar([
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
    ])

    expect(html).toContain('Side Codex chat')
    expect(html).toContain('Isolated sidecar')
    expect(html).toContain('Codex isolated side chat')
    expect(html).not.toContain('Codex side branch to Codex')
    expect(html).not.toContain('sidebar-sub-thread-identicon')
  })

  it('labels run-result seeded side-chat children explicitly', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar([
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
    ])

    expect(html).toContain('Run follow-up')
    expect(html).toContain('Seeded from run result')
  })

  it('labels copied parent snapshots for isolated side-chat children', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY]: collapseSectionsExcept('workspaces')
    })

    const html = renderSidebar([
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
    ])

    expect(html).toContain('Snapshot sidecar')
    expect(html).toContain('Copied parent snapshot')
    expect(html).not.toContain('Seeded from run result')
  })

  it('hides sub-thread children when the parent is persisted as collapsed', () => {
    stubSidebarStorage({
      [EXPANDED_WORKSPACES_STORAGE_KEY]: JSON.stringify(['ws-1']),
      [COLLAPSED_SUB_THREAD_PARENTS_STORAGE_KEY]: JSON.stringify(['parent-1'])
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
    expect((html.match(/provider-glyph-ensemble/g) || []).length).toBe(3)
    expect(html).not.toContain('sidebar-provider-dot-ensemble')
  })

  it('uses provider glyphs instead of colored dots in Pinned and Recents', () => {
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

    expect(pinnedBlock).toContain('provider-glyph-codex')
    expect(recentsBlock).toContain('provider-glyph-ollama')
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

describe('Sidebar footer controls', () => {
  it('renders the Approvals and Shares control buttons', () => {
    const html = renderSidebar([makeChat()])
    expect(html).toContain('aria-label="Approvals"')
    expect(html).toContain('aria-label="Shares"')
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

  it('ignores cleared (null) approval entries for the red glow', () => {
    // usePerChatState deletes keys on reset, but guard against a lingering null
    // still suppressing the glow.
    const html = renderSidebar([makeChat()], {
      pendingAgentApprovalByChatId: { 'parent-1': null }
    })
    expect(html).not.toContain('glow-red')
  })

  it('glows the Shares button yellow only while a chat is shared', () => {
    const idle = renderSidebar([makeChat()])
    expect(idle).not.toContain('glow-yellow')

    const shared = renderSidebar([makeChat()], {
      collaboratingChatIds: new Set(['parent-1'])
    })
    expect(shared).toContain('glow-yellow')
  })
})
