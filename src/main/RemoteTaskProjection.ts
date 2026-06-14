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
  PromptSurfaceStyle,
  ProviderId,
  RunDiffResult,
  ThemeAccentStyle,
  ThemeAppearance,
  ThemeCornerStyle,
  VisualEffectStyle
} from './store/types'

export type RemoteProjectionKind =
  | 'taskCard'
  | 'taskFeedSnapshot'
  | 'approvalCard'
  | 'questionCard'
  | 'threadSnapshot'
  | 'diffSummary'
  | 'ensembleState'
  | 'shellAppearance'

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
  /** `ensemble` chats need `ensembleQueuePrompt` on remote send paths. */
  chatKind?: 'single' | 'ensemble'
  workspaceId: string | null
  workspacePath?: string
  provider: ProviderId
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
  capabilities?: RemoteTaskCapabilities
  diffSummary?: MobileDiffSummary
  ensembleState?: RemoteEnsembleState
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
  /** Goal/brief (instructions), clipped for the wire. */
  brief?: string
}

export interface RemoteEnsembleState {
  threadId: string
  roundId?: string
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
  orchestrationMode?: string
  activeParticipantId?: string
  continuationHops?: number
  maxContinuationHops?: number
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
  compactDensity: false
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

export function buildRemoteTaskCard(
  chat: ChatRecord,
  options: BuildRemoteTaskCardOptions = {}
): RemoteTaskCard {
  const latestRun = latestChatRun(chat)
  const agentIdentity = options.agentIdentity
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
    ...(chat.chatKind ? { chatKind: chat.chatKind } : {}),
    workspaceId: chat.workspaceId && chat.workspaceId.length > 0 ? chat.workspaceId : null,
    provider: chat.provider ?? 'gemini',
    title: chat.title || 'Untitled chat',
    status: deriveTaskStatus(latestRun, pendingApprovalCount, pendingQuestionCount),
    preview: preview.preview,
    previewTruncated: preview.truncated,
    pendingApprovalCount,
    pendingQuestionCount
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
  if (options.capabilities) card.capabilities = options.capabilities
  const diffSummary = latestRun
    ? buildMobileDiffSummary(latestRun, {
        taskId: chat.appChatId,
        threadId: chat.appChatId,
        workspaceId: chat.workspaceId ?? null,
        generatedAt: options.generatedAt
      })
    : undefined
  if (diffSummary) card.diffSummary = diffSummary
  const ensembleState = buildRemoteEnsembleState(chat)
  if (ensembleState) card.ensembleState = ensembleState
  return card
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
      input.actions && input.actions.length > 0 ? input.actions.slice(0, 8) : ['accept', 'decline']
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
  const runDiffWorkspace = run.runDiff ? workspaceSummaryFromRunDiff(run.runDiff, run) : undefined
  if (runDiffWorkspace) {
    workspaceSummaries.push(runDiffWorkspace)
  }

  const byPath = run.runDiffByPath ?? {}
  for (const [workspacePath, files] of Object.entries(byPath)) {
    if (!Array.isArray(files)) continue
    if (runDiffWorkspace && runDiffWorkspace.workspacePath === workspacePath) continue
    workspaceSummaries.push(workspaceSummaryFromFiles(workspacePath, files))
  }

  if (workspaceSummaries.length === 0) return undefined
  const files = workspaceSummaries.flatMap((workspace) => workspace.files)
  const hunks = files.flatMap((file) => file.hunks ?? [])
  const truncated =
    files.some((file) => Boolean(file.truncated)) || hunks.some((hunk) => hunk.truncated)
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

export function buildRemoteEnsembleState(chat: ChatRecord): RemoteEnsembleState | undefined {
  const ensemble = chat.ensemble
  if (!ensemble) return undefined
  const activeRound = ensemble.activeRound
  const participants = activeRound?.participants ?? []
  return {
    threadId: chat.appChatId,
    roundId: activeRound?.roundId,
    status: activeRound?.status ?? 'idle',
    orchestrationMode: activeRound?.orchestrationMode ?? ensemble.orchestrationMode,
    activeParticipantId: activeRound?.activeParticipantId,
    continuationHops: activeRound?.continuationHops,
    maxContinuationHops: activeRound?.maxContinuationHops ?? ensemble.maxContinuationHops,
    queuedPromptCount: queuedPromptCount(activeRound),
    ...(combinedQueuedPrompts(activeRound).length > 0
      ? {
          queuedPrompts: combinedQueuedPrompts(activeRound).map((text, index) => ({
            index,
            text: sanitizeText(text, 4000).preview
          }))
        }
      : {}),
    participantCount: participants.length || ensemble.participants.length,
    participants: participants.map(projectEnsembleParticipant),
    roster: [...ensemble.participants]
      .sort((a, b) => a.order - b.order)
      .map((participant) => ({
        id: participant.id,
        provider: participant.provider,
        role: participant.role,
        enabled: participant.enabled,
        order: participant.order,
        ...(participant.model ? { model: participant.model } : {}),
        ...(participant.instructions
          ? { brief: sanitizeText(participant.instructions, 500).preview }
          : {})
      })),
    workSessionStatus: ensemble.workSession?.status
  }
}

function deriveTaskStatus(
  run: ChatRun | undefined,
  pendingApprovalCount: number,
  pendingQuestionCount: number
): RemoteTaskStatus {
  if (pendingQuestionCount > 0) return 'awaitingQuestion'
  if (pendingApprovalCount > 0) return 'awaitingApproval'
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
  const lastMessage = [...(chat.messages ?? [])].reverse().find((message) => message.content)
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
  run: ChatRun
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
    undefined
  )
}

function workspaceSummaryFromFiles(
  workspacePath: string,
  files: DiffFileSummary[],
  workspaceId?: string
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
    workspaceId
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
  workspaceId?: string
): MobileDiffWorkspaceSummary {
  const changed = [...buckets.created, ...buckets.modified, ...buckets.deleted]
  const allFiles = [...changed, ...buckets.preExisting]
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
    files: allFiles.map(projectDiffFile)
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
  const truncated = hunks.some((hunk) => hunk.truncated)
  if (truncated) projected.truncated = true
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

/** Injection-order queue view: legacy single slot first, then the array —
 * the SAME combined order the orchestrator drains and the desktop renders.
 * Index addressing for remote steerNow/remove uses this order. */
export function combinedQueuedPrompts(
  activeRound: EnsembleConfig['activeRound']
): string[] {
  if (!activeRound) return []
  return [
    ...(activeRound.queuedPrompt ? [activeRound.queuedPrompt] : []),
    ...(activeRound.queuedPrompts ?? [])
  ]
}

function queuedPromptCount(activeRound: EnsembleConfig['activeRound']): number {
  if (!activeRound) return 0
  const queuedPrompts = activeRound.queuedPrompts?.length ?? 0
  return queuedPrompts + (activeRound.queuedPrompt ? 1 : 0)
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
