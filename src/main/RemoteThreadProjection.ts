/**
 * 1.0.6-TV6 — RemoteThreadSnapshot projection (the iOS / Remote Console
 * contract).
 *
 * The Mac must project *bounded* transcript windows to a paired
 * iPhone/iPad, never a full chat dump (a long TaskWraith thread is many MB
 * of Ensemble rounds, tool traces, screenshots, diff cards). This pure,
 * renderer-free module is the seam the Remote Task Console (Codex's
 * R0–R12, task #198) builds against: given a thread's persisted
 * `messages` + `runs`, it returns a `RemoteThreadSnapshot` whose `rows`
 * are bounded *by construction* for every {@link RemoteProjectionMode}.
 *
 * Design contract (stable — Codex depends on it):
 *   - `threadId === appChatId` — the same id `BridgeRunEventSink`'s
 *     `extractThreadId` stamps on forwarded run events, so a snapshot
 *     and the live event stream address the same thread.
 *   - `row.id === message.id` — the persisted desktop message id, so a
 *     remote deep-link / "jump to row" resolves to the exact desktop
 *     row (the desktop side brings it in-window via TV4 `scrollToRow`).
 *   - Bounded: `latestN` caps to `n`, `aroundRow` to `2·radius+1`,
 *     `beforeRow` to `n`, `attention` to `maxAttentionRows`, `summaryOnly`
 *     to 0 rows.
 *   - Additive: this never replaces raw-event forwarding; the bridge
 *     emits a snapshot alongside the existing per-pair event fan-out.
 *
 * It is deliberately a sibling of `BridgeRunEventSink.ts` and imports
 * only `store/types`, so it stays unit-testable with no Electron / DOM
 * surface and no coupling to the renderer's `TranscriptVirtualWindow`.
 * The row-kind mapping mirrors that renderer module's classification so
 * a row's identity is consistent across desktop and remote.
 */

import type {
  BlackboardCategory,
  BlackboardEntry,
  BlackboardScope,
  ChatMessage,
  ChatRun,
  DiffFileStatus,
  DiffFileSummary,
  PooledAgentIdentitySnapshot,
  ProviderId,
  TranscriptMediaFormat,
  TranscriptMediaKind,
  TranscriptMediaSource,
  TranscriptMediaStatus,
  TranscriptMediaThumbnail,
  ToolActivity
} from './store/types'
import {
  createToolResultMediaRefs,
  extractMcpImageBlocksFromRawResult
} from './services/TranscriptMediaService'
import { isRetiredExternalChannelInboundMessage } from './LegacyExternalChannelHistory'
import { matchOllamaBrand } from '../shared/ollamaBrandTable'
import { TASKWRAITH_CLOSEOUT_KIND } from '../shared/taskWraithCloseout'
import {
  usageCacheCreationInputTokens,
  usageCacheReadInputTokens,
  usageInputIncludesCache
} from '../shared/usageAccounting'

export type RemoteDisplayCurrency = 'USD' | 'GBP' | 'EUR'

export interface RemoteCostDisplayOptions {
  currency?: RemoteDisplayCurrency
  overestimatePercent?: number
  fxRatesPerUsd?: Partial<Record<RemoteDisplayCurrency, number>>
  /** ProviderRateService snapshot or already-unwrapped rate table map. */
  providerRates?: unknown
}

/** Bounded preview size for routine iOS snapshot pushes — large enough
 * for most turns on a phone screen without blowing the relay frame budget. */
export const REMOTE_IOS_PREVIEW_MAX = 2400
/** Upper bound when the phone explicitly expands a clipped row. */
export const REMOTE_IOS_ROW_EXPAND_MAX = 32000
/** Routine thinking trace cap. The expand-row path lifts this to the row ceiling. */
export const REMOTE_IOS_THINKING_MAX = 4000
/** Per-run summaries carried for mobile completion cards. Needs to cover a
 * full 20-seat ensemble round plus nearby runs without making snapshots
 * unbounded. */
export const REMOTE_RUN_SUMMARY_MAX = 48
/** Keep individual thread-snapshot payloads well below the relay's 1 MB
 * WebSocket frame cap once JSON-RPC/envelope overhead is added. */
export const REMOTE_THREAD_SNAPSHOT_WIRE_MAX_BYTES = 600_000

const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama',
  antigravity: 'Antigravity'
}

const FALLBACK_FX_RATES_PER_USD: Record<RemoteDisplayCurrency, number> = {
  USD: 1,
  GBP: 0.79,
  EUR: 0.92
}

const COST_FLOORS: Record<RemoteDisplayCurrency, { threshold: number; label: string }> = {
  USD: { threshold: 0.01, label: '<$0.01' },
  GBP: { threshold: 0.01, label: '<£0.01' },
  EUR: { threshold: 0.01, label: '<€0.01' }
}

interface RemoteModelRate {
  modelId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
}

type RemoteProviderRates = Partial<Record<ProviderId, RemoteModelRate[]>>

interface RemoteUsageCounts {
  inputTokens: number
  billableInputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const DEFAULT_RATE_MODEL_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  codex: 'gpt-5.5',
  claude: 'claude-sonnet-5',
  gemini: 'gemini-3.1-flash-lite',
  kimi: 'kimi-k2.7-code',
  grok: 'grok-4.5',
  cursor: 'composer-2.5-fast',
  ollama: 'qwen3:4b-instruct'
}

const DEFAULT_MODEL_SENTINELS = new Set(['', 'default', 'cli-default', 'custom', 'best'])
const CODEX_DEFAULT_SENTINELS = new Set(['auto', 'pro', 'flash', 'flash-lite'])

function canonicalRateModelId(
  provider: ProviderId | undefined,
  model: string | undefined
): string {
  const trimmed = (model || '').trim()
  const key = trimmed.toLowerCase()
  const fallback = provider ? DEFAULT_RATE_MODEL_BY_PROVIDER[provider] : undefined
  if (!provider || !fallback) return trimmed
  if (DEFAULT_MODEL_SENTINELS.has(key)) return fallback
  if (provider === 'codex' && CODEX_DEFAULT_SENTINELS.has(key)) return fallback
  if (provider === 'gemini' && key === 'flash-lite') return fallback
  if (provider === 'grok' && (key === 'grok-build' || key === 'grok-build-0.1')) return fallback
  if (
    provider === 'cursor' &&
    (key === 'cursor-grok-4.5' || key.startsWith('grok-4.5-fast-') || key.startsWith('grok-4.5-'))
  ) {
    return 'grok-4.5'
  }
  return trimmed
}

function numberFromStats(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
  }
  return 0
}

function firstNumberFromStats(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = numberFromStats(source, key)
    if (value > 0) return value
  }
  return 0
}

function normalizeRemoteProviderRates(raw: unknown): RemoteProviderRates {
  if (!raw || typeof raw !== 'object') return {}
  const envelope = raw as Record<string, unknown>
  const tables =
    envelope.baseline && typeof envelope.baseline === 'object'
      ? (envelope.baseline as Record<string, unknown>)
      : envelope
  const out: RemoteProviderRates = {}
  for (const [provider, table] of Object.entries(tables)) {
    const models = Array.isArray(table)
      ? table
      : table && typeof table === 'object'
        ? (table as Record<string, unknown>).models
        : undefined
    if (!Array.isArray(models)) continue
    const entries: RemoteModelRate[] = []
    for (const model of models) {
      if (!model || typeof model !== 'object') continue
      const m = model as Record<string, unknown>
      if (
        typeof m.modelId === 'string' &&
        isFiniteNonNegative(m.inputUsdPerMillion) &&
        isFiniteNonNegative(m.outputUsdPerMillion)
      ) {
        const entry: RemoteModelRate = {
          modelId: m.modelId,
          inputUsdPerMillion: m.inputUsdPerMillion,
          outputUsdPerMillion: m.outputUsdPerMillion
        }
        if (
          isFiniteNonNegative(m.cachedInputUsdPerMillion) &&
          m.cachedInputUsdPerMillion < m.inputUsdPerMillion
        ) {
          entry.cachedInputUsdPerMillion = m.cachedInputUsdPerMillion
        }
        entries.push(entry)
      }
    }
    if (entries.length > 0) out[provider as ProviderId] = entries
  }
  return out
}

function resolveRemoteModelRate(
  rates: RemoteProviderRates,
  provider: ProviderId | undefined,
  model: string | undefined
): RemoteModelRate | null {
  if (!provider) return null
  const table = rates[provider]
  if (!table || table.length === 0) return null
  const wanted = canonicalRateModelId(provider, model).toLowerCase()
  if (wanted) {
    const exact = table.find((entry) => entry.modelId.toLowerCase() === wanted)
    if (exact) return exact
    const prefix = table.find((entry) => {
      const id = entry.modelId.toLowerCase()
      return wanted.startsWith(id) || id.startsWith(wanted)
    })
    if (prefix) return prefix
  }
  return table[0]
}

function clampOverestimate(percent: number | undefined): number {
  if (!Number.isFinite(percent ?? 0)) return 0
  return Math.max(0, Math.min(25, percent ?? 0))
}

function normaliseCurrency(currency: RemoteCostDisplayOptions['currency']): RemoteDisplayCurrency {
  return currency === 'GBP' || currency === 'EUR' ? currency : 'USD'
}

function formatRemoteCost(usd: number, display?: RemoteCostDisplayOptions): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  const currency = normaliseCurrency(display?.currency)
  const bias = clampOverestimate(display?.overestimatePercent)
  const biasedUsd = bias > 0 ? usd * (1 + bias / 100) : usd
  const configuredRate = display?.fxRatesPerUsd?.[currency]
  const rate =
    typeof configuredRate === 'number' && Number.isFinite(configuredRate) && configuredRate > 0
      ? configuredRate
      : FALLBACK_FX_RATES_PER_USD[currency]
  const converted = biasedUsd * rate
  const floor = COST_FLOORS[currency]
  if (converted < floor.threshold) return floor.label
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(converted)
  } catch {
    const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€'
    return `${symbol}${converted.toFixed(2)}`
  }
}

function extractRemoteUsageCounts(stats: Record<string, unknown>): RemoteUsageCounts {
  const inputBase = firstNumberFromStats(stats, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'input',
    'prompt'
  ])
  const inputAlreadyIncludesCache = usageInputIncludesCache(stats)
  const cacheReadInputTokens = usageCacheReadInputTokens(stats)
  const cacheCreationInputTokens = usageCacheCreationInputTokens(stats)
  const audioInputTokens = firstNumberFromStats(stats, ['input_audio_tokens', 'inputAudioTokens'])
  const outputTokens =
    firstNumberFromStats(stats, [
      'output_tokens',
      'outputTokens',
      'completion_tokens',
      'completionTokens',
      'output'
    ]) + firstNumberFromStats(stats, ['output_audio_tokens', 'outputAudioTokens'])
  const inputTokens = inputAlreadyIncludesCache
    ? inputBase
    : inputBase + cacheReadInputTokens + cacheCreationInputTokens + audioInputTokens
  const billableInputTokens = inputAlreadyIncludesCache
    ? Math.max(0, inputBase - cacheReadInputTokens - cacheCreationInputTokens)
    : inputBase + audioInputTokens
  const explicitTotal = firstNumberFromStats(stats, [
    'total_tokens',
    'totalTokens',
    'all_tokens',
    'total',
    'tokens'
  ])
  const totalTokens = explicitTotal > 0 ? explicitTotal : inputTokens + outputTokens

  return {
    inputTokens,
    billableInputTokens,
    outputTokens,
    totalTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens
  }
}

function estimateRemoteRunCostUsd(
  costDisplay: RemoteCostDisplayOptions | undefined,
  provider: ProviderId | undefined,
  model: string | undefined,
  usage: RemoteUsageCounts
): number {
  const rates = normalizeRemoteProviderRates(costDisplay?.providerRates)
  const rate = resolveRemoteModelRate(rates, provider, model)
  if (!rate) return 0
  const cachedInputRate = rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion
  const usd =
    (usage.billableInputTokens / 1_000_000) * rate.inputUsdPerMillion +
    (usage.cacheReadInputTokens / 1_000_000) * cachedInputRate +
    (usage.cacheCreationInputTokens / 1_000_000) * rate.inputUsdPerMillion +
    (usage.outputTokens / 1_000_000) * rate.outputUsdPerMillion
  return Number.isFinite(usd) && usd > 0 ? usd : 0
}

function shortModelLabel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 28) return trimmed
  const slash = trimmed.lastIndexOf('/')
  if (slash >= 0 && slash < trimmed.length - 1) {
    const tail = trimmed.slice(slash + 1).trim()
    if (tail.length > 0 && tail.length <= 28) return tail
  }
  return `${trimmed.slice(0, 25).trimEnd()}…`
}

/** Solo-chat speaker label — mirrors the desktop assistant header:
 * `Provider` or `Provider · Model` when the run/message carries one. */
export function soloSpeakerForMessage(
  chatProvider: ProviderId | undefined,
  runs: ChatRun[] | undefined
): (message: ChatMessage) => string | undefined {
  const runById = new Map(
    (Array.isArray(runs) ? runs : [])
      .filter((run) => run && typeof run.runId === 'string')
      .map((run) => [run.runId, run] as const)
  )
  return (message) => {
    if (message.role !== 'assistant' && message.role !== 'tool') return undefined
    if (message.metadata?.ensembleProvider) return undefined
    const provider =
      (message.metadata?.ensembleProvider as ProviderId | undefined) ?? chatProvider
    if (!provider) return undefined
    let label = PROVIDER_LABELS[provider] ?? provider
    const run = typeof message.runId === 'string' ? runById.get(message.runId) : undefined
    const model =
      (typeof message.metadata?.providerModel === 'string'
        ? message.metadata.providerModel
        : undefined) ||
      (typeof message.metadata?.ensembleModel === 'string'
        ? message.metadata.ensembleModel
        : undefined) ||
      run?.actualModel ||
      run?.requestedModel
    // Ollama-backed display brands spoof their upstream provider name on the
    // phone transcript header (e.g. "Alibaba · Qwen 3.5"), mirroring the
    // desktop assistant header so iOS reads as the same product.
    if (provider === 'ollama' && model) {
      const brand = matchOllamaBrand(model)
      if (brand) label = brand.providerLabel
    }
    if (model) {
      const short = shortModelLabel(model)
      return short ? `${label} · ${short}` : label
    }
    return label
  }
}

export function remoteSpeakerForMessage(
  chat: {
    provider?: ProviderId
    ensemble?: { enabled?: boolean; participants?: unknown }
    runs?: ChatRun[]
  },
  ensembleSpeaker?: (message: ChatMessage) => string | undefined
): (message: ChatMessage) => string | undefined {
  if (chat.ensemble?.enabled && ensembleSpeaker) return ensembleSpeaker
  return soloSpeakerForMessage(chat.provider, chat.runs)
}

export type RemoteProjectionMode =
  | { kind: 'latestN'; n: number }
  | { kind: 'beforeRow'; rowId: string; n: number }
  | { kind: 'aroundRow'; rowId: string; radius: number }
  | { kind: 'attention' }
  | { kind: 'summaryOnly' }

export type RemoteThreadRowKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'runBoundary'
  | 'system'
  | 'error'
  | 'attention'
  | 'summary'

export type RemoteAttentionKind = 'planChoice' | 'agentQuestion' | 'approval'

export interface RemoteToolEntry {
  /** Raw tool identifier for remote icon-family parity. `name` stays the
   * human-facing display label. */
  toolName?: string
  name: string
  category: 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'
  status: 'running' | 'success' | 'error'
  file?: string
  additions?: number
  deletions?: number
  detail?: string
}

export interface RemoteThinkingTrace {
  title: string
  preview: string
  truncated: boolean
  toolName?: string
  status?: 'running' | 'success' | 'error'
}

export interface RemoteParticipantHealthEntry {
  participantId: string
  provider: ProviderId
  /** Model id — lets the phone spoof the Ollama display brand (Qwen →
   * Alibaba) on the health chip, matching the desktop. */
  model?: string
  /** Frozen provider/brand label stamped when the round health card was written. */
  displayProviderLabel?: string
  /** Frozen hue class stamped when the round health card was written. */
  displayHueClass?: string
  role: string
  status: 'ok' | 'unreachable'
  reason?: string
  underlyingCode?: string
}

export interface RemoteParticipantHealthSummary {
  okCount: number
  totalCount: number
  entries: RemoteParticipantHealthEntry[]
}

export interface RemoteSubThreadReturnSummary {
  subThreadId?: string
  provider?: ProviderId
  title?: string
}

/** Structured identity for a mirrored guest-participant reply — lets remote
 * clients render the reply as a provider-tinted "Provider / Guest" bubble with
 * a model badge, matching the desktop guest-reply card. */
export interface RemoteGuestReplySummary {
  provider?: ProviderId
  role?: string
  model?: string
  guestChatId?: string
}

/** Structured Codex-style proposed-plan card — the desktop ProposedPlanCard's
 * persisted state (`metadata.proposedPlan`) projected for remote clients so the
 * phone renders the same inline collapsible plan card and can round-trip the
 * decision. The body is bounded INDEPENDENTLY of the row `preview` (which is the
 * already-block-stripped content) so a multi-paragraph plan isn't clipped to the
 * one-screen preview cap; `bodyTruncated` lets a client flag an over-long plan
 * rather than have the user approve a plan they can't fully read. */
export interface RemoteProposedPlan {
  title: string
  bodyPreview: string
  status: 'pending' | 'approved' | 'dismissed'
  artifactPath?: string
  bodyTruncated?: boolean
}

/** Structured `ask_user_question` prompt — the desktop AgentQuestionCard's data,
 * projected so the phone can render the question INLINE in the transcript
 * (anchored to its asking system message) instead of only in the top attention
 * banner. `promptId` === the registry questionId, so the inline card resolves the
 * SAME parked tool the banner does (the answer round-trip is unchanged — this
 * only moves the render home). The asking row also still carries `attention`
 * (kind 'agentQuestion') so older clients keep their banner. */
export interface RemoteAgentQuestion {
  promptId: string
  question: string
  options?: string[]
  context?: string
}

export interface RemoteThreadRowMedia {
  id: string
  kind: TranscriptMediaKind
  format: TranscriptMediaFormat
  source: TranscriptMediaSource
  name: string
  alt?: string
  caption?: string
  mimeType: string
  width?: number
  height?: number
  byteLength?: number
  /** Duration in ms for audio/video refs — projected so iOS can render an mm:ss label. */
  durationMs?: number
  /** Codec descriptor for AV refs, e.g. "h264,aac" (informational). */
  codecs?: string
  status?: TranscriptMediaStatus
  thumbnail?: TranscriptMediaThumbnail
}

export type RemotePooledAgentIdentity = PooledAgentIdentitySnapshot

export interface RemoteThreadRow {
  /** === desktop `message.id`, so remote deep-links resolve exactly. */
  id: string
  runId?: string
  /** Ensemble round this row belongs to, when projected from ensemble metadata. */
  ensembleRoundId?: string
  role: ChatMessage['role']
  kind: RemoteThreadRowKind
  /** Ensemble identity of the authoring participant — the SAME form the
   * desktop transcript tag uses minus the #pN handle:
   * `Provider / Role (Model)`, model included only on same-provider-
   * duplicate panels. Absent for solo chats and user rows, so remote
   * clients render "Agent"/"You" exactly like a solo desktop chat. */
  speaker?: string
  /** Frozen pooled-Agent display identity for this row, when the Mac transcript
   * message was authored by a saved Agent Pool participant. */
  pooledAgentIdentity?: RemotePooledAgentIdentity
  /** Images attached to this message (desktop file-picker or phone
   * uploads — both land in message.metadata.imagePaths). Count only;
   * remote clients render an attachment chip when no thumbnail is present. */
  imageAttachmentCount?: number
  /** Small base64 JPEG previews of the attached images, built Mac-side at
   * message creation. Remote clients can't read the Mac-local `imagePaths`,
   * so this is the only way they can show the actual image inline. Capped at
   * 2; absent for historical messages persisted before this field existed
   * (those fall back to `imageAttachmentCount`). */
  imageThumbnails?: Array<{
    dataBase64: string
    mimeType: string
    width?: number
    height?: number
  }>
  /** First-class transcript media projected from validated message metadata.
   * Carries only bounded thumbnail bytes; full media fetch is a separate
   * capability-gated bridge action. */
  media?: RemoteThreadRowMedia[]
  /** Bounded + sanitized one-screen preview of the row body. */
  preview: string
  /** True when `preview` was clipped from a longer body. */
  truncated: boolean
  /** Present for tool rows — compact stand-in for the ActivityStack. */
  toolSummary?: {
    activityCount: number
    status: 'running' | 'success' | 'error' | 'mixed'
    /** Per-tool detail (desktop activity-card parity): name, category,
     * status, the touched file, +/− diff stats for edits, and a clipped
     * result line. Capped at 12 entries; activityCount stays the truth. */
    tools?: RemoteToolEntry[]
  }
  /** Distinct bounded thinking/reasoning trace for mobile's expandable viewport.
   * Older clients still see the same activity inside `toolSummary`. */
  thinking?: RemoteThinkingTrace
  /** Structured ensemble pre-flight participant reachability summary. */
  participantHealth?: RemoteParticipantHealthSummary
  /** Structured metadata for returned TaskWraith sub-thread output. */
  subThreadReturn?: RemoteSubThreadReturnSummary
  /** Present for a mirrored guest-participant reply — the guest's identity so
   * remote clients render it inline like the desktop guest bubble. */
  guestReply?: RemoteGuestReplySummary
  /** Present for a Codex-style proposed plan awaiting (or carrying) a decision —
   * drives the inline collapsible plan card + approve/respond/dismiss on remote
   * clients, mirroring the desktop ProposedPlanCard. */
  proposedPlan?: RemoteProposedPlan
  /** Present on an ask_user_question asking message — drives the inline question
   * card (the same prompt the top attention banner shows) so remote clients can
   * answer it in place, matching the desktop AgentQuestionCard. */
  agentQuestion?: RemoteAgentQuestion
  /** Present for rows that need the user — drives the remote action UI. */
  attention?: {
    kind: RemoteAttentionKind
    promptPreview: string
  }
  timestamp: string
}

export interface RemoteRunSummary {
  runId: string
  /** Ensemble round this participant run belongs to. Used by remote clients
   * to render one completion card at the round boundary instead of one after
   * every participant turn. */
  ensembleRoundId?: string
  /** Ensemble participant identity for per-round token tables. */
  ensembleParticipantId?: string
  ensembleRole?: string
  ensembleOrder?: number
  provider?: string
  model?: string
  status?: string
  exitCode?: number
  startedAt?: string
  endedAt?: string
  durationMs?: number
  /** Best-effort token tally pulled from `run.stats` when present. */
  totalTokens?: number
  tokensIn?: number
  tokensOut?: number
  /** Pre-formatted cost line (e.g. "$0.45") when the run reported one. */
  costText?: string
  /** File-change counts pulled from `run.runDiff` when present. */
  fileChanges?: RemoteRunFileChangeCounts
}

export interface RemoteRunFileChangeCounts {
  filesChanged: number
  additions: number
  deletions: number
  createdFiles?: number
  modifiedFiles?: number
  deletedFiles?: number
  preExistingFiles?: number
  workspaceCount?: number
  workspaces?: RemoteRunWorkspaceFileChanges[]
  /** Bounded per-file rows (desktop File-changes card parity) — remote
   * clients render path + status + ±stats per run. Overflow is derivable
   * from `filesChanged - files.length`. */
  files?: RemoteRunChangedFile[]
}

export interface RemoteRunChangedFile {
  path: string
  status?: string
  additions?: number
  deletions?: number
}

export interface RemoteRunWorkspaceFileChanges {
  workspacePath?: string
  filesChanged: number
  additions: number
  deletions: number
  createdFiles?: number
  modifiedFiles?: number
  deletedFiles?: number
  preExistingFiles?: number
}

export interface RemoteBlackboardEntry {
  id: string
  key: string
  value: string
  category: BlackboardCategory
  scope: BlackboardScope
  participantId?: string
  roundId?: string
  createdAt?: string
  valueTruncated?: boolean
  originalLength?: number
}

export interface RemoteThreadSnapshot {
  /** appChatId — matches BridgeRunEventSink.extractThreadId. */
  threadId: string
  schemaVersion: 1
  mode: RemoteProjectionMode
  /** BOUNDED by `mode` — never the full history. */
  rows: RemoteThreadRow[]
  /** Total projectable rows in the thread (one per message). */
  totalRows: number
  /** Index into the full thread of `rows[0]` (0 for filtered modes). */
  windowStartIndex: number
  hasMoreAbove: boolean
  hasMoreBelow: boolean
  runSummary?: RemoteRunSummary
  /** Conversation-level spend estimate, summed across every run in the thread. */
  conversationCostUsd?: number
  conversationCostText?: string
  /** Settings-driven visibility for Task Complete / Final Summary cards. */
  showRunCompleteSummary?: boolean
  /** Thread notes (chat.pinnedNotes), clipped. */
  notes?: string
  /** Pinned messages (metadata.pinnedAt), newest first, capped — these may
   * fall OUTSIDE the latestN row window so they ship separately. */
  pinnedRows?: RemoteThreadRow[]
  /** Ensemble blackboard entries, category-grouped and capped. Future solo/guest
   * session-memory notes can reuse the same remote panel shape. */
  blackboardEntries?: RemoteBlackboardEntry[]
  /** Per-run summaries (oldest→newest, capped) — remote clients interleave
   * Task-complete cards after each run's last transcript row. */
  runSummaries?: RemoteRunSummary[]
  generatedAt: string
}

export interface RemoteProjectionOptions {
  /** Thread notes (chat.pinnedNotes) — projected onto snapshot.notes. */
  notes?: string
  /** Structured shared notes. Today this is `chat.ensemble.blackboard`;
   * later solo/guest chats can populate the same projection field. */
  blackboardEntries?: BlackboardEntry[]
  threadId: string
  mode: RemoteProjectionMode
  /** Max chars for `preview` / `promptPreview` (default 280). */
  previewMaxChars?: number
  /** Cap for `attention` mode (default 50). */
  maxAttentionRows?: number
  /**
   * Caller-supplied attention augment. The desktop surfaces plan
   * choices / pending approvals via transient state rather than a
   * persisted message marker; the bridge passes those message ids here
   * so the projection can flag them even before they carry metadata.
   * Auto-detected metadata markers are unioned with this set.
   */
  attentionRowIds?: ReadonlySet<string>
  /** Stable timestamp for `generatedAt` (tests pass a fixed value). */
  generatedAt?: string
  /** Currency-aware display options for run cost telemetry. */
  costDisplay?: RemoteCostDisplayOptions
  /** Settings-driven visibility for Task Complete / Final Summary cards. */
  showRunCompleteSummary?: boolean
  /** Ensemble speaker labeler — the bridge passes
   * `ensembleSpeakerForMessage(chat.ensemble.participants)` for ensemble
   * chats so each assistant row carries its participant identity. Solo
   * chats omit it (rows stay speaker-less). */
  speakerForMessage?: (message: ChatMessage) => string | undefined
  /** Single-provider fallback identity for rows that do not already carry
   * message-level pooled-agent metadata. Used by isolated side chats launched
   * from a pooled Agent participant. */
  pooledAgentIdentity?: PooledAgentIdentitySnapshot
}

const DEFAULT_PREVIEW_MAX = 280
const DEFAULT_MAX_ATTENTION_ROWS = 50
const REMOTE_BLACKBOARD_MAX_ENTRIES = 24
/** Cumulative caps (base64 chars) on attachment-thumbnail bytes shipped in
 * ONE snapshot. The relay drops frames over ~1MB (`maxFrameBytes`), so an
 * image-heavy thread could otherwise lose its entire snapshot. We keep
 * thumbnails on the most-recent rows (the just-sent image matters most) and
 * fall back to the count chip on older rows once the budget is spent. */
const MAX_SNAPSHOT_THUMBNAIL_BASE64 = 600_000
const MAX_PINNED_THUMBNAIL_BASE64 = 150_000

/** Drop `imageThumbnails` (keeping `imageAttachmentCount`) on the OLDEST rows
 * once the cumulative thumbnail payload would exceed `budget`. Walks
 * newest→oldest so recent attachments survive. Mutates + returns `rows`. */
function capRowThumbnails(
  rows: RemoteThreadRow[],
  budget = MAX_SNAPSHOT_THUMBNAIL_BASE64
): RemoteThreadRow[] {
  let remaining = budget
  for (let i = rows.length - 1; i >= 0; i--) {
    const thumbs = rows[i].imageThumbnails
    const mediaThumbs = rows[i].media?.map((media) => media.thumbnail).filter(Boolean) || []
    if (!thumbs?.length && mediaThumbs.length === 0) continue
    const cost =
      (thumbs || []).reduce((sum, t) => sum + (t.dataBase64?.length ?? 0), 0) +
      mediaThumbs.reduce((sum, t) => sum + (t?.dataBase64?.length ?? 0), 0)
    if (cost <= remaining) {
      remaining -= cost
    } else {
      delete rows[i].imageThumbnails
      if (rows[i].media?.length) {
        rows[i].media = rows[i].media?.map((media) => {
          if (!media.thumbnail) return media
          const { thumbnail: _thumbnail, ...rest } = media
          return rest
        })
      }
    }
  }
  return rows
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function rowWithTransportLeanFields(row: RemoteThreadRow, previewMax: number): RemoteThreadRow {
  const { imageThumbnails: _imageThumbnails, media, toolSummary, preview, truncated, ...rest } = row
  const clipped = preview.length > previewMax
  const lean: RemoteThreadRow = {
    ...rest,
    preview: clipped ? preview.slice(0, previewMax).trimEnd() : preview,
    truncated: truncated || clipped
  }
  if (media?.length) {
    lean.media = media.map(({ thumbnail: _thumbnail, ...item }) => item)
  }
  if (toolSummary) {
    const { tools: _tools, ...summary } = toolSummary
    lean.toolSummary = summary
  }
  return lean
}

function rowWithTransportSkeleton(row: RemoteThreadRow): RemoteThreadRow {
  const preview = row.preview.length > 240 ? row.preview.slice(0, 240).trimEnd() : row.preview
  return {
    id: row.id,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.ensembleRoundId ? { ensembleRoundId: row.ensembleRoundId } : {}),
    role: row.role,
    kind: row.kind,
    ...(row.speaker ? { speaker: row.speaker } : {}),
    ...(row.imageAttachmentCount ? { imageAttachmentCount: row.imageAttachmentCount } : {}),
    preview,
    truncated: row.truncated || preview.length < row.preview.length,
    timestamp: row.timestamp
  }
}

function trimOldestRowsForTransport<T extends RemoteThreadSnapshot>(
  snapshot: T,
  keepCount: number
): T {
  const rows = snapshot.rows.slice(-keepCount)
  const dropped = snapshot.rows.length - rows.length
  return {
    ...snapshot,
    rows,
    windowStartIndex: snapshot.windowStartIndex + Math.max(0, dropped),
    hasMoreAbove: snapshot.hasMoreAbove || dropped > 0
  }
}

export function fitRemoteThreadSnapshotToByteBudget<T extends RemoteThreadSnapshot>(
  snapshot: T,
  maxBytes = REMOTE_THREAD_SNAPSHOT_WIRE_MAX_BYTES
): T {
  if (jsonByteLength(snapshot) <= maxBytes) return snapshot

  const {
    notes: _notes,
    pinnedRows: _pinnedRows,
    blackboardEntries: _blackboardEntries,
    runSummaries: _runSummaries,
    ...withoutSidePanels
  } = snapshot
  let candidate = withoutSidePanels as T
  if (jsonByteLength(candidate) <= maxBytes) return candidate

  candidate = {
    ...candidate,
    rows: candidate.rows.map((row) => rowWithTransportLeanFields(row, 1200))
  }
  if (jsonByteLength(candidate) <= maxBytes) return candidate

  candidate = {
    ...candidate,
    rows: candidate.rows.map((row) => rowWithTransportLeanFields(row, 400))
  }
  while (candidate.rows.length > 1 && jsonByteLength(candidate) > maxBytes) {
    const keepCount = Math.max(1, Math.ceil(candidate.rows.length / 2))
    candidate = trimOldestRowsForTransport(candidate, keepCount)
  }
  if (jsonByteLength(candidate) <= maxBytes) return candidate

  const {
    runSummary: _runSummary,
    conversationCostText: _conversationCostText,
    conversationCostUsd: _conversationCostUsd,
    ...withoutSummary
  } = candidate
  candidate = {
    ...withoutSummary,
    rows: candidate.rows.map(rowWithTransportSkeleton)
  } as T
  while (candidate.rows.length > 1 && jsonByteLength(candidate) > maxBytes) {
    const keepCount = Math.max(1, Math.ceil(candidate.rows.length / 2))
    candidate = trimOldestRowsForTransport(candidate, keepCount)
  }
  if (jsonByteLength(candidate) <= maxBytes) return candidate

  return {
    ...withoutSummary,
    rows: [],
    windowStartIndex: snapshot.totalRows,
    hasMoreAbove: snapshot.totalRows > 0,
    hasMoreBelow: false
  } as unknown as T
}
const BLACKBOARD_CATEGORY_RANK: Record<BlackboardCategory, number> = {
  decision: 0,
  fact: 1,
  risk: 2,
  'do-not-repeat': 3,
  note: 4
}

/**
 * Collapse whitespace, strip control characters, and clip to `max`.
 * Returns the bounded preview plus whether it was truncated.
 */
export function sanitizePreview(
  raw: string | undefined,
  max: number = DEFAULT_PREVIEW_MAX
): { preview: string; truncated: boolean } {
  if (!raw) return { preview: '', truncated: false }
  // Replace C0 controls (incl. NUL), DEL, and C1 controls with a space —
  // EXCEPT newlines: line structure is what lets a remote client render
  // markdown blocks (headings/lists/fences/tables). Flattening to one
  // line shipped mashed paragraphs no renderer could recover.
  let cleaned = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (raw[i] === '\n') {
      cleaned += '\n'
    } else if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      cleaned += ' '
    } else {
      cleaned += raw[i]
    }
  }
  const collapsed = cleaned
    .replace(/[^\S\n]+/g, ' ') // collapse runs of spaces/tabs, keep newlines
    .replace(/ ?\n ?/g, '\n') // trim spaces hugging line breaks
    .replace(/\n{3,}/g, '\n\n') // cap blank-line runs
    .trim()
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_PREVIEW_MAX
  if (collapsed.length <= limit) return { preview: collapsed, truncated: false }
  return { preview: `${collapsed.slice(0, Math.max(0, limit - 3)).trimEnd()}...`, truncated: true }
}

function projectBlackboardEntries(entries: BlackboardEntry[] | undefined): RemoteBlackboardEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return []
  return entries
    .filter((entry) => typeof entry?.key === 'string' && typeof entry.value === 'string')
    .map((entry) => {
      const keySanitized = sanitizePreview(entry.key, 120)
      const valueSanitized = sanitizePreview(entry.value, 900)
      return {
        id: entry.id,
        key: keySanitized.preview,
        value: valueSanitized.preview,
        category: entry.category,
        scope: entry.scope,
        ...(entry.participantId
          ? { participantId: sanitizePreview(entry.participantId, 80).preview }
          : {}),
        ...(entry.roundId ? { roundId: entry.roundId } : {}),
        ...(entry.createdAt ? { createdAt: entry.createdAt } : {}),
        ...(valueSanitized.truncated
          ? { valueTruncated: true, originalLength: entry.value.length }
          : {})
      }
    })
    .filter((entry) => entry.key && entry.value)
    .sort((a, b) => {
      const rank = BLACKBOARD_CATEGORY_RANK[a.category] - BLACKBOARD_CATEGORY_RANK[b.category]
      if (rank !== 0) return rank
      return (b.createdAt || '').localeCompare(a.createdAt || '')
    })
    .slice(0, REMOTE_BLACKBOARD_MAX_ENTRIES)
}

/**
 * Map a message to its remote row kind. Mirrors the renderer's
 * `classifyRowType` ordering (sub-thread cards reuse system/tool roles
 * with a metadata `kind`, so they must be detected before the plain
 * role mapping). Attention overrides are applied separately by the
 * projector after this base classification.
 */
export function classifyRemoteKind(message: ChatMessage): RemoteThreadRowKind {
  const metaKind = message.metadata?.kind
  if (message.role === 'system' && metaKind === 'subThreadDelegation') return 'system'
  if (metaKind === 'subThreadReturn') return 'tool'
  // Guest replies render as an assistant-style (provider-tinted) bubble, NOT a
  // tool row — classifying them 'assistant' keeps remote clients from folding
  // them into adjacent tool groups or suppressing them mid-stream.
  if (metaKind === 'guestParticipantReply') return 'assistant'
  // Context-compaction cards degrade to a plain system row on the phone — the
  // message `content` carries the formatted "Context compacted · X → Y" summary.
  if (metaKind === 'contextCompaction') return 'system'
  if (message.role === 'tool') return 'tool'
  if (message.role === 'user') return 'user'
  if (message.role === 'error') return 'error'
  if (message.role === 'assistant') return 'assistant'
  return 'system'
}

/** Auto-detected attention from a message's own metadata. */
function detectMessageAttention(message: ChatMessage): RemoteAttentionKind | null {
  const metaKind = message.metadata?.kind
  if (message.role === 'system' && metaKind === 'agentQuestion') return 'agentQuestion'
  if (metaKind === 'planChoice') return 'planChoice'
  if (metaKind === 'approval' || metaKind === 'pendingApproval') return 'approval'
  return null
}

function buildToolSummary(message: ChatMessage): RemoteThreadRow['toolSummary'] | undefined {
  if (message.role !== 'tool') return undefined
  const activities = message.toolActivities || []
  if (activities.length === 0) return undefined
  let running = 0
  let success = 0
  let error = 0
  for (const a of activities) {
    if (a.status === 'running' || a.status === 'pending') running++
    else if (a.status === 'error') error++
    else success++
  }
  let status: 'running' | 'success' | 'error' | 'mixed'
  if (running > 0) status = 'running'
  else if (error > 0 && success > 0) status = 'mixed'
  else if (error > 0) status = 'error'
  else status = 'success'
  const tools: RemoteToolEntry[] = activities.slice(0, 12).map((activity) => {
    const singleDiffFile =
      Array.isArray(activity.diffSummary?.files) && activity.diffSummary.files.length === 1
        ? activity.diffSummary.files[0]
        : null
    const entry: RemoteToolEntry = {
      toolName: activity.toolName,
      name: activity.displayName || activity.toolName,
      category: activity.category ?? 'unknown',
      status:
        activity.status === 'running' || activity.status === 'pending'
          ? 'running'
          : activity.status === 'error'
            ? 'error'
            : 'success'
    }
    if (typeof activity.filePath === 'string' && activity.filePath) {
      entry.file = activity.filePath
    } else if (typeof singleDiffFile?.path === 'string' && singleDiffFile.path) {
      entry.file = singleDiffFile.path
    }
    if (typeof activity.diffSummary?.additions === 'number') {
      entry.additions = activity.diffSummary.additions
    } else if (typeof singleDiffFile?.additions === 'number') {
      entry.additions = singleDiffFile.additions
    }
    if (typeof activity.diffSummary?.deletions === 'number') {
      entry.deletions = activity.diffSummary.deletions
    } else if (typeof singleDiffFile?.deletions === 'number') {
      entry.deletions = singleDiffFile.deletions
    }
    // Desktop parity: an edit card is one line — "Edited <file> +N −M" —
    // with no result text underneath. Write entries that carry ± chips
    // drop their detail (often a raw MCP result envelope); everything
    // else keeps the one-line summary.
    const hasDiffChips =
      entry.category === 'write' && ((entry.additions ?? 0) > 0 || (entry.deletions ?? 0) > 0)
    const detail = activity.resultSummary?.trim()
    if (detail && !hasDiffChips) {
      entry.detail = detail.length > 90 ? `${detail.slice(0, 87).trimEnd()}...` : detail
    }
    return entry
  })
  return { activityCount: activities.length, status, tools }
}

function normalizedToolName(toolName: string | undefined): string {
  return (toolName || '').trim().toLowerCase().replace(/^mcp__[^_]+__/i, '')
}

function isThinkingTraceToolName(toolName: string | undefined): boolean {
  const name = normalizedToolName(toolName)
  return (
    name === 'thinking' ||
    name === 'reasoning' ||
    name.endsWith('_thinking') ||
    name.endsWith('_reasoning')
  )
}

function buildThinkingTrace(
  message: ChatMessage,
  previewMax: number
): RemoteThreadRow['thinking'] | undefined {
  if (message.role !== 'tool') return undefined
  const activities = (message.toolActivities || []).filter((entry) =>
    isThinkingTraceToolName(entry.toolName)
  )
  if (activities.length === 0) return undefined
  // Concatenate EVERY thinking segment in order. A turn that reasons between
  // tool calls emits several; taking only the last (`.slice(-1)`) silently
  // dropped all the earlier reasoning on iOS. Desktop renders each as its own
  // chronological segment — the phone still shows one merged viewport, but no
  // longer loses the earlier thinking. The 32k expand budget holds the full
  // trace when the row is expanded; collapsed rows truncate as before.
  const raw = activities
    .map((entry) => (entry.resultSummary || entry.outputPreview || '').trim())
    .filter(Boolean)
    .join('\n\n')
  if (!raw.trim()) return undefined
  const limit =
    previewMax >= REMOTE_IOS_ROW_EXPAND_MAX ? REMOTE_IOS_ROW_EXPAND_MAX : REMOTE_IOS_THINKING_MAX
  const { preview, truncated } = sanitizePreview(raw, limit)
  if (!preview) return undefined
  // Title/toolName from the latest segment (matches the single-segment case);
  // status aggregates so a still-streaming segment keeps the row "running".
  const last = activities[activities.length - 1]
  const status = activities.some((a) => a.status === 'running' || a.status === 'pending')
    ? 'running'
    : activities.some((a) => a.status === 'error')
      ? 'error'
      : 'success'
  return {
    title: last.displayName || 'Thinking',
    preview,
    truncated,
    toolName: last.toolName,
    status
  }
}

function stringField(value: unknown, max = 160): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return sanitizePreview(trimmed, max).preview
}

function providerField(value: unknown): ProviderId | undefined {
  if (typeof value !== 'string') return undefined
  const candidate = value.trim().toLowerCase()
  return candidate in PROVIDER_LABELS ? (candidate as ProviderId) : undefined
}

function normalizePooledAgentIdentity(
  raw: unknown,
  fallbackAgentId?: unknown
): RemotePooledAgentIdentity | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const agentId = stringField(fallbackAgentId, 160) ?? stringField(record.agentId, 160)
  const nickname = stringField(record.nickname, 80)
  const iconKind = record.iconKind
  const hue = Number(record.hue)
  if (
    !agentId ||
    !nickname ||
    !Number.isFinite(hue) ||
    (iconKind !== 'named' && iconKind !== 'seed' && iconKind !== 'asset')
  ) {
    return undefined
  }
  const identity: RemotePooledAgentIdentity = {
    schemaVersion: 1,
    agentId,
    nickname,
    iconKind,
    hue: ((Math.round(hue) % 360) + 360) % 360
  }
  const brightness = Number(record.brightness)
  if (Number.isFinite(brightness)) {
    identity.brightness = Math.max(0, Math.min(100, Math.round(brightness)))
  }
  const accent = stringField(record.accent, 24)
  if (accent) identity.accent = accent
  const slug = stringField(record.slug, 120)
  if (slug) identity.slug = slug
  const assetKey = stringField(record.assetKey, 180)
  if (assetKey) identity.assetKey = assetKey
  const seed = stringField(record.seed, 180)
  if (seed) identity.seed = seed
  if (typeof record.hueEnabled === 'boolean') identity.hueEnabled = record.hueEnabled
  return identity
}

function buildPooledAgentIdentity(
  metadata: Record<string, unknown> | undefined
): RemotePooledAgentIdentity | undefined {
  return normalizePooledAgentIdentity(metadata?.pooledAgentIdentity, metadata?.pooledAgentId)
}

function buildParticipantHealth(
  message: ChatMessage
): RemoteThreadRow['participantHealth'] | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined
  if (metadata?.kind !== 'ensembleParticipantHealth') return undefined
  const rawEntries = Array.isArray(metadata.entries) ? metadata.entries : []
  const entries: RemoteParticipantHealthEntry[] = rawEntries.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    const provider = providerField(entry.provider)
    if (!provider) return []
    const status = entry.status === 'ok' ? 'ok' : 'unreachable'
    const participantId =
      stringField(entry.participantId, 80) ?? `${provider}-${stringField(entry.role, 80) ?? index}`
    const healthEntry: RemoteParticipantHealthEntry = {
      participantId,
      provider,
      role: stringField(entry.role, 80) ?? PROVIDER_LABELS[provider],
      status
    }
    const model = stringField(entry.model, 120)
    if (model) healthEntry.model = model
    const displayProviderLabel = stringField(entry.displayProviderLabel, 80)
    if (displayProviderLabel) healthEntry.displayProviderLabel = displayProviderLabel
    const displayHueClass = stringField(entry.displayHueClass, 40)
    if (displayHueClass) healthEntry.displayHueClass = displayHueClass
    const reason = stringField(entry.reason, 220)
    if (reason) healthEntry.reason = reason
    const underlyingCode = stringField(entry.underlyingCode, 80)
    if (underlyingCode) healthEntry.underlyingCode = underlyingCode
    return [healthEntry]
  })
  if (entries.length === 0) return undefined
  const okCount =
    typeof metadata.okCount === 'number' && Number.isFinite(metadata.okCount)
      ? Math.max(0, Math.trunc(metadata.okCount))
      : entries.filter((entry) => entry.status === 'ok').length
  const totalCount =
    typeof metadata.totalCount === 'number' && Number.isFinite(metadata.totalCount)
      ? Math.max(entries.length, Math.trunc(metadata.totalCount))
      : entries.length
  return {
    okCount: Math.min(okCount, totalCount),
    totalCount,
    entries
  }
}

function subThreadReturnBody(content: string): string {
  const tagged = content.match(/<subthread_result(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/subthread_result>/)
  if (tagged) return tagged[1].trim()
  const lines = content.split(/\r?\n/)
  if (!lines[0]?.startsWith('↩ Result from ')) return content
  const bodyStart = lines[1]?.trim() === '' ? 2 : 1
  return lines.slice(bodyStart).join('\n').trimStart()
}

function buildSubThreadReturn(
  message: ChatMessage
): { summary: RemoteSubThreadReturnSummary; body: string } | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined
  if (metadata?.kind !== 'subThreadReturn') return undefined
  const summary: RemoteSubThreadReturnSummary = {}
  const subThreadId = stringField(metadata.subThreadId, 120)
  if (subThreadId) summary.subThreadId = subThreadId
  const provider = providerField(metadata.subThreadProvider)
  if (provider) summary.provider = provider
  const title = stringField(metadata.subThreadTitle, 160)
  if (title) summary.title = title
  return { summary, body: subThreadReturnBody(message.content || '') }
}

function buildGuestReply(
  message: ChatMessage
): { summary: RemoteGuestReplySummary; speaker?: string } | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined
  if (metadata?.kind !== 'guestParticipantReply') return undefined
  const summary: RemoteGuestReplySummary = {}
  const provider = providerField(metadata.guestProvider)
  if (provider) summary.provider = provider
  const role = stringField(metadata.guestRole, 60)
  if (role) summary.role = role
  const model = stringField(metadata.guestModel, 120)
  if (model) summary.model = model
  const guestChatId = stringField(metadata.guestChatId, 120)
  if (guestChatId) summary.guestChatId = guestChatId
  // Graceful-degradation speaker for the existing provider-tinted label path
  // ("Provider / Role"), so even clients without a dedicated guest card tint +
  // attribute the reply instead of rendering a bare "System" row.
  let speaker: string | undefined
  if (provider) {
    let label = PROVIDER_LABELS[provider] ?? provider
    if (provider === 'ollama' && model) {
      const brand = matchOllamaBrand(model)
      if (brand) label = brand.providerLabel
    }
    speaker = role ? `${label} / ${role}` : label
  }
  return { summary, speaker }
}

/** Generous body cap for a projected plan — large enough that the overwhelming
 * majority of plans ship whole, bounded so a runaway plan can't bloat the
 * snapshot. Over-long plans set `bodyTruncated` so the client can offer a full
 * fetch instead of approving blind. */
const REMOTE_PROPOSED_PLAN_BODY_MAX = 2000
const PROPOSED_PLAN_STATUSES = new Set(['pending', 'approved', 'dismissed'])

/**
 * Project a Codex-style proposed plan from `metadata.proposedPlan`.
 * PRESENCE-detected on the `proposedPlan` object itself — UNLIKE the
 * subThreadReturn/guestReply/health builders, the renderer never stamps a
 * `metadata.kind` for a proposed plan (App.tsx capture), so gating on `kind`
 * here would silently never fire. Ensemble chats never carry a plan (the
 * renderer refuses to capture one for chatKind 'ensemble'); the ensembleRoundId
 * guard keeps the two platforms from diverging even if a future path writes it.
 */
function buildProposedPlan(message: ChatMessage): RemoteProposedPlan | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined
  const raw = metadata?.proposedPlan
  if (!raw || typeof raw !== 'object') return undefined
  // Mirror the single writer: the renderer only ever stamps metadata.proposedPlan
  // on an assistant turn, so a plan blob on a tool/system/user row is malformed —
  // don't render a phantom card from it.
  if (message.role !== 'assistant') return undefined
  if (typeof metadata?.ensembleRoundId === 'string' && metadata.ensembleRoundId.trim()) {
    return undefined
  }
  const plan = raw as Record<string, unknown>
  const status = typeof plan.status === 'string' ? plan.status : undefined
  if (!status || !PROPOSED_PLAN_STATUSES.has(status)) return undefined
  const title = stringField(plan.title, 160)
  const bodyRaw = typeof plan.body === 'string' ? plan.body : ''
  const { preview: bodyPreview, truncated } = sanitizePreview(bodyRaw, REMOTE_PROPOSED_PLAN_BODY_MAX)
  // Neither a usable title nor a body — nothing worth a card.
  if (!title && !bodyPreview) return undefined
  const artifactPath = stringField(plan.artifactPath, 260)
  const result: RemoteProposedPlan = {
    title: title ?? 'Proposed plan',
    bodyPreview,
    status: status as RemoteProposedPlan['status']
  }
  if (artifactPath) result.artifactPath = artifactPath
  if (truncated) result.bodyTruncated = true
  return result
}

/**
 * Project an ask_user_question prompt from its asking message. The renderer
 * stamps `metadata.kind === 'agentQuestion'` (+ questionId / agentQuestion /
 * agentQuestionOptions / agentQuestionContext) ONLY on the asking SYSTEM message
 * (App.tsx capture), so gate on role==='system' && that kind. promptId is the
 * registry questionId — the inline card resolves the same parked tool the banner
 * does. Options are capped at 4 (the tool's ceiling).
 */
function buildAgentQuestion(message: ChatMessage): RemoteAgentQuestion | undefined {
  const metadata = message.metadata as Record<string, unknown> | undefined
  if (message.role !== 'system' || metadata?.kind !== 'agentQuestion') return undefined
  const promptId = typeof metadata.questionId === 'string' ? metadata.questionId.trim() : ''
  const question = stringField(metadata.agentQuestion, 600)
  if (!promptId || !question) return undefined
  const result: RemoteAgentQuestion = { promptId, question }
  const rawOptions = metadata.agentQuestionOptions
  if (Array.isArray(rawOptions)) {
    const options = rawOptions
      .map((option) => stringField(option, 200))
      .filter((option): option is string => Boolean(option))
      .slice(0, 4)
    if (options.length) result.options = options
  }
  const context = stringField(metadata.agentQuestionContext, 600)
  if (context) result.context = context
  return result
}

const REMOTE_MEDIA_SOURCES = new Set<TranscriptMediaSource>([
  'generated',
  'workspace_path',
  'upload',
  'tool_result'
])
const REMOTE_MEDIA_FORMATS = new Set<TranscriptMediaFormat>(['raster', 'svg', 'container'])
const REMOTE_MEDIA_KINDS = new Set<TranscriptMediaKind>(['image', 'audio', 'video'])
const REMOTE_MEDIA_STATUSES = new Set<TranscriptMediaStatus>([
  'available',
  'missing',
  'denied',
  'unsafe_svg',
  'too_large',
  'unsupported'
])
const REMOTE_THUMBNAIL_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const REMOTE_MEDIA_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
  // Audio/video (S0d) — projected so iOS shows a poster thumbnail (the poster
  // itself is still a raster image, gated by REMOTE_THUMBNAIL_MIME_TYPES). Real
  // playback fetch is S6; no path/bytes are carried to the phone here.
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'video/mp4',
  'video/quicktime',
  'video/webm'
])
const REMOTE_MAX_MEDIA_REFS_PER_ROW = 8
const REMOTE_MAX_MEDIA_THUMB_BASE64 = 180_000

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function validRemoteThumbnail(raw: unknown): TranscriptMediaThumbnail | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const dataBase64 = typeof record.dataBase64 === 'string' ? record.dataBase64 : ''
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.toLowerCase() : ''
  if (!dataBase64 || dataBase64.length > REMOTE_MAX_MEDIA_THUMB_BASE64) return undefined
  if (!REMOTE_THUMBNAIL_MIME_TYPES.has(mimeType)) return undefined
  const thumbnail: TranscriptMediaThumbnail = { dataBase64, mimeType }
  const width = positiveNumber(record.width)
  const height = positiveNumber(record.height)
  if (width !== undefined) thumbnail.width = width
  if (height !== undefined) thumbnail.height = height
  return thumbnail
}

function buildRowMedia(metadata: Record<string, unknown> | undefined): RemoteThreadRowMedia[] {
  const rawRefs = metadata?.mediaRefs
  if (!Array.isArray(rawRefs)) return []
  const media: RemoteThreadRowMedia[] = []
  for (const raw of rawRefs) {
    if (media.length >= REMOTE_MAX_MEDIA_REFS_PER_ROW) break
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const kind = record.kind as TranscriptMediaKind
    if (!REMOTE_MEDIA_KINDS.has(kind)) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim().toLowerCase() : ''
    const source = record.source as TranscriptMediaSource
    const format = record.format as TranscriptMediaFormat
    if (!id || !name || !REMOTE_MEDIA_SOURCES.has(source)) continue
    if (!REMOTE_MEDIA_FORMATS.has(format)) continue
    if (!REMOTE_MEDIA_MIME_TYPES.has(mimeType)) continue
    const status = record.status as TranscriptMediaStatus | undefined
    if (status !== undefined && !REMOTE_MEDIA_STATUSES.has(status)) continue
    const item: RemoteThreadRowMedia = {
      id,
      kind,
      format,
      source,
      name,
      mimeType,
      status: status || 'available'
    }
    const alt = typeof record.alt === 'string' ? record.alt.trim() : ''
    const caption = typeof record.caption === 'string' ? record.caption.trim() : ''
    const width = positiveNumber(record.width)
    const height = positiveNumber(record.height)
    const byteLength = positiveNumber(record.byteLength)
    const durationMs = positiveNumber(record.durationMs)
    const codecs = typeof record.codecs === 'string' ? record.codecs.trim().slice(0, 40) : ''
    const thumbnail = validRemoteThumbnail(record.thumbnail)
    if (alt) item.alt = alt
    if (caption) item.caption = caption
    if (width !== undefined) item.width = width
    if (height !== undefined) item.height = height
    if (byteLength !== undefined) item.byteLength = byteLength
    if (durationMs !== undefined) item.durationMs = durationMs
    if (codecs) item.codecs = codecs
    if (thumbnail) item.thumbnail = thumbnail
    media.push(item)
  }
  return media
}

function buildToolActivityMedia(message: ChatMessage): RemoteThreadRowMedia[] {
  if (!Array.isArray(message.toolActivities) || message.toolActivities.length === 0) return []
  const mediaRefs = message.toolActivities.flatMap((activity) => {
    const blocks = extractMcpImageBlocksFromRawResult(activity.rawResultEvent)
    if (blocks.length === 0) return []
    return createToolResultMediaRefs({
      messageId: `${message.id}:${activity.id}`,
      runId: message.runId,
      toolName: activity.displayName || activity.toolName,
      blocks,
      maxRefs: REMOTE_MAX_MEDIA_REFS_PER_ROW
    })
  })
  return buildRowMedia({ mediaRefs })
}

/** Seat identity for ensemble SYSTEM rows (participant yielded/skipped/failed
 * status codas, side messages, compaction notices). The orchestrator stamps
 * `ensembleProvider`/`ensembleRole` (and compaction's `displayParticipantLabel`)
 * at event time, so the label is FROZEN — a later seat rename does not rewrite
 * history, which is exactly the renamed-from identity iOS needs. Assistant rows
 * are untouched: the bridge's `ensembleSpeakerForMessage` resolver owns those
 * (it returns undefined for system rows, and the projectRemoteThread caller
 * never clears a speaker buildRow seeded). */
function ensembleSystemSeatLabel(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  if (!metadata) return undefined
  const frozen = stringField(metadata.displayParticipantLabel, 120)
  if (frozen) return frozen
  const provider = providerField(metadata.ensembleProvider)
  if (!provider) return undefined
  let label = PROVIDER_LABELS[provider]
  const model = stringField(metadata.ensembleModel, 120)
  if (provider === 'ollama' && model) {
    const brand = matchOllamaBrand(model)
    if (brand) label = brand.providerLabel
  }
  const role = stringField(metadata.ensembleRole, 80)
  return role ? `${label} / ${role}` : label
}

function buildRow(
  message: ChatMessage,
  previewMax: number,
  attentionKind: RemoteAttentionKind | null,
  fallbackPooledAgentIdentity?: RemotePooledAgentIdentity
): RemoteThreadRow {
  const subThreadReturn = buildSubThreadReturn(message)
  const guestReply = buildGuestReply(message)
  const { preview, truncated } = sanitizePreview(subThreadReturn?.body ?? message.content, previewMax)
  const row: RemoteThreadRow = {
    id: message.id,
    role: message.role,
    kind: attentionKind ? 'attention' : classifyRemoteKind(message),
    preview,
    truncated,
    timestamp: message.timestamp
  }
  if (typeof message.runId === 'string') row.runId = message.runId
  const metadata = message.metadata as Record<string, unknown> | undefined
  if (metadata?.kind === TASKWRAITH_CLOSEOUT_KIND) {
    row.speaker = 'TaskWraith'
    // Associate an ensemble-ROUND close-out with its round so the iOS
    // completion (Task-complete) card anchors AFTER the close-out, not before
    // it. A round close-out carries `closeoutRoundId` (not `ensembleRoundId`),
    // so it would otherwise project round-less; iOS anchors the card to the
    // round's last *tagged* row, and an untagged close-out then renders after
    // the card. Run-scoped close-outs already carry the run's `runId`, so they
    // are the run's last row and need no help here.
    if (typeof metadata.closeoutRoundId === 'string' && metadata.closeoutRoundId.trim()) {
      row.ensembleRoundId = metadata.closeoutRoundId.trim()
    }
  }
  const rowMedia = [...buildRowMedia(metadata), ...buildToolActivityMedia(message)].slice(
    0,
    REMOTE_MAX_MEDIA_REFS_PER_ROW
  )
  if (rowMedia.length > 0) {
    row.media = rowMedia
  }
  if (typeof metadata?.ensembleRoundId === 'string' && metadata.ensembleRoundId.trim()) {
    row.ensembleRoundId = metadata.ensembleRoundId
  }
  const pooledAgentIdentity =
    buildPooledAgentIdentity(metadata) ||
    ((message.role === 'assistant' || message.role === 'tool')
      ? fallbackPooledAgentIdentity
      : undefined)
  if (pooledAgentIdentity) {
    row.pooledAgentIdentity = pooledAgentIdentity
    row.speaker = pooledAgentIdentity.nickname
  }
  const imagePaths = metadata?.imagePaths
  if (Array.isArray(imagePaths) && imagePaths.length > 0) {
    row.imageAttachmentCount = imagePaths.length
  }
  const imageAttachments = metadata?.imageAttachments
  if (
    row.imageAttachmentCount === undefined &&
    Array.isArray(imageAttachments) &&
    imageAttachments.length > 0
  ) {
    row.imageAttachmentCount = imageAttachments.length
  }
  const imageThumbnails = metadata?.imageThumbnails
  if (Array.isArray(imageThumbnails) && imageThumbnails.length > 0) {
    const validThumbs = imageThumbnails
      .filter(
        (t): t is { dataBase64: string; mimeType: string; width?: number; height?: number } => {
          if (!t || typeof t !== 'object') return false
          const rec = t as Record<string, unknown>
          return typeof rec.dataBase64 === 'string' && rec.dataBase64.length > 0
        }
      )
      .slice(0, 2)
      .map((t) => ({
        dataBase64: t.dataBase64,
        mimeType: typeof t.mimeType === 'string' ? t.mimeType : 'image/jpeg',
        ...(typeof t.width === 'number' ? { width: t.width } : {}),
        ...(typeof t.height === 'number' ? { height: t.height } : {})
      }))
    if (validThumbs.length > 0) {
      row.imageThumbnails = validThumbs
      // Keep the count consistent even if only thumbnails were persisted.
      if (row.imageAttachmentCount === undefined) {
        row.imageAttachmentCount = validThumbs.length
      }
    }
  }
  if (rowMedia.length > 0) {
    if (row.imageAttachmentCount === undefined) {
      row.imageAttachmentCount = rowMedia.length
    }
    if (!row.imageThumbnails?.length) {
      const mediaThumbs = rowMedia
        .map((media) => media.thumbnail)
        .filter((thumb): thumb is TranscriptMediaThumbnail => Boolean(thumb))
        .slice(0, 2)
      if (mediaThumbs.length > 0) {
        row.imageThumbnails = mediaThumbs
      }
    }
  }
  const toolSummary = buildToolSummary(message)
  if (toolSummary) row.toolSummary = toolSummary
  const thinking = buildThinkingTrace(message, previewMax)
  if (thinking) row.thinking = thinking
  const participantHealth = buildParticipantHealth(message)
  if (participantHealth) row.participantHealth = participantHealth
  if (subThreadReturn) row.subThreadReturn = subThreadReturn.summary
  if (guestReply) {
    row.guestReply = guestReply.summary
    // soloSpeakerForMessage skips system rows, so the caller never sets a
    // speaker for a guest reply — seed it here (the caller only overwrites
    // when its own resolver returns a truthy speaker, never clears this).
    if (guestReply.speaker) row.speaker = guestReply.speaker
  }
  // C4 (iOS transcript parity): ensemble system rows (yielded/skipped/failed
  // status codas, side messages, compaction notices) carry seat identity in
  // metadata but previously projected speaker-less, so iOS rendered a generic
  // "System" header. Seed the frozen-at-stamp-time seat label; the closeout /
  // pooled-agent / guest speakers above win, and the caller's resolver never
  // clears a seeded speaker.
  if (!row.speaker && message.role === 'system') {
    const seatLabel = ensembleSystemSeatLabel(metadata)
    if (seatLabel) row.speaker = seatLabel
  }
  const proposedPlan = buildProposedPlan(message)
  if (proposedPlan) row.proposedPlan = proposedPlan
  const agentQuestion = buildAgentQuestion(message)
  if (agentQuestion) row.agentQuestion = agentQuestion
  if (attentionKind) {
    row.attention = {
      kind: attentionKind,
      promptPreview: sanitizePreview(message.content, previewMax).preview
    }
  }
  return row
}

function parseTime(value?: string): number {
  if (!value) return NaN
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : NaN
}

/** Best-effort run summary from the most recent run. */
export function buildRunSummary(
  runs: ChatRun[] | undefined,
  costDisplay?: RemoteCostDisplayOptions,
  messages?: ChatMessage[]
): RemoteRunSummary | undefined {
  if (!Array.isArray(runs) || runs.length === 0) return undefined
  const last = runs[runs.length - 1]
  // An ensemble round dispatches one run per participant (all sharing an
  // `ensembleRoundId`). The headline Task-complete card renders at the round
  // boundary, so it must reflect the WHOLE round — summed tokens/cost, unioned
  // file changes, the round's wall-clock span — not just whichever participant
  // finished last. Continuous ensembles (many rounds) made the last-only tally
  // badly understate the round.
  if (last && typeof last.ensembleRoundId === 'string' && last.ensembleRoundId) {
    const roundRuns = runs.filter(
      (run) => typeof run?.runId === 'string' && run.ensembleRoundId === last.ensembleRoundId
    )
    if (roundRuns.length > 1) {
      const aggregate = summarizeEnsembleRound(roundRuns, costDisplay, messages)
      if (aggregate) return aggregate
    }
  }
  return summarizeRun(last, costDisplay, messages)
}

/** Per-run projection — powers the per-run Task-complete cards. */
export function summarizeRun(
  run: ChatRun | undefined,
  costDisplay?: RemoteCostDisplayOptions,
  messages?: ChatMessage[]
): RemoteRunSummary | undefined {
  if (!run || typeof run.runId !== 'string') return undefined
  const summary: RemoteRunSummary = { runId: run.runId }
  if (run.ensembleRoundId) summary.ensembleRoundId = run.ensembleRoundId
  if (run.ensembleParticipantId) summary.ensembleParticipantId = run.ensembleParticipantId
  if (run.ensembleRole) summary.ensembleRole = run.ensembleRole
  if (typeof run.ensembleOrder === 'number' && Number.isFinite(run.ensembleOrder)) {
    summary.ensembleOrder = run.ensembleOrder
  }
  if (run.provider) summary.provider = run.provider
  const model = run.actualModel || run.requestedModel
  if (model) summary.model = model
  if (run.status) summary.status = run.status
  if (typeof run.exitCode === 'number') summary.exitCode = run.exitCode
  if (run.startedAt) summary.startedAt = run.startedAt
  if (run.endedAt) summary.endedAt = run.endedAt
  const started = parseTime(run.startedAt)
  const ended = parseTime(run.endedAt)
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    summary.durationMs = ended - started
  }
  // `stats` is loosely typed; pull token/cost telemetry where exposed
  // (canonical keys per the desktop usage aggregator: inputTokens /
  // outputTokens / totalTokens; cost via cost_usd / total_cost_usd).
  const stats = run.stats as Record<string, unknown> | undefined
  if (stats) {
    const usage = extractRemoteUsageCounts(stats)
    if (usage.inputTokens > 0) summary.tokensIn = usage.inputTokens
    if (usage.outputTokens > 0) summary.tokensOut = usage.outputTokens
    if (usage.totalTokens > 0) summary.totalTokens = usage.totalTokens
    const { usd: costUsd, estimated: costEstimated } = extractRunCostUsd(run, costDisplay)
    if (costUsd > 0) {
      const formatted = formatRemoteCost(costUsd, costDisplay)
      if (formatted) summary.costText = costEstimated ? `~${formatted}` : formatted
    }
  }
  const fileChanges = summarizeRunFileChanges(run, messages)
  if (fileChanges) summary.fileChanges = fileChanges
  return summary
}

/** Numeric run cost in USD + whether it was estimated (vs reported). Shared by
 * the per-run summary and the ensemble-round fold so costs can be summed before
 * formatting. Mirrors summarizeRun's cost logic exactly. */
function extractRunCostUsd(
  run: ChatRun | undefined,
  costDisplay?: RemoteCostDisplayOptions
): { usd: number; estimated: boolean } {
  if (!run) return { usd: 0, estimated: false }
  const stats = run.stats as Record<string, unknown> | undefined
  if (!stats) return { usd: 0, estimated: false }
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const v = stats[key]
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
    }
    return undefined
  }
  const explicit = num('cost_usd', 'total_cost_usd', 'costUsd', 'totalCostUsd')
  if (explicit !== undefined && explicit > 0) return { usd: explicit, estimated: false }
  const usage = extractRemoteUsageCounts(stats)
  const statsRateModel =
    typeof stats._taskwraith_cost_rate_model === 'string'
      ? stats._taskwraith_cost_rate_model.trim()
      : ''
  const model = statsRateModel || run.actualModel || run.requestedModel
  const estimated = estimateRemoteRunCostUsd(costDisplay, run.provider, model, usage)
  return estimated > 0 ? { usd: estimated, estimated: true } : { usd: 0, estimated: false }
}

function buildConversationCostSummary(
  runs: ChatRun[] | undefined,
  costDisplay?: RemoteCostDisplayOptions
): { usd: number; text: string; estimated: boolean } | undefined {
  if (!Array.isArray(runs) || runs.length === 0) return undefined
  let costUsd = 0
  let anyEstimated = false
  for (const run of runs) {
    const { usd, estimated } = extractRunCostUsd(run, costDisplay)
    if (usd <= 0) continue
    costUsd += usd
    if (estimated) anyEstimated = true
  }
  if (costUsd <= 0) return undefined
  const formatted = formatRemoteCost(costUsd, costDisplay)
  if (!formatted) return undefined
  return { usd: costUsd, text: anyEstimated ? `~${formatted}` : formatted, estimated: anyEstimated }
}

/** Fold every participant run of one ensemble round into a single headline
 * summary. Tokens and cost are SUMMED across participants, file changes are
 * UNIONED, and the duration spans the whole round (earliest start → latest
 * end). The round-boundary (last) run supplies the representative
 * runId/provider/model/status/exitCode. */
export function summarizeEnsembleRound(
  roundRuns: ChatRun[],
  costDisplay?: RemoteCostDisplayOptions,
  messages?: ChatMessage[]
): RemoteRunSummary | undefined {
  const perRun = roundRuns
    .map((run) => summarizeRun(run, costDisplay, messages))
    .filter((entry): entry is RemoteRunSummary => Boolean(entry))
  if (perRun.length === 0) return undefined
  const base = summarizeRun(roundRuns[roundRuns.length - 1], costDisplay, messages)
  if (!base) return undefined
  const summary: RemoteRunSummary = { ...base }

  // Summed token tallies across every participant.
  const sumTokens = (key: 'tokensIn' | 'tokensOut' | 'totalTokens'): number =>
    perRun.reduce((acc, entry) => acc + (typeof entry[key] === 'number' ? entry[key]! : 0), 0)
  const tokensIn = sumTokens('tokensIn')
  const tokensOut = sumTokens('tokensOut')
  const totalTokens = sumTokens('totalTokens')
  if (tokensIn > 0) summary.tokensIn = tokensIn
  else delete summary.tokensIn
  if (tokensOut > 0) summary.tokensOut = tokensOut
  else delete summary.tokensOut
  if (totalTokens > 0) summary.totalTokens = totalTokens
  else delete summary.totalTokens

  // Summed cost (numeric, formatted once). "~" if ANY participant was estimated.
  let costUsd = 0
  let anyEstimated = false
  for (const run of roundRuns) {
    const { usd, estimated } = extractRunCostUsd(run, costDisplay)
    if (usd > 0) {
      costUsd += usd
      if (estimated) anyEstimated = true
    }
  }
  if (costUsd > 0) {
    const formatted = formatRemoteCost(costUsd, costDisplay)
    if (formatted) summary.costText = anyEstimated ? `~${formatted}` : formatted
    else delete summary.costText
  } else {
    delete summary.costText
  }

  // Wall-clock span across the round.
  let minStart = Number.POSITIVE_INFINITY
  let maxEnd = Number.NEGATIVE_INFINITY
  let minStartStr: string | undefined
  let maxEndStr: string | undefined
  for (const run of roundRuns) {
    const started = parseTime(run.startedAt)
    const ended = parseTime(run.endedAt)
    if (Number.isFinite(started) && started < minStart) {
      minStart = started
      minStartStr = run.startedAt
    }
    if (Number.isFinite(ended) && ended > maxEnd) {
      maxEnd = ended
      maxEndStr = run.endedAt
    }
  }
  if (minStartStr) summary.startedAt = minStartStr
  if (maxEndStr) summary.endedAt = maxEndStr
  if (Number.isFinite(minStart) && Number.isFinite(maxEnd) && maxEnd >= minStart) {
    summary.durationMs = maxEnd - minStart
  } else {
    delete summary.durationMs
  }

  // Unioned file changes across participants.
  const merged = mergeEnsembleFileChanges(
    perRun
      .map((entry) => entry.fileChanges)
      .filter((entry): entry is RemoteRunFileChangeCounts => Boolean(entry))
  )
  if (merged) summary.fileChanges = merged
  else delete summary.fileChanges

  return summary
}

/** Union per-participant file-change tallies for an ensemble round: per-file
 * rows dedupe by path (churn from the same file across participants folds into
 * one row with summed ±), per-workspace rows dedupe by workspacePath, and the
 * scalar counts sum. */
function mergeEnsembleFileChanges(
  parts: RemoteRunFileChangeCounts[]
): RemoteRunFileChangeCounts | undefined {
  if (parts.length === 0) return undefined
  const sumKey = (key: keyof RemoteRunFileChangeCounts): number =>
    parts.reduce((acc, part) => acc + (typeof part[key] === 'number' ? (part[key] as number) : 0), 0)
  const sumOptional = (key: keyof RemoteRunFileChangeCounts): number | undefined => {
    let total = 0
    let present = false
    for (const part of parts) {
      const v = part[key]
      if (typeof v === 'number') {
        total += v
        present = true
      }
    }
    return present ? total : undefined
  }

  const fileByPath = new Map<string, RemoteRunChangedFile>()
  for (const part of parts) {
    for (const file of part.files ?? []) {
      const existing = fileByPath.get(file.path)
      if (!existing) {
        fileByPath.set(file.path, { ...file })
      } else {
        if (typeof file.additions === 'number') {
          existing.additions = (existing.additions ?? 0) + file.additions
        }
        if (typeof file.deletions === 'number') {
          existing.deletions = (existing.deletions ?? 0) + file.deletions
        }
        if (!existing.status && file.status) existing.status = file.status
      }
    }
  }

  const workspaceByPath = new Map<string, RemoteRunWorkspaceFileChanges>()
  for (const part of parts) {
    for (const workspace of part.workspaces ?? []) {
      const key = workspace.workspacePath ?? ''
      const existing = workspaceByPath.get(key)
      if (!existing) {
        workspaceByPath.set(key, { ...workspace })
      } else {
        existing.filesChanged += workspace.filesChanged
        existing.additions += workspace.additions
        existing.deletions += workspace.deletions
        const addOpt = (a?: number, b?: number): number | undefined =>
          a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
        existing.createdFiles = addOpt(existing.createdFiles, workspace.createdFiles)
        existing.modifiedFiles = addOpt(existing.modifiedFiles, workspace.modifiedFiles)
        existing.deletedFiles = addOpt(existing.deletedFiles, workspace.deletedFiles)
        existing.preExistingFiles = addOpt(existing.preExistingFiles, workspace.preExistingFiles)
      }
    }
  }

  const merged: RemoteRunFileChangeCounts = {
    // Unique files across the round when per-file rows are present; otherwise
    // fall back to the summed per-run counts.
    filesChanged: fileByPath.size > 0 ? fileByPath.size : sumKey('filesChanged'),
    additions: sumKey('additions'),
    deletions: sumKey('deletions')
  }
  const createdFiles = sumOptional('createdFiles')
  if (createdFiles !== undefined) merged.createdFiles = createdFiles
  const modifiedFiles = sumOptional('modifiedFiles')
  if (modifiedFiles !== undefined) merged.modifiedFiles = modifiedFiles
  const deletedFiles = sumOptional('deletedFiles')
  if (deletedFiles !== undefined) merged.deletedFiles = deletedFiles
  const preExistingFiles = sumOptional('preExistingFiles')
  if (preExistingFiles !== undefined) merged.preExistingFiles = preExistingFiles
  if (fileByPath.size > 0) merged.files = [...fileByPath.values()]
  if (workspaceByPath.size > 0) {
    merged.workspaces = [...workspaceByPath.values()]
    merged.workspaceCount = workspaceByPath.size
  }
  return merged
}

function summarizeRunFileChanges(
  run: ChatRun,
  messages?: ChatMessage[]
): RemoteRunSummary['fileChanges'] | undefined {
  const workspaces: RemoteRunWorkspaceFileChanges[] = []
  const changedFiles: DiffFileSummary[] = []
  const primaryPath = primaryRunDiffWorkspacePath(run)
  if (isRunDiffResult(run.runDiff)) {
    workspaces.push(summarizeRunDiffFiles(run.runDiff, primaryPath))
    changedFiles.push(
      ...safeDiffList(run.runDiff.createdFiles),
      ...safeDiffList(run.runDiff.modifiedFiles),
      ...safeDiffList(run.runDiff.deletedFiles)
    )
  }
  const byPath = run.runDiffByPath ?? {}
  for (const [workspacePath, files] of Object.entries(byPath)) {
    if (!Array.isArray(files)) continue
    if (primaryPath && workspacePath === primaryPath) continue
    workspaces.push(summarizeDiffFileList(files, workspacePath))
    changedFiles.push(...files)
  }
  if (workspaces.length > 0) {
    const total = workspaces.reduce<RemoteRunFileChangeCounts>(
      (acc, workspace) => {
        acc.filesChanged += workspace.filesChanged
        acc.additions += workspace.additions
        acc.deletions += workspace.deletions
        acc.createdFiles = (acc.createdFiles ?? 0) + (workspace.createdFiles ?? 0)
        acc.modifiedFiles = (acc.modifiedFiles ?? 0) + (workspace.modifiedFiles ?? 0)
        acc.deletedFiles = (acc.deletedFiles ?? 0) + (workspace.deletedFiles ?? 0)
        acc.preExistingFiles = (acc.preExistingFiles ?? 0) + (workspace.preExistingFiles ?? 0)
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
      } satisfies RemoteRunFileChangeCounts
    )
    total.workspaceCount = workspaces.length
    total.workspaces = workspaces
    if (changedFiles.length > 0) total.files = boundRunChangedFiles(changedFiles)
    return total
  }

  // Legacy records from before RunDiffResult used aggregate fields.
  const legacy = run.runDiff as
    | { filesChanged?: number; additions?: number; deletions?: number; files?: unknown[] }
    | undefined
  if (!legacy) return summarizeRunToolFileChanges(run, messages)
  const filesChanged =
    typeof legacy.filesChanged === 'number'
      ? legacy.filesChanged
      : Array.isArray(legacy.files)
        ? legacy.files.length
        : 0
  return {
    filesChanged,
    additions: typeof legacy.additions === 'number' ? legacy.additions : 0,
    deletions: typeof legacy.deletions === 'number' ? legacy.deletions : 0
  }
}

const TOOL_FILE_STATUS_PRIORITY: Record<DiffFileStatus, number> = {
  created: 3,
  deleted: 2,
  renamed: 1,
  modified: 0,
  untracked: 0,
  binary: 0,
  too_large: 0,
  hidden_sensitive: 0,
  noise: 0
}

function normalizeToolFileStatus(
  raw: string | undefined,
  fallback: DiffFileStatus
): DiffFileStatus {
  const value = (raw || '').toLowerCase()
  if (value === 'add' || value === 'create' || value === 'created' || value === 'new') {
    return 'created'
  }
  if (value === 'delete' || value === 'deleted' || value === 'remove' || value === 'removed') {
    return 'deleted'
  }
  if (value === 'rename' || value === 'renamed') return 'renamed'
  if (
    value === 'modify' ||
    value === 'modified' ||
    value === 'edit' ||
    value === 'update' ||
    value === 'updated' ||
    value === 'unknown'
  ) {
    return 'modified'
  }
  return value in TOOL_FILE_STATUS_PRIORITY ? (value as DiffFileStatus) : fallback
}

function isDeleteToolName(toolName: string | undefined): boolean {
  const value = (toolName || '').toLowerCase()
  return (
    value === 'delete_file' ||
    value === 'deletefile' ||
    value === 'delete_path' ||
    value === 'deletepath' ||
    value.endsWith('__delete_file') ||
    value.endsWith('__delete_path')
  )
}

function toolNameFallbackStatus(toolName: string | undefined): DiffFileStatus {
  const value = (toolName || '').toLowerCase()
  if (isDeleteToolName(value)) return 'deleted'
  if (value.includes('create') || value === 'write_file' || value.endsWith('__write_file')) {
    return 'created'
  }
  return 'modified'
}

function reconcileToolFileStatus(
  status: DiffFileStatus,
  fallbackStatus: DiffFileStatus,
  diffSource: NonNullable<ToolActivity['diffSummary']>['source'] | undefined
): DiffFileStatus {
  if (status !== 'deleted') return status
  if (fallbackStatus === 'deleted' || diffSource === 'patch_preview') return 'deleted'
  return 'modified'
}

function toolStringField(record: Record<string, unknown> | undefined, keys: string[]): string {
  if (!record) return ''
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeToolPath(path: string): string {
  return path.trim().replace(/\\/g, '/')
}

function mergeOptionalCount(lhs: number | undefined, rhs: number | undefined): number | undefined {
  if (rhs === undefined) return lhs
  if (lhs === undefined) return rhs
  return lhs + rhs
}

function mergeToolStatus(lhs: DiffFileStatus | undefined, rhs: DiffFileStatus): DiffFileStatus {
  if (!lhs) return rhs
  return (TOOL_FILE_STATUS_PRIORITY[rhs] ?? 0) > (TOOL_FILE_STATUS_PRIORITY[lhs] ?? 0)
    ? rhs
    : lhs
}

function addToolFileChange(
  changes: Map<string, DiffFileSummary>,
  input: {
    path: string
    status: DiffFileStatus
    additions?: number
    deletions?: number
  }
): void {
  const path = normalizeToolPath(input.path)
  if (!path) return
  const existing = changes.get(path)
  changes.set(path, {
    path,
    status: mergeToolStatus(existing?.status, input.status),
    additions: mergeOptionalCount(existing?.additions, input.additions),
    deletions: mergeOptionalCount(existing?.deletions, input.deletions),
    previewKind: 'none'
  })
}

function summarizeRunToolFileChanges(
  run: ChatRun,
  messages?: ChatMessage[]
): RemoteRunSummary['fileChanges'] | undefined {
  if (!run.runId || !Array.isArray(messages) || messages.length === 0) return undefined
  const changes = new Map<string, DiffFileSummary>()

  for (const message of messages) {
    if (message.runId !== run.runId) continue
    for (const activity of message.toolActivities ?? []) {
      addActivityFileChanges(changes, activity)
    }
  }

  const files = Array.from(changes.values()).filter((file) => file.status !== 'noise')
  if (files.length === 0) return undefined
  return {
    filesChanged: files.length,
    additions: sumDiffFiles(files, 'additions'),
    deletions: sumDiffFiles(files, 'deletions'),
    createdFiles: files.filter((file) => file.status === 'created' || file.status === 'untracked')
      .length,
    modifiedFiles: files.filter(
      (file) => file.status !== 'created' && file.status !== 'untracked' && file.status !== 'deleted'
    ).length,
    deletedFiles: files.filter((file) => file.status === 'deleted').length,
    files: boundRunChangedFiles(files)
  }
}

function addActivityFileChanges(
  changes: Map<string, DiffFileSummary>,
  activity: ToolActivity
): void {
  if (!activity || activity.status === 'error') return
  const fallbackStatus = toolNameFallbackStatus(activity.toolName)
  const fallbackPath =
    activity.filePath ||
    activity.affectedFilePath ||
    toolStringField(activity.parameters, [
      'file_path',
      'filePath',
      'path',
      'target',
      'target_file',
      'target_file_path'
    ])

  const files = activity.diffSummary?.files
  if (Array.isArray(files) && files.length > 0) {
    for (const file of files) {
      const path = typeof file.path === 'string' && file.path.trim() ? file.path : fallbackPath
      if (!path) continue
      const status = normalizeToolFileStatus(file.status, fallbackStatus)
      addToolFileChange(changes, {
        path,
        status: reconcileToolFileStatus(status, fallbackStatus, activity.diffSummary?.source),
        additions: typeof file.additions === 'number' ? file.additions : undefined,
        deletions: typeof file.deletions === 'number' ? file.deletions : undefined
      })
    }
    return
  }

  if (!fallbackPath || (activity.category !== 'write' && !activity.diffSummary)) return
  addToolFileChange(changes, {
    path: fallbackPath,
    status: fallbackStatus,
    additions:
      typeof activity.diffSummary?.additions === 'number'
        ? activity.diffSummary.additions
        : undefined,
    deletions:
      typeof activity.diffSummary?.deletions === 'number'
        ? activity.diffSummary.deletions
        : undefined
  })
}

function isRunDiffResult(value: ChatRun['runDiff']): value is NonNullable<ChatRun['runDiff']> {
  return Boolean(
    value &&
    Array.isArray(value.createdFiles) &&
    Array.isArray(value.modifiedFiles) &&
    Array.isArray(value.deletedFiles) &&
    Array.isArray(value.preExistingFiles)
  )
}

function summarizeRunDiffFiles(
  runDiff: NonNullable<ChatRun['runDiff']>,
  workspacePath: string | undefined
): RemoteRunWorkspaceFileChanges {
  const changedFiles = [
    ...safeDiffList(runDiff.createdFiles),
    ...safeDiffList(runDiff.modifiedFiles),
    ...safeDiffList(runDiff.deletedFiles)
  ]
  const summary: RemoteRunWorkspaceFileChanges = {
    filesChanged: changedFiles.length,
    additions: sumDiffFiles(changedFiles, 'additions'),
    deletions: sumDiffFiles(changedFiles, 'deletions'),
    createdFiles: safeDiffList(runDiff.createdFiles).length,
    modifiedFiles: safeDiffList(runDiff.modifiedFiles).length,
    deletedFiles: safeDiffList(runDiff.deletedFiles).length,
    preExistingFiles: safeDiffList(runDiff.preExistingFiles).length
  }
  if (workspacePath) summary.workspacePath = workspacePath
  return summary
}

function summarizeDiffFileList(
  files: DiffFileSummary[],
  workspacePath: string
): RemoteRunWorkspaceFileChanges {
  let createdFiles = 0
  let modifiedFiles = 0
  let deletedFiles = 0
  for (const file of files) {
    if (file.status === 'created' || file.status === 'untracked') createdFiles++
    else if (file.status === 'deleted') deletedFiles++
    else modifiedFiles++
  }
  const summary: RemoteRunWorkspaceFileChanges = {
    filesChanged: files.length,
    additions: sumDiffFiles(files, 'additions'),
    deletions: sumDiffFiles(files, 'deletions'),
    createdFiles,
    modifiedFiles,
    deletedFiles,
    preExistingFiles: 0
  }
  if (workspacePath) summary.workspacePath = workspacePath
  return summary
}

function safeDiffList(files: DiffFileSummary[] | undefined): DiffFileSummary[] {
  return Array.isArray(files) ? files : []
}

/** Clip the per-run file list for the wire: 12 rows (desktop card cap),
 * lean fields only, long paths tail-preserved (remote clients head-truncate). */
function boundRunChangedFiles(files: DiffFileSummary[]): RemoteRunChangedFile[] {
  return files.slice(0, 12).map((file) => ({
    path: file.path.length > 200 ? `…${file.path.slice(-199)}` : file.path,
    ...(file.status ? { status: file.status } : {}),
    ...(typeof file.additions === 'number' ? { additions: file.additions } : {}),
    ...(typeof file.deletions === 'number' ? { deletions: file.deletions } : {})
  }))
}

function sumDiffFiles(files: DiffFileSummary[], key: 'additions' | 'deletions'): number {
  return files.reduce((total, file) => total + (file[key] ?? 0), 0)
}

function primaryRunDiffWorkspacePath(run: ChatRun): string | undefined {
  return (
    run.runDiff?.postSnapshot?.workspacePath ||
    run.runDiff?.preSnapshot?.workspacePath ||
    run.effectiveWorkspacePath
  )
}

function clampIndex(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(value)))
}

/**
 * True only for a plain assistant text bubble carrying NO structured payload —
 * the one row kind safe to fold as a duplicate restatement. Mirrors buildRow's
 * structure detection exactly so a row with a tool card, sub-thread return,
 * guest reply, image, health badge, or attention flag is never collapsed.
 */
function isPlainAssistantTextMessage(
  message: ChatMessage,
  attentionFor: (m: ChatMessage) => RemoteAttentionKind | null
): boolean {
  if (message.role !== 'assistant') return false
  if (classifyRemoteKind(message) !== 'assistant') return false
  if (attentionFor(message)) return false
  if (buildToolSummary(message)) return false
  if (buildSubThreadReturn(message)) return false
  if (buildGuestReply(message)) return false
  if (buildParticipantHealth(message)) return false
  if (buildProposedPlan(message)) return false
  const md = message.metadata as Record<string, unknown> | undefined
  const imagePaths = md?.imagePaths
  if (Array.isArray(imagePaths) && imagePaths.length > 0) return false
  const imageThumbnails = md?.imageThumbnails
  if (Array.isArray(imageThumbnails) && imageThumbnails.length > 0) return false
  const mediaRefs = md?.mediaRefs
  if (Array.isArray(mediaRefs) && mediaRefs.length > 0) return false
  return true
}

/**
 * Collapse runs of CONSECUTIVE byte-identical assistant restatements from the
 * SAME speaker into a single row (keeping the first). An ensemble participant
 * stuck in a continuation loop — e.g. repeatedly calling `ensemble_continue`
 * with no new work — persists the same reply as N separate messages (one per
 * round), which the remote projection would otherwise fan out into N identical
 * bubbles. The desktop concatenates these into one bubble; this gives every
 * remote client the same hygiene. Deliberately conservative: only adjacent,
 * same-speaker, exact-content (full text, not the truncated preview),
 * structure-free, non-attention assistant rows fold — anything with a tool
 * call, diff, sub-thread return, guest reply, image, or distinct text survives.
 * Keeping the FIRST occurrence means the surviving id is stable, so a client
 * anchoring an aroundRow/beforeRow window never references a dropped row.
 */
export function collapseConsecutiveAssistantRestatements(
  messages: ChatMessage[],
  speakerFor: (m: ChatMessage) => string | undefined,
  attentionFor: (m: ChatMessage) => RemoteAttentionKind | null
): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    const prev = out[out.length - 1]
    if (
      prev &&
      isPlainAssistantTextMessage(prev, attentionFor) &&
      isPlainAssistantTextMessage(message, attentionFor) &&
      speakerFor(prev) === speakerFor(message)
    ) {
      const a = (prev.content ?? '').trim()
      const b = (message.content ?? '').trim()
      if (a.length > 0 && a === b) {
        continue // identical restatement — keep the first, drop this one
      }
    }
    out.push(message)
  }
  return out
}

/**
 * Project a thread's messages + runs into a bounded snapshot for the
 * Remote Console. Pure: same inputs → same output (pass `generatedAt`
 * for determinism). Never returns more rows than the mode allows.
 */
export function projectRemoteThread(
  messages: ChatMessage[],
  runs: ChatRun[] | undefined,
  opts: RemoteProjectionOptions
): RemoteThreadSnapshot {
  const all = Array.isArray(messages)
    ? messages.filter(
        (m) => m && typeof m.id === 'string' && !isRetiredExternalChannelInboundMessage(m)
      )
    : []
  const previewMax = opts.previewMaxChars ?? DEFAULT_PREVIEW_MAX
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const fallbackPooledAgentIdentity = normalizePooledAgentIdentity(opts.pooledAgentIdentity)
  const runSummary = buildRunSummary(runs, opts.costDisplay, all)
  const conversationCost = buildConversationCostSummary(runs, opts.costDisplay)
  const runSummaries = (runs ?? [])
    .slice(-REMOTE_RUN_SUMMARY_MAX)
    .map((run) => summarizeRun(run, opts.costDisplay, all))
    .filter((entry): entry is RemoteRunSummary => Boolean(entry))
  const blackboardEntries = projectBlackboardEntries(opts.blackboardEntries)
  const pinnedRows = capRowThumbnails(
    all
      .filter(
        (message) =>
          typeof (message.metadata as Record<string, unknown> | undefined)?.pinnedAt === 'number'
      )
      .sort(
        (a, b) =>
          Number((b.metadata as Record<string, unknown>).pinnedAt) -
          Number((a.metadata as Record<string, unknown>).pinnedAt)
      )
      .slice(0, 12)
      .map((message) => buildRow(message, previewMax, null, fallbackPooledAgentIdentity)),
    MAX_PINNED_THUMBNAIL_BASE64
  )

  const attentionFor = (message: ChatMessage): RemoteAttentionKind | null => {
    const detected = detectMessageAttention(message)
    if (detected) return detected
    if (opts.attentionRowIds?.has(message.id)) return 'agentQuestion'
    return null
  }

  // Fold consecutive identical assistant restatements (an ensemble continuation
  // loop persists the same reply once per round) before any windowing — so
  // totalRows and the window indices below all describe the collapsed view the
  // client actually sees. Pinned rows + run summaries above intentionally stay
  // on the raw `all` (the user may have pinned a specific occurrence, and run
  // summaries resolve their own run→message associations).
  const visible = collapseConsecutiveAssistantRestatements(
    all,
    (m) => opts.speakerForMessage?.(m),
    attentionFor
  )
  const totalRows = visible.length

  // The single most-recent assistant reply rides at full length (up to the
  // Show-more ceiling) so a just-finished answer doesn't visibly shrink to a
  // short preview the instant it settles. Exactly ONE row per snapshot is
  // enlarged (bounded payload growth); older long messages still collapse
  // behind "Show more". Resolved off `visible` — the collapse keeps the FIRST
  // of a run of identical restatements, so that id is the one the client
  // actually renders. Scoped to the routine `latestN` push: `aroundRow`/
  // `beforeRow` are targeted fetches whose caller sets the cap deliberately
  // (e.g. Show-more sends its own 32000), and the latest reply never falls in
  // a `beforeRow` (load-older) window — so the bump belongs only here.
  let latestAssistantRowId: string | null = null
  if (opts.mode.kind === 'latestN') {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      if (visible[i]?.role === 'assistant') {
        latestAssistantRowId = visible[i].id
        break
      }
    }
  }

  const toRow = (message: ChatMessage, att: RemoteAttentionKind | null): RemoteThreadRow => {
    const rowPreviewMax =
      message.id === latestAssistantRowId
        ? Math.max(previewMax, REMOTE_IOS_ROW_EXPAND_MAX)
        : previewMax
    const row = buildRow(message, rowPreviewMax, att, fallbackPooledAgentIdentity)
    const speaker = row.pooledAgentIdentity?.nickname || opts.speakerForMessage?.(message)
    if (speaker) row.speaker = speaker
    return row
  }

  const base = {
    threadId: opts.threadId,
    schemaVersion: 1 as const,
    mode: opts.mode,
    totalRows,
    generatedAt,
    ...(runSummary ? { runSummary } : {}),
    ...(conversationCost
      ? {
          conversationCostUsd: conversationCost.usd,
          conversationCostText: conversationCost.text
        }
      : {}),
    showRunCompleteSummary: opts.showRunCompleteSummary !== false,
    ...(typeof opts.notes === 'string' && opts.notes.trim()
      ? { notes: sanitizePreview(opts.notes, 4000).preview }
      : {}),
    ...(blackboardEntries.length > 0 ? { blackboardEntries } : {}),
    ...(pinnedRows.length > 0 ? { pinnedRows } : {}),
    ...(runSummaries.length > 0 ? { runSummaries } : {})
  }

  if (opts.mode.kind === 'summaryOnly') {
    return {
      ...base,
      rows: [],
      windowStartIndex: totalRows,
      hasMoreAbove: totalRows > 0,
      hasMoreBelow: false
    }
  }

  if (opts.mode.kind === 'attention') {
    const cap = opts.maxAttentionRows ?? DEFAULT_MAX_ATTENTION_ROWS
    const rows: RemoteThreadRow[] = []
    let matched = 0
    for (const message of visible) {
      const att = attentionFor(message)
      if (!att) continue
      matched++
      if (rows.length < cap) rows.push(toRow(message, att))
    }
    return {
      ...base,
      rows,
      windowStartIndex: 0,
      hasMoreAbove: false,
      hasMoreBelow: matched > rows.length
    }
  }

  if (opts.mode.kind === 'aroundRow') {
    const { rowId, radius: rawRadius } = opts.mode
    const radius = clampIndex(rawRadius, 0, totalRows)
    const targetIndex = visible.findIndex((m) => m.id === rowId)
    if (targetIndex < 0) {
      // Unknown row → empty window anchored at the end; the caller can
      // fall back to latestN.
      return {
        ...base,
        rows: [],
        windowStartIndex: totalRows,
        hasMoreAbove: totalRows > 0,
        hasMoreBelow: false
      }
    }
    const start = clampIndex(targetIndex - radius, 0, totalRows)
    const end = clampIndex(targetIndex + radius + 1, start, totalRows)
    const slice = visible.slice(start, end)
    return {
      ...base,
      rows: capRowThumbnails(slice.map((m) => toRow(m, attentionFor(m)))),
      windowStartIndex: start,
      hasMoreAbove: start > 0,
      hasMoreBelow: end < totalRows
    }
  }

  if (opts.mode.kind === 'beforeRow') {
    const { rowId, n: rawN } = opts.mode
    const n = clampIndex(rawN, 0, totalRows)
    const targetIndex = visible.findIndex((m) => m.id === rowId)
    if (targetIndex < 0) {
      return {
        ...base,
        rows: [],
        windowStartIndex: totalRows,
        hasMoreAbove: totalRows > 0,
        hasMoreBelow: false
      }
    }
    const start = clampIndex(targetIndex - n, 0, totalRows)
    const end = clampIndex(targetIndex, start, totalRows)
    const slice = visible.slice(start, end)
    return {
      ...base,
      rows: capRowThumbnails(slice.map((m) => toRow(m, attentionFor(m)))),
      windowStartIndex: start,
      hasMoreAbove: start > 0,
      hasMoreBelow: end < totalRows
    }
  }

  // latestN
  const n = clampIndex(opts.mode.n, 0, totalRows)
  const start = Math.max(0, totalRows - n)
  const slice = visible.slice(start)
  return {
    ...base,
    rows: capRowThumbnails(slice.map((m) => toRow(m, attentionFor(m)))),
    windowStartIndex: start,
    hasMoreAbove: start > 0,
    hasMoreBelow: false
  }
}
