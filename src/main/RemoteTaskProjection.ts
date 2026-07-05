import type {
  ActiveGoal,
  AppSettings,
  AppearanceMode,
  ChatRecord,
  ChatRun,
  ComposerStyle,
  DiffFileSummary,
  EnsembleConfig,
  EnsembleRoundParticipantState,
  ExternalPathGrant,
  PromptSurfaceStyle,
  ProviderId,
  RunDiffResult,
  RunQueueJob,
  ThemeAccentStyle,
  ThemeAppearance,
  ThemeCornerStyle,
  ToolActivity,
  VisualEffectStyle,
  WorkspaceBoardCard,
  WorkspaceBoardCardLink,
  WorkspaceBoardColumn,
  WorkspaceBoardColumnId,
  WorkspaceBoardDefinition
} from './store/types'
import { normalizeThreadTitle } from '../shared/threadTitles'
import { isEnsembleRoundDispatchLive } from '../shared/ensembleRoundLifecycle'
import type {
  TaskWraithPluginActivatedMobileProjection,
  TaskWraithPluginRemoteCapability
} from '../shared/plugins/PluginTypes'
import { collectExternalPathGrantsFromMetadata } from './store/ExternalPathGrants'
import { readPendingProviderChange } from './providerChangeQueue'
import { isContentlessRemoteDraftChat, remoteDraftVariant } from './remote/RemoteDraftChats'
import { isRetiredExternalChannelInboundMessage } from './LegacyExternalChannelHistory'
import { computeMergedTodosByLane, TODO_SOLO_LANE, type TodoStatus } from './TodoList'
import type { CanvasSessionSummary } from './canvas/canvasTypes'

const MOBILE_DIFF_SUMMARY_FILE_LIMIT = 40

export type RemoteProjectionKind =
  | 'taskCard'
  | 'taskFeedSnapshot'
  | 'approvalCard'
  | 'questionCard'
  | 'threadSnapshot'
  | 'diffSummary'
  | 'gitSnapshot'
  | 'ensembleState'
  | 'shellAppearance'
  | 'workflows'
  | 'workspaceBoards'
  | 'ensemblePresets'
  | 'pluginCapabilityCards'

/**
 * A workflow projected to paired devices (iOS Workflows tab). Flattened from a
 * WorkflowDefinition — the phone shows the list + opens the workflow's chat
 * (`threadId`); run-now/pause actions are a separate slice. One envelope per
 * workflow, `kind: 'workflows'`.
 */
export interface RemoteWorkflow {
  id: string
  name: string
  workspaceId: string
  /** The workflow's chat (template.chatId) — tap opens this thread. */
  threadId: string
  provider: ProviderId
  enabled: boolean
  /** Human-readable cadence, e.g. "Every 60 min" / "Manual". */
  schedule: string
  /** Last execution status, or "idle" if it hasn't run. */
  status: RemoteTaskStatus | 'completed' | 'skipped'
  nextRunAt?: string
  lastRunAt?: string
  /** Stage 2 slice 7b — latest LOOP execution summary for the phone's progress badge
   * (absent for a non-loop or never-run workflow). Cached on the WorkflowDefinition. */
  loopIterationCount?: number
  loopStopReason?: string
  loopTokens?: number
}

export interface RemoteWorkspaceBoardColumn {
  id: WorkspaceBoardColumnId
  name: string
  sortOrder: number
  wipLimit?: number
  activeCardCount: number
  archivedCardCount: number
}

export interface RemoteWorkspaceBoardCard {
  id: string
  boardId: string
  workspaceId: string
  columnId: WorkspaceBoardColumnId
  title: string
  body?: string
  labels?: string[]
  linkKind?: WorkspaceBoardCardLink['kind']
  linkId?: string
  sourceTitle?: string
  runId?: string
  archived?: boolean
  updatedAt: string
}

export interface RemotePluginCapabilityCard {
  id: string
  pluginId: string
  publisher: string
  label: string
  description?: string
  remoteCapabilities: TaskWraithPluginRemoteCapability[]
  enabled: boolean
}

export interface RemotePluginCapabilityCards {
  schemaVersion: 1
  cards: RemotePluginCapabilityCard[]
}

/**
 * Read-only Workspace Board projection for paired devices. The Mac remains the
 * write authority; iOS can list the boards/cards and open linked threads/runs in
 * follow-up slices. Cards are bounded so full remote snapshots stay relay-safe.
 */
export interface RemoteWorkspaceBoard {
  id: string
  workspaceId: string
  workspacePath?: string
  name: string
  description?: string
  pinned?: boolean
  archived?: boolean
  activeCardCount: number
  archivedCardCount: number
  columns: RemoteWorkspaceBoardColumn[]
  cards: RemoteWorkspaceBoardCard[]
  cardLimit: number
  cardsTruncated: boolean
  createdAt: string
  updatedAt: string
  latestCardUpdatedAt?: string
}

export type RemoteTaskStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaitingApproval'
  | 'awaitingQuestion'
  | 'success'
  | 'failed'
  | 'cancelled'

export interface RemoteActiveGoal {
  id: string
  objective: string
  status: ActiveGoal['status']
  mode: ActiveGoal['mode']
  provider: ProviderId
  createdAt: string
  updatedAt: string
  pausedAt?: string
  blockedAt?: string
  blockedReason?: string
  completedAt?: string
  completedSummary?: string
  lastStatusReason?: string
}

/** One step of an agent's working plan (todo). Mirrors TodoItem on the wire. */
export interface RemoteTodoItem {
  id: string
  content: string
  status: TodoStatus
}

/**
 * One author's plan within a chat. `lane` is the ensemble participant/provider
 * id, or TODO_SOLO_LANE for solo/guest chats. Derived from the activity stream
 * (todo_write / Claude TodoWrite / Codex codex_plan), so it covers every
 * provider whose plan flows as a tool activity — desktop PlanRail parity.
 */
export interface RemoteTodoLane {
  lane: string
  items: RemoteTodoItem[]
}

/**
 * Read-only projection of an OPEN TaskWraith Canvas preview to the phone (P3). No
 * pixels — just the metadata the user already sees in the desktop pill (driver +
 * query-redacted url + title + status + viewport). Phone write-actions are a
 * later slice; this card is view-only.
 */
export interface RemoteCanvasPreview {
  canvasId: string
  driver: string
  url: string
  title: string
  status: string
  viewport: { width: number; height: number }
}

const REMOTE_CANVAS_URL_MAX = 512
const REMOTE_CANVAS_TITLE_MAX = 160

function boundCanvasString(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : ''
  return s.length > max ? s.slice(0, max) : s
}

/** Map live CanvasSessionSummary[] (chat-scoped) to the bounded projection shape. */
export function buildRemoteCanvasPreviews(
  summaries: ReadonlyArray<CanvasSessionSummary>
): RemoteCanvasPreview[] {
  if (!Array.isArray(summaries)) return []
  return summaries
    .filter((s) => s && typeof s.canvasId === 'string' && s.canvasId.length > 0)
    .map((s) => ({
      canvasId: s.canvasId,
      driver: typeof s.driver === 'string' ? s.driver : 'web',
      url: boundCanvasString(s.url, REMOTE_CANVAS_URL_MAX),
      title: boundCanvasString(s.title, REMOTE_CANVAS_TITLE_MAX),
      status: typeof s.status === 'string' ? s.status : 'active',
      viewport: {
        width: Math.max(0, Math.round(Number(s.viewport?.width) || 0)),
        height: Math.max(0, Math.round(Number(s.viewport?.height) || 0))
      }
    }))
}

export interface RemoteProjectionEnvelope<TPayload = unknown> {
  schemaVersion: 1
  envelopeId: string
  source: 'mac'
  kind: RemoteProjectionKind
  generatedAt: string
  workspaceId?: string | null
  workspacePath?: string
  threadId?: string
  runId?: string
  payload: TPayload
}

export interface RemoteTaskCard {
  id: string
  threadId: string
  /** Present for sub-threads / isolated side chats — remote clients nest
   * these under the parent thread like the desktop sidebar. */
  parentChatId?: string
  /** Sidebar pin (drives remote Pinned sections). */
  pinned?: boolean
  /** Sub-agent character identity (desktop parity): pool/platform name,
   * accent hex, and identicon catalog slug. */
  agentName?: string
  agentAccent?: string
  agentSlug?: string
  /** `subThread` vs `sideChat` — drives ↳ vs ⇄ nesting chrome on remote
   * clients (mirrors the desktop sidebar relation glyphs). */
  parentChatRelation?: 'subThread' | 'sideChat'
  /** When `parentChatRelation === 'sideChat'`, the side-chat mode
   * (`guestParticipant`, `ensembleClone`, `fanOut`, …). */
  sideChatMode?: string
  /** When `parentChatRelation === 'sideChat'`, the side-chat lifecycle
   * (`active` | `closed` | `terminated`). Absent ⇒ treat as active. A removed
   * guest's child chat is marked `closed` (not deleted) by the store, so the
   * phone must read this to drop it from the ACTIVE-guest detector — otherwise
   * the composer guest chip lingers after removal. */
  sideChatLifecycleState?: string
  /** `ensemble` chats need `ensembleQueuePrompt` on remote send paths. */
  chatKind?: 'single' | 'ensemble'
  /** Unstarted iOS welcome-card draft (0 messages/runs). Remote clients keep
   * the card so an in-progress welcome screen still resolves, but hide it from
   * chat LISTS — it isn't a real conversation yet. */
  isDraft?: boolean
  draftVariant?: string
  /** Active People/collaboration share. Remote clients derive their Shared
   * section from this flag; invite creation remains Mac-only. */
  isShared?: boolean
  sharedMode?: string
  /** Mirrors ChatRecord.archived. Electron's sidebar hides archived chats from
   * its lists and counts; remote clients must do the same so the iOS thread
   * count matches the desktop sidebar. */
  archived?: boolean
  workspaceId: string | null
  workspacePath?: string
  provider: ProviderId
  /** Provider metadata needed for remote composers to resume the same model
   * selection before a side chat has any run summary. */
  selectedModelType?: string
  customModel?: string
  codexReasoningEffort?: string
  claudeReasoningEffort?: string
  /** Slice B (provider unlock): a provider/model/reasoning switch queued while
   *  a run is active, applied at turn end. Remote composers show a "switching at
   *  turn end" pill and reflect the queued target instead of snapping the picker
   *  back. Absent when nothing is queued. */
  pendingProviderChange?: {
    provider: ProviderId
    selectedModelType?: string
    customModel?: string
  }
  title: string
  status: RemoteTaskStatus
  createdAt?: string
  updatedAt?: string
  runId?: string
  latestRunId?: string
  runStartedAt?: string
  runEndedAt?: string
  preview: string
  previewTruncated: boolean
  pendingApprovalCount: number
  pendingQuestionCount: number
  activeGoal?: RemoteActiveGoal
  /** Per-author working plans (PlanRail). Ensemble chats carry one lane per
   * participant; solo/guest collapse to a single TODO_SOLO_LANE lane. */
  todoLanes?: RemoteTodoLane[]
  /** Open Canvas previews in this chat (read-only; P3). Omitted when none open. */
  canvasPreviews?: RemoteCanvasPreview[]
  capabilities?: RemoteTaskCapabilities
  diffSummary?: MobileDiffSummary
  additionalWorkspaces?: RemoteAdditionalWorkspace[]
  ensembleState?: RemoteEnsembleState
  queuedComposerPrompts?: RemoteQueuedComposerPrompt[]
}

export interface RemoteAdditionalWorkspace {
  id: string
  path: string
  kind: 'file' | 'directory'
  access: 'read' | 'write'
  providers: ProviderId[]
  order?: number
}

export interface RemoteQueuedComposerPrompt {
  id: string
  runId: string
  provider: ProviderId
  text: string
  index: number
  createdAt?: string
  enqueuedAt?: string
  threadId?: string
  workspaceId?: string
  model?: string
  approvalMode?: string
  reasoningEffort?: string | null
  claudeReasoningEffort?: string | null
}

export interface RemoteTaskCapabilities {
  monitor: boolean
  approve: boolean
  answer: boolean
  cancel: boolean
  startTurn: boolean
  diffReview: boolean
  steer: boolean
  fileBrowse?: boolean
  fileRead?: boolean
  fileWrite?: boolean
  externalPublish?: boolean
  pin?: boolean
  yolo?: boolean
  cancelRound?: boolean
  skipActiveParticipant?: boolean
  wakeNow?: boolean
  cancelWakeup?: boolean
  queuePrompt?: boolean
  queueLimit?: number
}

export interface RemoteTaskFeedSnapshot {
  schemaVersion: 1
  generatedAt: string
  tasks: RemoteTaskCard[]
  approvals: MobileApprovalCard[]
  questions: MobileQuestionCard[]
  totalTasks: number
  totalPendingApprovals: number
  totalPendingQuestions: number
  truncated: boolean
}

export interface MobileApprovalCard {
  toolCallId: string
  threadId?: string
  workspaceId?: string | null
  workspacePath?: string
  runId?: string
  provider?: ProviderId
  title: string
  body: string
  requestedAt: string
  expiresAt?: string
  actions: string[]
  status: 'pending' | 'resolved' | 'expired' | 'cancelled'
}

export interface MobileQuestionCard {
  promptId: string
  questionId: string
  threadId?: string
  workspaceId?: string | null
  workspacePath?: string
  runId?: string
  provider?: ProviderId
  question: string
  options?: string[]
  context?: string
  createdAt: string
  expiresAt?: string
  status: 'pending' | 'answered' | 'rejected' | 'expired' | 'cancelled'
}

export interface MobileDiffFile {
  path: string
  status: DiffFileSummary['status']
  additions: number
  deletions: number
  previewKind: DiffFileSummary['previewKind']
  hunks?: MobileDiffHunk[]
  truncated?: boolean
  diffTextOmittedLines?: number
  diffTextOriginalBytes?: number
  isBinary?: boolean
  binary?: boolean
  isNoise?: boolean
  isSensitive?: boolean
  sensitive?: boolean
  large?: boolean
  sizeBytes?: number
}

export interface MobileDiffHunk {
  id: string
  filePath: string
  header?: string
  previewLines: string[]
  oldStart?: number
  newStart?: number
  truncated: boolean
}

export interface MobileDiffWorkspaceSummary {
  workspaceId?: string
  workspacePath: string
  filesChanged: number
  additions: number
  deletions: number
  createdFiles: number
  modifiedFiles: number
  deletedFiles: number
  preExistingFiles: number
  files: MobileDiffFile[]
}

interface MobileDiffFileBudget {
  remaining: number
  truncated: boolean
}

export interface MobileDiffSummary {
  taskId?: string
  workspaceId?: string | null
  threadId?: string
  runId: string
  filesChanged: number
  additions: number
  deletions: number

  createdFiles: number
  modifiedFiles: number
  deletedFiles: number
  preExistingFiles: number
  files: MobileDiffFile[]
  hunks: MobileDiffHunk[]
  truncated: boolean
  updatedAt?: string
  workspaces: MobileDiffWorkspaceSummary[]
}

export interface RemoteEnsembleParticipantState {
  participantId: string
  provider: ProviderId
  role: string
  order: number
  status: EnsembleRoundParticipantState['status']
  runId?: string
  reason?: string
  startedAt?: string
  endedAt?: string
}

/** One CONFIGURED participant (chat.ensemble.participants) — the editable
 * roster, present even when no round is active (round state lives in
 * `participants`). */
export interface RemoteEnsembleRosterEntry {
  id: string
  provider: ProviderId
  role: string
  enabled: boolean
  order: number
  model?: string
  /** Honest current-context proxy for this participant: the LATEST run's
   * input+output tokens (NOT a cumulative sum). The phone divides by its own
   * per-model window to draw the participant's context meter. Omitted when 0. */
  contextTokens?: number
  /** Goal/brief (instructions), clipped for the wire. */
  brief?: string
  /** Per-participant approval preset + reasoning, so the remote chip editor can
   * display and round-trip them (iOS parity with the desktop participant editor). */
  permissionPresetId?: string
  reasoningEffort?: string
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  /** Staged fan-out stage ('scout' | 'worker' | 'reviewer') — spike 4; the
   * iOS Roster page displays and round-trips it via ensembleRosterUpdate. */
  stageRole?: string
  isBossman?: boolean
  isSecondInCommand?: boolean
}

/** A saved ensemble roster preset projected to paired devices (iOS Roster
 * page). GLOBAL (not workspace-bound). One envelope per preset,
 * `kind: 'ensemblePresets'`. The renderer owns the store; this is a read-only
 * projection of it. Participants reuse the roster-entry shape so the phone can
 * apply a preset by replaying them through the existing roster-update action. */
export interface RemoteEnsemblePreset {
  id: string
  name: string
  orchestrationMode?: string
  maxParticipants?: number
  updatedAt?: number
  participants: RemoteEnsembleRosterEntry[]
}

export interface RemoteEnsembleState {
  threadId: string
  roundId?: string
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  orchestrationMode?: string
  activeParticipantId?: string
  bossmanParticipantId?: string
  secondInCommandParticipantId?: string
  continuationHops?: number
  maxContinuationHops?: number
  fanoutPolicy?: string
  ensembleContextChars?: number
  queuedPromptCount: number
  participantCount: number
  participants: RemoteEnsembleParticipantState[]
  /** The configured (editable) roster — independent of round state. */
  roster?: RemoteEnsembleRosterEntry[]
  /** Queued prompt texts (combined legacy single + array, in injection
   * order) — `index` addresses items for steerNow/remove actions. */
  queuedPrompts?: Array<{ index: number; text: string }>
  workSessionStatus?: string
}

export type RemoteShellColorScheme = 'system' | 'light' | 'dark'

export interface RemoteShellAdaptiveColor {
  light: string
  dark: string
}

export interface RemoteShellAppearanceColors {
  windowBase: RemoteShellAdaptiveColor
  sidebarBase: RemoteShellAdaptiveColor
  cardFill: RemoteShellAdaptiveColor
  cardStroke: RemoteShellAdaptiveColor
  elevatedCardFill: RemoteShellAdaptiveColor
  inputSurface: RemoteShellAdaptiveColor
  composerSurface: RemoteShellAdaptiveColor
  composerBorder: RemoteShellAdaptiveColor
  primaryText: RemoteShellAdaptiveColor
  secondaryText: RemoteShellAdaptiveColor
  tertiaryText: RemoteShellAdaptiveColor
  separator: RemoteShellAdaptiveColor
  accent: string
  accentSoft: RemoteShellAdaptiveColor
  secondaryAccent: RemoteShellAdaptiveColor
  success: string
  warning: string
  destructive: string
}

export interface RemoteShellAppearance {
  schemaVersion: 1
  generatedAt: string
  appearanceMode: AppearanceMode
  visualEffectStyle: VisualEffectStyle
  themeAppearance: ThemeAppearance
  themeCornerStyle: ThemeCornerStyle
  themeAccentStyle: ThemeAccentStyle
  promptSurfaceStyle: PromptSurfaceStyle
  composerStyle: ComposerStyle
  reduceTransparency: boolean
  reduceMotion: boolean
  compactDensity: boolean
  /** Display name for the General-chat greeting on the phone ('' = no name). */
  userName: string
  preferredColorScheme: RemoteShellColorScheme
  colors: RemoteShellAppearanceColors
}

export interface BuildRemoteProjectionEnvelopeInput<TPayload> {
  kind: RemoteProjectionKind
  payload: TPayload
  generatedAt?: string
  workspaceId?: string | null
  workspacePath?: string
  threadId?: string
  runId?: string
  envelopeId?: string
}

export function buildRemotePluginCapabilityCards(
  projections: readonly TaskWraithPluginActivatedMobileProjection[]
): RemotePluginCapabilityCards {
  return {
    schemaVersion: 1,
    cards: projections.map((entry) => ({
      id: entry.id,
      pluginId: entry.plugin.pluginId,
      publisher: entry.plugin.publisher,
      label: entry.projection.label,
      ...(entry.projection.description ? { description: entry.projection.description } : {}),
      remoteCapabilities: [...entry.projection.remoteCapabilities],
      enabled: entry.enabled
    }))
  }
}

export interface BuildRemoteTaskCardOptions {
  generatedAt?: string
  previewMaxChars?: number
  pendingApprovalCount?: number
  pendingQuestionCount?: number
  capabilities?: RemoteTaskCapabilities
  /** Sub-agent character identity (read from the PARENT chat's persisted
   * providerMetadata.agentIdentities registry — the same names/accents
   * the desktop renders, never re-derived). */
  agentIdentity?: { name: string; accent?: string; slug?: string }
  queuedComposerJobs?: RunQueueJob[]
  /** Open Canvas sessions scoped to this chat (canvasService.list({chatId})). */
  openCanvases?: ReadonlyArray<CanvasSessionSummary>
  isShared?: boolean
  sharedMode?: string
}

export interface BuildRemoteTaskFeedSnapshotInput {
  chats: ChatRecord[]
  approvals?: MobileApprovalCard[]
  questions?: MobileQuestionCard[]
  generatedAt?: string
  maxTasks?: number
  previewMaxChars?: number
}

export type BuildRemoteShellAppearanceSettings = Partial<
  Pick<
    AppSettings,
    | 'appearanceMode'
    | 'visualEffectStyle'
    | 'themeAppearance'
    | 'themeCornerStyle'
    | 'themeAccentStyle'
    | 'promptSurfaceStyle'
    | 'composerStyle'
    | 'reduceTransparency'
    | 'reduceMotion'
    | 'compactDensity'
    | 'userName'
  >
>

export interface BuildRemoteShellAppearanceOptions {
  generatedAt?: string
}

export interface BuildMobileApprovalCardInput {
  toolCallId: string
  threadId?: string
  workspaceId?: string | null
  workspacePath?: string
  runId?: string
  provider?: ProviderId
  title?: string
  body?: string
  requestedAt?: string
  expiresAt?: string
  actions?: string[]
  status?: MobileApprovalCard['status']
}

export interface BuildMobileQuestionCardInput {
  questionId: string
  promptId?: string
  threadId?: string
  workspaceId?: string | null
  workspacePath?: string
  runId?: string
  provider?: ProviderId
  question: string
  options?: string[]
  context?: string
  createdAt: string
  expiresAt?: string
  status?: MobileQuestionCard['status']
}

const DEFAULT_PREVIEW_MAX = 240
const DEFAULT_MAX_TASKS = 100
const DEFAULT_REMOTE_WORKSPACE_BOARD_CARD_LIMIT = 40
const DEFAULT_REMOTE_SHELL_COLORS: RemoteShellAppearanceColors = {
  windowBase: { light: '#f4f6f8', dark: '#141414' },
  sidebarBase: { light: '#c2c2c2', dark: '#1e1e22' },
  cardFill: { light: '#f6f9fbae', dark: '#1c1c20d1' },
  cardStroke: { light: '#0000001a', dark: '#ffffff1a' },
  elevatedCardFill: { light: '#fbfdffc7', dark: '#26262ce0' },
  inputSurface: { light: '#00000012', dark: '#ffffff12' },
  composerSurface: { light: '#ffffffc7', dark: '#071024eb' },
  composerBorder: { light: '#0000001f', dark: '#7c9eff38' },
  primaryText: { light: '#000000e0', dark: '#ffffffeb' },
  secondaryText: { light: '#0000009e', dark: '#ffffff8c' },
  tertiaryText: { light: '#00000070', dark: '#ffffff59' },
  separator: { light: '#00000017', dark: '#ffffff0f' },
  accent: '#5a8cff',
  accentSoft: { light: '#5a8cff24', dark: '#5a8cff2e' },
  secondaryAccent: { light: '#00739e', dark: '#6bc4db' },
  success: '#4cc38a',
  warning: '#f5a623',
  destructive: '#e54d4d'
}

const THEME_ACCENTS: Partial<Record<ThemeAppearance | ThemeAccentStyle, string>> = {
  blue: '#5a8cff',
  purple: '#bf7cff',
  pink: '#ff5fa2',
  red: '#e65b62',
  orange: '#ff9b54',
  yellow: '#f2c94c',
  green: '#4cc38a',
  graphite: '#9da6b8',
  rainbow: '#ff5fa2',
  nebula: '#bf7cff',
  citrus: '#f2c94c',
  twilight: '#5a8cff',
  ocean: '#41c7e5',
  sunset: '#ff9b54',
  forest: '#4cc38a',
  cyber: '#62d8ff',
  candy: '#ff5fa2',
  mist: '#5a8cff',
  sage: '#84a33b',
  obsidian: '#c8c0d2',
  alabaster: '#5a6172',
  midnight: '#5a8cff'
}

const LIGHT_THEMES = new Set<ThemeAppearance>(['light', 'mist', 'sage', 'alabaster'])
const DARK_THEMES = new Set<ThemeAppearance>([
  'dark',
  'midnight',
  'rainbow',
  'twilight',
  'cyber',
  'obsidian'
])

const DEFAULT_REMOTE_SHELL_SETTINGS: Required<BuildRemoteShellAppearanceSettings> = {
  appearanceMode: 'soft_glass',
  visualEffectStyle: 'auto',
  themeAppearance: 'system',
  themeCornerStyle: 'rounded',
  themeAccentStyle: 'system',
  promptSurfaceStyle: 'liquid_glass',
  composerStyle: 'default',
  reduceTransparency: false,
  reduceMotion: false,
  compactDensity: false,
  userName: ''
}

export function buildRemoteProjectionEnvelope<TPayload>(
  input: BuildRemoteProjectionEnvelopeInput<TPayload>
): RemoteProjectionEnvelope<TPayload> {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const envelope: RemoteProjectionEnvelope<TPayload> = {
    schemaVersion: 1,
    envelopeId:
      input.envelopeId ??
      [
        'remote-projection',
        input.kind,
        input.threadId || 'no-thread',
        input.runId || 'no-run',
        Date.parse(generatedAt) || generatedAt
      ].join(':'),
    source: 'mac',
    kind: input.kind,
    generatedAt,
    payload: input.payload
  }
  if (input.workspaceId !== undefined) envelope.workspaceId = input.workspaceId
  if (input.workspacePath) envelope.workspacePath = input.workspacePath
  if (input.threadId) envelope.threadId = input.threadId
  if (input.runId) envelope.runId = input.runId
  return envelope
}

export function buildRemoteWorkspaceBoard(
  board: WorkspaceBoardDefinition,
  cards: ReadonlyArray<WorkspaceBoardCard>,
  options: { cardLimit?: number } = {}
): RemoteWorkspaceBoard {
  const cardLimit = clampPositiveInt(
    options.cardLimit,
    DEFAULT_REMOTE_WORKSPACE_BOARD_CARD_LIMIT
  )
  const boardCards = cards.filter((card) => card.boardId === board.id)
  const activeCards = boardCards.filter((card) => !card.archived)
  const archivedCards = boardCards.filter((card) => card.archived)
  const sortedCardUpdatedAts = boardCards
    .map((card) => card.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
  const latestCardUpdatedAt = sortedCardUpdatedAts[sortedCardUpdatedAts.length - 1]
  const activeCountsByColumn = countBoardCardsByColumn(activeCards)
  const archivedCountsByColumn = countBoardCardsByColumn(archivedCards)
  const columnOrder = new Map(board.columns.map((column, index) => [column.id, index]))
  const sortedCards = [...boardCards].sort(
    (left, right) =>
      Number(left.archived === true) - Number(right.archived === true) ||
      (columnOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
        (columnOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER) ||
      left.sortOrder - right.sortOrder ||
      right.updatedAt.localeCompare(left.updatedAt)
  )
  const projectedCards = sortedCards.slice(0, cardLimit).map(projectRemoteWorkspaceBoardCard)
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    workspacePath: board.workspacePath,
    name: sanitizeText(board.name, 160).preview,
    description: sanitizeText(board.description, 500).preview || undefined,
    pinned: board.pinned,
    archived: board.archived,
    activeCardCount: activeCards.length,
    archivedCardCount: archivedCards.length,
    columns: board.columns.map((column) =>
      projectRemoteWorkspaceBoardColumn(column, activeCountsByColumn, archivedCountsByColumn)
    ),
    cards: projectedCards,
    cardLimit,
    cardsTruncated: sortedCards.length > projectedCards.length,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    latestCardUpdatedAt
  }
}

function countBoardCardsByColumn(
  cards: ReadonlyArray<WorkspaceBoardCard>
): Map<WorkspaceBoardColumnId, number> {
  const counts = new Map<WorkspaceBoardColumnId, number>()
  for (const card of cards) {
    counts.set(card.columnId, (counts.get(card.columnId) ?? 0) + 1)
  }
  return counts
}

function projectRemoteWorkspaceBoardColumn(
  column: WorkspaceBoardColumn,
  activeCounts: ReadonlyMap<WorkspaceBoardColumnId, number>,
  archivedCounts: ReadonlyMap<WorkspaceBoardColumnId, number>
): RemoteWorkspaceBoardColumn {
  return {
    id: column.id,
    name: sanitizeText(column.name, 80).preview || column.id,
    sortOrder: column.sortOrder,
    ...(typeof column.wipLimit === 'number' && Number.isFinite(column.wipLimit)
      ? { wipLimit: column.wipLimit }
      : {}),
    activeCardCount: activeCounts.get(column.id) ?? 0,
    archivedCardCount: archivedCounts.get(column.id) ?? 0
  }
}

function projectRemoteWorkspaceBoardCard(card: WorkspaceBoardCard): RemoteWorkspaceBoardCard {
  const body = sanitizeText(card.body, 500).preview
  return {
    id: card.id,
    boardId: card.boardId,
    workspaceId: card.workspaceId,
    columnId: card.columnId,
    title: sanitizeText(card.title, 160).preview,
    ...(body ? { body } : {}),
    ...(card.labels?.length ? { labels: card.labels.slice(0, 8) } : {}),
    ...(card.link ? { linkKind: card.link.kind, linkId: card.link.id } : {}),
    ...(card.provenance?.sourceTitle
      ? { sourceTitle: sanitizeText(card.provenance.sourceTitle, 160).preview }
      : {}),
    ...(card.provenance?.runId ? { runId: card.provenance.runId } : {}),
    ...(card.archived ? { archived: true } : {}),
    updatedAt: card.updatedAt
  }
}

export function buildRemoteShellAppearance(
  settings: BuildRemoteShellAppearanceSettings = {},
  options: BuildRemoteShellAppearanceOptions = {}
): RemoteShellAppearance {
  const resolved = { ...DEFAULT_REMOTE_SHELL_SETTINGS, ...settings }
  const accent =
    resolved.themeAccentStyle === 'system'
      ? THEME_ACCENTS[resolved.themeAppearance] || DEFAULT_REMOTE_SHELL_COLORS.accent
      : THEME_ACCENTS[resolved.themeAccentStyle] || DEFAULT_REMOTE_SHELL_COLORS.accent

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    appearanceMode: resolved.appearanceMode,
    visualEffectStyle: resolved.visualEffectStyle,
    themeAppearance: resolved.themeAppearance,
    themeCornerStyle: resolved.themeCornerStyle,
    themeAccentStyle: resolved.themeAccentStyle,
    promptSurfaceStyle: resolved.promptSurfaceStyle,
    composerStyle: resolved.composerStyle,
    reduceTransparency: resolved.reduceTransparency,
    reduceMotion: resolved.reduceMotion,
    compactDensity: resolved.compactDensity,
    userName: resolved.userName,
    preferredColorScheme: preferredColorSchemeForRemoteShell(resolved.themeAppearance),
    colors: {
      ...DEFAULT_REMOTE_SHELL_COLORS,
      accent,
      accentSoft: {
        light: `${accent}24`,
        dark: `${accent}2e`
      }
    }
  }
}

function preferredColorSchemeForRemoteShell(theme: ThemeAppearance): RemoteShellColorScheme {
  if (theme === 'system') return 'system'
  if (LIGHT_THEMES.has(theme)) return 'light'
  if (DARK_THEMES.has(theme)) return 'dark'
  return 'system'
}

function projectActiveGoal(goal?: ActiveGoal): RemoteActiveGoal | undefined {
  if (!goal) return undefined
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    mode: goal.mode,
    provider: goal.provider,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.pausedAt ? { pausedAt: goal.pausedAt } : {}),
    ...(goal.blockedAt ? { blockedAt: goal.blockedAt } : {}),
    ...(goal.blockedReason ? { blockedReason: goal.blockedReason } : {}),
    ...(goal.completedAt ? { completedAt: goal.completedAt } : {}),
    ...(goal.completedSummary ? { completedSummary: goal.completedSummary } : {}),
    ...(goal.lastStatusReason ? { lastStatusReason: goal.lastStatusReason } : {})
  }
}

/**
 * Derive per-author working plans from the chat's tool activities — the same
 * source the desktop PlanRail uses (ActivityStack), so iOS shows the identical
 * lanes. Top-level activities only (sub-agent children excluded); grouped by
 * ensemble participant/provider, or TODO_SOLO_LANE for solo/guest.
 */
function buildRemoteTodoLanes(chat: ChatRecord): RemoteTodoLane[] {
  const activities: ToolActivity[] = []
  for (const message of chat.messages ?? []) {
    for (const activity of message.toolActivities ?? []) {
      // Sub-agent (Task/Agent child) calls never carry the parent plan; exclude
      // them so a delegate's todos don't leak into the parent's PlanRail.
      if (activity.parentToolCallId) continue
      activities.push(activity)
    }
  }
  if (activities.length === 0) return []
  const byLane = computeMergedTodosByLane(
    activities,
    (activity) =>
      activity.metadata?.ensembleProvider ?? activity.metadata?.provider ?? TODO_SOLO_LANE
  )
  return Object.entries(byLane)
    .filter(([, items]) => items.length > 0)
    .map(([lane, items]) => ({ lane, items }))
    .sort((a, b) => a.lane.localeCompare(b.lane))
}

function buildRemoteAdditionalWorkspaces(chat: ChatRecord): RemoteAdditionalWorkspace[] {
  if (!chat.workspacePath) return []
  const grants = collectExternalPathGrantsFromMetadata(chat.providerMetadata)
  if (grants.length === 0) return []

  const byPath = new Map<
    string,
    {
      path: string
      kind: ExternalPathGrant['kind']
      access: ExternalPathGrant['access']
      providers: ProviderId[]
      order?: number
    }
  >()
  for (const grant of grants) {
    if (!grant.path || grant.path === chat.workspacePath) continue
    const existing = byPath.get(grant.path)
    if (existing) {
      if (grant.access === 'write') existing.access = 'write'
      if (grant.kind === 'directory') existing.kind = 'directory'
      if (!existing.providers.includes(grant.provider)) existing.providers.push(grant.provider)
      if (typeof grant.order === 'number') {
        existing.order =
          typeof existing.order === 'number' ? Math.min(existing.order, grant.order) : grant.order
      }
      continue
    }
    byPath.set(grant.path, {
      path: grant.path,
      kind: grant.kind === 'directory' ? 'directory' : 'file',
      access: grant.access === 'write' ? 'write' : 'read',
      providers: [grant.provider],
      ...(typeof grant.order === 'number' ? { order: grant.order } : {})
    })
  }

  return [...byPath.values()]
    .sort((a, b) => {
      const aOrder = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER
      const bOrder = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER
      if (aOrder !== bOrder) return aOrder - bOrder
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })
    .map((workspace) => ({
      id: workspace.path,
      path: workspace.path,
      kind: workspace.kind,
      access: workspace.access,
      providers: workspace.providers,
      ...(typeof workspace.order === 'number' ? { order: workspace.order } : {})
    }))
}

export function buildRemoteTaskCard(
  chat: ChatRecord,
  options: BuildRemoteTaskCardOptions = {}
): RemoteTaskCard {
  const latestRun = latestChatRun(chat)
  const agentIdentity = options.agentIdentity
  const draftVariant = remoteDraftVariant(chat)
  const pendingQuestionCount = Math.max(0, Math.floor(options.pendingQuestionCount ?? 0))
  const pendingApprovalCount = Math.max(0, Math.floor(options.pendingApprovalCount ?? 0))
  const preview = previewForChat(chat, options.previewMaxChars ?? DEFAULT_PREVIEW_MAX)
  const card: RemoteTaskCard = {
    id: chat.appChatId,
    threadId: chat.appChatId,
    ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
    ...(chat.pinned ? { pinned: true } : {}),
    ...(agentIdentity?.name ? { agentName: agentIdentity.name } : {}),
    ...(agentIdentity?.accent ? { agentAccent: agentIdentity.accent } : {}),
    ...(agentIdentity?.slug ? { agentSlug: agentIdentity.slug } : {}),
    ...(chat.parentChatRelation ? { parentChatRelation: chat.parentChatRelation } : {}),
    ...(chat.sideChatContext?.mode ? { sideChatMode: chat.sideChatContext.mode } : {}),
    ...(chat.sideChatContext?.lifecycleState
      ? { sideChatLifecycleState: chat.sideChatContext.lifecycleState }
      : {}),
    ...(chat.chatKind ? { chatKind: chat.chatKind } : {}),
    ...(isContentlessRemoteDraftChat(chat) ? { isDraft: true } : {}),
    ...(draftVariant ? { draftVariant } : {}),
    ...(options.isShared ? { isShared: true } : {}),
    ...(isString(options.sharedMode) ? { sharedMode: options.sharedMode } : {}),
    ...(chat.archived ? { archived: true } : {}),
    workspaceId: chat.workspaceId && chat.workspaceId.length > 0 ? chat.workspaceId : null,
    provider: chat.provider ?? 'gemini',
    title: normalizeThreadTitle(chat.title, 'Untitled chat'),
    status: deriveTaskStatus(latestRun, pendingApprovalCount, pendingQuestionCount, {
      ensembleRound: chat.ensemble?.activeRound,
      hasQueuedFollowup: hasQueuedRemoteComposerJobs(options.queuedComposerJobs)
    }),
    preview: preview.preview,
    previewTruncated: preview.truncated,
    pendingApprovalCount,
    pendingQuestionCount
  }
  const providerMetadata = chat.providerMetadata || {}
  if (isString(providerMetadata.selectedModelType)) {
    card.selectedModelType = providerMetadata.selectedModelType
  }
  if (isString(providerMetadata.customModel)) {
    card.customModel = providerMetadata.customModel
  }
  if (isString(providerMetadata.codexReasoningEffort)) {
    card.codexReasoningEffort = providerMetadata.codexReasoningEffort
  }
  if (isString(providerMetadata.claudeReasoningEffort)) {
    card.claudeReasoningEffort = providerMetadata.claudeReasoningEffort
  }
  const pendingProviderChange = readPendingProviderChange(chat)
  if (pendingProviderChange) {
    const pendingMeta = pendingProviderChange.providerMetadata ?? {}
    card.pendingProviderChange = {
      provider: pendingProviderChange.provider,
      ...(isString(pendingMeta.selectedModelType)
        ? { selectedModelType: pendingMeta.selectedModelType }
        : {}),
      ...(isString(pendingMeta.customModel) ? { customModel: pendingMeta.customModel } : {})
    }
  }
  const createdAt = msToIso(chat.createdAt)
  if (createdAt) card.createdAt = createdAt
  const updatedAt = msToIso(chat.updatedAt)
  if (updatedAt) card.updatedAt = updatedAt
  if (chat.workspacePath) card.workspacePath = chat.workspacePath
  if (latestRun?.runId) {
    card.runId = latestRun.runId
    card.latestRunId = latestRun.runId
  }
  if (latestRun?.startedAt) card.runStartedAt = latestRun.startedAt
  if (latestRun?.endedAt) card.runEndedAt = latestRun.endedAt
  const activeGoal = projectActiveGoal(chat.activeGoal)
  if (activeGoal) card.activeGoal = activeGoal
  const todoLanes = buildRemoteTodoLanes(chat)
  if (todoLanes.length > 0) card.todoLanes = todoLanes
  const canvasPreviews = buildRemoteCanvasPreviews(options.openCanvases ?? [])
  if (canvasPreviews.length > 0) card.canvasPreviews = canvasPreviews
  if (options.capabilities) card.capabilities = options.capabilities
  const diffSummary = latestRun
    ? buildMobileDiffSummary(latestRun, {
        taskId: chat.appChatId,
        threadId: chat.appChatId,
        workspaceId: chat.workspaceId ?? null,
        generatedAt: options.generatedAt
      })
    : undefined
  if (diffSummary) card.diffSummary = compactDiffSummaryForTaskCard(diffSummary)
  const additionalWorkspaces = buildRemoteAdditionalWorkspaces(chat)
  if (additionalWorkspaces.length > 0) card.additionalWorkspaces = additionalWorkspaces
  const ensembleState = buildRemoteEnsembleState(chat)
  if (ensembleState) card.ensembleState = ensembleState
  const queuedComposerPrompts = buildRemoteQueuedComposerPrompts(options.queuedComposerJobs)
  if (queuedComposerPrompts.length > 0) card.queuedComposerPrompts = queuedComposerPrompts
  return card
}

function compactDiffSummaryForTaskCard(summary: MobileDiffSummary): MobileDiffSummary {
  return {
    ...summary,
    files: summary.files.map(({ hunks: _hunks, ...file }) => file),
    hunks: [],
    workspaces: summary.workspaces.map((workspace) => ({
      ...workspace,
      files: workspace.files.map(({ hunks: _hunks, ...file }) => file)
    }))
  }
}

export function buildRemoteQueuedComposerPrompts(
  jobs: RunQueueJob[] | undefined
): RemoteQueuedComposerPrompt[] {
  if (!jobs?.length) return []
  return jobs
    .filter((job) => job.status === 'queued' && job.request?.remoteComposer)
    .map((job, index) => {
      const remote = job.request!.remoteComposer!
      return {
        id: job.id,
        runId: job.runId,
        provider: job.provider,
        text: sanitizeText(remote.text || job.promptPreview, 4000).preview,
        index,
        ...(typeof remote.threadId === 'string' ? { threadId: remote.threadId } : {}),
        ...(typeof remote.workspaceId === 'string' ? { workspaceId: remote.workspaceId } : {}),
        ...(typeof remote.model === 'string' ? { model: remote.model } : {}),
        ...(typeof remote.approvalMode === 'string' ? { approvalMode: remote.approvalMode } : {}),
        ...(remote.reasoningEffort !== undefined ? { reasoningEffort: remote.reasoningEffort } : {}),
        ...(remote.claudeReasoningEffort !== undefined
          ? { claudeReasoningEffort: remote.claudeReasoningEffort }
          : {}),
        ...(job.createdAt ? { createdAt: job.createdAt } : {}),
        ...(job.enqueuedAt ? { enqueuedAt: job.enqueuedAt } : {})
      }
    })
}

function hasQueuedRemoteComposerJobs(jobs: RunQueueJob[] | undefined): boolean {
  return Boolean(jobs?.some((job) => job.status === 'queued' && job.request?.remoteComposer))
}

export function buildRemoteTaskFeedSnapshot(
  input: BuildRemoteTaskFeedSnapshotInput
): RemoteTaskFeedSnapshot {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const questions = input.questions ?? []
  const approvals = input.approvals ?? []
  const questionCounts = countByThread(questions.map((q) => q.threadId).filter(isString))
  const approvalCounts = countByThread(approvals.map((a) => a.threadId).filter(isString))
  const sortedChats = [...input.chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const maxTasks = clampPositiveInt(input.maxTasks, DEFAULT_MAX_TASKS)
  const tasks = sortedChats.slice(0, maxTasks).map((chat) =>
    buildRemoteTaskCard(chat, {
      generatedAt,
      previewMaxChars: input.previewMaxChars,
      pendingQuestionCount: questionCounts.get(chat.appChatId) ?? 0,
      pendingApprovalCount: approvalCounts.get(chat.appChatId) ?? 0
    })
  )
  return {
    schemaVersion: 1,
    generatedAt,
    tasks,
    approvals,
    questions,
    totalTasks: sortedChats.length,
    totalPendingApprovals: approvals.length,
    totalPendingQuestions: questions.length,
    truncated: sortedChats.length > tasks.length
  }
}

export function buildMobileApprovalCard(input: BuildMobileApprovalCardInput): MobileApprovalCard {
  const card: MobileApprovalCard = {
    toolCallId: input.toolCallId,
    title: sanitizeText(input.title || 'Approval requested', 120).preview,
    body: sanitizeText(input.body || '', 400).preview,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    actions:
      input.actions && input.actions.length > 0 ? input.actions.slice(0, 8) : ['accept', 'decline'],
    status: input.status ?? 'pending'
  }
  if (input.threadId) card.threadId = input.threadId
  if (input.workspaceId !== undefined) card.workspaceId = input.workspaceId
  if (input.workspacePath) card.workspacePath = input.workspacePath
  if (input.runId) card.runId = input.runId
  if (input.provider) card.provider = input.provider
  if (input.expiresAt) card.expiresAt = input.expiresAt
  return card
}

export function buildMobileQuestionCard(input: BuildMobileQuestionCardInput): MobileQuestionCard {
  const options = (input.options ?? [])
    .map((option) => sanitizeText(option, 120).preview)
    .filter((option) => option.length > 0)
    .slice(0, 8)
  const card: MobileQuestionCard = {
    promptId: input.promptId || input.questionId,
    questionId: input.questionId,
    question: sanitizeText(input.question, 500).preview,
    createdAt: input.createdAt,
    status: input.status ?? 'pending'
  }
  if (input.threadId) card.threadId = input.threadId
  if (input.workspaceId !== undefined) card.workspaceId = input.workspaceId
  if (input.workspacePath) card.workspacePath = input.workspacePath
  if (input.runId) card.runId = input.runId
  if (input.provider) card.provider = input.provider
  if (options.length > 0) card.options = options
  const context = sanitizeText(input.context, 500).preview
  if (context) card.context = context
  if (input.expiresAt) card.expiresAt = input.expiresAt
  return card
}

export function buildMobileDiffSummary(
  run: ChatRun,
  context: {
    taskId?: string
    workspaceId?: string | null
    threadId?: string
    generatedAt?: string
  } = {}
): MobileDiffSummary | undefined {
  const workspaceSummaries: MobileDiffWorkspaceSummary[] = []
  const fileBudget: MobileDiffFileBudget = {
    remaining: MOBILE_DIFF_SUMMARY_FILE_LIMIT,
    truncated: false
  }
  const runDiffWorkspace = run.runDiff
    ? workspaceSummaryFromRunDiff(
        run.runDiff,
        run,
        context.workspaceId ?? undefined,
        fileBudget
      )
    : undefined
  if (runDiffWorkspace) {
    workspaceSummaries.push(runDiffWorkspace)
  }

  const byPath = run.runDiffByPath ?? {}
  for (const [workspacePath, files] of Object.entries(byPath)) {
    if (!Array.isArray(files)) continue
    if (runDiffWorkspace && runDiffWorkspace.workspacePath === workspacePath) continue
    workspaceSummaries.push(workspaceSummaryFromFiles(workspacePath, files, undefined, fileBudget))
  }

  if (workspaceSummaries.length === 0) return undefined
  const files = workspaceSummaries.flatMap((workspace) => workspace.files)
  const hunks = files.flatMap((file) => file.hunks ?? [])
  const truncated =
    fileBudget.truncated ||
    files.some((file) => Boolean(file.truncated)) ||
    hunks.some((hunk) => hunk.truncated)
  const totals = workspaceSummaries.reduce(
    (acc, workspace) => {
      acc.filesChanged += workspace.filesChanged
      acc.additions += workspace.additions
      acc.deletions += workspace.deletions
      acc.createdFiles += workspace.createdFiles
      acc.modifiedFiles += workspace.modifiedFiles
      acc.deletedFiles += workspace.deletedFiles
      acc.preExistingFiles += workspace.preExistingFiles
      return acc
    },
    {
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      createdFiles: 0,
      modifiedFiles: 0,
      deletedFiles: 0,
      preExistingFiles: 0
    }
  )
  const summary: MobileDiffSummary = {
    runId: run.runId,
    ...totals,
    files,
    hunks,
    truncated,
    workspaces: workspaceSummaries
  }
  if (context.taskId) summary.taskId = context.taskId
  if (context.workspaceId !== undefined) summary.workspaceId = context.workspaceId
  if (context.threadId) summary.threadId = context.threadId
  if (context.generatedAt) summary.updatedAt = context.generatedAt
  return summary
}

/**
 * Honest current-context proxy for a chat, optionally scoped to one ensemble
 * participant: the LATEST run's input+output tokens (each turn re-sends the whole
 * conversation, so the most recent run ≈ what's actually in the window). NOT the
 * cumulative sum across runs (which over-counts). Mirrors the renderer's
 * lib/contextMeter.ts so desktop + phone agree. Reads the NORMALIZED stats fields
 * (ProviderRunStats already folds cache reads into input_tokens).
 */
function latestRunContextTokens(
  runs: ReadonlyArray<ChatRun>,
  participantId?: string
): number {
  let bestTime = Number.NEGATIVE_INFINITY
  let best = 0
  for (const run of runs) {
    if (participantId && run.ensembleParticipantId !== participantId) continue
    const stats = (run?.stats ?? {}) as Record<string, unknown>
    const input = Number(stats.input_tokens ?? stats.inputTokens ?? 0) || 0
    const output = Number(stats.output_tokens ?? stats.outputTokens ?? 0) || 0
    const total = Number(stats.total_tokens ?? stats.totalTokens ?? 0) || input + output
    if (total <= 0 && input <= 0) continue
    const parsed = Date.parse(run.startedAt || '')
    const time = Number.isFinite(parsed) ? parsed : 0
    if (time >= bestTime) {
      bestTime = time
      best = input + output
    }
  }
  return best
}

export function buildRemoteEnsembleState(chat: ChatRecord): RemoteEnsembleState | undefined {
  const ensemble = chat.ensemble
  if (!ensemble) return undefined
  const activeRound = ensemble.activeRound
  const projectedRoundStatus = projectEnsembleRoundStatus(activeRound)
  const queuedPrompts =
    projectedRoundStatus === 'running' || activeRound?.status === 'completed'
      ? combinedQueuedPrompts(activeRound)
      : []
  const participants = activeRound?.participants ?? []
  return {
    threadId: chat.appChatId,
    roundId: activeRound?.roundId,
    status: projectedRoundStatus,
    orchestrationMode: activeRound?.orchestrationMode ?? ensemble.orchestrationMode,
    activeParticipantId:
      projectedRoundStatus === 'running' ? activeRound?.activeParticipantId : undefined,
    bossmanParticipantId: ensemble.bossmanParticipantId,
    secondInCommandParticipantId: ensemble.secondInCommandParticipantId,
    continuationHops: activeRound?.continuationHops,
    maxContinuationHops: activeRound?.maxContinuationHops ?? ensemble.maxContinuationHops,
    fanoutPolicy: activeRound?.fanoutPolicy ?? ensemble.fanoutPolicy,
    ensembleContextChars: ensemble.ensembleContextChars,
    queuedPromptCount: queuedPrompts.length,
    ...(queuedPrompts.length > 0
      ? {
          queuedPrompts: queuedPrompts.map((text, index) => ({
            index,
            text: sanitizeText(text, 4000).preview
          }))
        }
      : {}),
    participantCount: participants.length || ensemble.participants.length,
    participants: participants.map(projectEnsembleParticipant),
    roster: [...ensemble.participants]
      .sort((a, b) => a.order - b.order)
      .map((participant) => {
        const contextTokens = latestRunContextTokens(chat.runs ?? [], participant.id)
        return {
          id: participant.id,
          provider: participant.provider,
          role: participant.role,
          enabled: participant.enabled,
          order: participant.order,
          ...(participant.id === ensemble.bossmanParticipantId ? { isBossman: true } : {}),
          ...(participant.id === ensemble.secondInCommandParticipantId
            ? { isSecondInCommand: true }
            : {}),
          ...(participant.model ? { model: participant.model } : {}),
          ...(contextTokens > 0 ? { contextTokens } : {}),
          ...(participant.instructions
            ? { brief: sanitizeText(participant.instructions, 500).preview }
            : {}),
          ...(participant.permissionPresetId
            ? { permissionPresetId: participant.permissionPresetId }
            : {}),
          ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {}),
          ...(participant.fastModeEnabled ? { fastModeEnabled: true } : {}),
          ...(participant.thinkingEnabled ? { thinkingEnabled: true } : {}),
          ...(participant.stageRole ? { stageRole: participant.stageRole } : {})
        }
      }),
    workSessionStatus: ensemble.workSession?.status
  }
}

function deriveTaskStatus(
  run: ChatRun | undefined,
  pendingApprovalCount: number,
  pendingQuestionCount: number,
  options: { ensembleRound?: EnsembleConfig['activeRound']; hasQueuedFollowup?: boolean } = {}
): RemoteTaskStatus {
  if (pendingQuestionCount > 0) return 'awaitingQuestion'
  if (pendingApprovalCount > 0) return 'awaitingApproval'
  // Ensemble rounds run participants serially, each as its own `ChatRun`
  // appended to `chat.runs`. `latestChatRun` therefore reports the most
  // recent participant — which flips running→success as EACH participant
  // finishes, so a naive derive would oscillate the card to 'success'
  // mid-round (and emit a premature runComplete push per participant; see
  // maybeNotifyRemoteTaskNeedsAttention). The round itself is the unit of
  // completion: it stays 'running' from beginRound until finishRound flips
  // it exactly once at end-of-round. While the round is still running, the
  // card never reports a terminal status off a single participant's run.
  const round = options.ensembleRound
  if (isEnsembleRoundDispatchLive(round)) return 'running'
  if (round?.status === 'completed' && combinedQueuedPrompts(round).length > 0) return 'running'
  if (options.hasQueuedFollowup) return 'running'
  if (!run) return 'idle'
  if (run.status === 'running') return 'running'
  if (run.status === 'cancelled' || run.cancelled) return 'cancelled'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'success' || run.status === 'success_with_warnings') return 'success'
  return 'idle'
}

function latestChatRun(chat: ChatRecord): ChatRun | undefined {
  const runs = chat.runs ?? []
  return [...runs].sort((a, b) => {
    const aTime = Date.parse(a.startedAt || '') || 0
    const bTime = Date.parse(b.startedAt || '') || 0
    return bTime - aTime
  })[0]
}

function previewForChat(
  chat: ChatRecord,
  maxChars: number
): { preview: string; truncated: boolean } {
  const lastMessage = [...(chat.messages ?? [])]
    .reverse()
    .find((message) => message.content && !isRetiredExternalChannelInboundMessage(message))
  return sanitizeText(lastMessage?.content || chat.title || '', maxChars)
}

function sanitizeText(
  raw: string | undefined,
  maxChars: number = DEFAULT_PREVIEW_MAX
): { preview: string; truncated: boolean } {
  if (!raw) return { preview: '', truncated: false }
  let cleaned = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    cleaned += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : raw[i]
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim()
  const limit = clampPositiveInt(maxChars, DEFAULT_PREVIEW_MAX)
  if (collapsed.length <= limit) return { preview: collapsed, truncated: false }
  return { preview: `${collapsed.slice(0, Math.max(0, limit - 1)).trimEnd()}...`, truncated: true }
}

function msToIso(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  return new Date(ms).toISOString()
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function countByThread(threadIds: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const threadId of threadIds) {
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1)
  }
  return counts
}

function workspaceSummaryFromRunDiff(
  runDiff: RunDiffResult,
  run: ChatRun,
  workspaceId?: string | null,
  fileBudget?: MobileDiffFileBudget
): MobileDiffWorkspaceSummary {
  const workspacePath =
    runDiff.postSnapshot?.workspacePath ||
    runDiff.preSnapshot.workspacePath ||
    run.effectiveWorkspacePath ||
    'workspace'
  return workspaceSummaryFromBuckets(
    workspacePath,
    {
      created: runDiff.createdFiles,
      modified: runDiff.modifiedFiles,
      deleted: runDiff.deletedFiles,
      preExisting: runDiff.preExistingFiles
    },
    workspaceId ?? undefined,
    fileBudget
  )
}

function workspaceSummaryFromFiles(
  workspacePath: string,
  files: DiffFileSummary[],
  workspaceId?: string,
  fileBudget?: MobileDiffFileBudget
): MobileDiffWorkspaceSummary {
  const created: DiffFileSummary[] = []
  const modified: DiffFileSummary[] = []
  const deleted: DiffFileSummary[] = []
  const preExisting: DiffFileSummary[] = []
  for (const file of files) {
    if (file.status === 'created' || file.status === 'untracked') created.push(file)
    else if (file.status === 'deleted') deleted.push(file)
    else if (file.status === 'noise' || file.status === 'hidden_sensitive') preExisting.push(file)
    else modified.push(file)
  }
  return workspaceSummaryFromBuckets(
    workspacePath,
    { created, modified, deleted, preExisting },
    workspaceId,
    fileBudget
  )
}

function workspaceSummaryFromBuckets(
  workspacePath: string,
  buckets: {
    created: DiffFileSummary[]
    modified: DiffFileSummary[]
    deleted: DiffFileSummary[]
    preExisting: DiffFileSummary[]
  },
  workspaceId?: string,
  fileBudget?: MobileDiffFileBudget
): MobileDiffWorkspaceSummary {
  const changed = [...buckets.created, ...buckets.modified, ...buckets.deleted]
  const allFiles = [...changed, ...buckets.preExisting]
  const filesForProjection =
    fileBudget === undefined ? allFiles : allFiles.slice(0, Math.max(0, fileBudget.remaining))
  if (fileBudget !== undefined) {
    if (filesForProjection.length < allFiles.length) fileBudget.truncated = true
    fileBudget.remaining = Math.max(0, fileBudget.remaining - filesForProjection.length)
  }
  return {
    workspaceId,
    workspacePath,
    filesChanged: changed.length,
    additions: sumFiles(changed, 'additions'),
    deletions: sumFiles(changed, 'deletions'),
    createdFiles: buckets.created.length,
    modifiedFiles: buckets.modified.length,
    deletedFiles: buckets.deleted.length,
    preExistingFiles: buckets.preExisting.length,
    files: filesForProjection.map(projectDiffFile)
  }
}

function projectDiffFile(file: DiffFileSummary): MobileDiffFile {
  const hunks = projectDiffHunks(file)
  const projected: MobileDiffFile = {
    path: file.path,
    status: file.status,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    previewKind: file.previewKind
  }
  if (hunks.length > 0) projected.hunks = hunks
  const truncated = Boolean(file.diffTextTruncated) || hunks.some((hunk) => hunk.truncated)
  if (truncated) projected.truncated = true
  if (file.diffTextOmittedLines !== undefined) {
    projected.diffTextOmittedLines = file.diffTextOmittedLines
  }
  if (file.diffTextOriginalBytes !== undefined) {
    projected.diffTextOriginalBytes = file.diffTextOriginalBytes
  }
  if (file.isBinary !== undefined) {
    projected.isBinary = file.isBinary
    projected.binary = file.isBinary
  }
  if (file.isNoise !== undefined) projected.isNoise = file.isNoise
  if (file.isSensitive !== undefined) {
    projected.isSensitive = file.isSensitive
    projected.sensitive = file.isSensitive
  }
  if (file.sizeBytes !== undefined) {
    projected.sizeBytes = file.sizeBytes
    projected.large = file.sizeBytes > 512 * 1024
  }
  return projected
}

function projectDiffHunks(file: DiffFileSummary): MobileDiffHunk[] {
  if (!file.diffText || file.isBinary || file.isSensitive) return []
  const lines = file.diffText.split(/\r?\n/)
  const hunks: MobileDiffHunk[] = []
  let current: MobileDiffHunk | null = null
  const maxHunks = 6
  const maxLinesPerHunk = 24
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current)
      if (hunks.length >= maxHunks) {
        current = null
        break
      }
      const parsed = parseUnifiedDiffHeader(line)
      current = {
        id: `${file.path}:${hunks.length}:${line.slice(0, 80)}`,
        filePath: file.path,
        header: sanitizeDiffLine(line, 160),
        previewLines: [],
        truncated: false
      }
      if (parsed.oldStart !== undefined) current.oldStart = parsed.oldStart
      if (parsed.newStart !== undefined) current.newStart = parsed.newStart
      continue
    }
    if (!current) continue
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (current.previewLines.length < maxLinesPerHunk) {
      current.previewLines.push(sanitizeDiffLine(line, 220))
    } else {
      current.truncated = true
    }
  }
  if (current) hunks.push(current)
  return hunks
}

function parseUnifiedDiffHeader(line: string): { oldStart?: number; newStart?: number } {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line)
  if (!match) return {}
  return { oldStart: Number(match[1]), newStart: Number(match[2]) }
}

function isRemoteDiffControlCode(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  )
}

function sanitizeDiffLine(raw: string, maxChars: number): string {
  let sanitized = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    sanitized += isRemoteDiffControlCode(char.charCodeAt(0)) ? ' ' : char
  }
  if (sanitized.length <= maxChars) return sanitized
  return `${sanitized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`
}

function sumFiles(files: DiffFileSummary[], key: 'additions' | 'deletions'): number {
  return files.reduce((total, file) => total + (file[key] ?? 0), 0)
}

/** Canonical queue view. Newer active rounds mirror the full FIFO in
 * `queuedPrompts` and keep `queuedPrompt` as the head for legacy readers.
 * Older records may only have `queuedPrompt`, so fall back to that single slot.
 * Index addressing for remote steerNow/remove uses this order. */
export function combinedQueuedPrompts(
  activeRound: EnsembleConfig['activeRound']
): string[] {
  if (!activeRound) return []
  if (Array.isArray(activeRound.queuedPrompts) && activeRound.queuedPrompts.length > 0) {
    return activeRound.queuedPrompts
  }
  return activeRound.queuedPrompt ? [activeRound.queuedPrompt] : []
}

function projectEnsembleRoundStatus(
  activeRound: EnsembleConfig['activeRound']
): RemoteEnsembleState['status'] {
  if (!activeRound) return 'idle'
  if (activeRound.status !== 'running') return activeRound.status
  return isEnsembleRoundDispatchLive(activeRound) ? 'running' : 'completed'
}

function projectEnsembleParticipant(
  participant: EnsembleRoundParticipantState
): RemoteEnsembleParticipantState {
  const projected: RemoteEnsembleParticipantState = {
    participantId: participant.participantId,
    provider: participant.provider,
    role: participant.role,
    order: participant.order,
    status: participant.status
  }
  if (participant.runId) projected.runId = participant.runId
  if (participant.reason) projected.reason = participant.reason
  if (participant.startedAt) projected.startedAt = participant.startedAt
  if (participant.endedAt) projected.endedAt = participant.endedAt
  return projected
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
