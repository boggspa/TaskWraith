import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { MascotGhost, SidebarRunningGhost, WorkflowGlyphIcon } from './AppChromeSymbols'
import { HostStatusRow } from './HostStatusRow'
import { useHostProjectionStore } from './HostProjectionProvider'
import { useHostProjection } from '../hooks/useHostProjection'
import { joinHostPendingApprovals } from '../hooks/usePendingApprovalsProjection'
import { joinHostPendingQuestions } from '../hooks/usePendingQuestionsProjection'
import taskwraithGhostMonolineSvg from '../assets/taskwraith-ghost-monoline.svg?raw'
import { isUpdatePillVisible, UpdatePill } from './UpdatePill'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'
import type {
  WorkspaceRecord,
  ChatRecord,
  ChatListItem,
  ScheduledTask,
  RunQueueJob,
  WorkflowDefinition,
  WorkspaceBoardDefinition,
  WorkspaceBoardCard,
  ProviderId,
  ComposerStyle,
  ThemeAccentStyle,
  ThemeAppearance,
  ToolIconAccent,
  ApprovalLedgerRecord
} from '../../../main/store/types'
import type { TaskWraithPluginActivatedWorkflowTemplate } from '../../../shared/plugins/PluginTypes'
import { getProviderLabel } from '../lib/providerLabels'
import { selectRecentChats } from '../lib/recentChatsList'
import { isContentlessRemoteDraftChat } from '../../../main/remote/RemoteDraftChats'
import { normalizeThreadTitle } from '../../../shared/threadTitles'
import { IOS_REMOTE_ENABLED } from '../lib/featureFlags'
import { ActiveRunsSection } from './ActiveRunsSection'
import { LocalServersSection } from './LocalServersSection'
import { ProjectsSidebarView } from './ProjectsSidebarView'
import { useLocalServers } from '../hooks/useLocalServers'
import { useSidebarHierarchyDrag } from '../hooks/useSidebarHierarchyDrag'
import {
  loadSidebarHierarchyOrder,
  saveSidebarHierarchyOrder,
  SIDEBAR_HIERARCHY_SECTION_LABELS,
  type SidebarHierarchySectionId
} from '../lib/sidebarSectionOrder'
import { AppShellStatsToolbar } from './AppShellStatsToolbar'
import { ModelUsageCard, type ModelUsageApiSpendOptions } from './ModelUsageCard'
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import { SidebarOverflowMenu, type SidebarOverflowMenuItem } from './SidebarOverflowMenu'
import { WorkflowRunHistory } from './WorkflowRunHistory'
import { ProviderGlyph } from './icons/ProviderGlyph'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'
import {
  chatGitWorkflowLabel,
  type ChatGitWorkflowSnapshot,
  type ChatGitWorkflowState
} from '../../../shared/chatGitWorkflow'
import { chatGitWorkflowMarker, groupChatsByGitWorkflow } from '../lib/gitWorkflowSections'
import { decodeSidebarGitIndicators } from '../lib/sidebarGitIndicators'
import { SidebarGitIndicatorStrip } from './SidebarGitIndicatorStrip'
import { branchTone } from './GitStatusChips'
import { isSubThreadChat } from '../lib/chatScope'
import {
  primarySurfaceForSidebarTabChange,
  type SidebarPrimarySurface
} from '../lib/primarySurfaceToggle'
import {
  findSurvivableUnstartedDraftId,
  isHideableUnstartedDraft
} from '../lib/unstartedDraftFilter'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import type { AgentApprovalAction, AgentApprovalRequest } from '../lib/agentApprovalTypes'
import type { AgentQuestionState } from './AgentQuestionCard'
import { chatHasPendingAgentQuestion } from '../lib/agentQuestionQueue'
import type { HumanCollaborationShare } from '../../../main/collaboration/HumanCollaborationStore'
import type { LocalServerEntry } from '../../../main/localServers/types'
import { isEnsembleActiveRoundDispatchLive } from '../lib/chatBusyState'
import { isCanvasEvalApprovalToolName } from '../lib/agentApprovalPreview'
import {
  acknowledgeSidebarTerminalOutcome,
  chatIsAwaitingUserResponse,
  chatIsSleeping,
  isSidebarTerminalOutcomeUnread,
  loadOrSeedSidebarSuccessInkEpoch,
  loadSidebarTerminalOutcomeAcknowledgements,
  persistSidebarTerminalOutcomeAcknowledgements,
  projectSidebarTerminalOutcome,
  sidebarRowToneClass,
  sidebarSuccessInkPredatesEpoch,
  type SidebarRowTone
} from '../lib/sidebarTerminalOutcome'
import {
  loadSidebarThreadOrderState,
  orderSidebarThreads,
  parseSidebarThreadDragPayload,
  reorderSidebarThreadOrder,
  saveSidebarThreadOrderState,
  serializeSidebarThreadDragPayload,
  SIDEBAR_THREAD_DRAG_MIME,
  type SidebarThreadDragPayload,
  type SidebarThreadOrderState
} from '../lib/sidebarThreadOrder'

export type SharedChatCreateVariant = 'global' | 'workspace' | 'ensemble'

export interface WorkspaceBoardCreateInput {
  workspaceId?: string
  name?: string
}

export interface SharedChatCreateOption {
  variant: SharedChatCreateVariant
  label: string
  title: string
  disabled: boolean
}

export function getSharedChatCreateOptions({
  hasWorkspace
}: {
  hasWorkspace: boolean
  ensembleModeEnabled?: boolean
}): SharedChatCreateOption[] {
  return [
    {
      variant: 'global',
      label: 'People Chat (General)',
      title: 'Create a general chat you can invite people into',
      disabled: false
    },
    {
      variant: 'workspace',
      label: 'People Chat (Workspace)',
      title: hasWorkspace
        ? 'Create a workspace chat you can invite people into'
        : 'Open a workspace first to create a workspace chat for people',
      disabled: !hasWorkspace
    }
  ]
}

const ageTickListeners = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    ageTickListeners.forEach((listener) => listener())
  }, 60000)
}
function subscribeAgeTick(listener: () => void): () => void {
  ageTickListeners.add(listener)
  return () => {
    ageTickListeners.delete(listener)
  }
}

interface SidebarProps {
  workspaces: WorkspaceRecord[]
  currentWorkspace: WorkspaceRecord | null
  chats: ChatRecord[]
  currentChat: ChatRecord | null
  activeChatId?: string | null
  /** Open/close transition classes from `usePanelPresence` (App.tsx). */
  animationClassName?: string
  /** Incremented by App.tsx when the editable workspace-search shortcut fires. */
  focusSearchRequestId?: number
  /** Compact display label for the currently configured workspace-search shortcut. */
  searchShortcutHint?: string
  usageSummary: ModelUsageAggregate[]
  runningChatIds?: string[]
  pluginWorkflowTemplates?: TaskWraithPluginActivatedWorkflowTemplate[]
  workflows?: WorkflowDefinition[]
  workspaceBoards?: WorkspaceBoardDefinition[]
  workspaceBoardCards?: WorkspaceBoardCard[]
  activeWorkspaceBoardId?: string | null
  scheduledTasks?: ScheduledTask[]
  collaboratingChatIds?: Set<string>
  /** Chats with non-empty unsent composer text — user intent that must stay
   *  visible across thread switches (mirrors the reaper's draftChatIds). */
  composerDraftChatIds?: ReadonlySet<string>
  /** Optional initial branch expansions; runtime callers normally omit this so branches start closed. */
  initialExpandedSubThreadParentIds?: string[]
  /**
   * First-launch onboarding hint visibility. When true AND the
   * workspace list is empty, the sidebar renders a faint card
   * under the `+` button pointing the user at "Click + above to
   * add your first workspace". The visibility itself is owned by
   * App.tsx (so the `?` button in the chat-corner rim highlight can flip
   * it on/off); the dismissal flag persists in localStorage via
   * `onDismissOnboardingHint`.
   */
  showOnboardingHint?: boolean
  onDismissOnboardingHint?: () => void
  onSelectWorkspace: (ws: WorkspaceRecord) => void
  onRemoveWorkspace: (id: string, e: MouseEvent<HTMLButtonElement>) => void
  onSelectWorkspaceDialog: () => void
  onNewChat: (wsId: string, wsPath: string) => void
  onNewGlobalChat: () => void
  onNewEnsemble: () => void
  ensembleModeEnabled?: boolean
  /**
   * The user clicked (or arrow-keyed) the Chat / Code segmented control onto a
   * primary chat surface. Fires only on a genuine user-initiated tab change —
   * never from the tab-follows-chat effect or the `+ New` create handlers —
   * and never for Projects, which is sidebar-only. The host may re-scope a
   * pristine welcome draft to the selected surface.
   */
  onPrimarySurfaceSelect?: (surface: SidebarPrimarySurface) => void
  /** Reports the active sidebar tab (initial mount value included) so the
   * host can key surface-scoped state — e.g. the contextual dock memory.
   * Fires for EVERY tab change regardless of source (click, arrow keys, the
   * tab-follows-chat effect), unlike onPrimarySurfaceSelect. */
  onActiveSidebarTabChange?: (tab: 'chat' | 'threads' | 'projects') => void
  onSelectChat: (chat: ChatRecord) => void
  /** Start Project Home for an unhomed project (Work panel pass-through). */
  onStartProjectHome?: (projectId: string) => void
  /** Reports the selected Project detail target for Work-scoped host chrome. */
  onSelectedProjectChange?: (projectId: string | null) => void
  /** Open the References dock panel for a project (Work panel pass-through). */
  onOpenReferencesLibrary?: (projectId: string) => void
  onOpenThreadGraph?: (projectId: string) => void
  projectGraphEntries?: { id: string; name: string; memberCount: number }[]
  activeThreadGraphProjectId?: string | null
  onOpenChatInSidePanel?: (chat: ChatRecord, presentation?: 'split' | 'drawer') => void
  /** Open this chat in a Multiview pane (all chat types). */
  onOpenInMultiview?: (chat: ChatRecord) => void
  onOpenSettings: () => void
  /** Live update snapshot for the one-click pill above the masthead. */
  updateSnapshot?: UpdateStateSnapshot | null
  /** Download / restart / retry without opening Settings. */
  onQuickUpdate?: () => void
  onOpenChangelog?: () => void
  appearanceQuickSettings?: {
    composerStyle: ComposerStyle
    themeAccentStyle: ThemeAccentStyle
    themeAppearance: ThemeAppearance
    toolIconAccent: ToolIconAccent
    sidebarOpacity: number
    mainPaneOpacity: number
  }
  onAppearanceQuickChange?: (next: {
    composerStyle?: ComposerStyle
    themeAccentStyle?: ThemeAccentStyle
    themeAppearance?: ThemeAppearance
    toolIconAccent?: ToolIconAccent
    sidebarOpacity?: number
    mainPaneOpacity?: number
    sidebarOpacityOverride?: boolean
    mainPaneOpacityOverride?: boolean
  }) => void
  onOpenWorkspacePopout?: (kind: 'file-editor' | 'diff-studio' | 'workbench') => void
  canOpenWorkspacePopout?: boolean
  onQuitApp?: () => void
  /** Phase F1: open the SubThreadCreator with `parent` as the parent
   * chat. When undefined the delegate affordance is hidden — keeps
   * the prop optional for any caller that doesn't yet wire it. */
  onCreateSubThread?: (parent: ChatRecord) => void
  /** Toggle the `pinned` flag on a chat. Optional so any caller that
   * hasn't wired persistence yet can omit it — the pin affordance is
   * hidden in that case. */
  onTogglePinChat?: (chatId: string) => void
  /** Toggle the `pinned` flag on a workspace. Optional for the same
   * reason as `onTogglePinChat`. */
  onTogglePinWorkspace?: (workspaceId: string) => void
  /** Hide/show a chat in the MAIN sections while its Git-section entry keeps
   * it reachable. Only offered for chats carrying a git workflow marker. */
  onSetChatHiddenFromMainList?: (chatId: string, hidden: boolean) => void
  /** "Remove from Git" — clear the chat's git workflow marker (and un-hide
   * it, so it can't be orphaned from every list). */
  onClearChatGitWorkflow?: (chatId: string) => void
  /** Workspace/branch identity ("TaskWraith/master") for the ACTIVE chat —
   * the selected row's label slowly cycles between title and this string. */
  activeChatIdentityTicker?: string | null
  /** The branch half of `activeChatIdentityTicker`, on its own, so the ticker
   * can tint it without guessing where the repo name ends. */
  activeChatIdentityBranch?: string | null
  /** Encoded git status strip shown at the right of that identity face —
   * built by `buildSidebarGitIndicators` and encoded so it crosses the memo
   * comparators as a primitive. */
  activeChatIdentityGitIndicators?: string | null
  /** Toggle the `archived` flag on a chat. Hides the chat from the main
   * sidebar lists; existing filters already drop archived chats so the
   * caller just needs to persist the flag. */
  onToggleArchiveChat?: (chatId: string, nextArchived: boolean) => void
  /** Permanently delete a chat (and its sub-threads, depending on caller
   * semantics). Surfaced from the overflow menu under a separate
   * destructive group so the user has to choose it deliberately. */
  onDeleteChat?: (chatId: string) => void
  /** Rename a chat thread to a user-chosen title (1.0.3). Surfaced via
   * the overflow menu's "Rename" item AND via double-click on a
   * visible title. The editor is scoped to the specific rendered row
   * so duplicate appearances of the same chat do not fight over focus. */
  onRenameChat?: (chatId: string, nextTitle: string) => void
  /** Phase K1 follow-up: when provided, clicking a row in the pinned
   * "Active runs" sidebar section navigates to the chat AND opens
   * the Run Inspector for that runId. */
  onInspectRun?: (runId: string, chatId: string | undefined) => void
  onCreateWorkflowFromPluginTemplate?: (
    templateId: string,
    workspace?: WorkspaceRecord
  ) => void
  onCreateWorkflow?: (workspace?: WorkspaceRecord) => void
  onCreateWorkspaceBoard?: (input?: WorkspaceBoardCreateInput) => void
  onOpenWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
  onRenameWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
  onDuplicateWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
  onTogglePinWorkspaceBoard?: (board: WorkspaceBoardDefinition) => void
  onArchiveWorkspaceBoard?: (boardId: string) => void
  onRestoreWorkspaceBoard?: (boardId: string) => void
  onDeleteWorkspaceBoard?: (boardId: string) => void
  onAddChatToWorkspaceBoard?: (chat: ChatRecord) => void
  onAddWorkflowToWorkspaceBoard?: (workflow: WorkflowDefinition) => void
  onAddRunQueueJobToWorkspaceBoard?: (job: RunQueueJob) => void
  onAddLocalServerToWorkspaceBoard?: (server: LocalServerEntry) => void
  /** Start a new shared chat + copy a collaborator invite (People feature). */
  onCreateSharedChat?: (variant: SharedChatCreateVariant) => void
  /** Join someone else's shared chat by pasting their invite (People feature). */
  onJoinSharedChat?: () => void
  onRunWorkflowNow?: (workflowId: string) => void
  onToggleWorkflowEnabled?: (workflow: WorkflowDefinition) => void
  onEditWorkflowInterval?: (workflow: WorkflowDefinition) => void
  onCancelWorkflowExecution?: (workflow: WorkflowDefinition) => void
  onDeleteWorkflow?: (workflowId: string) => void
  onSetWorkflowUnattended?: (workflow: WorkflowDefinition) => void
  /** Opens the iPhone/iPad pairing sheet (QR + JSON). When undefined
   * the remote-connection icon falls back to opening Settings →
   * Bridge Networking as a discoverability hint. */
  /** Deep-link to a specific Settings tab — used by the footer control
   * popovers (Approvals / Shares / Devices), each of which has a bottom nav
   * item that opens the matching tab. Falls back to the generic Settings
   * opener when omitted. */
  onOpenSettingsTab?: (tab: 'pairing' | 'approval-ledger' | 'shares') => void
  /** Per-chat head-of-queue agent approvals. Drives the Approvals footer
   * button's red glow and the pending list inside its popover. Sparse — only
   * chats with a live approval appear (see usePerChatState). */
  pendingAgentApprovalByChatId?: Record<string, AgentApprovalRequest | null>
  /** Per-chat approval queue tails (extra approvals waiting behind the head).
   * Folded into the Approvals popover's pending list so the count is honest
   * under parallel fan-out. */
  pendingApprovalQueueByChatId?: Record<string, AgentApprovalRequest[]>
  /** Resolve an approval directly from the Approvals footer popover. */
  onRespondAgentApproval?: (requestId: string, action: AgentApprovalAction) => void | Promise<void>
  /**
   * Per-chat pending `ask_user_question` queues. Same Approvals footer control
   * glows and lists these as "Needs your input" rows so a blocked elicitation
   * is visible even when the user is not in that thread.
   */
  pendingAgentQuestionsByChatId?: Record<string, readonly AgentQuestionState[]>
  /** Answer a multi-choice agent question from the Approvals popover. */
  onAnswerAgentQuestion?: (
    questionId: string,
    answer: string,
    isCustom: boolean
  ) => void | Promise<void>
  /** Dismiss an agent question from the Approvals popover. */
  onDismissAgentQuestion?: (questionId: string) => void | Promise<void>
  /** Enabled human-collaboration shares — populates the Shares footer popover
   * (chat + mode + active-collaborator count). */
  collaborationShares?: HumanCollaborationShare[]
  /** Revoke (stop) a single share by id, from the Shares popover. */
  onRevokeShare?: (shareId: string) => void
  /** True when at least one collaborator is LIVE-connected to a share right now
   * — drives the Shares button's yellow "someone's here" glow (more precise
   * than merely sharing). */
  hasConnectedCollaborator?: boolean
  /**
   * Model Usage card View-B ("API spend") inputs, forwarded to
   * `ModelUsageCard`. Bundles the rate table + display-currency settings
   * + the persisted view + a change handler. Optional so callers that
   * don't surface the spend view (or tests) can omit it.
   */
  modelUsageApiSpend?: ModelUsageApiSpendOptions
}

export interface PairedRemoteDeviceSummary {
  iphoneIdentityPubKey: string
  pairId: string
  controllerDisplayName: string
  pairedAt: string
  connected: boolean
}

type SidebarPathAction = () => Promise<{ ok: boolean; reason?: string; error?: string }>

const isSideChatRecord = (chat: ChatRecord): boolean => chat.parentChatRelation === 'sideChat'
const isLinkedChildChat = (chat: ChatRecord): boolean => isSubThreadChat(chat) || isSideChatRecord(chat)

const SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY = 'sideChatSelectedParticipantId'
const SIDE_CHAT_SELECTED_PARTICIPANT_ROLE_METADATA_KEY = 'sideChatSelectedParticipantRole'

const getSideChatChildKindLabel = (chat: ChatRecord): string => {
  if (chat.sideChatContext?.mode === 'fanOut') return 'Fan-out side chat'
  if (chat.sideChatContext?.mode === 'ensembleClone') return 'Side ensemble'
  if (chat.sideChatContext?.mode === 'guestParticipant') return 'Guest side chat'
  if (chat.sideChatContext?.mode === 'singleProvider') return 'Isolated side chat'
  return chat.chatKind === 'ensemble' ? 'Side ensemble' : 'Isolated side chat'
}

const getSideChatChildParticipantLabel = (chat: ChatRecord): string => {
  const roleValue = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ROLE_METADATA_KEY]
  if (typeof roleValue === 'string' && roleValue.trim()) return roleValue.trim()
  const idValue = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
  if (typeof idValue === 'string' && idValue.trim()) return getProviderName(chat.provider)
  return ''
}

const getSideChatChildModeLabel = (chat: ChatRecord): string => {
  if (chat.sideChatContext?.mode === 'fanOut') return 'Parallel fan-out'
  if (chat.sideChatContext?.mode === 'ensembleClone') return 'Ensemble clone'
  if (chat.sideChatContext?.mode === 'guestParticipant') return 'Historical guest chat'
  if (chat.sideChatContext?.mode === 'singleProvider') {
    const participantLabel = getSideChatChildParticipantLabel(chat)
    return participantLabel ? `Participant: ${participantLabel}` : 'Isolated sidecar'
  }
  return chat.chatKind === 'ensemble' ? 'Ensemble clone' : 'Isolated sidecar'
}

const getSideChatChildContextLabel = (chat: ChatRecord): string => {
  if (chat.sideChatContext?.mode === 'guestParticipant') return 'Historical guest transcript'
  if (chat.sideChatContext?.originMessageId) return 'Seeded from selected message'
  if (chat.sideChatContext?.originRunId) return 'Seeded from run result'
  if (chat.sideChatContext?.transcriptVisibility === 'summary') return 'Seeded from summary'
  if (chat.sideChatContext?.transcriptVisibility === 'snapshot') return 'Copied parent snapshot'
  return 'Isolated context'
}

const getSideChatChildLifecycleLabel = (chat: ChatRecord): string => {
  if (chat.sideChatContext?.lifecycleState === 'closed') return 'Closed'
  return ''
}

const getLinkedChildAgentIdentity = (chat: ChatRecord) => {
  if (isSubThreadChat(chat)) return assignAgentIdentityFromSeed(chat.appChatId)
  if (
    !isSideChatRecord(chat) ||
    !['singleProvider', 'guestParticipant'].includes(chat.sideChatContext?.mode || '')
  )
    return null
  if (chat.sideChatContext?.mode === 'guestParticipant') {
    return assignAgentIdentityFromSeed(`${chat.parentChatId || chat.appChatId}:guest`)
  }
  const participantId = chat.providerMetadata?.[SIDE_CHAT_SELECTED_PARTICIPANT_ID_METADATA_KEY]
  if (typeof participantId !== 'string' || !participantId.trim()) return null
  return assignAgentIdentityFromSeed(
    `${chat.parentChatId || chat.appChatId}:${participantId.trim()}`
  )
}

const getLinkedChildRouteLabel = (chat: ChatRecord, parentChat: ChatRecord | null): string => {
  const parentProvider = chat.delegationContext?.parentProvider || parentChat?.provider
  const parentLabel = parentProvider ? getProviderName(parentProvider) : 'Parent'
  const childLabel = getProviderName(chat.provider)
  if (isSubThreadChat(chat)) return `${parentLabel} delegated to ${childLabel}`
  if (!isSideChatRecord(chat)) return ''
  if (chat.sideChatContext?.mode === 'fanOut') return `${parentLabel} parallel fan-out`
  if (chat.sideChatContext?.mode === 'ensembleClone') return `${parentLabel} ensemble side branch`
  if (chat.sideChatContext?.mode === 'guestParticipant') {
    return `${parentLabel} historical guest transcript`
  }
  const participantLabel = getSideChatChildParticipantLabel(chat)
  if (!participantLabel && parentProvider === chat.provider) return `${parentLabel} isolated side chat`
  return participantLabel
    ? `${parentLabel} dedicated branch to ${participantLabel}`
    : `${parentLabel} side branch to ${childLabel}`
}

const SIDEBAR_ACTIVE_TAB_STORAGE_KEY = 'taskwraith-sidebar-active-tab'
// The third tab presents as "Work" but its id stays 'projects': persisted tab
// state, the panel/tab DOM ids, and the surface-toggle planner all key on the
// id, so the label can change (or be A/B'd) without touching the route. The
// noun inside the panel remains "Projects".
type SidebarActiveTab = 'chat' | 'threads' | 'projects'
const SIDEBAR_ACTIVE_TABS: readonly SidebarActiveTab[] = ['chat', 'threads', 'projects']

function getChatSidebarTab(chat: ChatRecord): Exclude<SidebarActiveTab, 'projects'> {
  return chat.scope === 'global' ? 'chat' : 'threads'
}
/**
 * Collapsed-section memory for the top-level sidebar lists
 * (Pinned / Recents / Ensembles / Workspaces / Chats). Set semantics: an id
 * present in the set means the user has explicitly collapsed that
 * section. Default is all collapsed except Recents, so reloads start tidy
 * while keeping the last-active chat shortlist immediately reachable.
 *
 * Independent from the in-memory workspace/chat branch disclosure state;
 * this one tracks the section header itself.
 */
const COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY = 'taskwraith-sidebar-collapsed-sections'
const COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY =
  'taskwraith-sidebar-collapsed-sections-default-version'
const COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION = 'recents-open-v1'
type SidebarSectionId =
  | 'workflows'
  | 'workspace-boards'
  | 'pinned'
  | 'recents'
  | 'git'
  | 'ensembles'
  | 'workspaces'
  | 'chats'
  | 'shared'
const SIDEBAR_SECTION_IDS: readonly SidebarSectionId[] = [
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
const SIDEBAR_SECTIONS_EXPANDED_BY_DEFAULT = new Set<SidebarSectionId>(['recents'])

function defaultCollapsedSidebarSections(): Set<SidebarSectionId> {
  return new Set(
    SIDEBAR_SECTION_IDS.filter((id) => !SIDEBAR_SECTIONS_EXPANDED_BY_DEFAULT.has(id))
  )
}

function defaultExpandedWorkspaceId(
  workspaces: WorkspaceRecord[],
  currentWorkspace: WorkspaceRecord | null
): string | null {
  if (currentWorkspace && workspaces.some((workspace) => workspace.id === currentWorkspace.id)) {
    return currentWorkspace.id
  }
  const lastOpened = [...workspaces].sort(
    (a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)
  )[0]
  return lastOpened?.id ?? null
}

function defaultExpandedWorkspaceIds(
  workspaces: WorkspaceRecord[],
  currentWorkspace: WorkspaceRecord | null
): Set<string> {
  const workspaceId = defaultExpandedWorkspaceId(workspaces, currentWorkspace)
  return workspaceId ? new Set([workspaceId]) : new Set()
}

/** Per-list preview cap. Each thread list (a workspace's chats, Ensembles,
 *  Recents, Chats, Shared) renders at most this many rows before a
 *  "Show N more…" toggle reveals the rest — so expanding one section header
 *  can't balloon the sidebar into a single endless scroll. */
const SIDEBAR_SECTION_PREVIEW_LIMIT = 5
/** Recents is a bounded shortlist: even fully expanded it never grows past
 *  this. Keeps "Show more" on Recents from re-listing the entire chat history
 *  the Workspaces / Chats sections already surface. */
const SIDEBAR_RECENTS_MAX = 20

export type SidebarSettingsMenuPane = 'root' | 'themes' | 'composer' | 'accent' | 'system' | 'tool'

const SIDEBAR_COMPOSER_STYLE_OPTIONS: Array<{ value: ComposerStyle; label: string }> = [
  { value: 'default', label: 'TaskWraith native' },
  { value: 'codex', label: 'Codex shell' },
  { value: 'chatgpt', label: 'ChatGPT shell' },
  { value: 'claude', label: 'Claude shell' },
  { value: 'cursor', label: 'Cursor shell' },
  { value: 'grok', label: 'Grok shell' },
  { value: 'gemini', label: 'Gemini shell' },
  { value: 'kimi', label: 'Kimi shell' },
  { value: 'modular', label: 'Modular' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'stub', label: 'Ticket stub' },
  { value: 'satellite', label: 'Satellite' },
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'alabaster', label: 'Alabaster' }
]

const SIDEBAR_ACCENT_OPTIONS: Array<{ value: ThemeAccentStyle; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'orange', label: 'Orange' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' }
]

const SIDEBAR_SYSTEM_THEME_OPTIONS: Array<{ value: ThemeAppearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'rainbow', label: 'Rainbow' },
  { value: 'nebula', label: 'Nebula' },
  { value: 'citrus', label: 'Citrus' },
  { value: 'twilight', label: 'Twilight' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'forest', label: 'Forest' },
  { value: 'cyber', label: 'Cyber' },
  { value: 'candy', label: 'Candy' },
  { value: 'mist', label: 'Mist' },
  { value: 'sage', label: 'Sage' }
]

const SIDEBAR_TOOL_ICON_OPTIONS: Array<{ value: ToolIconAccent; label: string }> = [
  { value: 'system', label: 'Match accent' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'orange', label: 'Orange' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'amber', label: 'Amber' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'violet', label: 'Violet' }
]

function FolderSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.8 4.4h4.1L7.3 5.6h6.5c.6 0 1.1.4 1.1 1v6.2c0 .6-.5 1-1.1 1H2.8C2.2 13.8 1.7 13.4 1.7 12.8V5.5c0-.6.5-1.1 1.1-1.1z" />
      </svg>
    </span>
  )
}

export function GearSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 2.5v1M8 12.5v1M2.5 8h1M12.5 8h1M4.2 4.2l.7.7M11.1 11.1l.7.7M11.1 4.9l-.7.7M4.9 11.1l-.7.7" />
      </svg>
    </span>
  )
}

function MenuChevronIcon({ direction = 'right' }: { direction?: 'left' | 'right' }) {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {direction === 'left' ? (
          <path d="M9.8 4.2 6 8l3.8 3.8" />
        ) : (
          <path d="M6.2 4.2 10 8l-3.8 3.8" />
        )}
      </svg>
    </span>
  )
}

function MenuCheckIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m3.5 8.3 2.8 2.8 6.2-6.2" />
      </svg>
    </span>
  )
}

export function RemoteConnectionSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="5.3" y="5.1" width="5.4" height="8.4" rx="1.2" />
        <path d="M7.1 11.7h1.8" />
        <path d="M4.2 4.2a5.3 5.3 0 0 1 7.6 0" />
        <path d="M5.6 5.7a3.4 3.4 0 0 1 4.8 0" />
        <path d="M6.8 7.1a1.7 1.7 0 0 1 2.4 0" />
      </svg>
    </span>
  )
}

// Shield + check — mirrors the Settings → "Approvals & Grants" tab glyph so the
// footer Approvals button reads as the same surface.
export function ApprovalsShieldIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2.2 12.8 4v3.4c0 3-1.8 5.2-4.8 6.4-3-1.2-4.8-3.4-4.8-6.4V4Z" />
        <path d="m5.8 8 1.4 1.4 3-3.2" />
      </svg>
    </span>
  )
}

// Share-fan: one source node linking out to two recipients. Distinct from the
// People (two-person) glyph and the shield — reads as "this thread is shared
// out to others".
export function ShareNetworkIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="3.7" r="1.85" />
        <circle cx="3.9" cy="12.1" r="1.85" />
        <circle cx="12.1" cy="12.1" r="1.85" />
        <path d="M6.8 5.2 5.1 10.5" />
        <path d="M9.2 5.2 10.9 10.5" />
      </svg>
    </span>
  )
}

function ChevronSymbolIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <span
      className={`sf-symbol-icon sidebar-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}
      aria-hidden
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.2 4.7 10 8.1 6.2 11.5" />
      </svg>
    </span>
  )
}

/**
 * Roving arrow-key focus for the sidebar's `role="menu"` popovers
 * (the `+ New` menu + every SidebarSettingsMenu pane). The
 * portal-based SidebarOverflowMenu carries its own focusedIndex
 * roving; these inline menus are plain focusable `<button>` lists, so
 * we move focus across them via the DOM instead of index state —
 * keeps the menu/menuitem ARIA semantics honest (arrow keys now work
 * as a screen reader would expect) without per-pane bookkeeping.
 *
 * Attach as the container's `onKeyDown`. ArrowDown/ArrowUp wrap;
 * Home/End jump to the ends. Other keys (Enter/Space activate the
 * focused button, Escape dismisses) fall through to the buttons +
 * the existing global listeners.
 */
function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return
  }
  const container = event.currentTarget
  const items = Array.from(
    container.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')
  )
  if (items.length === 0) return
  event.preventDefault()
  const currentIndex = items.indexOf(document.activeElement as HTMLElement)
  let nextIndex: number
  if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = items.length - 1
  } else if (event.key === 'ArrowDown') {
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
  } else {
    nextIndex =
      currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
  }
  items[nextIndex]?.focus()
}

export function SidebarSettingsMenu({
  pane,
  setPane,
  quickSettings,
  onAppearanceQuickChange,
  onOpenSettings,
  onOpenWorkspacePopout,
  canOpenWorkspacePopout,
  onQuitApp,
  onClose
}: {
  pane: SidebarSettingsMenuPane
  setPane: (pane: SidebarSettingsMenuPane) => void
  quickSettings?: SidebarProps['appearanceQuickSettings']
  onAppearanceQuickChange?: SidebarProps['onAppearanceQuickChange']
  onOpenSettings: () => void
  onOpenWorkspacePopout?: SidebarProps['onOpenWorkspacePopout']
  canOpenWorkspacePopout?: boolean
  onQuitApp?: () => void
  onClose: () => void
}) {
  const selectAppearance = (
    next: NonNullable<SidebarProps['onAppearanceQuickChange']> extends (arg: infer Arg) => void
      ? Arg
      : never
  ) => {
    onAppearanceQuickChange?.(next)
    onClose()
  }

  const renderBackButton = (label: string, target: SidebarSettingsMenuPane = 'root') => (
    <button
      type="button"
      className="sidebar-settings-menu-item sidebar-settings-menu-back"
      onClick={() => setPane(target)}
    >
      <MenuChevronIcon direction="left" />
      <span className="sidebar-settings-menu-item-label">{label}</span>
    </button>
  )

  const renderChoice = (label: string, active: boolean, onSelect: () => void) => (
    <button
      key={label}
      type="button"
      className={`sidebar-settings-menu-item sidebar-settings-menu-choice ${active ? 'is-active' : ''}`}
      onClick={onSelect}
      role="menuitemradio"
      aria-checked={active}
    >
      <span className="sidebar-settings-menu-check">{active ? <MenuCheckIcon /> : null}</span>
      <span className="sidebar-settings-menu-item-label">{label}</span>
    </button>
  )

  // Mini pane-opacity sliders live at the foot of the Themes pane. They apply
  // live via onAppearanceQuickChange WITHOUT onClose (dragging must not dismiss
  // the menu), and stop keydown propagation so arrow keys nudge the slider
  // rather than moving menu focus (moveMenuFocus on the menu root).
  const renderOpacitySlider = (
    label: string,
    value: number,
    apply: (value: number) => void
  ) => (
    <label className="sidebar-settings-menu-slider">
      <span className="sidebar-settings-menu-slider-head">
        <span className="sidebar-settings-menu-item-label">{label}</span>
        <span className="sidebar-settings-menu-slider-value">{Math.round(value)}%</span>
      </span>
      <input
        type="range"
        className="composer-ensemble-context-slider"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(event) => apply(Number(event.target.value))}
        onKeyDown={(event) => event.stopPropagation()}
        aria-label={`${label} pane opacity`}
        style={{ '--ensemble-context-slider-fill': `${value}%` } as CSSProperties}
      />
    </label>
  )

  if (pane === 'themes') {
    return (
      <div
        className="sidebar-settings-menu"
        role="menu"
        aria-label="Theme shortcuts"
        onKeyDown={moveMenuFocus}
      >
        {renderBackButton('Themes')}
        <div className="sidebar-settings-menu-divider" aria-hidden />
        <button
          type="button"
          className="sidebar-settings-menu-item"
          onClick={() => setPane('composer')}
        >
          <span className="sidebar-settings-menu-item-label">Composer Shell</span>
          <MenuChevronIcon />
        </button>
        <button
          type="button"
          className="sidebar-settings-menu-item"
          onClick={() => setPane('accent')}
        >
          <span className="sidebar-settings-menu-item-label">Accent Theme</span>
          <MenuChevronIcon />
        </button>
        <button
          type="button"
          className="sidebar-settings-menu-item"
          onClick={() => setPane('system')}
        >
          <span className="sidebar-settings-menu-item-label">System Theme</span>
          <MenuChevronIcon />
        </button>
        <button
          type="button"
          className="sidebar-settings-menu-item"
          onClick={() => setPane('tool')}
        >
          <span className="sidebar-settings-menu-item-label">Tool Call Theme</span>
          <MenuChevronIcon />
        </button>
        <div className="sidebar-settings-menu-divider" aria-hidden />
        <div className="sidebar-settings-menu-section-label" aria-hidden>
          Pane opacity
        </div>
        {renderOpacitySlider('Sidebar', quickSettings?.sidebarOpacity ?? 100, (value) =>
          onAppearanceQuickChange?.({ sidebarOpacity: value, sidebarOpacityOverride: true })
        )}
        {renderOpacitySlider('Main pane', quickSettings?.mainPaneOpacity ?? 100, (value) =>
          onAppearanceQuickChange?.({ mainPaneOpacity: value, mainPaneOpacityOverride: true })
        )}
      </div>
    )
  }

  if (pane === 'composer') {
    return (
      <div
        className="sidebar-settings-menu"
        role="menu"
        aria-label="Composer shell shortcuts"
        onKeyDown={moveMenuFocus}
      >
        {renderBackButton('Composer Shell', 'themes')}
        <div className="sidebar-settings-menu-divider" aria-hidden />
        {SIDEBAR_COMPOSER_STYLE_OPTIONS.map((option) =>
          renderChoice(option.label, quickSettings?.composerStyle === option.value, () =>
            selectAppearance({ composerStyle: option.value })
          )
        )}
      </div>
    )
  }

  if (pane === 'accent') {
    return (
      <div
        className="sidebar-settings-menu"
        role="menu"
        aria-label="Accent theme shortcuts"
        onKeyDown={moveMenuFocus}
      >
        {renderBackButton('Accent Theme', 'themes')}
        <div className="sidebar-settings-menu-divider" aria-hidden />
        {SIDEBAR_ACCENT_OPTIONS.map((option) =>
          renderChoice(option.label, quickSettings?.themeAccentStyle === option.value, () =>
            selectAppearance({ themeAccentStyle: option.value })
          )
        )}
      </div>
    )
  }

  if (pane === 'system') {
    return (
      <div
        className="sidebar-settings-menu"
        role="menu"
        aria-label="System theme shortcuts"
        onKeyDown={moveMenuFocus}
      >
        {renderBackButton('System Theme', 'themes')}
        <div className="sidebar-settings-menu-divider" aria-hidden />
        {SIDEBAR_SYSTEM_THEME_OPTIONS.map((option) =>
          renderChoice(option.label, quickSettings?.themeAppearance === option.value, () =>
            selectAppearance({ themeAppearance: option.value })
          )
        )}
      </div>
    )
  }

  if (pane === 'tool') {
    return (
      <div
        className="sidebar-settings-menu"
        role="menu"
        aria-label="Tool call theme shortcuts"
        onKeyDown={moveMenuFocus}
      >
        {renderBackButton('Tool Call Theme', 'themes')}
        <div className="sidebar-settings-menu-divider" aria-hidden />
        {SIDEBAR_TOOL_ICON_OPTIONS.map((option) =>
          renderChoice(option.label, quickSettings?.toolIconAccent === option.value, () =>
            selectAppearance({ toolIconAccent: option.value })
          )
        )}
      </div>
    )
  }

  return (
    <div
      className="sidebar-settings-menu"
      role="menu"
      aria-label="Settings shortcuts"
      onKeyDown={moveMenuFocus}
    >
      <button
        type="button"
        className="sidebar-settings-menu-item"
        onClick={() => setPane('themes')}
      >
        <span className="sidebar-settings-menu-item-label">Themes</span>
        <MenuChevronIcon />
      </button>
      <div className="sidebar-settings-menu-divider" aria-hidden />
      <button
        type="button"
        className="sidebar-settings-menu-item"
        disabled={!canOpenWorkspacePopout}
        onClick={() => {
          onOpenWorkspacePopout?.('workbench')
          onClose()
        }}
      >
        <span className="sidebar-settings-menu-item-label">Workbench</span>
      </button>
      <button
        type="button"
        className="sidebar-settings-menu-item"
        disabled={!canOpenWorkspacePopout}
        onClick={() => {
          onOpenWorkspacePopout?.('diff-studio')
          onClose()
        }}
      >
        <span className="sidebar-settings-menu-item-label">Diff Studio</span>
      </button>
      <button
        type="button"
        className="sidebar-settings-menu-item"
        disabled={!canOpenWorkspacePopout}
        onClick={() => {
          onOpenWorkspacePopout?.('file-editor')
          onClose()
        }}
      >
        <span className="sidebar-settings-menu-item-label">File Editor</span>
      </button>
      <div className="sidebar-settings-menu-divider" aria-hidden />
      <button
        type="button"
        className="sidebar-settings-menu-item"
        onClick={() => {
          onOpenSettings()
          onClose()
        }}
      >
        <span className="sidebar-settings-menu-item-label">Settings</span>
      </button>
      <button
        type="button"
        className="sidebar-settings-menu-item sidebar-settings-menu-item-danger"
        onClick={() => {
          onQuitApp?.()
          onClose()
        }}
      >
        <span className="sidebar-settings-menu-item-label">Quit</span>
      </button>
    </div>
  )
}

function PlusSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 3.5v9M3.5 8h9" />
      </svg>
    </span>
  )
}

function SearchSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="7.1" cy="7.1" r="4.1" />
        <path d="m10.1 10.1 3.1 3.1" />
      </svg>
    </span>
  )
}

function XSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4.7 4.7 11.3 11.3M11.3 4.7 4.7 11.3" />
      </svg>
    </span>
  )
}

/**
 * `SidebarChatTitleEditable` — renders a chat's title with two modes:
 *
 *   - Display: `<HighlightMatch>` for search-term highlighting. Double-
 *     clicking the title enters edit mode. Plain row clicks still navigate,
 *     so rename stays deliberate without requiring a prior selection click.
 *   - Edit: an `<input>` with the current title pre-filled. Enter
 *     submits, Escape cancels, blur submits (matches Finder rename UX).
 *     We stopPropagation on click/mousedown so clicks inside the input
 *     don't re-fire the parent row's onClick handler.
 *
 * Used at all 6 chat-tile render sites (pinned, recents, ensembles
 * section, workspace-expanded parents, workspace-expanded sub-threads,
 * global chats). Each site passes its own outer span className so the
 * existing per-section styling rules (`.sidebar-pinned-label` /
 * `.sidebar-recents-label` / `.sidebar-chat-title`) keep working.
 */
function SidebarChatTitleEditable({
  chat,
  className,
  query,
  isEditing,
  onStartEdit,
  onSubmit,
  onCancel
}: {
  chat: ChatRecord
  className: string
  query: string
  isSelected?: boolean
  isEditing: boolean
  onStartEdit: () => void
  onSubmit: (nextValue: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(chat.title)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const draftRef = useRef(chat.title)
  const editClosedRef = useRef(true)
  const wasEditingRef = useRef(false)
  const closeWithSubmit = useCallback(
    (nextValue?: string): void => {
      if (editClosedRef.current) return
      editClosedRef.current = true
      onSubmit(nextValue ?? draftRef.current)
    },
    [onSubmit]
  )
  const closeWithCancel = useCallback((): void => {
    if (editClosedRef.current) return
    editClosedRef.current = true
    onCancel()
  }, [onCancel])

  // Seed the draft when edit mode opens. Once the user is typing, keep
  // incoming chat updates from clobbering the in-progress rename.
  useEffect(() => {
    if (!isEditing) {
      wasEditingRef.current = false
      editClosedRef.current = true
      return
    }
    if (wasEditingRef.current) return
    wasEditingRef.current = true
    editClosedRef.current = false
    draftRef.current = chat.title
    setDraft(chat.title)
  }, [isEditing, chat.appChatId, chat.title])

  useEffect(() => {
    if (!isEditing) return
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isEditing, chat.appChatId])

  if (isEditing) {
    return (
      <span className={className}>
        <input
          ref={inputRef}
          autoFocus
          className="sidebar-chat-title-input"
          value={draft}
          onChange={(event) => {
            draftRef.current = event.target.value
            setDraft(event.target.value)
          }}
          onBlur={(event) => closeWithSubmit(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              closeWithSubmit(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeWithCancel()
            }
          }}
          aria-label="Rename chat"
        />
      </span>
    )
  }

  // Content-only search hint: when the query matched a message body but
  // not the title, the title highlight is empty and the user can't tell
  // why the row surfaced. Show a small "in conversation" snippet so the
  // match is honest. Skipped entirely when the title already matches.
  const contentSnippet = getChatContentMatchSnippet(chat, query)

  return (
    <span
      className={className}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onStartEdit()
      }}
    >
      <HighlightMatch text={chat.title} query={query} />
      {contentSnippet && (
        <span className="sidebar-chat-subline sidebar-search-content-match">
          <span
            className="sidebar-run-status tone-muted"
            title={`Match in conversation: ${contentSnippet}`}
          >
            <HighlightMatch text={contentSnippet} query={query} />
          </span>
        </span>
      )}
    </span>
  )
}

// `PinSymbolIcon` was used by the inline pin/unpin icon button that
// every chat-tile + workspace-tile rendered alongside the three-dots
// overflow menu (1.0.2 behaviour). Both icon buttons were retired in
// 1.0.3 — Pin / Unpin now lives exclusively in the overflow menu via
// `buildChatMenuItems` + `buildWorkspaceMenuItems`. Definition kept
// out of the bundle entirely so the unused-import lint stays clean.

/**
 * Keep the Ensembles empty-state identity on the same canonical artwork used
 * by chat rows, badges, notifications, and the composer toggle.
 */
function EnsembleSymbolIcon() {
  return <ProviderGlyph provider="ensemble" className="sidebar-ensemble-symbol-icon" />
}

/**
 * `ChatBubbleSymbolIcon` — speech-bubble glyph for the "New Chat"
 * row in the `+ New` dropdown. Distinct from the `+` of the trigger
 * button so the menu items each carry their own affordance.
 */
function ChatBubbleSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.2 4.3c0-.66.54-1.2 1.2-1.2h7.2c.66 0 1.2.54 1.2 1.2v5.2c0 .66-.54 1.2-1.2 1.2H7.2L4.5 12.6V10.7H4.4a1.2 1.2 0 0 1-1.2-1.2V4.3Z" />
      </svg>
    </span>
  )
}

function BoardSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 3.5h10M3 8h10M3 12.5h10" />
        <path d="M5.5 2.5v11M10.5 2.5v11" />
      </svg>
    </span>
  )
}

/** Two-person glyph for the "Shared" / People collaboration affordances. */
function PeopleSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="6" cy="5.4" r="2.1" />
        <path d="M2.4 12.4c0-1.9 1.6-3.2 3.6-3.2s3.6 1.3 3.6 3.2" />
        <path d="M10.3 3.7a2 2 0 0 1 0 3.9" />
        <path d="M11 9.3c1.6.2 2.9 1.4 2.9 3.1" />
      </svg>
    </span>
  )
}

// Phase L6 slice 1 — exported for `ModelUsageCard` provider headers.
//
// The trailing 'Gemini' is this function's UNKNOWN-provider default, dating to
// when Gemini was the only seat — so every seat added since has had to be
// listed explicitly or silently answer "Gemini". Pi was missed, which is why
// its rows read "Gemini deepseek/deepseek-v4-flash" across the composer picker
// trigger, the above-composer chips and the mention menu.
//
// This returns the SEAT name on purpose. Surfaces that should show the brand
// behind the seat ("Mistral" for a Pi run, "Alibaba" for an Ollama Qwen) get it
// from `resolveProviderBrandLabel`, falling back to this — see that function's
// note on why the two stay separate.
export function getProviderName(provider?: ProviderId) {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  if (provider === 'antigravity') return 'Antigravity'
  if (provider === 'pi') return 'Pi'
  if (provider === 'mistral') return 'Mistral'
  return 'Gemini'
}

// Exported so compact provider rows can reuse the same official marks as the
// sidebar; Ensemble retains TaskWraith's own glyph.
type SidebarProviderBadgeId = ProviderId | 'ensemble'

export function ProviderBadgeIcon({
  provider,
  accentProvider
}: {
  provider?: SidebarProviderBadgeId
  accentProvider?: string
}) {
  const providerKey = provider || 'gemini'

  if (providerKey !== 'ensemble') {
    return <ProviderBrandLogoIcon provider={providerKey} />
  }

  return (
    <span className={`sidebar-provider-icon provider-${providerKey}`} aria-hidden="true">
      <ProviderGlyph provider={providerKey} accentProvider={accentProvider} />
    </span>
  )
}

/** Provider mnemonic id for a chat's badge — ensembles get their own glyph.
 * Module scope so the memoized row components can call it without a
 * per-render Sidebar closure. */
function getChatProviderBadgeId(chat: ChatRecord): SidebarProviderBadgeId {
  return chat.chatKind === 'ensemble' ? 'ensemble' : chat.provider || 'gemini'
}

/** Satellite-family icon per git workflow state (same vocabulary as the
 * composer's GitHubSatelliteRow: git / pull-request / merge / ci). */
const GIT_WORKFLOW_ICON_FAMILY: Record<
  ChatGitWorkflowState,
  'git' | 'pull-request' | 'merge' | 'ci'
> = {
  pushed: 'git',
  draft: 'pull-request',
  open: 'pull-request',
  merged: 'merge',
  closed: 'pull-request',
  failed: 'ci'
}

/**
 * The single-slot per-row git workflow icon (sits beside the provider logo).
 * Derived from the stable `chat` object inside the memoized rows: a marker
 * change replaces the ChatRecord, so the `a.chat === b.chat` comparators
 * already cover re-rendering. Tones mirror the satellite row's palette.
 */
export function SidebarGitWorkflowIcon({
  marker
}: {
  marker: ChatGitWorkflowSnapshot
}): ReactNode {
  const label = chatGitWorkflowLabel(marker)
  return (
    <span
      className={`sidebar-git-workflow-icon state-${marker.state}`}
      title={`Git: ${label}`}
      aria-label={`Git: ${label}`}
    >
      <ToolFamilyIcon family={GIT_WORKFLOW_ICON_FAMILY[marker.state]} size={12} />
    </span>
  )
}

/**
 * Active-row title ticker: the selected row's label slowly slides between the
 * thread title and its workspace/branch identity ("TaskWraith/master"). Pure
 * CSS (see 01-sidebar.css `.sidebar-title-ticker*`): two 100%-width
 * ellipsizing segments in an overflow-hidden strip, ease-in-out holds,
 * disabled under prefers-reduced-motion. Rename editing bypasses the ticker
 * at the call sites so double-click-to-rename keeps working.
 */
function SidebarTitleTicker({
  identity,
  branch,
  gitIndicators,
  className,
  children
}: {
  identity: string
  /** The branch half of `identity`, supplied separately rather than split out
   * of it: a branch may itself contain "/" ("feat/foo"), and so may a
   * folder-derived workspace name, so there is no safe place to cut the joined
   * string. Absent (no repo / detached) leaves the whole face untinted. */
  branch?: string | null
  /** Encoded git status strip (see lib/sidebarGitIndicators). Rides the
   * identity face, right-aligned, so it slides in and out with the branch
   * name rather than becoming permanent row chrome. */
  gitIndicators?: string | null
  className: string
  children: ReactNode
}): ReactNode {
  const indicators = decodeSidebarGitIndicators(gitIndicators)
  // Only the branch is tinted; the repo/workspace name stays in the row's own
  // ink. The suffix check is belt-and-braces — if the two ever disagree the
  // face renders plain rather than mis-slicing the name.
  const trimmedBranch = (branch || '').trim()
  const branchSuffix = trimmedBranch ? `/${trimmedBranch}` : ''
  const splitsCleanly = Boolean(branchSuffix) && identity.endsWith(branchSuffix)
  const repoHalf = splitsCleanly ? identity.slice(0, identity.length - trimmedBranch.length) : ''
  return (
    <span className={`sidebar-title-ticker ${className}`}>
      <span className="sidebar-title-ticker-strip">
        <span className="sidebar-title-ticker-seg">{children}</span>
        <span className="sidebar-title-ticker-seg sidebar-title-ticker-identity" aria-hidden>
          <span className="sidebar-title-ticker-identity-text">
            {splitsCleanly ? (
              <>
                {repoHalf}
                <span
                  className={`sidebar-title-ticker-branch git-tone-${branchTone(
                    trimmedBranch,
                    false
                  )}`}
                >
                  {trimmedBranch}
                </span>
              </>
            ) : (
              identity
            )}
          </span>
          <SidebarGitIndicatorStrip indicators={indicators} />
        </span>
      </span>
    </span>
  )
}

/** Prop bag spread onto a draggable recents row — the exact shape
 * `getChatTileDragProps` returns. */
type SidebarChatTileDragProps = {
  draggable: boolean
  onDragStart?: (event: ReactDragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  'data-dragging'?: 'true' | undefined
  'data-sidebar-thread-id'?: string
  'data-sidebar-thread-list'?: string
  'data-sidebar-thread-drop-target'?: 'true' | undefined
}

interface SidebarCompactChatRowProps {
  chat: ChatRecord
  variant: 'pinned' | 'recents' | 'git'
  surfaceId: string
  isSelected: boolean
  isRunning: boolean
  rowTone: SidebarRowTone | null
  /** True when an agent is blocked on `ask_user_question` in this chat. */
  needsInput: boolean
  isEditing: boolean
  query: string
  /** Workspace/branch identity ("TaskWraith/master") the ACTIVE row's label
   * slowly cycles to. null/undefined (every non-active row) renders the plain
   * label. Threaded as a primitive so the comparator can gate it. */
  identityTicker?: string | null
  /** Encoded git status strip for the identity face — same primitive-prop
   * contract as `identityTicker`. */
  identityGitIndicators?: string | null
  /** Branch half of `identityTicker`, tinted by kind. Same primitive-prop
   * contract as the two above. */
  identityBranch?: string | null
  /** Comparator proxies for the SSR-relevant fields of `dragHandlers`
   * (recents only). `dragHandlers` itself is a fresh object each render and
   * is intentionally NOT compared — these primitives gate re-render. */
  draggable: boolean
  isDragging: boolean
  dragHandlers?: SidebarChatTileDragProps
  onSelect: (chat: ChatRecord) => void
  onStartRename: (chat: ChatRecord, surfaceId: string) => void
  onSubmitRename: (chat: ChatRecord, next: string) => void
  onCancelRename: () => void
  buildMenuItems: (chat: ChatRecord, surfaceId: string) => SidebarOverflowMenuItem[]
}

/**
 * Memoized compact chat row (Pinned + Recents). Extracted so a background
 * stream — which churns the `chats` array identity ~60fps but keeps every
 * NON-streaming ChatRecord object identity stable — re-renders only the
 * streaming chat's row instead of reconciling every row each frame. All
 * mutable state is threaded as PRIMITIVES so the comparator can skip.
 * Markup is byte-identical to the former inline rows (verified via a
 * before/after SSR diff).
 */
function SidebarCompactChatRowInner({
  chat,
  variant,
  surfaceId,
  isSelected,
  isRunning,
  rowTone,
  needsInput,
  isEditing,
  query,
  identityTicker,
  identityGitIndicators,
  identityBranch,
  dragHandlers,
  onSelect,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  buildMenuItems
}: SidebarCompactChatRowProps): ReactNode {
  const badgeId = getChatProviderBadgeId(chat)
  const gitMarker = chatGitWorkflowMarker(chat)
  const baseClass = variant === 'pinned' ? 'sidebar-pinned-item' : 'sidebar-recents-item'
  const labelClass = variant === 'pinned' ? 'sidebar-pinned-label' : 'sidebar-recents-label'
  const toneClass = rowTone ? ` ${sidebarRowToneClass(rowTone)}` : ''
  const editableTitle = (
    <SidebarChatTitleEditable
      chat={chat}
      className={labelClass}
      query={query}
      isEditing={isEditing}
      onStartEdit={() => onStartRename(chat, surfaceId)}
      onSubmit={(next) => onSubmitRename(chat, next)}
      onCancel={onCancelRename}
    />
  )
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${baseClass} provider-${badgeId} ${isSelected ? 'active' : ''}${
        needsInput ? ' needs-input' : ''
      }${toneClass}`}
      onClick={() => onSelect(chat)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(chat)
        }
      }}
      title={needsInput ? `${chat.title} — needs your input` : chat.title}
      aria-busy={isRunning || undefined}
      aria-label={
        needsInput
          ? `${chat.title}, needs input`
          : isRunning
            ? `${chat.title}, running`
            : rowTone === 'waiting'
              ? `${chat.title}, waiting on your response`
              : rowTone === 'sleeping'
                ? `${chat.title}, sleeping until its next wake-up`
                : rowTone === 'success'
                  ? `${chat.title}, completed successfully, unread`
                  : rowTone === 'failure'
                    ? `${chat.title}, blocked or failed, unread`
                    : chat.title
      }
      {...(dragHandlers || {})}
    >
      <ProviderBrandLogoIcon provider={badgeId} />
      {gitMarker && <SidebarGitWorkflowIcon marker={gitMarker} />}
      {identityTicker && isSelected && !isEditing ? (
        <SidebarTitleTicker
          identity={identityTicker}
          gitIndicators={identityGitIndicators}
          branch={identityBranch}
          className={labelClass}
        >
          {editableTitle}
        </SidebarTitleTicker>
      ) : (
        editableTitle
      )}
      {/* Run-state chips retired: the row's title ink says it (amber while
        parked on you, red/green for a settled result, sea blue asleep) and the
        ghost says running. The state still reaches screen readers through the
        composed aria-label — the ink is visual-only. */}
      {variant === 'pinned' ? (
        isRunning && <SidebarRunningGhost />
      ) : isRunning ? (
        <SidebarRunningGhost />
      ) : (
        <ChatAgeLabel timestamp={chat.updatedAt || chat.createdAt} />
      )}
      <SidebarOverflowMenu triggerLabel="Chat actions" items={buildMenuItems(chat, surfaceId)} />
    </div>
  )
}

export function sidebarCompactChatRowPropsAreEqual(
  a: SidebarCompactChatRowProps,
  b: SidebarCompactChatRowProps
): boolean {
  return (
    a.chat === b.chat &&
    a.variant === b.variant &&
    a.surfaceId === b.surfaceId &&
    a.isSelected === b.isSelected &&
    a.isRunning === b.isRunning &&
    a.rowTone === b.rowTone &&
    a.needsInput === b.needsInput &&
    a.isEditing === b.isEditing &&
    a.draggable === b.draggable &&
    a.isDragging === b.isDragging &&
    a.query === b.query &&
    (a.dragHandlers?.['data-sidebar-thread-drop-target'] ?? null) ===
      (b.dragHandlers?.['data-sidebar-thread-drop-target'] ?? null) &&
    (a.identityTicker ?? null) === (b.identityTicker ?? null) &&
    (a.identityGitIndicators ?? null) === (b.identityGitIndicators ?? null) &&
    (a.identityBranch ?? null) === (b.identityBranch ?? null)
  )
}

const SidebarCompactChatRow = memo(SidebarCompactChatRowInner, sidebarCompactChatRowPropsAreEqual)

interface SidebarChatRowProps {
  chat: ChatRecord
  variant: 'workspace' | 'global' | 'shared'
  surfaceId: string
  isSelected: boolean
  isRunning: boolean
  rowTone: SidebarRowTone | null
  /** True when an agent is blocked on `ask_user_question` in this chat. */
  needsInput: boolean
  isEditing: boolean
  /** Workspace subline "People" badge. Always false for global/shared. */
  isCollaborating: boolean
  /** Linked sub-thread counts (workspace only; 0 for global/shared). */
  subThreadCount: number
  liveSubThreadCount: number
  subThreadsExpanded: boolean
  query: string
  /** Workspace/branch identity the ACTIVE row's label slowly cycles to —
   * see SidebarCompactChatRowProps.identityTicker. */
  identityTicker?: string | null
  /** See SidebarCompactChatRowProps.identityGitIndicators. */
  identityGitIndicators?: string | null
  /** See SidebarCompactChatRowProps.identityBranch. */
  identityBranch?: string | null
  /** Drag/reorder props for the list this row belongs to. */
  dragHandlers?: SidebarChatTileDragProps
  onSelect: (chat: ChatRecord) => void
  onRowKeyDown: (event: KeyboardEvent<HTMLDivElement>, chat: ChatRecord) => void
  onToggleSubThreads: (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
    parentChatId: string
  ) => void
  onStartRename: (chat: ChatRecord, surfaceId: string) => void
  onSubmitRename: (chat: ChatRecord, next: string) => void
  onCancelRename: () => void
  buildMenuItems: (chat: ChatRecord, surfaceId: string) => SidebarOverflowMenuItem[]
}

/**
 * Memoized full chat row with subline (Workspace-grouped + Global + Shared).
 * Same win as SidebarCompactChatRow: only the streaming chat's row re-renders
 * during a run instead of every row reconciling ~60fps. All mutable state is
 * threaded as PRIMITIVES; `lastRunStatus`/a11y are derived INSIDE from the
 * stable `chat` object (never passed — they'd be fresh objects and bust the
 * memo). Markup is byte-identical per variant to the former inline rows
 * (verified via a before/after SSR diff). The workspace variant's
 * `.sidebar-chat-family` wrapper + children block stay at the map site.
 */
function SidebarChatRowInner({
  chat,
  variant,
  surfaceId,
  isSelected,
  isRunning,
  rowTone,
  needsInput,
  isEditing,
  isCollaborating,
  subThreadCount,
  liveSubThreadCount,
  subThreadsExpanded,
  query,
  identityTicker,
  identityGitIndicators,
  identityBranch,
  onSelect,
  onRowKeyDown,
  onToggleSubThreads,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  buildMenuItems,
  dragHandlers
}: SidebarChatRowProps): ReactNode {
  const provider = chat.provider || 'gemini'
  const gitMarker = chatGitWorkflowMarker(chat)
  const lastRunStatus = getLastRunStatus(chat)
  const branchedBadgeTone = liveSubThreadCount > 0 ? 'active' : 'dim'
  const a11y = buildSidebarChatRowA11y(
    variant === 'shared'
      ? {
          chatId: chat.appChatId,
          title: chat.title || 'People chat',
          provider: chat.provider,
          selected: isSelected,
          isRunning,
          needsInput,
          lastRunStatus,
          rowTone,
          prefix: 'People'
        }
      : {
          chatId: chat.appChatId,
          title: chat.title,
          provider: chat.provider,
          selected: isSelected,
          isRunning,
          needsInput,
          lastRunStatus,
          rowTone
        }
  )
  // Preserve each variant's existing active/running spacing, then append the
  // outcome hook as a suffix so ordinary rows remain byte-identical.
  const toneClass = rowTone ? ` ${sidebarRowToneClass(rowTone)}` : ''
  const className =
    variant === 'workspace'
      ? `sidebar-item sidebar-chat-item provider-${provider} ${isSelected ? 'active' : ''} ${isRunning ? 'running' : ''}${toneClass}`
      : variant === 'global'
        ? `sidebar-item sidebar-chat-item sidebar-global-chat-item provider-${provider} ${isSelected ? 'active' : ''} ${isRunning ? 'running' : ''}${toneClass}`
        : `sidebar-item sidebar-chat-item sidebar-shared-chat-item provider-${provider}${isSelected ? ' active' : ''}${isRunning ? ' running' : ''}${toneClass}`
  const showStatus =
    lastRunStatus && lastRunStatus.tone !== 'success' && lastRunStatus.tone !== 'muted'
  const showSubline =
    variant === 'workspace'
      ? needsInput || isRunning || showStatus || subThreadCount > 0 || isCollaborating
      : needsInput || isRunning || showStatus
  const copyTitle = variant === 'shared' ? chat.title || 'People chat' : chat.title
  return (
    <div
      role="button"
      tabIndex={0}
      className={className}
      onClick={() => onSelect(chat)}
      onKeyDown={(event) => onRowKeyDown(event, chat)}
      aria-label={a11y.ariaLabel}
      aria-current={a11y.ariaCurrent}
      aria-describedby={a11y.statusDescribedById}
      {...(dragHandlers || {})}
    >
      {a11y.statusDescription && (
        <span id={a11y.statusDescribedById} className="sr-only">
          {a11y.statusDescription}
        </span>
      )}
      {variant === 'workspace' && subThreadCount > 0 && (
        <span
          role="button"
          tabIndex={0}
          className="sidebar-tree-toggle sidebar-chat-tree-toggle"
          onClick={(event) => onToggleSubThreads(event, chat.appChatId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              onToggleSubThreads(event, chat.appChatId)
            }
          }}
          title={subThreadsExpanded ? 'Collapse sub-threads' : 'Expand sub-threads'}
          aria-label={subThreadsExpanded ? 'Collapse sub-threads' : 'Expand sub-threads'}
          aria-expanded={subThreadsExpanded}
        >
          <ChevronSymbolIcon isExpanded={subThreadsExpanded} />
        </span>
      )}
      <span className="sidebar-chat-copy" title={copyTitle}>
        <span className="sidebar-chat-title-line">
          {variant === 'shared' ? (
            <ProviderBadgeIcon provider={getChatProviderBadgeId(chat)} />
          ) : (
            <SidebarProviderLabel provider={chat.provider} />
          )}
          {gitMarker && <SidebarGitWorkflowIcon marker={gitMarker} />}
          {identityTicker && isSelected && !isEditing ? (
            <SidebarTitleTicker
              identity={identityTicker}
              gitIndicators={identityGitIndicators}
              branch={identityBranch}
              className="sidebar-chat-title"
            >
              <SidebarChatTitleEditable
                chat={chat}
                className="sidebar-chat-title"
                query={query}
                isEditing={isEditing}
                onStartEdit={() => onStartRename(chat, surfaceId)}
                onSubmit={(next) => onSubmitRename(chat, next)}
                onCancel={onCancelRename}
              />
            </SidebarTitleTicker>
          ) : (
            <SidebarChatTitleEditable
              chat={chat}
              className="sidebar-chat-title"
              query={query}
              isEditing={isEditing}
              onStartEdit={() => onStartRename(chat, surfaceId)}
              onSubmit={(next) => onSubmitRename(chat, next)}
              onCancel={onCancelRename}
            />
          )}
        </span>
        {showSubline && (
          <span className="sidebar-chat-subline">
            {variant === 'workspace' && subThreadCount > 0 && (
              <span
                className={`sidebar-branched-badge sidebar-branched-${branchedBadgeTone}`}
                title={`${liveSubThreadCount} of ${subThreadCount} linked chat${subThreadCount === 1 ? '' : 's'} running`}
                aria-label={`linked ${subThreadCount} chat${subThreadCount === 1 ? '' : 's'}`}
              >
                linked · {subThreadCount}
              </span>
            )}
            {variant === 'workspace' && isCollaborating && (
              <span
                className="sidebar-branched-badge sidebar-shared-badge"
                title="People have access"
              >
                People
              </span>
            )}
          </span>
        )}
      </span>
      {variant === 'shared' && (
        <span
          className="sidebar-branched-badge sidebar-shared-badge"
          title="People have access"
        >
          People
        </span>
      )}
      {isRunning && <SidebarRunningGhost />}
      {!isRunning && <ChatAgeLabel timestamp={chat.updatedAt || chat.createdAt} />}
      <SidebarOverflowMenu
        triggerLabel={variant === 'shared' ? 'People chat actions' : 'Chat actions'}
        items={buildMenuItems(chat, surfaceId)}
      />
    </div>
  )
}

export function sidebarChatRowPropsAreEqual(
  a: SidebarChatRowProps,
  b: SidebarChatRowProps
): boolean {
  return (
    a.chat === b.chat &&
    a.variant === b.variant &&
    a.surfaceId === b.surfaceId &&
    a.isSelected === b.isSelected &&
    a.isRunning === b.isRunning &&
    a.rowTone === b.rowTone &&
    a.needsInput === b.needsInput &&
    a.isEditing === b.isEditing &&
    a.isCollaborating === b.isCollaborating &&
    a.subThreadCount === b.subThreadCount &&
    a.liveSubThreadCount === b.liveSubThreadCount &&
    a.subThreadsExpanded === b.subThreadsExpanded &&
    a.query === b.query &&
    (a.dragHandlers?.draggable ?? false) === (b.dragHandlers?.draggable ?? false) &&
    (a.dragHandlers?.['data-dragging'] ?? null) ===
      (b.dragHandlers?.['data-dragging'] ?? null) &&
    (a.dragHandlers?.['data-sidebar-thread-list'] ?? null) ===
      (b.dragHandlers?.['data-sidebar-thread-list'] ?? null) &&
    (a.dragHandlers?.['data-sidebar-thread-drop-target'] ?? null) ===
      (b.dragHandlers?.['data-sidebar-thread-drop-target'] ?? null) &&
    (a.identityTicker ?? null) === (b.identityTicker ?? null) &&
    (a.identityGitIndicators ?? null) === (b.identityGitIndicators ?? null) &&
    (a.identityBranch ?? null) === (b.identityBranch ?? null)
  )
}

const SidebarChatRow = memo(SidebarChatRowInner, sidebarChatRowPropsAreEqual)

function SidebarProviderLabel({
  provider,
  showModel
}: {
  provider: ProviderId | undefined
  showModel?: string
}) {
  const providerName = provider || 'gemini'
  return (
    <span className={`sidebar-provider-label provider-${providerName}`}>
      <ProviderBrandLogoIcon provider={provider} />
      <span>
        {getProviderName(provider)}
        {showModel ? ` / ${showModel}` : ''}
      </span>
    </span>
  )
}

function getChatsByWorkspace(chats: ChatRecord[]): Map<string, ChatRecord[]> {
  const grouped = new Map<string, ChatRecord[]>()
  for (const chat of chats) {
    if (chat.archived) continue
    if (chat.scope === 'global') continue
    if (!chat.workspaceId) continue
    const bucket = grouped.get(chat.workspaceId)
    if (bucket) {
      bucket.push(chat)
    } else {
      grouped.set(chat.workspaceId, [chat])
    }
  }
  return grouped
}

function normalizeSearchText(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function chatMatchesSearch(chat: ChatRecord, query: string): boolean {
  if (!query) return true
  const provider = getProviderName(chat.provider)
  const summary = chat as Partial<ChatListItem>
  const searchableMessages = (chat.messages || []).filter(
    (message) => message.metadata?.kind !== 'channelInbound'
  )
  const searchableText = [
    chat.title,
    provider,
    chat.appChatId,
    chat.linkedGeminiSessionId,
    chat.linkedProviderSessionId,
    summary.searchText,
    ...searchableMessages.map((message) => `${message.role} ${message.content}`)
  ].join(' ')
  return searchableText.toLowerCase().includes(query)
}

/**
 * When a search hits a chat's message body but NOT its title, the title
 * highlight stays empty and the row gives no clue why it matched. This
 * returns a short snippet of the first matching message (centered on the
 * match) so the tile can surface a "found in conversation" hint. Returns
 * null when there's no query, the title already covers the match, or no
 * message body contains the term — in those cases the existing title
 * highlight is enough.
 */
function getChatContentMatchSnippet(chat: ChatRecord, query: string): string | null {
  if (!query) return null
  if (chat.title.toLowerCase().includes(query)) return null
  const summaryPreview = (chat as Partial<ChatListItem>).searchPreview
  if (summaryPreview && summaryPreview.toLowerCase().includes(query)) {
    return summaryPreview
  }
  for (const message of chat.messages || []) {
    if (message.metadata?.kind === 'channelInbound') continue
    const content = message.content || ''
    const matchIndex = content.toLowerCase().indexOf(query)
    if (matchIndex < 0) continue
    const radius = 24
    const start = Math.max(0, matchIndex - radius)
    const end = Math.min(content.length, matchIndex + query.length + radius)
    const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`
  }
  return null
}

function workspaceMatchesSearch(workspace: WorkspaceRecord, query: string): boolean {
  if (!query) return true
  return [workspace.displayName, workspace.path, workspace.branch]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function ChatAgeLabel({ timestamp }: { timestamp: number }): ReactNode {
  const [label, setLabel] = useState(() =>
    Number.isFinite(timestamp) ? formatChatAge(timestamp, Date.now()) : ''
  )

  useEffect(() => {
    if (!Number.isFinite(timestamp)) {
      let cancelled = false
      queueMicrotask(() => {
        if (!cancelled) setLabel((prev) => (prev === '' ? prev : ''))
      })
      return () => {
        cancelled = true
      }
    }
    const compute = () => formatChatAge(timestamp, Date.now())
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setLabel((prev) => {
        const next = compute()
        return prev === next ? prev : next
      })
    })
    const unsubscribe = subscribeAgeTick(() => {
      setLabel((prev) => {
        const next = compute()
        return prev === next ? prev : next
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [timestamp])

  if (!label) return null
  return (
    <span className="sidebar-chat-age" title={formatChatAgeTitle(timestamp)}>
      {label}
    </span>
  )
}

function formatChatAge(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp)) return ''
  const elapsedMs = Math.max(0, now - timestamp)
  const elapsedMinutes = Math.floor(elapsedMs / 60000)
  if (elapsedMinutes < 1) return 'now'
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 7) return `${elapsedDays}d`

  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  // `[]` defers to the runtime's default locale (matches
  // `formatChatAgeTitle` below) instead of hard-coding en-GB.
  return date.toLocaleDateString(
    [],
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: '2-digit' }
  )
}

function formatChatAgeTitle(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatWorkflowTime(value?: string): string {
  if (!value) return 'Manual'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unscheduled'
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatWorkflowTrigger(workflow: WorkflowDefinition): string {
  const trigger = workflow.trigger
  if (trigger.kind === 'manual') return 'Manual'
  if (trigger.kind === 'once') return `Once · ${formatWorkflowTime(trigger.runAt)}`
  if (trigger.kind === 'interval') {
    const minutes = Math.max(1, Math.round((trigger.intervalMs || 60_000) / 60_000))
    if (minutes < 60) return `Every ${minutes}m`
    const hours = Math.round(minutes / 60)
    return `Every ${hours}h`
  }
  return trigger.cronExpression ? `Cron · ${trigger.cronExpression}` : 'Cron'
}

function workflowMatchesSearch(workflow: WorkflowDefinition, query: string): boolean {
  if (!query) return true
  return [
    workflow.name,
    workflow.template.prompt,
    workflow.template.provider,
    workflow.lastStatus,
    formatWorkflowTrigger(workflow)
  ]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function workspaceBoardMatchesSearch(
  board: WorkspaceBoardDefinition,
  workspace: WorkspaceRecord | undefined,
  cards: WorkspaceBoardCard[],
  query: string
): boolean {
  if (!query) return true
  const cardText = cards.flatMap((card) => [
    card.title,
    card.body,
    card.humanOwner,
    card.blockedReason,
    card.nextStep,
    ...(card.labels || [])
  ])
  return [board.name, board.description, workspace?.displayName, workspace?.path, ...cardText]
    .join(' ')
    .toLowerCase()
    .includes(query)
}

const WORKFLOW_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped'])
const WORKFLOW_COUNTER_STATUSES = [
  'running',
  'queued',
  'completed',
  'skipped',
  'failed',
  'cancelled'
] as const

type WorkflowCounterStatus = (typeof WORKFLOW_COUNTER_STATUSES)[number]
type WorkflowActionIconKind =
  | 'run'
  | 'pause'
  | 'resume'
  | 'cadence'
  | 'cancel'
  | 'delete'
  | 'unattended'
  | 'board'

function isWorkflowExecutionActive(status?: string): boolean {
  return Boolean(status && !WORKFLOW_TERMINAL_STATUSES.has(status))
}

function formatWorkflowStatus(status?: string): string {
  if (!status) return 'Idle'
  if (status === 'queued') return 'Queued'
  if (status === 'running') return 'Running'
  if (status === 'completed') return 'Done'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  if (status === 'skipped') return 'Skipped'
  return status
}

function workflowStatusTone(status?: string): 'running' | 'success' | 'warning' | 'danger' | 'muted' {
  if (status === 'queued' || status === 'running') return 'running'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'skipped') return 'warning'
  return 'muted'
}

function getWorkflowStatusCounters(history: WorkflowDefinition['history']) {
  const counts = new Map<WorkflowCounterStatus, number>()
  for (const execution of history) {
    const status = execution.status
    if (!WORKFLOW_COUNTER_STATUSES.includes(status as WorkflowCounterStatus)) continue
    const key = status as WorkflowCounterStatus
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return WORKFLOW_COUNTER_STATUSES.map((status) => ({
    status,
    count: counts.get(status) || 0
  })).filter((item) => item.count > 0)
}

function WorkflowActionIcon({ kind }: { kind: WorkflowActionIconKind }) {
  if (kind === 'run') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M6.2 5.2 17.9 12 6.2 18.8Z" />
        <path d="M17.4 4.2 16.1 6.3" />
        <path d="M20.1 7.1 17.8 8.1" />
        <path d="M19.8 16.9 17.7 15.7" />
      </svg>
    )
  }
  if (kind === 'board') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4.5 5.5h15" />
        <path d="M4.5 12h15" />
        <path d="M4.5 18.5h15" />
        <path d="M9 4v16" />
        <path d="M15 4v16" />
      </svg>
    )
  }
  if (kind === 'pause') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M7.2 5.3v13.4" />
        <path d="M14.2 5.3v13.4" />
        <path d="M18.4 7.3c1.2 1.25 1.85 2.85 1.85 4.7s-.65 3.45-1.85 4.7" />
        <circle cx="19.3" cy="12" r=".75" />
      </svg>
    )
  }
  if (kind === 'resume') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M7 5.2 17.7 12 7 18.8Z" />
        <path d="M4.3 7.4C2.9 9.1 2.5 11.3 3.2 13.4c.75 2.25 2.65 3.75 4.95 4.05" />
        <path d="m6.9 15.2 1.35 2.25-2.35 1.15" />
      </svg>
    )
  }
  if (kind === 'cadence') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M6.2 6.4A7.7 7.7 0 0 1 19.7 11" />
        <path d="m17.6 9.6 2.1 1.4 1.15-2.2" />
        <path d="M17.8 17.6A7.7 7.7 0 0 1 4.3 13" />
        <path d="m6.4 14.4-2.1-1.4-1.15 2.2" />
        <path d="M12 7.2v5l3 1.75" />
      </svg>
    )
  }
  if (kind === 'cancel') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M6.1 6.1h11.8v11.8H6.1Z" />
        <path d="M5 19 19 5" />
      </svg>
    )
  }
  if (kind === 'unattended') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 4.5 21 19.5H3Z" />
        <path d="M12 10v4.5" />
        <circle cx="12" cy="17.4" r=".75" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5.6 7.2h12.8" />
      <path d="M9.1 7.1 9.8 4.8h4.4l.7 2.3" />
      <path d="M7.5 9.5 8.35 19h7.3l.85-9.5" />
      <path d="M10.4 11.5v5" />
      <path d="M13.6 11.5v5" />
    </svg>
  )
}

function WorkflowStatusCounterIcon({ status }: { status: WorkflowCounterStatus }) {
  if (status === 'completed') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M4.2 12.3 9.2 17.2 19.8 6.8" />
        <path d="M5.1 5.2h13.8v13.6H5.1Z" opacity=".34" />
      </svg>
    )
  }
  if (status === 'skipped') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M5.1 6.2 12 12 5.1 17.8Z" />
        <path d="M12.4 6.2 19.3 12l-6.9 5.8Z" />
        <path d="M20.4 6.5v11" />
      </svg>
    )
  }
  if (status === 'failed') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="m12 3.9 8.1 8.1-8.1 8.1L3.9 12Z" />
        <path d="m9.2 9.2 5.6 5.6" />
        <path d="m14.8 9.2-5.6 5.6" />
      </svg>
    )
  }
  if (status === 'cancelled') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M8.4 4.3h7.2l4.1 4.1v7.2l-4.1 4.1H8.4l-4.1-4.1V8.4Z" />
        <path d="M7.5 16.5 16.5 7.5" />
      </svg>
    )
  }
  if (status === 'running') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M5.7 6.7A7.9 7.9 0 0 1 20 11.2" />
        <path d="m17.8 9.8 2.2 1.4 1.05-2.3" />
        <path d="M18.3 17.3A7.9 7.9 0 0 1 4 12.8" />
        <path d="m6.2 14.2-2.2-1.4-1.05 2.3" />
        <path d="M8.1 12h2.1l1.25-3.2 2.25 6.4 1.25-3.2h1.85" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 6.2h12" />
      <path d="M6 11.9h12" />
      <path d="M6 17.6h8.2" />
      <path d="m16.1 15.4 2.4 2.2-2.4 2.2" />
    </svg>
  )
}

function getWorkspaceMeta(workspace: WorkspaceRecord): string {
  const pathParts = workspace.path.split(/[\\/]/).filter(Boolean)
  const compactPath = pathParts.length > 2 ? `.../${pathParts.slice(-2).join('/')}` : workspace.path
  return [compactPath, workspace.branch ? `branch ${workspace.branch}` : '']
    .filter(Boolean)
    .join(' · ')
}

function HighlightMatch({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerText.indexOf(lowerQuery, cursor)

  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex))
    }
    const matchEnd = matchIndex + lowerQuery.length
    parts.push(
      <mark key={`${matchIndex}-${matchEnd}`} className="sidebar-search-highlight">
        {text.slice(matchIndex, matchEnd)}
      </mark>
    )
    cursor = matchEnd
    matchIndex = lowerText.indexOf(lowerQuery, cursor)
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return parts.length > 0 ? parts : text
}

type SidebarRunStatusSnapshot = {
  label: string
  tone: 'success' | 'warning' | 'danger' | 'muted'
} | null

function getLastRunStatus(chat: ChatRecord): SidebarRunStatusSnapshot {
  const run = (chat as Partial<ChatListItem>).lastRun || chat.runs?.[chat.runs.length - 1]
  if (!run) return null
  if (run.status === 'sleeping') return { label: 'Sleeping', tone: 'warning' }
  if (!run.endedAt && run.status !== 'failed' && run.status !== 'cancelled') {
    return { label: 'Running', tone: 'warning' }
  }
  if (run.status === 'success') return { label: 'Done', tone: 'success' }
  if (run.status === 'success_with_warnings') return { label: 'Warnings', tone: 'warning' }
  if (run.status === 'failed') return { label: 'Failed', tone: 'danger' }
  if (run.status === 'cancelled') return { label: 'Cancelled', tone: 'muted' }
  return { label: run.status || 'Completed', tone: 'muted' }
}

function sidebarChatRunStatusText(
  isRunning: boolean,
  lastRunStatus: SidebarRunStatusSnapshot,
  needsInput = false
): string | null {
  if (needsInput) return 'needs input'
  if (isRunning) return 'running'
  if (lastRunStatus) return lastRunStatus.label
  return null
}

function buildSidebarChatRowA11y(args: {
  chatId: string
  title: string
  provider?: ProviderId
  providerLabel?: string
  selected: boolean
  isRunning: boolean
  needsInput?: boolean
  lastRunStatus: SidebarRunStatusSnapshot
  rowTone?: SidebarRowTone | null
  prefix?: string
}): {
  ariaLabel: string
  ariaCurrent?: 'page'
  statusDescribedById?: string
  statusDescription?: string
} {
  const provider = args.providerLabel ?? getProviderName(args.provider)
  const statusText = sidebarChatRunStatusText(
    args.isRunning,
    args.lastRunStatus,
    Boolean(args.needsInput)
  )
  const titlePart = args.prefix ? `${args.prefix}: ${args.title}` : args.title
  const parts = [titlePart, provider]
  if (statusText) parts.push(statusText)
  // `needsInput` already contributes "needs input" via statusText for the
  // question case; the waiting tone also covers approvals, so name it only
  // when statusText did not already say so.
  if (args.rowTone === 'waiting' && !args.needsInput) parts.push('waiting on your response')
  if (args.rowTone === 'sleeping') parts.push('sleeping until its next wake-up')
  if (args.rowTone === 'success') parts.push('goal or task completed, unread')
  if (args.rowTone === 'failure') parts.push('goal blocked or task failed, unread')
  if (args.selected) parts.push('selected')
  const failed = !args.isRunning && !args.needsInput && args.lastRunStatus?.tone === 'danger'
  return {
    ariaLabel: parts.join(', '),
    ariaCurrent: args.selected ? 'page' : undefined,
    ...(failed
      ? {
          statusDescribedById: `sidebar-chat-status-${args.chatId}`,
          statusDescription: `Last run failed: ${args.lastRunStatus!.label}`
        }
      : args.needsInput
        ? {
            statusDescribedById: `sidebar-chat-status-${args.chatId}`,
            statusDescription: 'Agent is waiting for your answer'
          }
        : {})
  }
}

// Shared shell for the three footer control popovers (Approvals / Shares /
// Devices). Mirrors the SidebarSettingsMenu philosophy: a small anchored panel
// whose body lists live state and whose bottom item deep-links to the matching
// Settings tab. The expanded sidebar wraps each trigger + popover in its own
// anchor so widened panels can grow from the summoning icon instead of the
// whole footer cluster. The collapsed corner pill keeps its own CSS override.
function SidebarFooterPopover({
  title,
  navLabel,
  onNav,
  ariaLabel,
  className,
  children
}: {
  title: string
  navLabel: string
  onNav: () => void
  ariaLabel?: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={`sidebar-footer-popover${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel ?? title}
    >
      <div className="sidebar-footer-popover-title">{title}</div>
      <div className="sidebar-footer-popover-body">{children}</div>
      <div className="sidebar-settings-menu-divider" aria-hidden />
      <button
        type="button"
        className="sidebar-settings-menu-item sidebar-footer-popover-nav"
        onClick={onNav}
      >
        <span className="sidebar-settings-menu-item-label">{navLabel}</span>
        <MenuChevronIcon />
      </button>
    </div>
  )
}

// Approvals popover — pending agent questions + approvals (each a deep-link into
// the thread that's waiting), then the most recent resolved decisions, then a
// deep-link to Settings → Approvals & Grants. `loadRecent` is injected so the
// pure rendering is testable without the IPC bridge.
const APPROVALS_POPOVER_PENDING_LIMIT = 6
export function ApprovalsFooterPopover({
  pendingApprovals,
  pendingQuestions = [],
  resolveChatTitle,
  onJumpToChat,
  onRespondApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenSettings,
  loadRecent
}: {
  /** Each pending approval paired with the chatId it is filed under (the jump
   * target — see pendingApprovalsFlat). */
  pendingApprovals: Array<{ chatId: string; approval: AgentApprovalRequest }>
  /** Pending `ask_user_question` cards across chats — same jump target shape. */
  pendingQuestions?: Array<{ chatId: string; question: AgentQuestionState }>
  resolveChatTitle?: (chatId: string) => string | undefined
  onJumpToChat?: (chatId: string) => void
  onRespondApproval?: (requestId: string, action: AgentApprovalAction) => void | Promise<void>
  onAnswerQuestion?: (
    questionId: string,
    answer: string,
    isCustom: boolean
  ) => void | Promise<void>
  onDismissQuestion?: (questionId: string) => void | Promise<void>
  onOpenSettings: () => void
  loadRecent?: () => Promise<ApprovalLedgerRecord[]>
}) {
  const [recent, setRecent] = useState<ApprovalLedgerRecord[]>([])
  useEffect(() => {
    if (!loadRecent) return
    let cancelled = false
    loadRecent()
      .then((records) => {
        if (!cancelled) setRecent(records.slice(0, 3))
      })
      .catch(() => {
        if (!cancelled) setRecent([])
      })
    return () => {
      cancelled = true
    }
  }, [loadRecent])

  const pendingShown = pendingApprovals.slice(0, APPROVALS_POPOVER_PENDING_LIMIT)
  const pendingOverflow = pendingApprovals.length - pendingShown.length
  const questionsShown = pendingQuestions.slice(0, APPROVALS_POPOVER_PENDING_LIMIT)
  const questionsOverflow = pendingQuestions.length - questionsShown.length
  const hasAnyPending = pendingApprovals.length > 0 || pendingQuestions.length > 0
  const popoverTitle =
    pendingQuestions.length > 0 && pendingApprovals.length === 0
      ? 'Needs your input'
      : pendingQuestions.length > 0
        ? 'Needs your input'
        : 'Approvals'
  const pendingLiveSummary = (() => {
    const parts: string[] = []
    if (pendingQuestions.length > 0) {
      parts.push(
        `${pendingQuestions.length} pending question${pendingQuestions.length === 1 ? '' : 's'}`
      )
    }
    if (pendingApprovals.length > 0) {
      parts.push(
        `${pendingApprovals.length} pending approval${pendingApprovals.length === 1 ? '' : 's'}`
      )
    }
    return parts.length === 0 ? 'No pending approvals or questions' : parts.join(', ')
  })()

  return (
    <SidebarFooterPopover
      title={popoverTitle}
      ariaLabel="Pending questions, approvals, and recent decisions"
      className="is-approvals"
      navLabel="Approvals & Grants"
      onNav={onOpenSettings}
    >
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {pendingLiveSummary}
      </div>
      {/* Host Arc 4.3e — Host connection state lives here, NOT in the Devices
          popover, because that chrome is gated behind IOS_REMOTE_ENABLED and
          Host is not an iOS feature: with the flag off, Desktop's only Host
          surface would disappear entirely.

          Approvals is the honest home for it. Host reachability is exactly
          what decides whether the list below can be trusted — an unreachable
          Host means these approvals may be stale, and saying so beside them is
          more useful than saying it somewhere else. */}
      <HostStatusRow />
      {!hasAnyPending ? (
        <div className="sidebar-footer-popover-empty">No pending approvals or questions</div>
      ) : null}

      {questionsShown.length > 0 ? (
        <>
          <div className="sidebar-footer-popover-subhead">Questions</div>
          {questionsShown.map(({ chatId, question }) => {
            const providerLabel = question.provider
              ? getProviderLabel(question.provider)
              : 'Agent'
            const chatTitle = resolveChatTitle?.(chatId)?.trim() || 'Thread'
            const options = question.options ?? []
            const canAnswerInline = Boolean(onAnswerQuestion) && options.length > 0
            const rowLabel =
              chatId && onJumpToChat
                ? `${question.question}, ${providerLabel}, open thread`
                : `${question.question}, ${providerLabel}`
            const summary =
              chatId && onJumpToChat ? (
                <button
                  type="button"
                  className="sidebar-footer-approval-row is-clickable sidebar-footer-approval-summary"
                  onClick={() => onJumpToChat(chatId)}
                  aria-label={rowLabel}
                >
                  <span className="sidebar-footer-led is-pending" aria-hidden />
                  <span className="sidebar-footer-approval-title">{question.question}</span>
                  <span className="sidebar-footer-approval-meta">
                    {providerLabel} · {chatTitle}
                  </span>
                </button>
              ) : (
                <div
                  className="sidebar-footer-approval-row sidebar-footer-approval-summary"
                  aria-label={rowLabel}
                >
                  <span className="sidebar-footer-led is-pending" aria-hidden />
                  <span className="sidebar-footer-approval-title">{question.question}</span>
                  <span className="sidebar-footer-approval-meta">
                    {providerLabel} · {chatTitle}
                  </span>
                </div>
              )
            return (
              <div
                className="sidebar-footer-approval-pending"
                key={question.questionId}
                data-agent-question-id={question.questionId}
              >
                {summary}
                {question.context ? (
                  <div className="sidebar-footer-approval-meta sidebar-footer-question-context">
                    {question.context}
                  </div>
                ) : null}
                {canAnswerInline ? (
                  <div
                    className="sidebar-footer-approval-actions"
                    aria-label={`Answer choices for ${question.question}`}
                  >
                    {options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="sidebar-footer-approval-action is-approve"
                        title={option}
                        onClick={() => void onAnswerQuestion?.(question.questionId, option, false)}
                      >
                        {option}
                      </button>
                    ))}
                    {onDismissQuestion ? (
                      <button
                        type="button"
                        className="sidebar-footer-approval-action is-deny"
                        title="Skip this question"
                        onClick={() => void onDismissQuestion(question.questionId)}
                      >
                        Skip
                      </button>
                    ) : null}
                  </div>
                ) : onJumpToChat && chatId ? (
                  <div className="sidebar-footer-approval-meta">
                    Open the thread to type your answer.
                  </div>
                ) : null}
              </div>
            )
          })}
          {questionsOverflow > 0 && (
            <div className="sidebar-footer-popover-more">
              +{questionsOverflow} more question{questionsOverflow === 1 ? '' : 's'}
            </div>
          )}
        </>
      ) : null}

      {pendingShown.length > 0 ? (
        <>
          {pendingQuestions.length > 0 ? (
            <div className="sidebar-footer-popover-subhead">Approvals</div>
          ) : null}
          {pendingShown.map(({ chatId, approval }) => {
            const providerLabel = getProviderLabel(approval.provider)
            const actions = approval.actions || []
            // Signed-elevated canvas_eval must be reviewed in the task, where the
            // live (non-durable) card shows the exact script. The compact sidebar
            // row intentionally cannot approve a title-only summary.
            const requiresDetailedReview = isCanvasEvalApprovalToolName(
              approval.preview?.toolName
            ) || approval.preview?.requiresExactDesktopReview === true
            const canApprove = actions.includes('accept') && !requiresDetailedReview
            const alwaysAllowAction: AgentApprovalAction | null = actions.includes('acceptForWorkspace')
              ? requiresDetailedReview
                ? null
                : 'acceptForWorkspace'
              : actions.includes('acceptForSession') && !requiresDetailedReview
                ? 'acceptForSession'
                : null
            const canDeny = actions.includes('decline')
            const hasInlineActions =
              Boolean(onRespondApproval) && (canApprove || Boolean(alwaysAllowAction) || canDeny)
            const rowLabel = chatId && onJumpToChat
              ? `${approval.title}, ${providerLabel}, open thread`
              : `${approval.title}, ${providerLabel}`
            const summary = chatId && onJumpToChat ? (
              <button
                type="button"
                className="sidebar-footer-approval-row is-clickable sidebar-footer-approval-summary"
                onClick={() => onJumpToChat(chatId)}
                aria-label={rowLabel}
              >
                <span className="sidebar-footer-led is-pending" aria-hidden />
                <span className="sidebar-footer-approval-title">{approval.title}</span>
                <span className="sidebar-footer-approval-meta">{providerLabel}</span>
              </button>
            ) : (
              <div
                className="sidebar-footer-approval-row sidebar-footer-approval-summary"
                aria-label={rowLabel}
              >
                <span className="sidebar-footer-led is-pending" aria-hidden />
                <span className="sidebar-footer-approval-title">{approval.title}</span>
                <span className="sidebar-footer-approval-meta">{providerLabel}</span>
              </div>
            )
            return (
              <div className="sidebar-footer-approval-pending" key={approval.id}>
                {summary}
                {requiresDetailedReview && (
                  <div className="sidebar-footer-approval-meta">
                    Review the exact script in the task before approving.
                  </div>
                )}
                {hasInlineActions && (
                  <div
                    className="sidebar-footer-approval-actions"
                    aria-label={`Actions for ${approval.title}`}
                  >
                    {canApprove && (
                      <button
                        type="button"
                        className="sidebar-footer-approval-action is-approve"
                        title="Approve this request once."
                        onClick={() => void onRespondApproval?.(approval.id, 'accept')}
                      >
                        Approve
                      </button>
                    )}
                    {alwaysAllowAction && (
                      <button
                        type="button"
                        className="sidebar-footer-approval-action is-always"
                        title={
                          alwaysAllowAction === 'acceptForWorkspace'
                            ? 'Allow this kind of request for this workspace until revoked in Approvals & Grants.'
                            : 'Allow matching requests for the rest of this app session.'
                        }
                        onClick={() => void onRespondApproval?.(approval.id, alwaysAllowAction)}
                      >
                        Always Allow
                      </button>
                    )}
                    {canDeny && (
                      <button
                        type="button"
                        className="sidebar-footer-approval-action is-deny"
                        title="Deny this request."
                        onClick={() => void onRespondApproval?.(approval.id, 'decline')}
                      >
                        Deny
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {pendingOverflow > 0 && (
            <div className="sidebar-footer-popover-more">+{pendingOverflow} more pending</div>
          )}
        </>
      ) : null}

      {recent.length > 0 && (
        <>
          <div className="sidebar-footer-popover-subhead">Recent</div>
          {recent.map((record) => (
            <div className="sidebar-footer-approval-row" key={record.id} title={record.title}>
              <span
                className={`sidebar-footer-led ${
                  record.status === 'approved' ? 'is-on' : 'is-denied'
                }`}
                aria-hidden
              />
              <span className="sidebar-footer-approval-title">{record.title}</span>
              <span className="sidebar-footer-approval-meta">{record.status}</span>
            </div>
          ))}
        </>
      )}
    </SidebarFooterPopover>
  )
}

// Shares popover — each active shared chat with its mode + active-collaborator
// count, a click-to-open affordance, and a per-share "Stop" (revoke), then a
// deep-link to Settings → Shares.
function shareModeLabel(mode: HumanCollaborationShare['mode']): string {
  return mode === 'readOnly' ? 'Read-only' : 'Comments'
}
export function SharesFooterPopover({
  shares,
  resolveChatTitle,
  connectedShareChatIds,
  onJumpToChat,
  onRevokeShare,
  onOpenSettings
}: {
  shares: HumanCollaborationShare[]
  resolveChatTitle?: (chatId: string) => string | undefined
  connectedShareChatIds?: Set<string>
  onJumpToChat?: (chatId: string) => void
  onRevokeShare?: (shareId: string) => void
  onOpenSettings: () => void
}) {
  return (
    <SidebarFooterPopover
      title="People"
      ariaLabel="Active People chats"
      navLabel="Manage shares"
      onNav={onOpenSettings}
    >
      {shares.length === 0 ? (
        <div className="sidebar-footer-popover-empty">No active shares</div>
      ) : (
        shares.map((share) => {
          const title = resolveChatTitle?.(share.chatId) || 'People chat'
          const isConnected = connectedShareChatIds?.has(share.chatId) ?? false
          const active = share.participants.filter(
            (participant) => participant.status === 'active'
          ).length
          return (
            <div className="sidebar-footer-share-row" key={share.shareId}>
              <button
                type="button"
                className={`sidebar-footer-share-main${onJumpToChat ? ' is-clickable' : ''}`}
                onClick={onJumpToChat ? () => onJumpToChat(share.chatId) : undefined}
                title={title}
              >
                <span className="sidebar-footer-share-title">{title}</span>
                <span className="sidebar-footer-share-sub">
                  {shareModeLabel(share.mode)} ·{' '}
                  {active > 0 ? `${active} active` : 'Awaiting collaborator'}
                  {' · '}
                  {isConnected ? 'Live' : 'Not connected'}
                </span>
              </button>
              {onRevokeShare && (
                <button
                  type="button"
                  className="sidebar-footer-share-revoke"
                  onClick={() => onRevokeShare(share.shareId)}
                  title="Stop sharing"
                  aria-label={`Stop sharing ${title}`}
                >
                  Stop
                </button>
              )}
            </div>
          )
        })
      )}
    </SidebarFooterPopover>
  )
}

// Devices popover — up to five paired devices, each with a connected/idle LED,
// or an empty state, then a deep-link to Settings → Devices. The summaries
// expose only a `connected` boolean (no last-seen), so the LED is green when
// connected and grey ("Idle") otherwise.
const DEVICES_POPOVER_LIMIT = 5
export function DevicesFooterPopover({
  devices = [],
  onOpenSettings
}: {
  devices?: PairedRemoteDeviceSummary[]
  onOpenSettings: () => void
}) {
  const shown = devices.slice(0, DEVICES_POPOVER_LIMIT)
  const overflow = devices.length - shown.length
  return (
    <SidebarFooterPopover
      title="Devices"
      ariaLabel="Paired devices"
      navLabel="Manage devices"
      onNav={onOpenSettings}
    >
      {devices.length === 0 ? (
        <div className="sidebar-footer-popover-empty">No paired devices</div>
      ) : (
        <>
          {shown.map((device) => (
            <div className="sidebar-footer-device-row" key={device.iphoneIdentityPubKey}>
              <span
                className={`sidebar-footer-led${device.connected ? ' is-on' : ''}`}
                aria-hidden
              />
              <span className="sidebar-footer-device-name">
                {device.controllerDisplayName || 'Paired device'}
              </span>
              <span className="sidebar-footer-device-status">
                {device.connected ? 'Connected' : 'Idle'}
              </span>
            </div>
          ))}
          {overflow > 0 && (
            <div className="sidebar-footer-popover-more">+{overflow} more</div>
          )}
        </>
      )}
    </SidebarFooterPopover>
  )
}

export function Sidebar({
  workspaces,
  currentWorkspace,
  chats,
  currentChat,
  activeChatId,
  animationClassName = '',
  focusSearchRequestId,
  searchShortcutHint = '⇧⌘F',
  usageSummary,
  runningChatIds = [],
  pluginWorkflowTemplates = [],
  workflows = [],
  workspaceBoards = [],
  workspaceBoardCards = [],
  activeWorkspaceBoardId = null,
  scheduledTasks = [],
  collaboratingChatIds = new Set<string>(),
  composerDraftChatIds,
  initialExpandedSubThreadParentIds = [],
  showOnboardingHint = false,
  onDismissOnboardingHint,
  onSelectWorkspace,
  onRemoveWorkspace,
  onSelectWorkspaceDialog,
  onNewChat,
  onNewGlobalChat,
  onNewEnsemble,
  ensembleModeEnabled = true,
  onPrimarySurfaceSelect,
  onActiveSidebarTabChange,
  onSelectChat,
  onStartProjectHome,
  onSelectedProjectChange,
  onOpenReferencesLibrary,
  onOpenThreadGraph,
  projectGraphEntries,
  activeThreadGraphProjectId,
  onOpenChatInSidePanel,
  onOpenInMultiview,
  onOpenSettings,
  updateSnapshot,
  onQuickUpdate,
  onOpenChangelog,
  appearanceQuickSettings,
  onAppearanceQuickChange,
  onOpenWorkspacePopout,
  canOpenWorkspacePopout = false,
  onQuitApp,
  onCreateSubThread,
  onTogglePinChat,
  onTogglePinWorkspace,
  onSetChatHiddenFromMainList,
  onClearChatGitWorkflow,
  activeChatIdentityTicker,
  activeChatIdentityGitIndicators,
  activeChatIdentityBranch,
  onToggleArchiveChat,
  onDeleteChat,
  onRenameChat,
  onInspectRun,
  onCreateWorkflowFromPluginTemplate,
  onCreateWorkflow,
  onCreateWorkspaceBoard,
  onOpenWorkspaceBoard,
  onRenameWorkspaceBoard,
  onDuplicateWorkspaceBoard,
  onTogglePinWorkspaceBoard,
  onArchiveWorkspaceBoard,
  onRestoreWorkspaceBoard,
  onDeleteWorkspaceBoard,
  onAddChatToWorkspaceBoard,
  onAddWorkflowToWorkspaceBoard,
  onAddRunQueueJobToWorkspaceBoard,
  onAddLocalServerToWorkspaceBoard,
  onCreateSharedChat,
  onJoinSharedChat,
  onRunWorkflowNow,
  onToggleWorkflowEnabled,
  onEditWorkflowInterval,
  onCancelWorkflowExecution,
  onDeleteWorkflow,
  onSetWorkflowUnattended,
  onOpenSettingsTab,
  pendingAgentApprovalByChatId = {},
  pendingApprovalQueueByChatId = {},
  onRespondAgentApproval,
  pendingAgentQuestionsByChatId = {},
  onAnswerAgentQuestion,
  onDismissAgentQuestion,
  collaborationShares = [],
  onRevokeShare,
  hasConnectedCollaborator = false,
  modelUsageApiSpend
}: SidebarProps) {
  const [hoveredWorkspace, setHoveredWorkspace] = useState<string | null>(null)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [newMenuSharedOpen, setNewMenuSharedOpen] = useState(false)
  const [newMenuWorkflowTemplatesOpen, setNewMenuWorkflowTemplatesOpen] = useState(false)
  const [sharedCreateMenuOpen, setSharedCreateMenuOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [settingsMenuPane, setSettingsMenuPane] = useState<SidebarSettingsMenuPane>('root')
  // Footer control-row popovers (Approvals / Shares / Devices). At most one is
  // open at a time — each button's onClick closes the others (and the settings
  // menu) before toggling itself.
  const [approvalsPopoverOpen, setApprovalsPopoverOpen] = useState(false)
  const [sharesPopoverOpen, setSharesPopoverOpen] = useState(false)
  const [devicesPopoverOpen, setDevicesPopoverOpen] = useState(false)
  // Deep-link helper for the footer popovers' bottom nav items. Falls back to
  // the generic Settings opener for any caller that hasn't wired the tab-aware
  // callback (keeps the prop optional).
  const openSettingsTab = useCallback(
    (tab: 'pairing' | 'approval-ledger' | 'shares') => {
      if (onOpenSettingsTab) onOpenSettingsTab(tab)
      else onOpenSettings()
    },
    [onOpenSettingsTab, onOpenSettings]
  )
  // Host Arc Wave 5c Phase 2 — dual-read join. Host not live → AppStore
  // verbatim; Host live + shadow-backed → Host membership filters AppStore
  // rows by approvalId. Heads-first flatten lives in joinHostPendingApprovals.
  const hostProjectionStore = useHostProjectionStore()
  const hostProjectionState = useHostProjection(hostProjectionStore)
  const pendingApprovalsFlat = useMemo(
    () =>
      joinHostPendingApprovals(
        hostProjectionState,
        pendingAgentApprovalByChatId,
        pendingApprovalQueueByChatId
      ),
    [hostProjectionState, pendingAgentApprovalByChatId, pendingApprovalQueueByChatId]
  )
  const pendingQuestionsFlat = useMemo(
    () =>
      joinHostPendingQuestions(
        hostProjectionState,
        pendingAgentQuestionsByChatId
      ),
    [hostProjectionState, pendingAgentQuestionsByChatId]
  )
  const hasPendingApprovals = pendingApprovalsFlat.length > 0
  const hasPendingQuestions = pendingQuestionsFlat.length > 0
  const hasNeedsInputAttention = hasPendingApprovals || hasPendingQuestions
  const resolveChatTitleForAttention = useCallback(
    (chatId: string) => chats.find((candidate) => candidate.appChatId === chatId)?.title,
    [chats]
  )
  const footerPopoverActive = approvalsPopoverOpen || sharesPopoverOpen || devicesPopoverOpen
  // Stable so the Approvals popover doesn't re-fetch the ledger on every
  // unrelated Sidebar re-render (e.g. the 5s device poll) while it's open.
  const loadRecentApprovals = useCallback(
    () => window.api.getApprovalLedger({ statuses: ['approved', 'denied'], limit: 3 }),
    []
  )
  /*
   * 1.0.5-SB5 — Drag-and-drop pinning state. `draggedChatId`
   * carries the id of the chat currently being dragged so the
   * Pinned section + its empty-state drop hint know whether to
   * render. `pinDropActive` flips true when the cursor crosses
   * the Pinned drop target so the section gets a visual
   * highlight (CSS `[data-pin-drop="active"]`). Both reset on
   * `dragend` regardless of whether the drop succeeded.
   *
   * The custom MIME type prevents accidental triggers from
   * external drags (image files into the sidebar etc.) — only
   * payloads carrying `application/x-taskwraith-chat-id` count as
   * a sidebar drag.
   */
  const [draggedChatId, setDraggedChatId] = useState<string | null>(null)
  const [pinDropActive, setPinDropActive] = useState(false)
  const [sidebarThreadOrderState, setSidebarThreadOrderState] =
    useState<SidebarThreadOrderState>(() => loadSidebarThreadOrderState())
  const draggedThreadPayloadRef = useRef<SidebarThreadDragPayload | null>(null)
  const [draggedThreadPayload, setDraggedThreadPayload] =
    useState<SidebarThreadDragPayload | null>(null)
  const [threadDropTarget, setThreadDropTarget] = useState<SidebarThreadDragPayload | null>(null)
  useEffect(() => {
    saveSidebarThreadOrderState(sidebarThreadOrderState)
  }, [sidebarThreadOrderState])
  // 1.0.3 sidebar rename — single source of "which chat row is being
  // edited right now". Key by both chat id AND render surface: the same
  // chat can appear in Recents, Workspaces, Pinned, and Shared at once.
  // A chat-id-only edit flag mounts multiple inputs; their autofocus/blur
  // handlers fight and can instantly cancel the rename.
  const [editingChatTarget, setEditingChatTarget] = useState<{
    chatId: string
    surfaceId: string
  } | null>(null)
  const [terminalOutcomeAcknowledgements, setTerminalOutcomeAcknowledgements] =
    useState(loadSidebarTerminalOutcomeAcknowledgements)
  // Seeded once, on the first render this install ever performs. Everything
  // that had already finished by then is history and stays quiet; see
  // loadOrSeedSidebarSuccessInkEpoch.
  const [successInkEpochMs] = useState(() => loadOrSeedSidebarSuccessInkEpoch(Date.now()))
  const terminalOutcomeAcknowledgementsRef = useRef(terminalOutcomeAcknowledgements)
  terminalOutcomeAcknowledgementsRef.current = terminalOutcomeAcknowledgements
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  // Wrap ref for the `+ New` menu so an outside-click / Escape listener
  // can dismiss the popover without each menu item having to remember
  // to call `setNewMenuOpen(false)`. Mirrors the standard pattern the
  // rest of the app uses for floating menus (overflow menus, slash
  // menu portal, etc.).
  const newMenuWrapRef = useRef<HTMLDivElement | null>(null)
  const sharedCreateMenuWrapRef = useRef<HTMLDivElement | null>(null)
  const settingsMenuWrapRef = useRef<HTMLDivElement | null>(null)
  // One wrap around the whole footer control cluster (Approvals/Shares/Devices
  // anchors + their popovers) so a single outside-click/Escape listener
  // dismisses whichever popover is open.
  const footerControlsWrapRef = useRef<HTMLDivElement | null>(null)
  // Ref to the sidebar search <input>. App.tsx owns the editable key command
  // and bumps `focusSearchRequestId` when it should focus this field.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [projectsSearchResultCount, setProjectsSearchResultCount] = useState(0)
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarActiveTab>(() => {
    try {
      const storedTab = localStorage.getItem(SIDEBAR_ACTIVE_TAB_STORAGE_KEY)
      if (storedTab === 'projects') return 'projects'

      const selectedChat =
        chats.find((chat) => chat.appChatId === activeChatId) || currentChat || null
      if (selectedChat) return getChatSidebarTab(selectedChat)

      return storedTab === 'chat' ? 'chat' : 'threads'
    } catch {
      return 'threads'
    }
  })
  const [sidebarSearchByTab, setSidebarSearchByTab] = useState<Record<SidebarActiveTab, string>>({
    chat: '',
    threads: '',
    projects: ''
  })
  const sidebarSearch = sidebarSearchByTab[activeSidebarTab]
  const setActiveSidebarSearch = useCallback(
    (next: string): void => {
      setSidebarSearchByTab((current) => ({ ...current, [activeSidebarTab]: next }))
    },
    [activeSidebarTab]
  )
  const [remoteDeviceConnected, setRemoteDeviceConnected] = useState(false)
  const [pairedDevices, setPairedDevices] = useState<PairedRemoteDeviceSummary[]>([])
  const startupExpandedWorkspaceId = defaultExpandedWorkspaceId(workspaces, currentWorkspace)
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(() =>
    defaultExpandedWorkspaceIds(workspaces, currentWorkspace)
  )
  const expandedWorkspaceStartupSeededRef = useRef(expandedWorkspaceIds.size > 0)
  const [expandedSubThreadParentIds, setExpandedSubThreadParentIds] = useState<Set<string>>(
    () =>
      new Set(
        initialExpandedSubThreadParentIds.filter(
          (value): value is string => typeof value === 'string'
        )
      )
  )
  // Per-list "show more" expansion, keyed by a stable list id
  // ('recents' | 'chats' | 'ensembles' | 'shared' | `ws:${workspaceId}`).
  // Deliberately in-memory (not persisted): a reload returns every list to its
  // compact preview so no section silently reopens huge on next launch.
  const [expandedSidebarLists, setExpandedSidebarLists] = useState<Set<string>>(() => new Set())
  // Section-level collapse state for the top-level sidebar lists.
  // Default all collapsed except Recents. `isSectionCollapsed` below
  // applies a search-active override so a filter pass forces every
  // section open — otherwise a user with collapsed sections would see
  // no results despite typing in the search box.
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Set<SidebarSectionId>>(
    () => {
      try {
        const raw = localStorage.getItem(COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY)
        if (!raw) return defaultCollapsedSidebarSections()
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return defaultCollapsedSidebarSections()
        const saved = new Set(
          parsed.filter((value): value is SidebarSectionId =>
            SIDEBAR_SECTION_IDS.includes(value as SidebarSectionId)
          )
        )
        const version = localStorage.getItem(COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY)
        if (version !== COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION) {
          const migrated = saved.size === 0 ? defaultCollapsedSidebarSections() : new Set(saved)
          for (const sectionId of SIDEBAR_SECTIONS_EXPANDED_BY_DEFAULT) {
            migrated.delete(sectionId)
          }
          return migrated
        }
        return saved
      } catch {
        return defaultCollapsedSidebarSections()
      }
    }
  )
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_ACTIVE_TAB_STORAGE_KEY, activeSidebarTab)
    } catch {
      // Tab memory is best-effort renderer-local state.
    }
  }, [activeSidebarTab])
  // Unstarted iOS welcome-card drafts (0 messages/runs) are real chat records on
  // the Mac but must never surface as chats in the sidebar — the phone keeps one
  // only so its in-progress welcome screen resolves; the Mac never owns it.
  // Workflow chats live ONLY under the Workflows section — they must never leak
  // into Pinned / Recents / Workspaces / Global / Ensembles. A workflow's target
  // chat is an ordinary ChatRecord with no marker, so key off the workflow
  // list's template.chatId. Excluding at `topLevelChats` covers every downstream
  // bucket (regular / ensemble / pinned / recents / workspaces all derive here).
  const workflowChatIds = new Set(workflows.map((workflow) => workflow.template.chatId))
  // Unstarted "New Chat" / "New Ensemble" drafts must never stack in the
  // sidebar until they are begun — they only litter it (esp. ensemble drafts,
  // which the DELETE-ONLY reaper deliberately never collects). Hide every
  // pristine draft EXCEPT: the ones the user is actively on or that are live
  // (the selected chat, any chat with a running/queued run, shared chats),
  // chats holding unsent composer text (typed intent survives a thread
  // switch), and the ONE survivable New Chat — the newest pristine draft,
  // kept visible so preparing a prompt isn't lost when the user checks
  // another thread for context (the create-time reaper sweeps any older
  // drafts down to that single survivor). A hidden draft is not deleted (the
  // reaper owns that) and stays reachable through create-path draft reuse.
  // Intent-bearing drafts (pinned / goal / renamed / todo'd) are kept by the
  // predicate itself.
  const draftVisibilityProtectedIds = new Set<string>(runningChatIds)
  if (activeChatId) draftVisibilityProtectedIds.add(activeChatId)
  if (currentChat?.appChatId) draftVisibilityProtectedIds.add(currentChat.appChatId)
  for (const id of collaboratingChatIds) draftVisibilityProtectedIds.add(id)
  if (composerDraftChatIds) {
    for (const id of composerDraftChatIds) draftVisibilityProtectedIds.add(id)
  }
  const survivableDraftId = findSurvivableUnstartedDraftId(
    chats.filter((chat) => !isContentlessRemoteDraftChat(chat)),
    { protectedChatIds: draftVisibilityProtectedIds }
  )
  if (survivableDraftId) draftVisibilityProtectedIds.add(survivableDraftId)
  const displayChats = chats.filter(
    (chat) =>
      !isContentlessRemoteDraftChat(chat) &&
      !isHideableUnstartedDraft(chat, { protectedChatIds: draftVisibilityProtectedIds })
  )
  const orderSidebarChatList = (listId: string, list: readonly ChatRecord[]): ChatRecord[] =>
    orderSidebarThreads(list, listId, sidebarThreadOrderState)
  const applySidebarThreadDrop = (
    listId: string,
    listIds: readonly string[],
    draggedChatId: string,
    targetChatId: string | null,
    placement: 'before' | 'after'
  ): void => {
    setSidebarThreadOrderState((current) =>
      reorderSidebarThreadOrder(current, listId, listIds, draggedChatId, targetChatId, placement)
    )
  }
  const topLevelChats = displayChats.filter(
    (chat) => !isLinkedChildChat(chat) && !workflowChatIds.has(chat.appChatId)
  )
  const projectSidebarChats = topLevelChats
  const activeChatSurfaceTab: Exclude<SidebarActiveTab, 'projects'> =
    activeSidebarTab === 'chat' ? 'chat' : 'threads'
  const activeSurfaceChats = chats.filter(
    (chat) => getChatSidebarTab(chat) === activeChatSurfaceTab
  )
  const regularChats = topLevelChats.filter((chat) => chat.chatKind !== 'ensemble')
  const ensembleChats = ensembleModeEnabled
    ? topLevelChats.filter(
        (chat) =>
          chat.chatKind === 'ensemble' &&
          !chat.archived &&
          !chat.hiddenFromMainList &&
          getChatSidebarTab(chat) === activeChatSurfaceTab
      )
    : []
  // Workspaces dual-surface ensembles (ALWAYS ALSO): Recents/Pinned already
  // include ensembles; feed workspace-scoped ensembles into the workspace
  // buckets so they appear under their workspace group as well as Ensembles.
  // getChatsByWorkspace still skips archived/global/missing workspaceId.
  // hiddenFromMainList drops a chat from every MAIN section (its Git-section
  // entry keeps it reachable), so filter the workspace feed here too.
  const chatsByWorkspace = getChatsByWorkspace(
    (ensembleModeEnabled ? [...regularChats, ...ensembleChats] : regularChats).filter(
      (chat) => !chat.hiddenFromMainList
    )
  )
  const globalChats = regularChats.filter(
    (chat) => !chat.archived && !chat.hiddenFromMainList && chat.scope === 'global'
  )
  const runningChatIdSet = new Set(runningChatIds)
  const sidebarSearchQuery = normalizeSearchText(sidebarSearch)
  const isSidebarSearchActive = sidebarSearchQuery.length > 0
  const visibleWorkspaceEntries = workspaces
    .map((workspace) => {
      const workspaceChats = orderSidebarChatList(
        `code:workspace:${workspace.id}`,
        chatsByWorkspace.get(workspace.id) || []
      )
      const workspaceMatched = workspaceMatchesSearch(workspace, sidebarSearchQuery)
      const visibleChats = isSidebarSearchActive
        ? workspaceChats.filter((chat) => chatMatchesSearch(chat, sidebarSearchQuery))
        : workspaceChats
      return {
        workspace,
        workspaceChats,
        workspaceMatched,
        visibleChats,
        totalChats: workspaceChats.length
      }
    })
    .filter(
      (entry) => !isSidebarSearchActive || entry.workspaceMatched || entry.visibleChats.length > 0
    )
  const orderedGlobalChats = orderSidebarChatList('chat:chats', globalChats)
  const visibleGlobalChats = isSidebarSearchActive
    ? orderedGlobalChats.filter((chat) => chatMatchesSearch(chat, sidebarSearchQuery))
    : orderedGlobalChats
  const visibleChatCounts = displayChats.reduce(
    (counts, chat) => {
      if (!chat.archived && !chat.hiddenFromMainList) counts[getChatSidebarTab(chat)] += 1
      return counts
    },
    { chat: 0, threads: 0 }
  )
  const totalChatCount = visibleChatCounts.chat + visibleChatCounts.threads
  const workspaceWorkflowIds = new Set(workspaces.map((workspace) => workspace.id))
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const scopedWorkflows = workflows
    .filter((workflow) => workspaceWorkflowIds.has(workflow.workspaceId))
    .slice()
    .sort((left, right) => {
      const leftRunAt = left.nextRunAt ? new Date(left.nextRunAt).getTime() : Number.POSITIVE_INFINITY
      const rightRunAt = right.nextRunAt
        ? new Date(right.nextRunAt).getTime()
        : Number.POSITIVE_INFINITY
      if (leftRunAt !== rightRunAt) return leftRunAt - rightRunAt
      return left.name.localeCompare(right.name)
    })

  // Pinned + Recents derivations. Both honor the search query so the
  // sections collapse alongside the rest of the sidebar when the user
  // is filtering. Computed via `useMemo` to keep React's render output
  // stable across renders that don't actually touch chats/workspaces.
  const pinnedWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.pinned === true),
    [workspaces]
  )
  /*
   * 1.0.5-SB5 — Pinned chats now include Ensemble chats. Pre-SB5
   * `pinnedChats` filtered from `regularChats` (which excludes
   * chatKind === 'ensemble'), so pinning an Ensemble via the
   * overflow menu set the flag but the chat never surfaced in
   * the Pinned section. Lift the filter to the full chat list +
   * subtract pinned ensembles from the Ensembles section below
   * so they don't render twice.
   */
  const pinnedChats = useMemo(
    () =>
      topLevelChats.filter(
        (chat) =>
          chat.pinned === true &&
          !chat.archived &&
          !chat.hiddenFromMainList &&
          getChatSidebarTab(chat) === activeChatSurfaceTab
      ),
    [activeChatSurfaceTab, topLevelChats]
  )
  // 1.0.7 — Recents now includes Ensemble chats (when ensemble mode is on),
  // mirroring the SB5 lift that put ensembles into Pinned. Pre-1.0.7 Recents
  // was built from `regularChats` (which excludes chatKind === 'ensemble'), so
  // an active ensemble thread never surfaced under Recents even when it was the
  // most recently touched chat. Ensembles still render in their own ENSEMBLES
  // section too — same dual-surfacing as a solo chat appearing in Recents,
  // its workspace group (chatsByWorkspace lift above), and Ensembles.
  // `selectRecentChats` already drops archived + pinned.
  const recentSourceChats = ensembleModeEnabled
    ? topLevelChats.filter((chat) => chat.chatKind !== 'ensemble' || !chat.archived)
    : regularChats
  const recentChats = selectRecentChats(
    recentSourceChats.filter(
      (chat) => !chat.hiddenFromMainList && getChatSidebarTab(chat) === activeChatSurfaceTab
    ),
    { limit: SIDEBAR_RECENTS_MAX }
  )
  const orderedEnsembleChats = orderSidebarChatList('code:ensembles', ensembleChats)
  const visibleEnsembleChats = isSidebarSearchActive
    ? orderedEnsembleChats.filter(
        (chat) => !chat.pinned && chatMatchesSearch(chat, sidebarSearchQuery)
      )
    : orderedEnsembleChats.filter((chat) => !chat.pinned)
  const sharedChats = topLevelChats.filter(
    (chat) =>
      collaboratingChatIds.has(chat.appChatId) &&
      !chat.archived &&
      !chat.hiddenFromMainList &&
      getChatSidebarTab(chat) === activeChatSurfaceTab
  )
  const orderedSharedChats = orderSidebarChatList('code:shared', sharedChats)
  const visibleSharedChats = isSidebarSearchActive
    ? orderedSharedChats.filter((chat) => chatMatchesSearch(chat, sidebarSearchQuery))
    : orderedSharedChats

  // Git section — an ADDITIONAL reference surface for chats carrying a git
  // workflow marker (dual-surfacing, the sidebar norm: the same chat keeps
  // rendering in Pinned/Recents/Workspaces/Chats/Shared exactly as before).
  // Deliberately NOT filtered by hiddenFromMainList — this section is where
  // hidden threads stay reachable; `archived` stays the stronger put-away.
  const gitWorkflowChats = topLevelChats.filter(
    (chat) =>
      !chat.archived &&
      getChatSidebarTab(chat) === activeChatSurfaceTab &&
      chatGitWorkflowMarker(chat) !== null
  )
  const visibleGitWorkflowChats = isSidebarSearchActive
    ? gitWorkflowChats.filter((chat) => chatMatchesSearch(chat, sidebarSearchQuery))
    : gitWorkflowChats
  const gitWorkflowGroups = groupChatsByGitWorkflow(visibleGitWorkflowChats).map((group) => ({
    ...group,
    chats: orderSidebarChatList(`code:git:${group.group}`, group.chats)
  }))

  const visiblePinnedWorkspaces =
    activeChatSurfaceTab === 'chat'
      ? []
      : isSidebarSearchActive
        ? pinnedWorkspaces.filter((workspace) =>
            workspaceMatchesSearch(workspace, sidebarSearchQuery)
          )
        : pinnedWorkspaces
  const orderedPinnedChats = orderSidebarChatList('code:pinned', pinnedChats)
  const visiblePinnedChats = isSidebarSearchActive
    ? orderedPinnedChats.filter((chat) => chatMatchesSearch(chat, sidebarSearchQuery))
    : orderedPinnedChats
  const orderedRecentChats = orderSidebarChatList('code:recents', recentChats)
  const visibleRecentChats = isSidebarSearchActive
    ? orderedRecentChats.filter((chat) => chatMatchesSearch(chat, sidebarSearchQuery))
    : orderedRecentChats
  const visibleWorkflows = isSidebarSearchActive
    ? scopedWorkflows.filter((workflow) => workflowMatchesSearch(workflow, sidebarSearchQuery))
    : scopedWorkflows
  const workspaceBoardCardsByBoardId = useMemo(() => {
    const map = new Map<string, WorkspaceBoardCard[]>()
    for (const card of workspaceBoardCards) {
      if (card.archived) continue
      const cardsForBoard = map.get(card.boardId) || []
      cardsForBoard.push(card)
      map.set(card.boardId, cardsForBoard)
    }
    return map
  }, [workspaceBoardCards])
  const visibleWorkspaceBoards = (isSidebarSearchActive
    ? workspaceBoards.filter((board) =>
        workspaceBoardMatchesSearch(
          board,
          workspaceById.get(board.workspaceId),
          workspaceBoardCardsByBoardId.get(board.id) || [],
          sidebarSearchQuery
        )
      )
    : workspaceBoards
  )
    .filter((board) => workspaceWorkflowIds.has(board.workspaceId) && !board.archived)
    .slice()
    .sort((left, right) => {
      if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1
      return right.updatedAt.localeCompare(left.updatedAt)
    })
  const archivedWorkspaceBoards = (isSidebarSearchActive
    ? workspaceBoards.filter((board) =>
        workspaceBoardMatchesSearch(
          board,
          workspaceById.get(board.workspaceId),
          workspaceBoardCardsByBoardId.get(board.id) || [],
          sidebarSearchQuery
        )
      )
    : workspaceBoards
  )
    .filter((board) => workspaceWorkflowIds.has(board.workspaceId) && board.archived)
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const scheduledTaskById = useMemo(() => {
    const map = new Map<string, ScheduledTask>()
    for (const task of scheduledTasks) map.set(task.id, task)
    return map
  }, [scheduledTasks])

  useEffect(() => {
    if (!selectedWorkflowId) return
    if (!visibleWorkflows.some((workflow) => workflow.id === selectedWorkflowId)) {
      setSelectedWorkflowId(null)
    }
  }, [selectedWorkflowId, visibleWorkflows])

  // Search result-count badge. Count distinct items on the active primary
  // surface: General chats never inflate Code results, and workspace content
  // never inflates Chat results. Projects owns its count in its child view.
  // Dedup via id sets because the same chat can dual-surface in Pinned,
  // Recents, Shared, and its canonical section.
  const sidebarSearchResultCount = (() => {
    const chatIds = new Set<string>()
    const workspaceIds = new Set<string>()
    const workflowIds = new Set<string>()
    const boardIds = new Set<string>()
    if (activeChatSurfaceTab === 'chat') {
      for (const chat of visibleGlobalChats) chatIds.add(chat.appChatId)
    } else {
      for (const workflow of visibleWorkflows) workflowIds.add(workflow.id)
      for (const board of visibleWorkspaceBoards) boardIds.add(board.id)
      for (const entry of visibleWorkspaceEntries) {
        workspaceIds.add(entry.workspace.id)
        for (const chat of entry.visibleChats) chatIds.add(chat.appChatId)
      }
      for (const workspace of visiblePinnedWorkspaces) workspaceIds.add(workspace.id)
    }
    for (const chat of visiblePinnedChats) chatIds.add(chat.appChatId)
    for (const chat of visibleRecentChats) chatIds.add(chat.appChatId)
    for (const chat of visibleEnsembleChats) chatIds.add(chat.appChatId)
    for (const chat of visibleSharedChats) chatIds.add(chat.appChatId)
    return chatIds.size + workspaceIds.size + workflowIds.size + boardIds.size
  })()
  const activeSidebarSearchResultCount =
    activeSidebarTab === 'projects' ? projectsSearchResultCount : sidebarSearchResultCount

  // 1.0.3 retiring inline tile action icons — `handleTogglePinChatClick`,
  // `handleTogglePinWorkspaceClick`, and `handleAddChat` were the
  // hover-revealed icon-button handlers on each chat / workspace tile
  // (Pinned / Recents / Workspace-expanded / Global sections). All
  // affordances now live in the per-tile three-dots overflow menu,
  // wired via `buildChatMenuItems` / `buildWorkspaceMenuItems`.

  const getSidebarThreadListDropProps = (
    listId: string,
    list: readonly ChatRecord[]
  ) => {
    const listIds = list.map((chat) => chat.appChatId)
    const findTarget = (event: ReactDragEvent<HTMLElement>): HTMLElement | null => {
      if (!(event.target instanceof HTMLElement)) return null
      const target = event.target.closest<HTMLElement>('[data-sidebar-thread-id]')
      if (!target || target.dataset.sidebarThreadList !== listId) return null
      if (!event.currentTarget.contains(target)) return null
      return target
    }
    return {
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        const active = draggedThreadPayloadRef.current
        if (
          !active ||
          active.listId !== listId ||
          !event.dataTransfer.types.includes(SIDEBAR_THREAD_DRAG_MIME)
        ) {
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const target = findTarget(event)
        if (target) {
          const nextTarget = { listId, chatId: target.dataset.sidebarThreadId || '' }
          setThreadDropTarget((current) =>
            current?.listId === nextTarget.listId && current.chatId === nextTarget.chatId
              ? current
              : nextTarget
          )
        }
      },
      onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
        const relatedTarget = event.relatedTarget
        if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return
        setThreadDropTarget(null)
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        const active = draggedThreadPayloadRef.current
        if (!active || active.listId !== listId) return
        const payload = parseSidebarThreadDragPayload(
          event.dataTransfer.getData(SIDEBAR_THREAD_DRAG_MIME)
        )
        if (!payload || payload.listId !== listId || !listIds.includes(payload.chatId)) return
        event.preventDefault()
        event.stopPropagation()
        const target = findTarget(event)
        const targetChatId = target?.dataset.sidebarThreadId || null
        const rect = target?.getBoundingClientRect()
        const placement = rect && event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
        applySidebarThreadDrop(listId, listIds, payload.chatId, targetChatId, placement)
        draggedThreadPayloadRef.current = null
        setDraggedThreadPayload(null)
        setThreadDropTarget(null)
      },
      'data-sidebar-thread-list': listId
    }
  }

  /**
   * Drag props shared by every reorderable thread row. The source list id is
   * carried in the payload and is checked again by the list drop target; a
   * thread therefore cannot be reordered into an adjacent list or workspace.
   * The legacy chat-id MIME remains available only for the existing pin drop.
   */
  const getChatTileDragProps = (
    chat: ChatRecord,
    listId: string
  ): SidebarChatTileDragProps => {
    if (!listId || editingChatTarget?.chatId === chat.appChatId) {
      return { draggable: false }
    }
    const canPin = Boolean(onTogglePinChat) && chat.pinned !== true
    return {
      draggable: true,
      onDragStart: (event) => {
        const payload = { listId, chatId: chat.appChatId }
        draggedThreadPayloadRef.current = payload
        setDraggedThreadPayload(payload)
        event.dataTransfer.effectAllowed = canPin ? 'copyMove' : 'move'
        event.dataTransfer.setData(SIDEBAR_THREAD_DRAG_MIME, serializeSidebarThreadDragPayload(payload))
        if (canPin) {
          event.dataTransfer.setData('application/x-taskwraith-chat-id', chat.appChatId)
          setDraggedChatId(chat.appChatId)
        }
        event.dataTransfer.setData('text/plain', chat.title)
      },
      onDragEnd: () => {
        draggedThreadPayloadRef.current = null
        setDraggedThreadPayload(null)
        setDraggedChatId(null)
        setPinDropActive(false)
        setThreadDropTarget(null)
      },
      'data-dragging':
        draggedThreadPayload?.listId === listId && draggedThreadPayload.chatId === chat.appChatId
          ? 'true'
          : undefined,
      'data-sidebar-thread-id': chat.appChatId,
      'data-sidebar-thread-list': listId,
      'data-sidebar-thread-drop-target':
        threadDropTarget?.listId === listId && threadDropTarget.chatId === chat.appChatId
          ? 'true'
          : undefined
    }
  }

  /*
   * 1.0.5-SB5 — Drop-target prop bag for the Pinned section
   * container (or the empty-state placeholder when the section
   * has no entries yet). `dragOver` must `preventDefault()` to
   * accept the drop; the visual feedback flips on/off via
   * `pinDropActive`. The drop itself reads the chat id from
   * the dataTransfer + calls `onTogglePinChat` ONLY when the
   * chat isn't already pinned (drop-to-unpin would be
   * surprising; users unpin via the menu).
   */
  const pinDropProps = {
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!onTogglePinChat) return
      // Only accept our custom MIME type — ignores arbitrary
      // external drags. `types` is the API for sniffing
      // dataTransfer at dragOver time (you can't read `getData`
      // mid-drag for security reasons).
      if (!event.dataTransfer.types.includes('application/x-taskwraith-chat-id')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (!pinDropActive) setPinDropActive(true)
    },
    onDragEnter: (event: React.DragEvent<HTMLElement>) => {
      if (!onTogglePinChat) return
      if (!event.dataTransfer.types.includes('application/x-taskwraith-chat-id')) return
      setPinDropActive(true)
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      // dragLeave fires when crossing child boundaries inside
      // the drop target — that's a false negative for
      // "actually left the drop zone". Only clear when the
      // pointer leaves the container's bounding rect entirely.
      const rect = event.currentTarget.getBoundingClientRect()
      const { clientX, clientY } = event
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        setPinDropActive(false)
      }
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!onTogglePinChat) return
      const chatId = event.dataTransfer.getData('application/x-taskwraith-chat-id')
      if (!chatId) return
      event.preventDefault()
      const chat = chats.find((c) => c.appChatId === chatId)
      // Skip if chat is gone OR already pinned — drop-to-pin
      // shouldn't toggle pinned-state to unpinned.
      if (chat && !chat.pinned) {
        onTogglePinChat(chatId)
      }
      setDraggedChatId(null)
      setPinDropActive(false)
    },
    'data-pin-drop': pinDropActive ? 'active' : undefined
  }

  /*
   * 1.0.5-SB5 — Whether to show the "Pin drop zone" empty-state
   * hint above Recents. Surfaces only when:
   *   1. A drag is in flight
   *   2. The chat being dragged isn't already pinned
   *   3. The Pinned section is currently empty (no workspaces +
   *      no chats) — when it's non-empty the existing section
   *      itself is the drop target.
   */
  const showPinDropPlaceholder =
    Boolean(onTogglePinChat) &&
    draggedChatId !== null &&
    visiblePinnedWorkspaces.length === 0 &&
    visiblePinnedChats.length === 0 &&
    chats.find((c) => c.appChatId === draggedChatId)?.pinned !== true

  // getChatProviderBadgeId is hoisted to module scope (used by the memoized
  // row components); renderChatProviderBadge stays local (used by rows still
  // inline in the Sidebar body).
  const renderChatProviderBadge = (chat: ChatRecord): ReactNode => {
    return <ProviderBadgeIcon provider={getChatProviderBadgeId(chat)} />
  }
  const cancelChatRename = useCallback(() => setEditingChatTarget(null), [])
  // Linked child chats (agent sub-threads + user side chats) render directly
  // under their parent so the sidebar preserves relationship continuity.
  const subThreadsByParentId = useMemo(() => {
    const grouped = new Map<string, ChatRecord[]>()
    for (const chat of chats) {
      if (!isLinkedChildChat(chat) || !chat.parentChatId) continue
      const bucket = grouped.get(chat.parentChatId)
      if (bucket) bucket.push(chat)
      else grouped.set(chat.parentChatId, [chat])
    }
    // Sort each bucket oldest-first for stable presentation.
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => a.createdAt - b.createdAt)
    }
    return grouped
  }, [chats])
  const selectedChatId = activeChatId ?? currentChat?.appChatId ?? null
  const selectedChat = chats.find((chat) => chat.appChatId === selectedChatId) || currentChat || null
  const acknowledgeTerminalOutcomeProjection = useCallback(
    (chatId: string, outcome: NonNullable<ReturnType<typeof projectSidebarTerminalOutcome>>) => {
      const current = terminalOutcomeAcknowledgementsRef.current
      const next = acknowledgeSidebarTerminalOutcome(current, chatId, outcome)
      if (next === current) return
      terminalOutcomeAcknowledgementsRef.current = next
      setTerminalOutcomeAcknowledgements(next)
      persistSidebarTerminalOutcomeAcknowledgements(next)
    },
    []
  )
  const acknowledgeChatTerminalOutcome = useCallback(
    (chat: ChatRecord): void => {
      const outcome = projectSidebarTerminalOutcome(chat)
      if (outcome) acknowledgeTerminalOutcomeProjection(chat.appChatId, outcome)
    },
    [acknowledgeTerminalOutcomeProjection]
  )
  const selectAndAcknowledgeChat = useCallback(
    (chat: ChatRecord): void => {
      acknowledgeChatTerminalOutcome(chat)
      onSelectChat(chat)
    },
    [acknowledgeChatTerminalOutcome, onSelectChat]
  )
  const selectedTerminalOutcome = useMemo(
    () => (selectedChat ? projectSidebarTerminalOutcome(selectedChat) : null),
    [selectedChat]
  )
  useEffect(() => {
    if (!selectedChatId || !selectedTerminalOutcome) return
    acknowledgeTerminalOutcomeProjection(selectedChatId, selectedTerminalOutcome)
  }, [acknowledgeTerminalOutcomeProjection, selectedChatId, selectedTerminalOutcome])
  const pendingAttentionSources = useMemo(
    () => ({
      approvalHeadByChatId: pendingAgentApprovalByChatId,
      approvalQueueByChatId: pendingApprovalQueueByChatId,
      questionsByChatId: pendingAgentQuestionsByChatId
    }),
    [pendingAgentApprovalByChatId, pendingApprovalQueueByChatId, pendingAgentQuestionsByChatId]
  )
  const rowToneByChatId = useMemo(() => {
    const tones = new Map<string, SidebarRowTone>()
    const runningIds = new Set(runningChatIds)
    for (const chat of chats) {
      if (chat.appChatId === selectedChatId) continue
      // A thread parked on an approval or an ask_user_question is asking for
      // the user BY NAME, so it outranks any unread settled outcome — and,
      // unlike those, it is live state: the run is blocked, not finished, so
      // it must survive the running gate below that suppresses outcome ink on
      // threads still working. It clears itself when the answer lands.
      if (chatIsAwaitingUserResponse(chat.appChatId, pendingAttentionSources)) {
        tones.set(chat.appChatId, 'waiting')
        continue
      }
      // Parked on a clock rather than a person. Ranked under `waiting`
      // because nothing is owed, and above the outcomes because the thread
      // has not finished — it is going to wake up. Live state, so no
      // acknowledgement and no epoch: it retires when the run does.
      if (chatIsSleeping(chat)) {
        tones.set(chat.appChatId, 'sleeping')
        continue
      }
      if (runningIds.has(chat.appChatId)) continue
      // The old "never paint a goal-less success green while it is asking the
      // user" guard lived here. It is now structurally unreachable: every chat
      // with an unanswered question takes the `waiting` branch above, which is
      // a stronger statement of the same intent.
      const outcome = projectSidebarTerminalOutcome(chat)
      if (
        outcome &&
        !sidebarSuccessInkPredatesEpoch(outcome, successInkEpochMs) &&
        // Failure ink is NOT unread-scoped. Success is news — once seen, it
        // retires. A failure is a standing condition: the thread is broken
        // until something changes it, and the status chips that used to say so
        // in the subline are gone. Reading it does not fix it, so red persists
        // until a NEW result supersedes it (a fresh run mints a new
        // fingerprint, and a success replaces the tone outright).
        (outcome.tone === 'failure' ||
          isSidebarTerminalOutcomeUnread(terminalOutcomeAcknowledgements, chat.appChatId, outcome))
      ) {
        tones.set(chat.appChatId, outcome.tone)
      }
    }
    return tones
  }, [
    chats,
    pendingAttentionSources,
    runningChatIds,
    selectedChatId,
    successInkEpochMs,
    terminalOutcomeAcknowledgements
  ])
  const selectedChatSurfaceKey = selectedChat
    ? `${selectedChat.appChatId}:${getChatSidebarTab(selectedChat)}`
    : null
  const activeSidebarTabRef = useRef(activeSidebarTab)
  activeSidebarTabRef.current = activeSidebarTab
  const previousSelectedChatSurfaceKeyRef = useRef(selectedChatSurfaceKey)
  useEffect(() => {
    const previousSurfaceKey = previousSelectedChatSurfaceKeyRef.current
    previousSelectedChatSurfaceKeyRef.current = selectedChatSurfaceKey
    if (!selectedChat || !selectedChatSurfaceKey || previousSurfaceKey === selectedChatSurfaceKey) {
      return
    }
    // Projects is deliberately cross-scope: selecting one of its members must
    // not eject the user from the organisational view.
    if (activeSidebarTabRef.current === 'projects') return
    setActiveSidebarTab(getChatSidebarTab(selectedChat))
  }, [selectedChat, selectedChatSurfaceKey])
  // Report EVERY active-tab value (mount included) to the host — unlike the
  // user-initiated onPrimarySurfaceSelect below, this is a passive mirror for
  // surface-scoped host state (contextual dock memory).
  useEffect(() => {
    onActiveSidebarTabChange?.(activeSidebarTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSidebarTab])
  // Single entry point for USER-initiated tab selection (segment click +
  // arrow-key roving). A genuine Chat/Code change is reported to the host so
  // it can re-scope a pristine welcome draft onto the selected surface. The
  // tab-follows-chat effect above and the `+ New` create handlers below call
  // setActiveSidebarTab directly — they react to or create the right chat
  // themselves and must never fire the callback.
  const selectSidebarTab = (nextTab: SidebarActiveTab): void => {
    const surface = primarySurfaceForSidebarTabChange(activeSidebarTab, nextTab)
    setActiveSidebarTab(nextTab)
    if (surface) onPrimarySurfaceSelect?.(surface)
  }
  const currentScopeTitle =
    currentWorkspace?.displayName || (currentChat?.scope === 'global' ? null : 'TaskWraith')
  const runningCount =
    activeSidebarTab === 'projects'
      ? runningChatIdSet.size
      : activeSurfaceChats.reduce(
          (count, chat) => count + (runningChatIdSet.has(chat.appChatId) ? 1 : 0),
          0
        )
  const activeSidebarChatCount =
    activeSidebarTab === 'chat'
      ? visibleChatCounts.chat
      : activeSidebarTab === 'projects'
        ? totalChatCount
        : visibleChatCounts.threads
  // The first create-menu item follows the active primary surface: Chat starts
  // a General chat, while Code starts a workspace chat. Projects remains a
  // cross-scope organisational view and keeps General chat as its first action.
  const primaryNewTitle =
    activeSidebarTab === 'threads' ? 'New workspace chat' : 'New general chat'
  const defaultWorkspaceForNewChat =
    currentWorkspace ||
    [...workspaces].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0] ||
    null
  const defaultWorkflowWorkspace = defaultWorkspaceForNewChat
  const handlePrimaryNewChat = () => {
    setNewMenuOpen(false)
    setNewMenuSharedOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    if (activeSidebarTab !== 'projects') setActiveSidebarTab('chat')
    onNewGlobalChat()
  }
  const handleNewWorkspaceChat = () => {
    if (!defaultWorkspaceForNewChat) return
    setNewMenuOpen(false)
    setNewMenuSharedOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    if (activeSidebarTab !== 'projects') setActiveSidebarTab('threads')
    onNewChat(defaultWorkspaceForNewChat.id, defaultWorkspaceForNewChat.path)
  }
  const handleNewEnsemble = () => {
    setNewMenuOpen(false)
    setNewMenuSharedOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    expandSidebarSection('ensembles')
    onNewEnsemble()
  }
  const handleNewWorkflow = () => {
    if (!defaultWorkflowWorkspace) return
    setNewMenuOpen(false)
    setNewMenuSharedOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    expandSidebarSection('workflows')
    onCreateWorkflow?.(defaultWorkflowWorkspace)
  }
  const handleNewWorkflowFromTemplate = (templateId: string) => {
    if (!defaultWorkflowWorkspace) return
    setNewMenuOpen(false)
    setNewMenuSharedOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    expandSidebarSection('workflows')
    onCreateWorkflowFromPluginTemplate?.(templateId, defaultWorkflowWorkspace)
  }
  const openWorkspaceBoardCreator = () => {
    if (!onCreateWorkspaceBoard || workspaces.length === 0) return
    setNewMenuOpen(false)
    setSharedCreateMenuOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    expandSidebarSection('workspace-boards')
    onCreateWorkspaceBoard()
  }
  const handleNewWorkspaceBoard = () => {
    openWorkspaceBoardCreator()
  }
  const sharedChatCreateOptions = getSharedChatCreateOptions({
    hasWorkspace: Boolean(currentWorkspace),
    ensembleModeEnabled
  })
  const handleCreateSharedChat = (variant: SharedChatCreateVariant) => {
    setNewMenuOpen(false)
    setNewMenuSharedOpen(false)
    setNewMenuWorkflowTemplatesOpen(false)
    setSharedCreateMenuOpen(false)
    expandSidebarSection('shared')
    if (activeSidebarTab !== 'projects') {
      setActiveSidebarTab(variant === 'global' ? 'chat' : 'threads')
    }
    onCreateSharedChat?.(variant)
  }

  // Outside-click + Escape dismiss for the `+ New` popover. Mounts
  // global mousedown / keydown listeners only while the menu is open
  // so we don't sit on event traffic the rest of the time. Click-
  // inside checks via `contains` on the wrap ref so menu-item clicks
  // are not treated as outside-clicks; the menu items already call
  // `setNewMenuOpen(false)` themselves after their action runs.
  useEffect(() => {
    if (!newMenuOpen) return
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const wrap = newMenuWrapRef.current
      if (!wrap) return
      if (event.target instanceof Node && wrap.contains(event.target)) return
      setNewMenuOpen(false)
      setNewMenuSharedOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNewMenuOpen(false)
        setNewMenuSharedOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [newMenuOpen])

  useEffect(() => {
    if (!sharedCreateMenuOpen) return
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const wrap = sharedCreateMenuWrapRef.current
      if (!wrap) return
      if (event.target instanceof Node && wrap.contains(event.target)) return
      setSharedCreateMenuOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSharedCreateMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [sharedCreateMenuOpen])

  useEffect(() => {
    if (!settingsMenuOpen) return
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const wrap = settingsMenuWrapRef.current
      if (!wrap) return
      if (event.target instanceof Node && wrap.contains(event.target)) return
      setSettingsMenuOpen(false)
      setSettingsMenuPane('root')
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsMenuOpen(false)
        setSettingsMenuPane('root')
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [settingsMenuOpen])

  // Outside-click / Escape dismissal for the footer control popovers. A single
  // listener covers all three: any click outside the control cluster closes
  // whichever is open; Escape closes all.
  useEffect(() => {
    if (!approvalsPopoverOpen && !sharesPopoverOpen && !devicesPopoverOpen) return
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      const wrap = footerControlsWrapRef.current
      if (!wrap) return
      if (event.target instanceof Node && wrap.contains(event.target)) return
      setApprovalsPopoverOpen(false)
      setSharesPopoverOpen(false)
      setDevicesPopoverOpen(false)
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setApprovalsPopoverOpen(false)
        setSharesPopoverOpen(false)
        setDevicesPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [approvalsPopoverOpen, sharesPopoverOpen, devicesPopoverOpen])

  useEffect(() => {
    if (!IOS_REMOTE_ENABLED) {
      setRemoteDeviceConnected(false)
      return
    }
    let cancelled = false
    const refreshRemoteDevices = async (): Promise<void> => {
      try {
        const devices = (await window.api.bridgeListPairedDevices()) as PairedRemoteDeviceSummary[]
        if (!cancelled) {
          const list = devices ?? []
          setPairedDevices(list)
          setRemoteDeviceConnected(list.some((device) => device.connected))
        }
      } catch {
        if (!cancelled) {
          setPairedDevices([])
          setRemoteDeviceConnected(false)
        }
      }
    }
    void refreshRemoteDevices()
    const interval = window.setInterval(() => {
      void refreshRemoteDevices()
    }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  // Workspace search is now an editable app command (default Cmd/Ctrl+Shift+F).
  // App.tsx handles the shortcut and this effect performs the actual focus
  // after the sidebar is mounted or re-opened.
  useEffect(() => {
    if (!focusSearchRequestId) return
    const frame = window.requestAnimationFrame(() => {
      const input = searchInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusSearchRequestId])

  useEffect(() => {
    if (expandedWorkspaceStartupSeededRef.current || !startupExpandedWorkspaceId) return
    expandedWorkspaceStartupSeededRef.current = true
    setExpandedWorkspaceIds((prev) => {
      if (prev.size > 0) return prev
      return new Set([startupExpandedWorkspaceId])
    })
  }, [startupExpandedWorkspaceId])

  useEffect(() => {
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id))
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setExpandedWorkspaceIds((prev) => {
        const next = new Set<string>()
        for (const workspaceId of prev) {
          if (workspaceIds.has(workspaceId)) {
            next.add(workspaceId)
          }
        }
        if (next.size === prev.size) {
          return prev
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [workspaces])

  useEffect(() => {
    if (chats.length === 0) return
    const parentIds = new Set(subThreadsByParentId.keys())
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setExpandedSubThreadParentIds((prev) => {
        const next = new Set<string>()
        for (const parentId of prev) {
          if (parentIds.has(parentId)) {
            next.add(parentId)
          }
        }
        if (next.size === prev.size) {
          return prev
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [chats.length, subThreadsByParentId])

  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_SIDEBAR_SECTIONS_STORAGE_KEY,
        JSON.stringify([...collapsedSidebarSections])
      )
      localStorage.setItem(
        COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION_KEY,
        COLLAPSED_SIDEBAR_SECTIONS_DEFAULT_VERSION
      )
    } catch {
      // Ignore persistence errors in constrained environments.
    }
  }, [collapsedSidebarSections])

  /**
   * Honor an explicit collapse — except while the user is actively
   * searching. The search input is global to the sidebar; forcing
   * sections open during search means matches in collapsed sections
   * stay reachable. When the search input clears, the user's prior
   * collapse choice snaps back automatically (state was never
   * mutated).
   */
  const isSectionCollapsed = (sectionId: SidebarSectionId): boolean => {
    if (isSidebarSearchActive) return false
    return collapsedSidebarSections.has(sectionId)
  }

  const toggleSidebarSection = (sectionId: SidebarSectionId): void => {
    setCollapsedSidebarSections((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) {
        next.delete(sectionId)
      } else {
        next.add(sectionId)
      }
      return next
    })
  }

  const expandSidebarSection = (sectionId: SidebarSectionId): void => {
    setCollapsedSidebarSections((prev) => {
      if (!prev.has(sectionId)) return prev
      const next = new Set(prev)
      next.delete(sectionId)
      return next
    })
  }

  const toggleSidebarListExpanded = (listId: string): void => {
    setExpandedSidebarLists((prev) => {
      const next = new Set(prev)
      if (next.has(listId)) next.delete(listId)
      else next.add(listId)
      return next
    })
  }

  // Trim a section's list to the preview cap unless the user expanded it — or a
  // search is active, when every match stays visible so results aren't hidden.
  const previewSidebarList = (listId: string, items: ChatRecord[]): ChatRecord[] => {
    if (
      isSidebarSearchActive ||
      expandedSidebarLists.has(listId) ||
      items.length <= SIDEBAR_SECTION_PREVIEW_LIMIT
    ) {
      return items
    }
    return items.slice(0, SIDEBAR_SECTION_PREVIEW_LIMIT)
  }

  // Trailing "Show N more… / Show less" toggle for a truncated list. Renders
  // nothing when the list already fits the preview cap, or while searching
  // (search shows every match, so there is nothing hidden to reveal).
  const renderSidebarShowMore = (listId: string, totalCount: number): ReactNode => {
    if (isSidebarSearchActive || totalCount <= SIDEBAR_SECTION_PREVIEW_LIMIT) return null
    const expanded = expandedSidebarLists.has(listId)
    const hiddenCount = totalCount - SIDEBAR_SECTION_PREVIEW_LIMIT
    return (
      <button
        type="button"
        className="sidebar-show-more"
        onClick={() => toggleSidebarListExpanded(listId)}
        aria-expanded={expanded}
      >
        {expanded ? 'Show less' : `Show ${hiddenCount} more…`}
      </button>
    )
  }

  const { servers: localServers } = useLocalServers()
  const [sidebarHierarchyOrder, setSidebarHierarchyOrder] = useState<SidebarHierarchySectionId[]>(
    () => loadSidebarHierarchyOrder()
  )
  const persistSidebarHierarchyOrder = useCallback((next: SidebarHierarchySectionId[]) => {
    setSidebarHierarchyOrder(next)
    saveSidebarHierarchyOrder(next)
  }, [])
  const { dragGhost, handleSectionPointerDown, sectionDragClass, sectionOrderStyle } =
    useSidebarHierarchyDrag(sidebarHierarchyOrder, persistSidebarHierarchyOrder)

  const runSidebarPathAction = useCallback((action: SidebarPathAction): void => {
    void action()
      .then((result) => {
        if (!result.ok) {
          console.warn('[sidebar] Path action failed', result.reason || result.error || 'unknown')
        }
      })
      .catch((error) => {
        console.warn('[sidebar] Path action failed', error)
      })
  }, [])

  /**
   * Build the items rendered inside a chat tile's overflow menu.
   * Keeps the action set consistent across the four sites that render
   * chat tiles (global chats, pinned, recents, workspace-expanded chats,
   * sub-thread children). Items collapse to an empty array when the
   * caller hasn't wired the corresponding handler — the trigger still
   * renders so layout stays stable.
   */
  const startChatRename = (chat: ChatRecord, surfaceId: string): void => {
    setEditingChatTarget({ chatId: chat.appChatId, surfaceId })
  }

  const isChatRenameTarget = (chat: ChatRecord, surfaceId: string): boolean =>
    editingChatTarget?.chatId === chat.appChatId && editingChatTarget.surfaceId === surfaceId

  const buildChatMenuItems = (
    chat: ChatRecord,
    surfaceId: string
  ): SidebarOverflowMenuItem[] => {
    const items: SidebarOverflowMenuItem[] = []
    const hasWorkspaceDirectory =
      chat.scope !== 'global' && Boolean(chat.workspaceId || chat.workspacePath)
    if (onRenameChat) {
      items.push({
        id: 'rename',
        label: 'Rename',
        group: 'primary',
        onSelect: () => {
          // The menu Rename is unconditional — user explicitly chose it,
          // so we flip this exact rendered row into inline-edit mode
          // regardless of current selection.
          startChatRename(chat, surfaceId)
        }
      })
    }
    if (onTogglePinChat) {
      items.push({
        id: 'pin',
        label: chat.pinned ? 'Unpin' : 'Pin',
        group: 'primary',
        onSelect: () => onTogglePinChat(chat.appChatId)
      })
    }
    if (onToggleArchiveChat) {
      items.push({
        id: 'archive',
        label: chat.archived ? 'Unarchive' : 'Archive',
        group: 'primary',
        onSelect: () => onToggleArchiveChat(chat.appChatId, !chat.archived)
      })
    }
    // Git-workflow housekeeping — only offered once the thread carries a git
    // marker (its Git-section entry keeps a hidden chat reachable, so hiding
    // can never orphan it).
    if (chatGitWorkflowMarker(chat)) {
      if (onSetChatHiddenFromMainList) {
        items.push({
          id: 'hide-from-main',
          label: chat.hiddenFromMainList
            ? 'Show in main lists'
            : 'Hide from main lists (keep in Git)',
          group: 'secondary',
          onSelect: () => onSetChatHiddenFromMainList(chat.appChatId, !chat.hiddenFromMainList)
        })
      }
      if (onClearChatGitWorkflow) {
        items.push({
          id: 'remove-from-git',
          label: 'Remove from Git section',
          group: 'secondary',
          onSelect: () => onClearChatGitWorkflow(chat.appChatId)
        })
      }
    }
    if (onAddChatToWorkspaceBoard && chat.scope !== 'global' && chat.workspaceId) {
      items.push({
        id: 'add-to-board',
        label: 'Add to Workspace Board',
        group: 'primary',
        onSelect: () => onAddChatToWorkspaceBoard(chat)
      })
    }
    if (onCreateSubThread) {
      // 1.0.3 — delegate moved INTO the overflow menu after the inline
      // `↪` icon button on each chat tile was retired. Same handler
      // wiring as before (opens the SubThreadCreator for this chat as
      // the parent); just lives in the menu now to keep each tile
      // chrome consistent.
      items.push({
        id: 'delegate',
        label: 'Delegate to a sub-thread',
        group: 'primary',
        onSelect: () => onCreateSubThread(chat)
      })
    }
    if (onOpenChatInSidePanel && chat.parentChatId) {
      items.push({
        id: 'open-side-panel',
        label: 'Open beside parent',
        group: 'primary',
        onSelect: () => {
          acknowledgeChatTerminalOutcome(chat)
          onOpenChatInSidePanel(chat, 'split')
        }
      })
      items.push({
        id: 'open-side-drawer',
        label: 'Open drawer beside parent',
        group: 'primary',
        onSelect: () => {
          acknowledgeChatTerminalOutcome(chat)
          onOpenChatInSidePanel(chat, 'drawer')
        }
      })
    }
    if (onOpenInMultiview) {
      items.push({
        id: 'open-in-multiview',
        label: 'Open in Multiview pane',
        group: 'primary',
        onSelect: () => {
          acknowledgeChatTerminalOutcome(chat)
          onOpenInMultiview(chat)
        }
      })
    }
    if (hasWorkspaceDirectory) {
      items.push({
        id: 'show-workspace-in-finder',
        label: 'Show Workspace in Finder',
        group: 'secondary',
        onSelect: () =>
          runSidebarPathAction(() => window.api.sidebarShowChatWorkspaceInFinder(chat.appChatId))
      })
      items.push({
        id: 'copy-working-directory',
        label: 'Copy Working Directory',
        group: 'secondary',
        onSelect: () =>
          runSidebarPathAction(() => window.api.sidebarCopyChatWorkingDirectory(chat.appChatId))
      })
    }
    items.push({
      id: 'copy-chat-transcript-directory',
      label: 'Copy Chat Transcript Directory',
      group: 'secondary',
      onSelect: () =>
        runSidebarPathAction(() => window.api.sidebarCopyChatTranscriptPath(chat.appChatId))
    })
    if (onDeleteChat) {
      items.push({
        id: 'delete',
        label: 'Delete',
        group: 'destructive',
        danger: true,
        onSelect: () => onDeleteChat(chat.appChatId)
      })
    }
    return items
  }

  /**
   * Commit a rename submitted from the inline `<input>`. Trims, drops
   * no-ops (empty / unchanged), and clears edit mode unconditionally
   * so the helper always returns to the display state regardless of
   * whether the submit was meaningful.
   */
  const commitChatRename = (chat: ChatRecord, nextValue: string): void => {
    const trimmed = normalizeThreadTitle(nextValue, '')
    const currentTitle = normalizeThreadTitle(chat.title, '')
    setEditingChatTarget(null)
    if (!trimmed || trimmed === currentTitle) return
    onRenameChat?.(chat.appChatId, trimmed)
  }

  const handleChatRowKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    chat: ChatRecord
  ): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectAndAcknowledgeChat(chat)
    }
  }

  /**
   * Workspace tile overflow items. Wraps the existing pin / new-chat /
   * remove handlers so the tile's primary affordance set lives in one
   * menu. Existing inline icon buttons stay for now — the menu is
   * additive in this slice.
   */
  const buildWorkspaceMenuItems = (ws: WorkspaceRecord): SidebarOverflowMenuItem[] => {
    const items: SidebarOverflowMenuItem[] = []
    if (onTogglePinWorkspace) {
      items.push({
        id: 'pin',
        label: ws.pinned ? 'Unpin' : 'Pin',
        group: 'primary',
        onSelect: () => onTogglePinWorkspace(ws.id)
      })
    }
    items.push({
      id: 'new-chat',
      label: 'New chat',
      group: 'primary',
      onSelect: () => onNewChat(ws.id, ws.path)
    })
    items.push({
      id: 'show-workspace-in-finder',
      label: 'Show Workspace in Finder',
      group: 'secondary',
      onSelect: () => runSidebarPathAction(() => window.api.sidebarShowWorkspaceInFinder(ws.id))
    })
    items.push({
      id: 'copy-working-directory',
      label: 'Copy Working Directory',
      group: 'secondary',
      onSelect: () => runSidebarPathAction(() => window.api.sidebarCopyWorkspaceDirectory(ws.id))
    })
    items.push({
      id: 'remove',
      label: 'Remove workspace',
      group: 'destructive',
      danger: true,
      onSelect: () => {
        // Synthesize a stub event for the existing onRemoveWorkspace signature
        // (it expects a MouseEvent to support stopPropagation). The menu has
        // already swallowed the click, so the stub is a no-op for the caller.
        const stubEvent = {
          preventDefault: () => {},
          stopPropagation: () => {}
        } as unknown as MouseEvent<HTMLButtonElement>
        onRemoveWorkspace(ws.id, stubEvent)
      }
    })
    return items
  }

  const buildWorkspaceBoardMenuItems = (board: WorkspaceBoardDefinition): SidebarOverflowMenuItem[] => {
    const items: SidebarOverflowMenuItem[] = []
    if (onTogglePinWorkspaceBoard) {
      items.push({
        id: 'pin',
        label: board.pinned ? 'Unpin' : 'Pin',
        group: 'primary',
        onSelect: () => onTogglePinWorkspaceBoard(board)
      })
    }
    if (onRenameWorkspaceBoard) {
      items.push({
        id: 'rename',
        label: 'Rename',
        group: 'primary',
        onSelect: () => onRenameWorkspaceBoard(board)
      })
    }
    if (onDuplicateWorkspaceBoard) {
      items.push({
        id: 'duplicate',
        label: 'Duplicate',
        group: 'primary',
        onSelect: () => onDuplicateWorkspaceBoard(board)
      })
    }
    if (board.archived && onRestoreWorkspaceBoard) {
      items.push({
        id: 'restore',
        label: 'Restore',
        group: 'primary',
        onSelect: () => onRestoreWorkspaceBoard(board.id)
      })
    } else if (onArchiveWorkspaceBoard) {
      items.push({
        id: 'archive',
        label: 'Archive',
        group: 'primary',
        onSelect: () => onArchiveWorkspaceBoard(board.id)
      })
    }
    if (onDeleteWorkspaceBoard) {
      items.push({
        id: 'delete',
        label: 'Delete',
        group: 'destructive',
        danger: true,
        onSelect: () => onDeleteWorkspaceBoard(board.id)
      })
    }
    return items
  }

  const renderLinkedChildChat = (subChat: ChatRecord): ReactNode => {
    const subRunning = runningChatIdSet.has(subChat.appChatId)
    const subRowTone = rowToneByChatId.get(subChat.appChatId) ?? null
    const subLastStatus = getLastRunStatus(subChat)
    const subIsSideChat = isSideChatRecord(subChat)
    const subKindLabel = subIsSideChat ? getSideChatChildKindLabel(subChat) : 'Sub-thread'
    const subParentChat =
      subChat.parentChatId ? chats.find((chat) => chat.appChatId === subChat.parentChatId) || null : null
    const subRouteLabel = getLinkedChildRouteLabel(subChat, subParentChat)
    const subAgentIdentity = getLinkedChildAgentIdentity(subChat)
    const subSideChatMetaLabels = subIsSideChat
      ? [
          getSideChatChildModeLabel(subChat),
          getSideChatChildContextLabel(subChat),
          subRouteLabel,
          getSideChatChildLifecycleLabel(subChat)
        ].filter(Boolean)
      : []
    const subProviderColor = `var(--provider-${subChat.provider || 'gemini'}-color)`
    const renameSurfaceId = `linked-${subChat.appChatId}`
    const subNeedsInput = chatHasPendingAgentQuestion(
      pendingAgentQuestionsByChatId,
      subChat.appChatId
    )
    const subRowA11y = buildSidebarChatRowA11y({
      chatId: subChat.appChatId,
      title: subChat.title,
      provider: subChat.provider,
      selected: selectedChatId === subChat.appChatId,
      isRunning: subRunning,
      needsInput: subNeedsInput,
      lastRunStatus: subLastStatus,
      rowTone: subRowTone,
      prefix: subKindLabel
    })
    return (
      <div
        role="button"
        tabIndex={0}
        key={subChat.appChatId}
        className={`sidebar-item sidebar-chat-item sidebar-sub-thread ${
          subIsSideChat ? 'sidebar-side-chat-child' : ''
        } provider-${subChat.provider || 'gemini'} ${
          selectedChatId === subChat.appChatId ? 'active' : ''
        } ${subRunning ? 'running' : ''}${
          subRowTone ? ` ${sidebarRowToneClass(subRowTone)}` : ''
        }`}
        onClick={() => selectAndAcknowledgeChat(subChat)}
        onKeyDown={(event) => handleChatRowKeyDown(event, subChat)}
        aria-label={subRowA11y.ariaLabel}
        aria-current={subRowA11y.ariaCurrent}
        aria-describedby={subRowA11y.statusDescribedById}
      >
        {subRowA11y.statusDescription && (
          <span id={subRowA11y.statusDescribedById} className="sr-only">
            {subRowA11y.statusDescription}
          </span>
        )}
        <span className="sidebar-sub-thread-prefix" aria-hidden>
          {subIsSideChat ? '⇄' : '↳'}
        </span>
        {subAgentIdentity ? (
          <AgentIdentityIcon
            name={subAgentIdentity.key}
            color={subAgentIdentity.accent}
            size={18}
            className="sidebar-sub-thread-identicon"
            title={subAgentIdentity.name}
          />
        ) : (
          <span className="sidebar-sub-thread-dot" aria-hidden="true" style={{ background: subProviderColor }} />
        )}
        <span className="sidebar-chat-copy" title={subChat.title}>
          <span className="sidebar-chat-title-line">
            <SidebarProviderLabel provider={subChat.provider} />
            <SidebarChatTitleEditable
              chat={subChat}
              className="sidebar-chat-title"
              query={sidebarSearchQuery}
              isEditing={isChatRenameTarget(subChat, renameSurfaceId)}
              onStartEdit={() => startChatRename(subChat, renameSurfaceId)}
              onSubmit={(next) => commitChatRename(subChat, next)}
              onCancel={() => setEditingChatTarget(null)}
            />
          </span>
          <span className="sidebar-chat-subline">
            <span className="sidebar-run-status tone-muted">{subKindLabel}</span>
            {subAgentIdentity && (
              <span className="sidebar-run-status tone-muted">{subAgentIdentity.name}</span>
            )}
            {!subIsSideChat && subRouteLabel && (
              <span className="sidebar-run-status tone-muted">{subRouteLabel}</span>
            )}
            {subSideChatMetaLabels.map((label) => (
              <span key={label} className="sidebar-run-status tone-muted">
                {label}
              </span>
            ))}
          </span>
        </span>
        <SidebarOverflowMenu
          triggerLabel={`${subKindLabel} actions`}
          items={buildChatMenuItems(subChat, renameSurfaceId)}
        />
      </div>
    )
  }

  const toggleWorkspaceExpanded = (event: MouseEvent<HTMLButtonElement>, workspaceId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setExpandedWorkspaceIds((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) {
        next.delete(workspaceId)
      } else {
        next.add(workspaceId)
      }
      return next
    })
  }

  const toggleSubThreadsExpanded = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
    parentChatId: string
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setExpandedSubThreadParentIds((prev) => {
      const next = new Set(prev)
      if (next.has(parentChatId)) {
        next.delete(parentChatId)
      } else {
        next.add(parentChatId)
      }
      return next
    })
  }

  // `handleAddChat` retired alongside the workspace tile's inline
  // `+` button (1.0.3). New chat lives in the workspace overflow
  // menu's `New chat` item now (built in `buildWorkspaceMenuItems`).

  // Phase L6 slice 1 — `formatResetShort` extracted to
  // `lib/UsageFormat.ts`; the Model Usage card now lives in its
  // own `ModelUsageCard` component. Sidebar no longer needs to
  // reference either directly.

  const wrapHierarchySection = (
    sectionId: SidebarHierarchySectionId,
    content: ReactNode,
    visible = true
  ): ReactNode => {
    if (!visible) return null
    const label = SIDEBAR_HIERARCHY_SECTION_LABELS[sectionId]
    const style: CSSProperties = sectionOrderStyle(sectionId)
    return (
      <div
        key={sectionId}
        data-sidebar-section-id={sectionId}
        className={`sidebar-hierarchy-section ${sectionDragClass(sectionId)}`.trim()}
        style={style}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) =>
          handleSectionPointerDown(event, sectionId, label)
        }
      >
        {content}
      </div>
    )
  }

  return (
    <div
      className={`app-sidebar${animationClassName ? ` ${animationClassName}` : ''}${
        footerPopoverActive ? ' has-footer-popover' : ''
      }`}
    >
      <div className="sidebar-titlebar-fill" aria-hidden />
      <div className="sidebar-content">
        <div className="sidebar-top-chrome">
        {/* The update pill lives INSIDE the fixed-opacity top-chrome band so the
            row shares the band's fill — outside it the row sat on the raw
            slider-opacity sidebar surface and read as a gap in the chrome. */}
        {isUpdatePillVisible(updateSnapshot) && (onQuickUpdate || onOpenChangelog) ? (
          <div className="sidebar-update-pill-row">
            <UpdatePill
              snapshot={updateSnapshot ?? null}
              onQuickUpdate={onQuickUpdate}
              onOpen={onOpenChangelog}
              variant="sidebar"
            />
          </div>
        ) : null}
        <div className="sidebar-masthead">
          <div className="sidebar-masthead-copy">
            <span className="sidebar-product-label">
              <span
                className="sidebar-product-ghost sidebar-product-ghost-monoline"
                aria-hidden
                dangerouslySetInnerHTML={{ __html: taskwraithGhostMonolineSvg }}
              />
              TaskWraith
            </span>
            {/* On the first-launch zero-state `currentScopeTitle` falls
                back to "TaskWraith" (no workspace, no global chat), which
                would render "TaskWraith" twice stacked. Suppress the
                redundant scope title in that single case. */}
            {currentScopeTitle && currentScopeTitle !== 'TaskWraith' && (
              <strong title={currentWorkspace?.path || currentScopeTitle}>
                {currentScopeTitle}
              </strong>
            )}
          </div>
          <div className="sidebar-new-menu-wrap" ref={newMenuWrapRef}>
            <button
              type="button"
              className="sidebar-primary-action"
              onClick={() => {
                setSharedCreateMenuOpen(false)
                setNewMenuOpen((current) => {
                  const next = !current
                  if (next) {
                    setNewMenuSharedOpen(false)
                    setNewMenuWorkflowTemplatesOpen(false)
                  }
                  return next
                })
              }}
              title="Create"
              aria-label="Create"
              aria-expanded={newMenuOpen}
              aria-haspopup="menu"
            >
              <PlusSymbolIcon />
              <span>New</span>
            </button>
            {newMenuOpen && (
              <div className="sidebar-new-menu" role="menu" onKeyDown={moveMenuFocus}>
                <button
                  type="button"
                  role="menuitem"
                  className="sidebar-new-menu-item"
                  onClick={
                    activeSidebarTab === 'threads'
                      ? handleNewWorkspaceChat
                      : handlePrimaryNewChat
                  }
                  disabled={activeSidebarTab === 'threads' && !defaultWorkspaceForNewChat}
                  title={primaryNewTitle}
                >
                  {activeSidebarTab === 'threads' ? <FolderSymbolIcon /> : <ChatBubbleSymbolIcon />}
                  <span className="sidebar-new-menu-item-label">
                    {activeSidebarTab === 'threads' ? 'New Workspace Chat' : 'New Chat'}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sidebar-new-menu-item"
                  onClick={
                    activeSidebarTab === 'threads'
                      ? handlePrimaryNewChat
                      : handleNewWorkspaceChat
                  }
                  disabled={activeSidebarTab !== 'threads' && !defaultWorkspaceForNewChat}
                  title={
                    activeSidebarTab === 'threads'
                      ? 'New general chat'
                      : defaultWorkspaceForNewChat
                      ? `New workspace chat in ${defaultWorkspaceForNewChat.displayName}`
                      : 'Add a workspace first to create a workspace chat'
                  }
                >
                  {activeSidebarTab === 'threads' ? <ChatBubbleSymbolIcon /> : <FolderSymbolIcon />}
                  <span className="sidebar-new-menu-item-label">
                    {activeSidebarTab === 'threads' ? 'New General Chat' : 'New Workspace Chat'}
                  </span>
                </button>
                {onCreateWorkflow && (
                  <button
                    type="button"
                    role="menuitem"
                    className="sidebar-new-menu-item"
                    onClick={handleNewWorkflow}
                    disabled={!defaultWorkflowWorkspace}
                    title={
                      defaultWorkflowWorkspace
                        ? `New workflow in ${defaultWorkflowWorkspace.displayName}`
                        : 'Open a workspace first — workflows run inside a workspace'
                    }
                  >
                    <WorkflowGlyphIcon />
                    <span className="sidebar-new-menu-item-label">New Workflow</span>
                  </button>
                )}
                {onCreateWorkflowFromPluginTemplate && pluginWorkflowTemplates.length > 0 && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-new-menu-item sidebar-new-menu-shared-toggle"
                      onClick={() => {
                        setNewMenuSharedOpen(false)
                        setNewMenuWorkflowTemplatesOpen((current) => !current)
                      }}
                      aria-expanded={newMenuWorkflowTemplatesOpen}
                      disabled={!defaultWorkflowWorkspace}
                      title={
                        defaultWorkflowWorkspace
                          ? 'Start from an active plugin workflow template'
                          : 'Open a workspace first — workflows run inside a workspace'
                      }
                    >
                      <WorkflowGlyphIcon />
                      <span className="sidebar-new-menu-item-label">Workflow Templates...</span>
                      <span className="sidebar-new-menu-chevron" aria-hidden>
                        <ChevronSymbolIcon isExpanded={newMenuWorkflowTemplatesOpen} />
                      </span>
                    </button>
                    {newMenuWorkflowTemplatesOpen &&
                      pluginWorkflowTemplates.slice(0, 8).map((entry) => (
                        <button
                          type="button"
                          role="menuitem"
                          key={entry.id}
                          className="sidebar-new-menu-item sidebar-new-menu-subitem"
                          onClick={() => handleNewWorkflowFromTemplate(entry.id)}
                          disabled={!defaultWorkflowWorkspace}
                          title={
                            entry.template.description ||
                            `${entry.plugin.pluginId} workflow template`
                          }
                        >
                          <WorkflowGlyphIcon />
                          <span className="sidebar-new-menu-item-label">
                            {entry.template.name}
                          </span>
                        </button>
                      ))}
                  </>
                )}
                {onCreateWorkspaceBoard && (
                  <button
                    type="button"
                    role="menuitem"
                    className="sidebar-new-menu-item"
                    onClick={handleNewWorkspaceBoard}
                    disabled={workspaces.length === 0}
                    title={
                      workspaces.length > 0
                        ? 'New workspace board'
                        : 'Add a workspace first to create a board'
                    }
                  >
                    <BoardSymbolIcon />
                    <span className="sidebar-new-menu-item-label">New Workspace Board</span>
                  </button>
                )}
                {onCreateSharedChat && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="sidebar-new-menu-item sidebar-new-menu-shared-toggle"
                      onClick={() => {
                        setNewMenuWorkflowTemplatesOpen(false)
                        setNewMenuSharedOpen((current) => !current)
                      }}
                      aria-expanded={newMenuSharedOpen}
                      title="Show People chat options"
                    >
                      <PeopleSymbolIcon />
                      <span className="sidebar-new-menu-item-label">People...</span>
                      <span className="sidebar-new-menu-chevron" aria-hidden>
                        <ChevronSymbolIcon isExpanded={newMenuSharedOpen} />
                      </span>
                    </button>
                    {newMenuSharedOpen && sharedChatCreateOptions.map((option) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={option.variant}
                        className="sidebar-new-menu-item sidebar-new-menu-subitem"
                        onClick={() => handleCreateSharedChat(option.variant)}
                        disabled={option.disabled}
                        title={option.title}
                      >
                        <PeopleSymbolIcon />
                        <span className="sidebar-new-menu-item-label">{option.label}</span>
                      </button>
                    ))}
                  </>
                )}
                {onJoinSharedChat && (
                  <button
                    type="button"
                    role="menuitem"
                    className="sidebar-new-menu-item"
                    onClick={() => {
                      setNewMenuOpen(false)
                      setNewMenuSharedOpen(false)
                      setNewMenuWorkflowTemplatesOpen(false)
                      onJoinSharedChat()
                    }}
                    title="Join a People chat — paste an invite to follow along"
                  >
                    <PeopleSymbolIcon />
                    <span className="sidebar-new-menu-item-label">Join a People Chat</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="sidebar-masthead-stats" aria-label="Sidebar summary">
          {activeSidebarTab !== 'chat' && (
            <span>
              {workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}
            </span>
          )}
          <span>
            {activeSidebarChatCount} {activeSidebarTab === 'chat' ? 'chat' : 'thread'}
            {activeSidebarChatCount === 1 ? '' : 's'}
          </span>
          {runningCount > 0 && <span className="sidebar-stat-live">{runningCount} running</span>}
        </div>

        <div
          className="segmented-control sidebar-view-tabs"
          role="tablist"
          aria-label="Sidebar view"
        >
          {SIDEBAR_ACTIVE_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeSidebarTab === tab}
              aria-controls={`sidebar-${tab}-panel`}
              className={`segmented-control-segment sidebar-view-tab ${
                activeSidebarTab === tab ? 'is-active' : ''
              }`}
              id={`sidebar-${tab}-tab`}
              onClick={() => selectSidebarTab(tab)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const direction = event.key === 'ArrowRight' ? 1 : -1
                const currentIndex = SIDEBAR_ACTIVE_TABS.indexOf(tab)
                const nextTab =
                  SIDEBAR_ACTIVE_TABS[
                    (currentIndex + direction + SIDEBAR_ACTIVE_TABS.length) %
                      SIDEBAR_ACTIVE_TABS.length
                  ]
                selectSidebarTab(nextTab)
                window.requestAnimationFrame(() => {
                  document.getElementById(`sidebar-${nextTab}-tab`)?.focus()
                })
              }}
              tabIndex={activeSidebarTab === tab ? 0 : -1}
            >
              {tab === 'chat' ? 'Chat' : tab === 'threads' ? 'Code' : 'Work'}
            </button>
          ))}
        </div>

        <div className="sidebar-search-section">
          <label className="sidebar-search-field">
            <SearchSymbolIcon />
            <input
              ref={searchInputRef}
              type="search"
              value={sidebarSearch}
              onChange={(event) => setActiveSidebarSearch(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears a non-empty query, then blurs an
                // already-empty field — matches the ✕ clear button +
                // the Finder-style "Escape backs out" expectation.
                if (event.key === 'Escape') {
                  event.preventDefault()
                  if (sidebarSearch) {
                    setActiveSidebarSearch('')
                  } else {
                    event.currentTarget.blur()
                  }
                }
              }}
              placeholder={
                activeSidebarTab === 'projects'
                  ? 'Search projects & members'
                  : activeSidebarTab === 'chat'
                    ? 'Search chats'
                    : 'Search workspaces & threads'
              }
              aria-label={
                activeSidebarTab === 'projects'
                  ? 'Search projects and project members'
                  : activeSidebarTab === 'chat'
                    ? 'Search chats'
                    : 'Search workspaces and chats'
              }
              spellCheck={false}
            />
            {!isSidebarSearchActive && searchShortcutHint && (
              <span className="sidebar-search-hint">{searchShortcutHint}</span>
            )}
            {isSidebarSearchActive && (
              <>
                <span className="sidebar-search-result-count">{activeSidebarSearchResultCount}</span>
                <button
                  type="button"
                  className="sidebar-search-clear"
                  onClick={() => setActiveSidebarSearch('')}
                  title="Clear search"
                  aria-label={
                    activeSidebarTab === 'projects'
                      ? 'Clear project search'
                      : activeSidebarTab === 'chat'
                        ? 'Clear chat search'
                        : 'Clear workspace and thread search'
                  }
                >
                  <XSymbolIcon />
                </button>
              </>
            )}
          </label>
        </div>
        </div>

        <div className="sidebar-hierarchy-scroll">
          {activeSidebarTab === 'projects' ? (
            <div
              id="sidebar-projects-panel"
              role="tabpanel"
              aria-labelledby="sidebar-projects-tab"
            >
              <ProjectsSidebarView
                chats={projectSidebarChats}
                currentChat={currentChat}
                activeChatId={selectedChatId}
                runningChatIds={runningChatIds}
                searchQuery={sidebarSearchQuery}
                isSearchActive={isSidebarSearchActive}
                onSelectChat={selectAndAcknowledgeChat}
                onStartProjectHome={onStartProjectHome}
                onSelectedProjectChange={onSelectedProjectChange}
                onOpenReferencesLibrary={onOpenReferencesLibrary}
                onAddRunQueueJobToWorkspaceBoard={onAddRunQueueJobToWorkspaceBoard}
                workspaces={workspaces}
                onSearchResultCountChange={setProjectsSearchResultCount}
              />
              {onOpenThreadGraph && projectGraphEntries && projectGraphEntries.length > 0 && (
                <section className="sidebar-project-graphs-section" aria-label="Node graphs">
                  <div className="sidebar-project-graphs-header">
                    <span className="sidebar-project-graphs-title">Node Graphs</span>
                    <span className="sidebar-project-graphs-hint">Map a project&apos;s threads</span>
                  </div>
                  <div className="sidebar-project-graphs-list">
                    {projectGraphEntries.map((entry) => (
                      <div
                        key={entry.id}
                        role="button"
                        tabIndex={0}
                        className={`sidebar-project-graph-item ${
                          activeThreadGraphProjectId === entry.id ? 'active' : ''
                        }`}
                        onClick={() => onOpenThreadGraph(entry.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onOpenThreadGraph(entry.id)
                          }
                        }}
                        title={`Open ${entry.name} node graph`}
                      >
                        <span className="sidebar-project-graph-glyph" aria-hidden="true">
                          ◇
                        </span>
                        <span className="sidebar-project-graph-name">{entry.name}</span>
                        <span className="sidebar-project-graph-count">{entry.memberCount}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div
              id={`sidebar-${activeSidebarTab}-panel`}
              role="tabpanel"
              aria-labelledby={`sidebar-${activeSidebarTab}-tab`}
            >
          {wrapHierarchySection(
            'active-runs',
            <ActiveRunsSection
              chats={chats}
              currentChat={currentChat}
              runningChatIds={runningChatIds}
              surface={activeSidebarTab === 'chat' ? 'chat' : 'code'}
              onSelectChat={selectAndAcknowledgeChat}
              onInspectRun={onInspectRun}
              onAddRunQueueJobToWorkspaceBoard={onAddRunQueueJobToWorkspaceBoard}
            />
          )}

          {wrapHierarchySection(
            'local-servers',
            <LocalServersSection onAddLocalServerToWorkspaceBoard={onAddLocalServerToWorkspaceBoard} />,
            activeSidebarTab === 'threads' && localServers.length > 0
          )}

          {wrapHierarchySection(
            'workflows',
            <div className="sidebar-workflows-section">
            <div className="sidebar-section-header">
              <button
                type="button"
                className="sidebar-section-header-toggle"
                onClick={() => toggleSidebarSection('workflows')}
                aria-expanded={!isSectionCollapsed('workflows')}
                title={
                  isSectionCollapsed('workflows') ? 'Expand Workflows' : 'Collapse Workflows'
                }
              >
                <ChevronSymbolIcon isExpanded={!isSectionCollapsed('workflows')} />
                <h4 className="sidebar-section-title">Workflows</h4>
                {visibleWorkflows.length > 0 && (
                  <span className="sidebar-section-count">{visibleWorkflows.length}</span>
                )}
              </button>
              <button
                type="button"
                className="sidebar-section-header-action sidebar-workflow-create"
                onClick={handleNewWorkflow}
                disabled={!onCreateWorkflow || workspaces.length === 0}
                title={
                  workspaces.length === 0
                    ? 'Add a workspace first — workflows run inside a workspace'
                    : defaultWorkflowWorkspace
                      ? `New workflow in ${defaultWorkflowWorkspace.displayName}`
                      : 'Open a workspace first — workflows run inside a workspace'
                }
                aria-label="New workflow"
              >
                <PlusSymbolIcon />
              </button>
            </div>
            {!isSectionCollapsed('workflows') && (
              <div className="sidebar-workflow-list">
                {visibleWorkflows.length === 0 ? (
                  <div className="sidebar-workflow-empty">
                    {isSidebarSearchActive ? 'No matching workflows' : 'No workflows'}
                  </div>
                ) : (
                  visibleWorkflows.map((workflow) => {
                    const activeExecution = workflow.activeExecutionId
                      ? workflow.history.find(
                          (execution) => execution.id === workflow.activeExecutionId
                        ) || null
                      : null
                    const activeTask = activeExecution?.scheduledTaskId
                      ? scheduledTaskById.get(activeExecution.scheduledTaskId) || null
                      : null
                    const isActiveExecution =
                      isWorkflowExecutionActive(activeExecution?.status) ||
                      activeTask?.status === 'running' ||
                      activeTask?.status === 'due'
                    const latestExecution =
                      workflow.history.length > 0
                        ? workflow.history[workflow.history.length - 1]
                        : null
                    const status = isActiveExecution
                      ? activeTask?.status === 'running'
                        ? 'running'
                        : activeExecution?.status || 'queued'
                      : workflow.enabled
                        ? workflow.lastStatus
                        : 'paused'
                    const statusLabel = workflow.enabled
                      ? formatWorkflowStatus(status)
                      : 'Paused'
                    const selected = selectedWorkflowId === workflow.id
                    const statusCounters = getWorkflowStatusCounters(workflow.history)
                    // P2b: a minted, non-safe unattended-elevation ack.
                    const unattendedElevation =
                      workflow.unattendedElevation && workflow.unattendedElevation.level !== 'safe'
                        ? workflow.unattendedElevation
                        : null
                    const unattendedElevationLabel =
                      unattendedElevation?.level === 'full_access'
                        ? 'Full Access'
                        : 'Default'
                    return (
                      <div key={workflow.id} className="sidebar-workflow-block">
                        <button
                          type="button"
                          className={`sidebar-workflow-item provider-${workflow.template.provider || 'gemini'} ${
                            selected ? 'active' : ''
                          } ${workflow.enabled ? '' : 'is-paused'}`}
                          onClick={() => {
                            // Summon the workflow's transcript into the main pane
                            // AND expand its controls. The chip used to only toggle
                            // the controls, leaving the main pane on whatever chat
                            // was open — the source of the "workflows feel detached"
                            // confusion.
                            setSelectedWorkflowId((current) =>
                              current === workflow.id ? null : workflow.id
                            )
                            const workflowChat = chats.find(
                              (chat) => chat.appChatId === workflow.template.chatId
                            )
                            if (workflowChat && currentChat?.appChatId !== workflowChat.appChatId) {
                              selectAndAcknowledgeChat(workflowChat)
                            }
                          }}
                          aria-expanded={selected}
                          title={workflow.name}
                        >
                          <ProviderBadgeIcon provider={workflow.template.provider} />
                          <span className="sidebar-workflow-copy">
                            <span className="sidebar-workflow-name">
                              <HighlightMatch text={workflow.name} query={sidebarSearchQuery} />
                            </span>
                            <span className="sidebar-workflow-meta">
                              {formatWorkflowTrigger(workflow)}
                            </span>
                          </span>
                          {unattendedElevation && (
                            <span
                              className="sidebar-workflow-unattended-badge"
                              title={`Runs unattended with ${unattendedElevationLabel} permissions`}
                              aria-label={`Runs unattended with ${unattendedElevationLabel} permissions`}
                            >
                              ⚠
                            </span>
                          )}
                          {typeof workflow.lastRunIterationCount === 'number' &&
                            workflow.lastRunIterationCount > 0 && (
                              <span
                                className="sidebar-workflow-loop-count"
                                title={`Loop: ${workflow.lastRunIterationCount} iteration${
                                  workflow.lastRunIterationCount === 1 ? '' : 's'
                                }${workflow.lastRunStopReason ? ` · ${workflow.lastRunStopReason}` : ''}`}
                                aria-label={`${workflow.lastRunIterationCount} loop iterations`}
                              >
                                {workflow.lastRunIterationCount}×
                              </span>
                            )}
                          <span
                            className={`sidebar-workflow-status tone-${workflowStatusTone(status)}`}
                          >
                            {statusLabel}
                          </span>
                        </button>
                        {selected && (
                          <div className="sidebar-workflow-detail">
                            <div className="sidebar-workflow-detail-row">
                              <span>Next</span>
                              <strong>{formatWorkflowTime(workflow.nextRunAt)}</strong>
                            </div>
                            {latestExecution && (
                              <div className="sidebar-workflow-detail-row">
                                <span>Last</span>
                                <strong>{formatWorkflowStatus(latestExecution.status)}</strong>
                              </div>
                            )}
                            <div className="sidebar-workflow-icon-strip">
                              <div className="sidebar-workflow-actions">
                                <button
                                  type="button"
                                  className="sidebar-workflow-action primary"
                                  onClick={() => onRunWorkflowNow?.(workflow.id)}
                                  disabled={!onRunWorkflowNow}
                                  title="Run now"
                                  aria-label={`Run ${workflow.name} now`}
                                >
                                  <WorkflowActionIcon kind="run" />
                                </button>
                                <button
                                  type="button"
                                  className="sidebar-workflow-action"
                                  onClick={() => onAddWorkflowToWorkspaceBoard?.(workflow)}
                                  disabled={!onAddWorkflowToWorkspaceBoard}
                                  title="Add to Workspace Board"
                                  aria-label={`Add ${workflow.name} to workspace board`}
                                >
                                  <WorkflowActionIcon kind="board" />
                                </button>
                                <button
                                  type="button"
                                  className="sidebar-workflow-action"
                                  onClick={() => onToggleWorkflowEnabled?.(workflow)}
                                  disabled={!onToggleWorkflowEnabled}
                                  title={workflow.enabled ? 'Pause' : 'Resume'}
                                  aria-label={`${workflow.enabled ? 'Pause' : 'Resume'} ${
                                    workflow.name
                                  }`}
                                >
                                  <WorkflowActionIcon
                                    kind={workflow.enabled ? 'pause' : 'resume'}
                                  />
                                </button>
                                <button
                                  type="button"
                                  className="sidebar-workflow-action"
                                  onClick={() => onEditWorkflowInterval?.(workflow)}
                                  disabled={!onEditWorkflowInterval}
                                  title="Cadence"
                                  aria-label={`Edit ${workflow.name} cadence`}
                                >
                                  <WorkflowActionIcon kind="cadence" />
                                </button>
                                <button
                                  type="button"
                                  className={`sidebar-workflow-action${
                                    unattendedElevation ? ' is-active' : ''
                                  }`}
                                  onClick={() => onSetWorkflowUnattended?.(workflow)}
                                  disabled={!onSetWorkflowUnattended}
                                  title={
                                    unattendedElevation
                                      ? `Unattended: ${unattendedElevationLabel} — click to revoke`
                                      : 'Unattended permissions'
                                  }
                                  aria-label={`Unattended permissions for ${workflow.name}`}
                                  aria-pressed={Boolean(unattendedElevation)}
                                >
                                  <WorkflowActionIcon kind="unattended" />
                                </button>
                                {isActiveExecution && (
                                  <button
                                    type="button"
                                    className="sidebar-workflow-action danger"
                                    onClick={() => onCancelWorkflowExecution?.(workflow)}
                                    disabled={!onCancelWorkflowExecution}
                                    title="Cancel"
                                    aria-label={`Cancel ${workflow.name} run`}
                                  >
                                    <WorkflowActionIcon kind="cancel" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="sidebar-workflow-action danger"
                                  onClick={() => onDeleteWorkflow?.(workflow.id)}
                                  disabled={!onDeleteWorkflow}
                                  title="Delete"
                                  aria-label={`Delete ${workflow.name}`}
                                >
                                  <WorkflowActionIcon kind="delete" />
                                </button>
                              </div>
                              {statusCounters.length > 0 && (
                                <div
                                  className="sidebar-workflow-stats"
                                  aria-label="Workflow run counters"
                                >
                                  {statusCounters.map(({ status, count }) => (
                                    <span
                                      key={status}
                                      className={`sidebar-workflow-stat tone-${workflowStatusTone(
                                        status
                                      )}`}
                                      title={`${formatWorkflowStatus(status)}: ${count}`}
                                      aria-label={`${formatWorkflowStatus(status)} runs: ${count}`}
                                    >
                                      <WorkflowStatusCounterIcon status={status} />
                                      <span>{count}</span>
                                    </span>
                                  ))}
                                </div>
                              )}
                              <WorkflowRunHistory key={workflow.id} workflowId={workflow.id} />
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            )}
            </div>,
            activeSidebarTab === 'threads'
          )}

          {wrapHierarchySection(
            'workspace-boards',
            <div className="sidebar-workspace-boards-section">
              <div className="sidebar-section-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('workspace-boards')}
                  aria-expanded={!isSectionCollapsed('workspace-boards')}
                  title={
                    isSectionCollapsed('workspace-boards')
                      ? 'Expand Workspace Boards'
                      : 'Collapse Workspace Boards'
                  }
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('workspace-boards')} />
                  <h4 className="sidebar-section-title">Workspace Boards</h4>
                  {visibleWorkspaceBoards.length > 0 && (
                    <span className="sidebar-section-count">{visibleWorkspaceBoards.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="sidebar-section-header-action sidebar-workspace-board-create"
                  onClick={handleNewWorkspaceBoard}
                  disabled={!onCreateWorkspaceBoard || workspaces.length === 0}
                  title={
                    workspaces.length > 0
                      ? 'New workspace board'
                      : 'Add a workspace first to create a board'
                  }
                  aria-label="New workspace board"
                >
                  <PlusSymbolIcon />
                </button>
              </div>
              {!isSectionCollapsed('workspace-boards') && (
                <div className="sidebar-workspace-board-list">
                  {visibleWorkspaceBoards.length === 0 && archivedWorkspaceBoards.length === 0 ? (
                    <div className="sidebar-workflow-empty">
                      {isSidebarSearchActive ? 'No matching boards' : 'No workspace boards'}
                    </div>
                  ) : visibleWorkspaceBoards.length > 0 ? (
                    visibleWorkspaceBoards.map((board) => {
                      const workspace = workspaceById.get(board.workspaceId)
                      const boardCards = workspaceBoardCardsByBoardId.get(board.id) || []
                      const attentionCount = boardCards.filter(
                        (card) =>
                          card.columnId === 'needs-input' ||
                          card.columnId === 'blocked' ||
                          card.columnId === 'review-ready'
                      ).length
                      const boardMeta = [
                        board.pinned ? 'Pinned' : null,
                        workspace?.displayName || 'Workspace',
                        `${boardCards.length} card${boardCards.length === 1 ? '' : 's'}`,
                        attentionCount > 0
                          ? `${attentionCount} attention`
                          : null
                      ]
                        .filter(Boolean)
                        .join(' · ')
                      return (
                        <div key={board.id} className="sidebar-workspace-board-block">
                          <div
                            role="button"
                            tabIndex={0}
                            className={`sidebar-workspace-board-item ${
                              activeWorkspaceBoardId === board.id ? 'active' : ''
                            }`}
                            onClick={() => onOpenWorkspaceBoard?.(board)}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                onOpenWorkspaceBoard?.(board)
                              }
                            }}
                            title={board.name}
                          >
                            <span className="sidebar-workspace-board-icon" aria-hidden>
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                                <path d="M3 3.5h10M3 8h10M3 12.5h10" />
                                <path d="M5.5 2.5v11M10.5 2.5v11" />
                              </svg>
                            </span>
                            <span className="sidebar-workflow-copy">
                              <span className="sidebar-workflow-name">
                                <HighlightMatch text={board.name} query={sidebarSearchQuery} />
                              </span>
                              <span className="sidebar-workflow-meta">
                                {boardMeta}
                              </span>
                            </span>
                            <SidebarOverflowMenu
                              triggerLabel="Workspace board actions"
                              items={buildWorkspaceBoardMenuItems(board)}
                            />
                          </div>
                        </div>
                      )
                    })
                  ) : null}
                  {archivedWorkspaceBoards.length > 0 && (
                    <div className="sidebar-workspace-board-archived-group">
                      <div className="sidebar-workflow-empty">Archived</div>
                      {archivedWorkspaceBoards.map((board) => {
                        const workspace = workspaceById.get(board.workspaceId)
                        const boardCards = workspaceBoardCardsByBoardId.get(board.id) || []
                        const boardMeta = [
                          'Archived',
                          workspace?.displayName || 'Workspace',
                          `${boardCards.length} active card${boardCards.length === 1 ? '' : 's'}`
                        ].join(' · ')
                        return (
                          <div key={board.id} className="sidebar-workspace-board-block">
                            <div
                              className="sidebar-workspace-board-item archived"
                              title={`${board.name} (archived)`}
                            >
                              <span className="sidebar-workspace-board-icon" aria-hidden>
                                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                                  <path d="M3 3.5h10M3 8h10M3 12.5h10" />
                                  <path d="M5.5 2.5v11M10.5 2.5v11" />
                                </svg>
                              </span>
                              <span className="sidebar-workflow-copy">
                                <span className="sidebar-workflow-name">
                                  <HighlightMatch text={board.name} query={sidebarSearchQuery} />
                                </span>
                                <span className="sidebar-workflow-meta">{boardMeta}</span>
                              </span>
                              <SidebarOverflowMenu
                                triggerLabel="Archived workspace board actions"
                                items={buildWorkspaceBoardMenuItems(board)}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>,
            activeSidebarTab === 'threads'
          )}

          {wrapHierarchySection(
            'pinned',
            <>
          {(visiblePinnedWorkspaces.length > 0 || visiblePinnedChats.length > 0) && (
            <div className="sidebar-pinned-section" {...pinDropProps}>
              <div className="sidebar-section-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('pinned')}
                  aria-expanded={!isSectionCollapsed('pinned')}
                  title={isSectionCollapsed('pinned') ? 'Expand Pinned' : 'Collapse Pinned'}
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('pinned')} />
                  <h4 className="sidebar-section-title">Pinned</h4>
                  {visiblePinnedWorkspaces.length + visiblePinnedChats.length > 0 && (
                    <span className="sidebar-section-count">
                      {visiblePinnedWorkspaces.length + visiblePinnedChats.length}
                    </span>
                  )}
                </button>
              </div>
              {!isSectionCollapsed('pinned') && (
                <div
                  className="sidebar-pinned-list"
                  {...getSidebarThreadListDropProps('code:pinned', orderedPinnedChats)}
                >
                  {visiblePinnedWorkspaces.map((workspace) => (
                    <div
                      key={`pinned-workspace-${workspace.id}`}
                      role="button"
                      tabIndex={0}
                      className={`sidebar-pinned-item ${currentWorkspace?.id === workspace.id ? 'active' : ''}`}
                      onClick={() => onSelectWorkspace(workspace)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onSelectWorkspace(workspace)
                        }
                      }}
                      title={workspace.path}
                    >
                      <FolderSymbolIcon />
                      <span className="sidebar-pinned-label">
                        <HighlightMatch text={workspace.displayName} query={sidebarSearchQuery} />
                      </span>
                      <SidebarOverflowMenu
                        triggerLabel="Workspace actions"
                        items={buildWorkspaceMenuItems(workspace)}
                      />
                    </div>
                  ))}
                  {visiblePinnedChats.map((chat) => {
                    const renameSurfaceId = `pinned-${chat.appChatId}`
                    const dragHandlers = getChatTileDragProps(chat, 'code:pinned')
                    return (
                      <SidebarCompactChatRow
                        key={`pinned-chat-${chat.appChatId}`}
                        chat={chat}
                        variant="pinned"
                        surfaceId={renameSurfaceId}
                        isSelected={selectedChatId === chat.appChatId}
                        isRunning={runningChatIdSet.has(chat.appChatId)}
                        rowTone={rowToneByChatId.get(chat.appChatId) ?? null}
                        needsInput={chatHasPendingAgentQuestion(
                          pendingAgentQuestionsByChatId,
                          chat.appChatId
                        )}
                        isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                        query={sidebarSearchQuery}
                        identityTicker={
                          selectedChatId === chat.appChatId ? activeChatIdentityTicker : null
                        }
                        identityGitIndicators={
                          selectedChatId === chat.appChatId ? activeChatIdentityGitIndicators : null
                        }
                        identityBranch={
                          selectedChatId === chat.appChatId ? activeChatIdentityBranch : null
                        }
                        draggable={dragHandlers.draggable}
                        isDragging={dragHandlers['data-dragging'] === 'true'}
                        dragHandlers={dragHandlers}
                        onSelect={selectAndAcknowledgeChat}
                        onStartRename={startChatRename}
                        onSubmitRename={commitChatRename}
                        onCancelRename={cancelChatRename}
                        buildMenuItems={buildChatMenuItems}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/*
            1.0.5-SB5 — Empty-state drop placeholder. Surfaces only
            while a non-pinned chat is being dragged AND the
            Pinned section is currently empty. Without this, a
            fresh user with nothing pinned has no visible drop
            target and discovers drag-to-pin only by accident.
          */}
          {showPinDropPlaceholder && (
            <div
              className="sidebar-pin-drop-placeholder"
              {...pinDropProps}
              role="region"
              aria-label="Drop here to pin"
            >
              <span className="sidebar-pin-drop-placeholder-glyph" aria-hidden>
                ☆
              </span>
              <span className="sidebar-pin-drop-placeholder-copy">Drop here to pin</span>
            </div>
          )}
            </>,
            visiblePinnedWorkspaces.length > 0 ||
              visiblePinnedChats.length > 0 ||
              showPinDropPlaceholder
          )}

          {wrapHierarchySection(
            'git',
            <div className="sidebar-git-section">
              <div className="sidebar-section-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('git')}
                  aria-expanded={!isSectionCollapsed('git')}
                  title={isSectionCollapsed('git') ? 'Expand Git' : 'Collapse Git'}
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('git')} />
                  <h4 className="sidebar-section-title">Git</h4>
                  {visibleGitWorkflowChats.length > 0 && (
                    <span className="sidebar-section-count">{visibleGitWorkflowChats.length}</span>
                  )}
                </button>
              </div>
              {!isSectionCollapsed('git') && (
                <div className="sidebar-git-list">
                  {gitWorkflowGroups.map((group) => (
                    <div
                      key={`git-group-${group.group}`}
                      className="sidebar-git-group"
                      {...getSidebarThreadListDropProps(`code:git:${group.group}`, group.chats)}
                    >
                      <div className="sidebar-git-subheader">{group.label}</div>
                      {previewSidebarList(`git:${group.group}`, group.chats).map((chat) => {
                        const renameSurfaceId = `git-${group.group}-${chat.appChatId}`
                        const dragHandlers = getChatTileDragProps(
                          chat,
                          `code:git:${group.group}`
                        )
                        return (
                          <SidebarCompactChatRow
                            key={`git-chat-${group.group}-${chat.appChatId}`}
                            chat={chat}
                            variant="git"
                            surfaceId={renameSurfaceId}
                            isSelected={selectedChatId === chat.appChatId}
                            isRunning={runningChatIdSet.has(chat.appChatId)}
                            rowTone={rowToneByChatId.get(chat.appChatId) ?? null}
                            needsInput={chatHasPendingAgentQuestion(
                              pendingAgentQuestionsByChatId,
                              chat.appChatId
                            )}
                            isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                            query={sidebarSearchQuery}
                            identityTicker={
                              selectedChatId === chat.appChatId ? activeChatIdentityTicker : null
                            }
                            identityGitIndicators={
                              selectedChatId === chat.appChatId ? activeChatIdentityGitIndicators : null
                            }
                            identityBranch={
                              selectedChatId === chat.appChatId ? activeChatIdentityBranch : null
                            }
                            draggable={dragHandlers.draggable}
                            isDragging={dragHandlers['data-dragging'] === 'true'}
                            dragHandlers={dragHandlers}
                            onSelect={selectAndAcknowledgeChat}
                            onStartRename={startChatRename}
                            onSubmitRename={commitChatRename}
                            onCancelRename={cancelChatRename}
                            buildMenuItems={buildChatMenuItems}
                          />
                        )
                      })}
                      {renderSidebarShowMore(`git:${group.group}`, group.chats.length)}
                    </div>
                  ))}
                  {gitWorkflowGroups.length === 0 && !isSidebarSearchActive && (
                    <div className="sidebar-empty-state">
                      <strong>No git workflows yet</strong>
                      <span>Threads land here when they push or open a PR.</span>
                    </div>
                  )}
                  {gitWorkflowGroups.length === 0 && isSidebarSearchActive && (
                    <div className="sidebar-empty-state">
                      <strong>No matches</strong>
                      <span>No git workflow threads match.</span>
                    </div>
                  )}
                </div>
              )}
            </div>,
            true
          )}

          {wrapHierarchySection(
            'recents',
            visibleRecentChats.length > 0 ? (
            <div className="sidebar-recents-section">
              <div className="sidebar-section-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('recents')}
                  aria-expanded={!isSectionCollapsed('recents')}
                  title={isSectionCollapsed('recents') ? 'Expand Recents' : 'Collapse Recents'}
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('recents')} />
                  <h4 className="sidebar-section-title">Recents</h4>
                </button>
              </div>
              {!isSectionCollapsed('recents') && (
                <div
                  className="sidebar-recents-list"
                  {...getSidebarThreadListDropProps('code:recents', orderedRecentChats)}
                >
                  {previewSidebarList('recents', visibleRecentChats).map((chat) => {
                    const renameSurfaceId = `recent-${chat.appChatId}`
                    const dragHandlers = getChatTileDragProps(chat, 'code:recents')
                    return (
                      <SidebarCompactChatRow
                        key={`recent-${chat.appChatId}`}
                        chat={chat}
                        variant="recents"
                        surfaceId={renameSurfaceId}
                        isSelected={selectedChatId === chat.appChatId}
                        isRunning={runningChatIdSet.has(chat.appChatId)}
                        rowTone={rowToneByChatId.get(chat.appChatId) ?? null}
                        needsInput={chatHasPendingAgentQuestion(
                          pendingAgentQuestionsByChatId,
                          chat.appChatId
                        )}
                        isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                        query={sidebarSearchQuery}
                        identityTicker={
                          selectedChatId === chat.appChatId ? activeChatIdentityTicker : null
                        }
                        identityGitIndicators={
                          selectedChatId === chat.appChatId ? activeChatIdentityGitIndicators : null
                        }
                        identityBranch={
                          selectedChatId === chat.appChatId ? activeChatIdentityBranch : null
                        }
                        draggable={dragHandlers.draggable}
                        isDragging={dragHandlers['data-dragging'] === 'true'}
                        dragHandlers={dragHandlers}
                        onSelect={selectAndAcknowledgeChat}
                        onStartRename={startChatRename}
                        onSubmitRename={commitChatRename}
                        onCancelRename={cancelChatRename}
                        buildMenuItems={buildChatMenuItems}
                      />
                    )
                  })}
                  {renderSidebarShowMore('recents', visibleRecentChats.length)}
                </div>
              )}
            </div>
            ) : null,
            visibleRecentChats.length > 0
          )}

          {wrapHierarchySection(
            'ensembles',
            ensembleModeEnabled ? (
            <div className="sidebar-ensembles-section">
              {/* 1.0.3 — dropped the `sidebar-section-header-with-action`
                  modifier so the Ensembles `+` aligns to the trailing
                  edge (matches Workspaces / Chats). The modifier was
                  pinning the `+` flush against the title with
                  justify-content: flex-start; the base `.sidebar-section-
                  header` uses space-between which is what we want here. */}
              <div className="sidebar-section-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('ensembles')}
                  aria-expanded={!isSectionCollapsed('ensembles')}
                  title={
                    isSectionCollapsed('ensembles') ? 'Expand Ensembles' : 'Collapse Ensembles'
                  }
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('ensembles')} />
                  <h4 className="sidebar-section-title">Ensembles</h4>
                  {visibleEnsembleChats.length > 0 && (
                    <span className="sidebar-section-count">{visibleEnsembleChats.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="sidebar-section-header-action sidebar-ensemble-create"
                  onClick={handleNewEnsemble}
                  title="New Ensemble"
                  aria-label="New Ensemble"
                >
                  <PlusSymbolIcon />
                </button>
              </div>
              {!isSectionCollapsed('ensembles') &&
                (visibleEnsembleChats.length === 0 ? (
                  /*
                  Empty-state caption. Gives ensembles the same
                  discoverability Workspaces gets when the list is
                  empty — without it, fresh users never see the
                  section at all. The caption points at the section
                  header action now that the masthead picker keeps chat
                  creation deterministic.
                */
                  <div className="sidebar-ensembles-empty" role="note">
                    <span className="sidebar-ensembles-empty-icon" aria-hidden>
                      <EnsembleSymbolIcon />
                    </span>
                    <span className="sidebar-ensembles-empty-copy">
                      No ensembles yet. Use the <strong>Ensembles +</strong> button to put two or
                      more providers in the same thread.
                    </span>
                  </div>
                ) : (
                  <div
                    className="sidebar-chat-list sidebar-ensemble-list"
                    {...getSidebarThreadListDropProps('code:ensembles', orderedEnsembleChats)}
                  >
                    {previewSidebarList('ensembles', visibleEnsembleChats).map((chat) => {
                      const activeRound = chat.ensemble?.activeRound
                      const activeParticipant = chat.ensemble?.participants.find(
                        (participant) => participant.id === activeRound?.activeParticipantId
                      )
                      const isRunning = isEnsembleActiveRoundDispatchLive(activeRound)
                      const rowTone = rowToneByChatId.get(chat.appChatId) ?? null
                      const toneClass = rowTone ? ` ${sidebarRowToneClass(rowTone)}` : ''
                      // Trim the role so a blank/whitespace role doesn't
                      // render a dangling "Provider / " — fall back to
                      // just the provider name in that case.
                      const activeRole = activeParticipant?.role?.trim()
                      const subtitle = activeParticipant
                        ? activeRole
                          ? `${getProviderName(activeParticipant.provider)} / ${activeRole}`
                          : getProviderName(activeParticipant.provider)
                        : chat.scope === 'global'
                          ? 'General ensemble'
                          : 'Workspace ensemble'
                      const subThreads = subThreadsByParentId.get(chat.appChatId) ?? []
                      const subThreadsExpanded = isSidebarSearchActive
                        ? true
                        : expandedSubThreadParentIds.has(chat.appChatId)
                      const renameSurfaceId = `ensemble-${chat.appChatId}`
                      const ensembleNeedsInput = chatHasPendingAgentQuestion(
                        pendingAgentQuestionsByChatId,
                        chat.appChatId
                      )
                      const ensembleRowA11y = buildSidebarChatRowA11y({
                        chatId: chat.appChatId,
                        title: chat.title,
                        providerLabel: 'Ensemble',
                        selected: selectedChatId === chat.appChatId,
                        isRunning,
                        needsInput: ensembleNeedsInput,
                        rowTone,
                        lastRunStatus: isRunning
                          ? { label: 'Running', tone: 'warning' }
                          : null,
                        prefix: subtitle
                      })
                      return (
                        <div key={`ensemble-${chat.appChatId}`} className="sidebar-chat-family">
                          <div
                            role="button"
                            tabIndex={0}
                            className={`sidebar-item sidebar-chat-item sidebar-ensemble-item provider-ensemble ${selectedChatId === chat.appChatId ? 'active' : ''} ${isRunning ? 'running' : ''}${toneClass}`}
                            onClick={() => selectAndAcknowledgeChat(chat)}
                            onKeyDown={(event) => handleChatRowKeyDown(event, chat)}
                            aria-label={ensembleRowA11y.ariaLabel}
                            aria-current={ensembleRowA11y.ariaCurrent}
                            aria-describedby={ensembleRowA11y.statusDescribedById}
                            {...getChatTileDragProps(chat, 'code:ensembles')}
                          >
                            {ensembleRowA11y.statusDescription ? (
                              <span id={ensembleRowA11y.statusDescribedById} className="sr-only">
                                {ensembleRowA11y.statusDescription}
                              </span>
                            ) : null}
                            {subThreads.length > 0 && (
                              <span
                                role="button"
                                tabIndex={0}
                                className="sidebar-tree-toggle sidebar-chat-tree-toggle"
                                onClick={(event) => toggleSubThreadsExpanded(event, chat.appChatId)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    toggleSubThreadsExpanded(event, chat.appChatId)
                                  }
                                }}
                                title={
                                  subThreadsExpanded
                                    ? 'Collapse linked chats'
                                    : 'Expand linked chats'
                                }
                                aria-label={
                                  subThreadsExpanded
                                    ? 'Collapse linked chats'
                                    : 'Expand linked chats'
                                }
                                aria-expanded={subThreadsExpanded}
                              >
                                <ChevronSymbolIcon isExpanded={subThreadsExpanded} />
                              </span>
                            )}
                            {renderChatProviderBadge(chat)}
                            <span className="sidebar-chat-copy" title={chat.title}>
                              <span className="sidebar-chat-title-line">
                                <span className="sidebar-provider-label provider-ensemble">
                                  <span>Ensemble</span>
                                </span>
                                <SidebarChatTitleEditable
                                  chat={chat}
                                  className="sidebar-chat-title"
                                  query={sidebarSearchQuery}
                                  isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                                  onStartEdit={() => startChatRename(chat, renameSurfaceId)}
                                  onSubmit={(next) => commitChatRename(chat, next)}
                                  onCancel={() => setEditingChatTarget(null)}
                                />
                              </span>
                              <span className="sidebar-chat-subline">
                                      {/* Identity (which participant holds the turn), not run state. Muted, not amber, so it never competes with the waiting ink. */}
                                      <span className="sidebar-run-status tone-muted">
                                        {isRunning ? `Speaking: ${subtitle}` : subtitle}
                                      </span>
                                {subThreads.length > 0 && (
                                  <span
                                    className="sidebar-branched-badge sidebar-branched-dim"
                                    title={`${subThreads.length} linked chat${subThreads.length === 1 ? '' : 's'}`}
                                  >
                                    linked · {subThreads.length}
                                  </span>
                                )}
                                {collaboratingChatIds.has(chat.appChatId) && (
                                  <span
                                    className="sidebar-branched-badge sidebar-shared-badge"
                                    title="People have access"
                                  >
                                    People
                                  </span>
                                )}
                              </span>
                            </span>
                            {isRunning && <SidebarRunningGhost />}
                            {!isRunning && (
                              <ChatAgeLabel timestamp={chat.updatedAt || chat.createdAt} />
                            )}
                            <SidebarOverflowMenu
                              triggerLabel="Ensemble actions"
                              items={buildChatMenuItems(chat, renameSurfaceId)}
                            />
                          </div>
                          {subThreads.length > 0 && subThreadsExpanded && (
                            <div className="sidebar-chat-children">
                              {subThreads.map(renderLinkedChildChat)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {renderSidebarShowMore('ensembles', visibleEnsembleChats.length)}
                  </div>
                ))}
            </div>
            ) : null,
            ensembleModeEnabled
          )}

          {wrapHierarchySection(
            'workspaces',
            <div className="sidebar-workspace-scroll">
            <div className="sidebar-section-header">
              <button
                type="button"
                className="sidebar-section-header-toggle"
                onClick={() => toggleSidebarSection('workspaces')}
                aria-expanded={!isSectionCollapsed('workspaces')}
                title={
                  isSectionCollapsed('workspaces') ? 'Expand Workspaces' : 'Collapse Workspaces'
                }
              >
                <ChevronSymbolIcon isExpanded={!isSectionCollapsed('workspaces')} />
                <h4 className="sidebar-section-title">Workspaces</h4>
                {visibleWorkspaceEntries.length > 0 && (
                  <span className="sidebar-section-count">{visibleWorkspaceEntries.length}</span>
                )}
              </button>
              {/*
                Sits OUTSIDE the section-header toggle so clicking `+`
                opens the workspace picker without ever collapsing the
                section. Keeping the `+` reachable when the section is
                collapsed lets the user add a workspace even while their
                list is folded away.
              */}
              <button
                type="button"
                className="sidebar-section-header-action sidebar-workspace-create"
                onClick={onSelectWorkspaceDialog}
                title="Add workspace"
                aria-label="Add workspace"
                id="sidebar-add-workspace-btn"
              >
                <PlusSymbolIcon />
              </button>
            </div>
            {/*
              First-launch onboarding hint. Renders only when the
              workspace list is empty AND the App-owned
              `showOnboardingHint` flag is on (which auto-starts true
              for fresh users and stays off after explicit dismissal,
              unless the user re-opens it from the `?` button in
              chat-corner-controls-left). Inline ✕ persists the
              dismissal so the next launch starts hidden too.
            */}
            {!isSectionCollapsed('workspaces') && showOnboardingHint && workspaces.length === 0 && (
              <div className="sidebar-onboarding-hint" role="note">
                <div className="sidebar-onboarding-hint-body">
                  <strong>Add your first workspace</strong>
                  <span>
                    Click the <span className="sidebar-onboarding-plus">+</span> above to point
                    TaskWraith at a project folder. Workspaces hold your chats and let the agent read /
                    edit files inside their trust boundary.
                  </span>
                </div>
                {onDismissOnboardingHint && (
                  <button
                    className="sidebar-onboarding-hint-dismiss"
                    type="button"
                    onClick={onDismissOnboardingHint}
                    aria-label="Dismiss onboarding hint"
                    title="Dismiss"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}
            <div className="sidebar-workspace-list">
              {/*
                Workspace entries — gated on the Workspaces section's
                collapse state. The "No matches" search empty-state and
                the global "Chats" section below has its own collapse
                state, so workspace folding never hides the top-level
                global-chat controls.
              */}
              {!isSectionCollapsed('workspaces') &&
                visibleWorkspaceEntries.map(({ workspace: ws, workspaceChats, visibleChats, totalChats }) => {
                  const expanded = isSidebarSearchActive ? true : expandedWorkspaceIds.has(ws.id)
                  const workspaceHasRunning = workspaceChats.some((chat) =>
                    runningChatIdSet.has(chat.appChatId)
                  )
                  // Linked child chats render nested under their parent below, so
                  // the preview cap + "show more" count only the top-level rows.
                  const workspaceListId = `ws:${ws.id}`
                  const workspaceTopLevelChats = visibleChats.filter(
                    (chat) => !isLinkedChildChat(chat)
                  )
                  return (
                    <div key={ws.id} className="sidebar-workspace-group">
                      <div
                        className={`sidebar-item sidebar-workspace-item ${currentWorkspace?.id === ws.id ? 'active' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectWorkspace(ws)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) {
                            return
                          }
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onSelectWorkspace(ws)
                          }
                        }}
                        onFocus={() => setHoveredWorkspace(ws.id)}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                            setHoveredWorkspace(null)
                          }
                        }}
                        onMouseEnter={() => setHoveredWorkspace(ws.id)}
                        onMouseLeave={() => setHoveredWorkspace(null)}
                      >
                        {totalChats > 0 ? (
                          <button
                            type="button"
                            className="sidebar-tree-toggle"
                            onClick={(event) => toggleWorkspaceExpanded(event, ws.id)}
                            title={expanded ? 'Collapse chats' : 'Expand chats'}
                            aria-label={expanded ? 'Collapse chats' : 'Expand chats'}
                          >
                            <ChevronSymbolIcon isExpanded={expanded} />
                          </button>
                        ) : (
                          <span className="sidebar-tree-toggle spacer" />
                        )}
                        <FolderSymbolIcon />
                        <span className="sidebar-workspace-copy" title={ws.path}>
                          <span className="sidebar-workspace-name">
                            <HighlightMatch text={ws.displayName} query={sidebarSearchQuery} />
                          </span>
                          <span className="sidebar-workspace-meta">
                            <HighlightMatch
                              text={getWorkspaceMeta(ws)}
                              query={sidebarSearchQuery}
                            />
                          </span>
                        </span>
                        {workspaceHasRunning && (
                          <>
                            {/* Same pulsing monoline ghost the thread rows use.
                              A workspace is running because a THREAD inside it
                              is, so the folded parent should say it in the same
                              vocabulary rather than inventing a second "busy"
                              mark — the dot that used to live here read as a
                              different kind of state. */}
                            <SidebarRunningGhost />
                            {/* The ghost is decorative (aria-hidden), and this
                              row's accessible name is its text content, so the
                              running state needs a text node of its own. Thread
                              rows announce it through their composed aria-label
                              instead. */}
                            <span className="sr-only">Task running in this workspace</span>
                          </>
                        )}
                        {totalChats > 0 && hoveredWorkspace !== ws.id && (
                          <span
                            className="sidebar-workspace-count-badge"
                            title={`${totalChats} chat${totalChats === 1 ? '' : 's'}`}
                            aria-label={`${totalChats} chat${totalChats === 1 ? '' : 's'} in this workspace`}
                          >
                            {totalChats}
                          </span>
                        )}
                        {/* 1.0.3 — workspace inline action icons retired in
                          favour of the three-dots overflow menu (single
                          source of actions per chat-tile rework). All
                          affordances (New chat / Pin / Unpin / Remove
                          workspace) live in `buildWorkspaceMenuItems`. */}
                        <SidebarOverflowMenu
                          triggerLabel="Workspace actions"
                          items={buildWorkspaceMenuItems(ws)}
                        />
                      </div>
                      {visibleChats.length > 0 && expanded ? (
                        <div
                          className="sidebar-chat-list"
                          {...getSidebarThreadListDropProps(
                            `code:workspace:${ws.id}`,
                            workspaceChats
                          )}
                        >
                          {previewSidebarList(workspaceListId, workspaceTopLevelChats)
                            .map((chat) => {
                              const subThreads = subThreadsByParentId.get(chat.appChatId) ?? []
                              // Linked-child badge. Bright while any child is
                              // running, dim once they settle.
                              const subThreadCount = subThreads.length
                              const subThreadsExpanded = isSidebarSearchActive
                                ? true
                                : expandedSubThreadParentIds.has(chat.appChatId)
                              const liveSubThreadCount = subThreads.reduce(
                                (count, sub) =>
                                  count + (runningChatIdSet.has(sub.appChatId) ? 1 : 0),
                                0
                              )
                              const renameSurfaceId = `workspace-${ws.id}-${chat.appChatId}`
                              const dragHandlers = getChatTileDragProps(
                                chat,
                                `code:workspace:${ws.id}`
                              )
                              return (
                                <div key={chat.appChatId} className="sidebar-chat-family">
                                  <SidebarChatRow
                                    chat={chat}
                                    variant="workspace"
                                    surfaceId={renameSurfaceId}
                                    isSelected={selectedChatId === chat.appChatId}
                                    isRunning={runningChatIdSet.has(chat.appChatId)}
                                    rowTone={rowToneByChatId.get(chat.appChatId) ?? null}
                                    needsInput={chatHasPendingAgentQuestion(
                                      pendingAgentQuestionsByChatId,
                                      chat.appChatId
                                    )}
                                    isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                                    isCollaborating={collaboratingChatIds.has(chat.appChatId)}
                                    subThreadCount={subThreadCount}
                                    liveSubThreadCount={liveSubThreadCount}
                                    subThreadsExpanded={subThreadsExpanded}
                                    query={sidebarSearchQuery}
                                    identityTicker={
                                      selectedChatId === chat.appChatId
                                        ? activeChatIdentityTicker
                                        : null
                                    }
                                    identityGitIndicators={
                                      selectedChatId === chat.appChatId
                                        ? activeChatIdentityGitIndicators
                                        : null
                                    }
                                    dragHandlers={dragHandlers}
                                    onSelect={selectAndAcknowledgeChat}
                                    onRowKeyDown={handleChatRowKeyDown}
                                    onToggleSubThreads={toggleSubThreadsExpanded}
                                    onStartRename={startChatRename}
                                    onSubmitRename={commitChatRename}
                                    onCancelRename={cancelChatRename}
                                    buildMenuItems={buildChatMenuItems}
                                  />
                                  {subThreads.length > 0 && subThreadsExpanded && (
                                    <div className="sidebar-chat-children">
                                      {subThreads.map(renderLinkedChildChat)}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          {renderSidebarShowMore(workspaceListId, workspaceTopLevelChats.length)}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
            </div>
              {isSidebarSearchActive &&
                visibleWorkspaceEntries.length === 0 && (
                  <div className="sidebar-empty-state">
                    <strong>No matches</strong>
                    <span>Try a workspace name, provider, branch, or thread title.</span>
                  </div>
                )}
            </div>,
            activeSidebarTab === 'threads'
          )}

          {wrapHierarchySection(
            'chats',
            <div className="sidebar-chats-section">
              <div className="sidebar-section-header sidebar-chats-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('chats')}
                  aria-expanded={!isSectionCollapsed('chats')}
                  title={isSectionCollapsed('chats') ? 'Expand Chats' : 'Collapse Chats'}
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('chats')} />
                  <h4 className="sidebar-section-title">Chats</h4>
                  {visibleGlobalChats.length > 0 && (
                    <span className="sidebar-section-count">{visibleGlobalChats.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="sidebar-section-header-action sidebar-global-chat-create"
                  onClick={onNewGlobalChat}
                  title="New general chat"
                  aria-label="New general chat"
                >
                  <PlusSymbolIcon />
                </button>
              </div>
              {!isSectionCollapsed('chats') && (
                <div
                  className="sidebar-chat-list sidebar-global-chat-list"
                  {...getSidebarThreadListDropProps('chat:chats', orderedGlobalChats)}
                >
                  {previewSidebarList('chats', visibleGlobalChats).map((chat) => {
                    const renameSurfaceId = `global-${chat.appChatId}`
                    const dragHandlers = getChatTileDragProps(chat, 'chat:chats')
                    return (
                      <SidebarChatRow
                        key={chat.appChatId}
                        chat={chat}
                        variant="global"
                        surfaceId={renameSurfaceId}
                        isSelected={selectedChatId === chat.appChatId}
                        isRunning={runningChatIdSet.has(chat.appChatId)}
                        rowTone={rowToneByChatId.get(chat.appChatId) ?? null}
                        needsInput={chatHasPendingAgentQuestion(
                          pendingAgentQuestionsByChatId,
                          chat.appChatId
                        )}
                        isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                        isCollaborating={false}
                        subThreadCount={0}
                        liveSubThreadCount={0}
                        subThreadsExpanded={false}
                        query={sidebarSearchQuery}
                        identityTicker={
                          selectedChatId === chat.appChatId ? activeChatIdentityTicker : null
                        }
                        identityGitIndicators={
                          selectedChatId === chat.appChatId ? activeChatIdentityGitIndicators : null
                        }
                        identityBranch={
                          selectedChatId === chat.appChatId ? activeChatIdentityBranch : null
                        }
                        dragHandlers={dragHandlers}
                        onSelect={selectAndAcknowledgeChat}
                        onRowKeyDown={handleChatRowKeyDown}
                        onToggleSubThreads={toggleSubThreadsExpanded}
                        onStartRename={startChatRename}
                        onSubmitRename={commitChatRename}
                        onCancelRename={cancelChatRename}
                        buildMenuItems={buildChatMenuItems}
                      />
                    )
                  })}
                  {renderSidebarShowMore('chats', visibleGlobalChats.length)}
                  {visibleGlobalChats.length === 0 && !isSidebarSearchActive && (
                    <div className="sidebar-empty-state sidebar-empty-state--ghost">
                      <MascotGhost size={28} />
                      <strong>No chats yet</strong>
                      <span>Hit + above to start one.</span>
                    </div>
                  )}
                  {visibleGlobalChats.length === 0 && isSidebarSearchActive && (
                    <div className="sidebar-empty-state">
                      <strong>No matches</strong>
                      <span>Try a provider or chat title.</span>
                    </div>
                  )}
                </div>
              )}
            </div>,
            activeSidebarTab === 'chat'
          )}
          {wrapHierarchySection(
            'shared',
            <div className="sidebar-shared-section">
              <div className="sidebar-section-header sidebar-shared-header">
                <button
                  type="button"
                  className="sidebar-section-header-toggle"
                  onClick={() => toggleSidebarSection('shared')}
                  aria-expanded={!isSectionCollapsed('shared')}
                  title={isSectionCollapsed('shared') ? 'Expand People' : 'Collapse People'}
                >
                  <ChevronSymbolIcon isExpanded={!isSectionCollapsed('shared')} />
                  <h4 className="sidebar-section-title">People</h4>
                  {visibleSharedChats.length > 0 && (
                    <span className="sidebar-section-count">{visibleSharedChats.length}</span>
                  )}
                </button>
                {onCreateSharedChat && (
                  <div className="sidebar-new-menu-wrap" ref={sharedCreateMenuWrapRef}>
                    <button
                      type="button"
                      className="sidebar-section-header-action sidebar-shared-create"
                      onClick={() => {
                        setNewMenuOpen(false)
                        expandSidebarSection('shared')
                        setSharedCreateMenuOpen((current) => !current)
                      }}
                      title="Choose People chat type"
                      aria-label="Choose People chat type"
                      aria-expanded={sharedCreateMenuOpen}
                      aria-haspopup="menu"
                    >
                      <PlusSymbolIcon />
                    </button>
                    {sharedCreateMenuOpen && (
                      <div
                        className="sidebar-new-menu sidebar-shared-create-menu"
                        role="menu"
                        onKeyDown={moveMenuFocus}
                      >
                        {sharedChatCreateOptions.map((option) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={option.variant}
                            className="sidebar-new-menu-item"
                            onClick={() => handleCreateSharedChat(option.variant)}
                            disabled={option.disabled}
                            title={option.title}
                          >
                            <PeopleSymbolIcon />
                            <span className="sidebar-new-menu-item-label">{option.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {!isSectionCollapsed('shared') && (
                <div
                  className="sidebar-chat-list sidebar-shared-chat-list"
                  {...getSidebarThreadListDropProps('code:shared', orderedSharedChats)}
                >
                  {previewSidebarList('shared', visibleSharedChats).map((chat) => {
                    const renameSurfaceId = `shared-${chat.appChatId}`
                    const dragHandlers = getChatTileDragProps(chat, 'code:shared')
                    return (
                      <SidebarChatRow
                        key={chat.appChatId}
                        chat={chat}
                        variant="shared"
                        surfaceId={renameSurfaceId}
                        isSelected={selectedChatId === chat.appChatId}
                        isRunning={runningChatIdSet.has(chat.appChatId)}
                        rowTone={rowToneByChatId.get(chat.appChatId) ?? null}
                        needsInput={chatHasPendingAgentQuestion(
                          pendingAgentQuestionsByChatId,
                          chat.appChatId
                        )}
                        isEditing={isChatRenameTarget(chat, renameSurfaceId)}
                        isCollaborating={false}
                        subThreadCount={0}
                        liveSubThreadCount={0}
                        subThreadsExpanded={false}
                        query={sidebarSearchQuery}
                        identityTicker={
                          selectedChatId === chat.appChatId ? activeChatIdentityTicker : null
                        }
                        identityGitIndicators={
                          selectedChatId === chat.appChatId ? activeChatIdentityGitIndicators : null
                        }
                        identityBranch={
                          selectedChatId === chat.appChatId ? activeChatIdentityBranch : null
                        }
                        dragHandlers={dragHandlers}
                        onSelect={selectAndAcknowledgeChat}
                        onRowKeyDown={handleChatRowKeyDown}
                        onToggleSubThreads={toggleSubThreadsExpanded}
                        onStartRename={startChatRename}
                        onSubmitRename={commitChatRename}
                        onCancelRename={cancelChatRename}
                        buildMenuItems={buildChatMenuItems}
                      />
                    )
                  })}
                  {renderSidebarShowMore('shared', visibleSharedChats.length)}
                  {visibleSharedChats.length === 0 && !isSidebarSearchActive && (
                    <div className="sidebar-empty-state sidebar-empty-state--ghost">
                      <PeopleSymbolIcon />
                      <strong>No People chats</strong>
                      <span>Hit + above to invite people.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {dragGhost
            ? createPortal(
                <div
                  className="sidebar-section-drag-ghost"
                  style={{
                    position: 'fixed',
                    left: `${dragGhost.x}px`,
                    top: `${dragGhost.y}px`,
                    zIndex: 10050
                  }}
                  aria-hidden
                >
                  <span className="sidebar-section-drag-ghost-title">{dragGhost.label}</span>
                </div>,
                document.body
              )
            : null}
            </div>
          )}
        </div>

        {/* Phase L6 slice 1 — Model Usage card extracted to its own
         * component. Phase L6 slices 2-6 will rebuild this card's
         * visual identity to match the another-project compact card
         * (provider marks + warning gradient + pace tick + heatmap)
         * inside the new component, leaving Sidebar untouched. */}
        <ModelUsageCard
          usageSummary={usageSummary}
          variant="sidebar"
          apiSpend={modelUsageApiSpend}
        />
      </div>

      {/* Footer */}
      <div className="sidebar-footer">
        <div className="sidebar-footer-action-row">
          <div className="sidebar-footer-settings-wrap" ref={settingsMenuWrapRef}>
            <button
              className="sidebar-footer-settings"
              onClick={() => {
                setApprovalsPopoverOpen(false)
                setSharesPopoverOpen(false)
                setDevicesPopoverOpen(false)
                setSettingsMenuOpen((current) => !current)
                setSettingsMenuPane('root')
              }}
              title="Settings"
              aria-label="Open settings menu"
              aria-haspopup="menu"
              aria-expanded={settingsMenuOpen}
            >
              <GearSymbolIcon />
              <span>Settings</span>
            </button>
            {settingsMenuOpen && (
              <SidebarSettingsMenu
                pane={settingsMenuPane}
                setPane={setSettingsMenuPane}
                quickSettings={appearanceQuickSettings}
                onAppearanceQuickChange={onAppearanceQuickChange}
                onOpenSettings={onOpenSettings}
                onOpenWorkspacePopout={onOpenWorkspacePopout}
                canOpenWorkspacePopout={canOpenWorkspacePopout}
                onQuitApp={onQuitApp}
                onClose={() => {
                  setSettingsMenuOpen(false)
                  setSettingsMenuPane('root')
                }}
              />
            )}
          </div>
          {/* Traffic-light control cluster: Approvals (red) / Shares (yellow) /
              Devices (green). Each opens a popover anchored to its own icon;
              the bottom item deep-links to the matching Settings tab. Settings
              stays flex:1 so it dominates the row. */}
          <div className="sidebar-footer-controls" ref={footerControlsWrapRef}>
            <div className="sidebar-footer-control-anchor">
              <button
                type="button"
                className={`sidebar-footer-icon-btn${hasNeedsInputAttention ? ' glow-red' : ''}${
                  approvalsPopoverOpen ? ' is-open' : ''
                }`}
                onClick={() => {
                  setSettingsMenuOpen(false)
                  setSharesPopoverOpen(false)
                  setDevicesPopoverOpen(false)
                  setApprovalsPopoverOpen((open) => !open)
                }}
                title={
                  hasPendingQuestions && hasPendingApprovals
                    ? 'Approvals — pending questions and approvals'
                    : hasPendingQuestions
                      ? 'Approvals — needs your input'
                      : hasPendingApprovals
                        ? 'Approvals — pending approval'
                        : 'Approvals'
                }
                aria-label={
                  hasPendingQuestions && hasPendingApprovals
                    ? 'Approvals, questions and approvals are waiting'
                    : hasPendingQuestions
                      ? 'Approvals, an agent question is waiting'
                      : hasPendingApprovals
                        ? 'Approvals, a pending approval is waiting'
                        : 'Approvals'
                }
                aria-haspopup="dialog"
                aria-expanded={approvalsPopoverOpen}
              >
                <ApprovalsShieldIcon />
              </button>

              {approvalsPopoverOpen && (
                <ApprovalsFooterPopover
                  pendingApprovals={pendingApprovalsFlat}
                  pendingQuestions={pendingQuestionsFlat}
                  resolveChatTitle={resolveChatTitleForAttention}
                  onJumpToChat={(chatId) => {
                    setApprovalsPopoverOpen(false)
                    const chat = chats.find((candidate) => candidate.appChatId === chatId)
                    if (chat) selectAndAcknowledgeChat(chat)
                  }}
                  onRespondApproval={onRespondAgentApproval}
                  onAnswerQuestion={onAnswerAgentQuestion}
                  onDismissQuestion={onDismissAgentQuestion}
                  loadRecent={loadRecentApprovals}
                  onOpenSettings={() => {
                    setApprovalsPopoverOpen(false)
                    openSettingsTab('approval-ledger')
                  }}
                />
              )}
            </div>
            <div className="sidebar-footer-control-anchor">
              <button
                type="button"
                className={`sidebar-footer-icon-btn${
                  hasConnectedCollaborator ? ' glow-yellow' : ''
                }${sharesPopoverOpen ? ' is-open' : ''}`}
                onClick={() => {
                  setSettingsMenuOpen(false)
                  setApprovalsPopoverOpen(false)
                  setDevicesPopoverOpen(false)
                  setSharesPopoverOpen((open) => !open)
                }}
                title={hasConnectedCollaborator ? 'People — someone connected' : 'People'}
                aria-label={
                  hasConnectedCollaborator ? 'People, someone is connected' : 'People'
                }
                aria-haspopup="dialog"
                aria-expanded={sharesPopoverOpen}
              >
                <ShareNetworkIcon />
              </button>

              {sharesPopoverOpen && (
                <SharesFooterPopover
                  shares={collaborationShares}
                  resolveChatTitle={(chatId) =>
                    chats.find((candidate) => candidate.appChatId === chatId)?.title
                  }
                  connectedShareChatIds={collaboratingChatIds}
                  onJumpToChat={(chatId) => {
                    setSharesPopoverOpen(false)
                    const chat = chats.find((candidate) => candidate.appChatId === chatId)
                    if (chat) selectAndAcknowledgeChat(chat)
                  }}
                  onRevokeShare={onRevokeShare}
                  onOpenSettings={() => {
                    setSharesPopoverOpen(false)
                    openSettingsTab('shares')
                  }}
                />
              )}
            </div>
            {IOS_REMOTE_ENABLED && (
              <div className="sidebar-footer-control-anchor">
                <button
                  type="button"
                  className={`sidebar-footer-icon-btn${
                    remoteDeviceConnected ? ' glow-green' : ''
                  }${devicesPopoverOpen ? ' is-open' : ''}`}
                  onClick={() => {
                    setSettingsMenuOpen(false)
                    setApprovalsPopoverOpen(false)
                    setSharesPopoverOpen(false)
                    setDevicesPopoverOpen((open) => !open)
                  }}
                  title={remoteDeviceConnected ? 'Devices — connected' : 'Devices'}
                  aria-label={remoteDeviceConnected ? 'Devices, a device is connected' : 'Devices'}
                  aria-haspopup="dialog"
                  aria-expanded={devicesPopoverOpen}
                >
                  <RemoteConnectionSymbolIcon />
                </button>

                {devicesPopoverOpen && (
                  <DevicesFooterPopover
                    devices={pairedDevices}
                    onOpenSettings={() => {
                      setDevicesPopoverOpen(false)
                      openSettingsTab('pairing')
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        <AppShellStatsToolbar />
      </div>
    </div>
  )
}
