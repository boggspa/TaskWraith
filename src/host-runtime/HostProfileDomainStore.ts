/**
 * Lease-gated, Node-only durable profile domain store.
 *
 * The caller acquires HostProfileAuthorityLease. This store nevertheless
 * invokes `assertProfileAuthority` before every profile-backed operation so a
 * released/stale lease cannot accidentally continue serving mutable profile
 * state. Files use private modes, no-follow reads, bounded JSON, and atomic
 * temp/fsync/rename publication.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'

import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest,
  HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../shared/ensembleLimits'
import { isEnsembleRoundDispatchLive } from '../shared/ensembleRoundLifecycle'

export const HOST_PROFILE_WORKSPACES_FILENAME = 'workspaces.json'
export const HOST_PROFILE_CHATS_DIRECTORY = 'chats'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_WORKSPACES_BYTES = 4 * 1024 * 1024
const MAX_CHAT_BYTES = 64 * 1024 * 1024
const MAX_TEXT = 16_000
/** Preview length the Host projection has always published. */
const MAX_THREAD_PREVIEW = 2_000
/**
 * Summary bytes `listThreadSummaries()` keeps resident.
 *
 * WHY A CACHE EXISTS AT ALL. The summary sweep runs once per second from
 * HostProjectionReconciler's snapshot capture, and again from the run ports on
 * every run start. Without a cache each of those passes re-read and re-parsed
 * the WHOLE chat corpus. Measured 2026-08-29 on a real 448-record /
 * 832MB profile: 689MB of JSON.parse per pass, ~4.9s of blocking work on a 1s
 * timer, 69.5% Host CPU. The event loop was saturated, so client handshakes
 * lost against both the 5s server handshake deadline and the 6.25s client
 * connect budget — Ensemble rounds failed with "Timed out connecting to the
 * TaskWraith Host" and TUI/iOS clients reconnected in a storm. The scan was
 * the cause; every timeout was a symptom.
 *
 * WHY IT IS BOUNDED. A summary is ~5% of its record (689.4MB of records ->
 * 32.1MB of summaries, measured over 446 real chats), so a fixed budget this
 * size covers a corpus many times larger than any profile seen in the wild
 * while still refusing to grow without limit. Whatever does not fit costs
 * exactly what it costs today, so the cache is never worse than no cache.
 *
 * The budget deliberately does NOT scale with machine memory any more. It did
 * while whole records were held, because full coverage then cost ~870MB and
 * a partial cache was worse than none on both axes — the tail that did not fit
 * was re-parsed and discarded every second, keeping the collector hot. At 5%
 * of that, one number covers everyone.
 */
const DEFAULT_THREAD_CACHE_MAX_BYTES = 256 * 1024 * 1024

export interface HostProfileAuthorityPort {
  assertProfileAuthority(): void
}

export interface HostProfileWorkspace {
  readonly id: string
  readonly path: string
  readonly realPath: string
  readonly displayName?: string
  readonly pinned: boolean
  readonly updatedAt: number
  readonly [key: string]: unknown
}

export interface HostProfileThread {
  readonly appChatId: string
  readonly scope: 'global' | 'workspace'
  readonly workspaceId?: string
  readonly workspacePath?: string
  readonly title: string
  readonly provider?: string
  readonly providerMetadata?: Record<string, unknown>
  readonly workflowMode?: 'normal' | 'plan'
  readonly archived: boolean
  readonly pinned?: boolean
  readonly messages: readonly HostProfileMessage[]
  readonly runs?: readonly HostProfileRun[]
  readonly updatedAt: number
  readonly persistenceRevision?: number
  readonly [key: string]: unknown
}

export interface HostProfileMessage {
  readonly id: string
  /** Exact provider-run identity when the message was produced by a Host run. */
  readonly runId?: string
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'error'
  readonly content: string
  readonly timestamp: string
}

export interface HostProfileRun {
  readonly runId: string
  readonly provider?: string
  readonly status?: string
  readonly phase?: 'starting' | 'streaming' | 'cancelling'
  readonly startedAt?: string
  readonly endedAt?: string
  readonly requestedModel?: string
  readonly providerSessionId?: string
  readonly usage?: HostProfileRunUsage
  readonly warningSummaries?: readonly string[]
  readonly errorCode?: 'provider_setup_unavailable' | 'provider_launch_failed' | 'provider_failed'
}

export interface HostProfileRunUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly estimatedCostUsd?: number
}

/**
 * A chat record without its transcript.
 *
 * This is what the Host projection and the run ports actually consume, and on
 * a real profile it is 5% of the record by bytes: measured 2026-08-29 over 446
 * chats, 689.4MB of records summarize to 32.1MB. Holding these instead of
 * whole records is what lets the reconciler's cache cover an entire corpus on
 * any machine rather than only a large one.
 *
 * Everything the record carried survives except `messages`; the two fields the
 * transcript was being read FOR are derived here once, at decode time.
 */
export interface HostProfileThreadSummary {
  readonly appChatId: string
  readonly scope: 'global' | 'workspace'
  readonly workspaceId?: string
  readonly workspacePath?: string
  readonly title: string
  readonly provider?: string
  readonly providerMetadata?: Record<string, unknown>
  readonly workflowMode?: 'normal' | 'plan'
  readonly archived: boolean
  readonly pinned?: boolean
  readonly runs?: readonly HostProfileRun[]
  readonly updatedAt: number
  readonly persistenceRevision?: number
  /** `messages.length`, so no caller needs the array in order to count it. */
  readonly messageCount: number
  /** Newest terminal-safe user/assistant/system message content, bounded. */
  readonly latestPreview?: string
  readonly [key: string]: unknown
}

/** One thread summary held against the exact file that produced it. */
interface CachedThreadSummary {
  /** dev/ino/mtime/size/mode of the file this summary was derived from. */
  readonly identity: string
  /** Summary bytes, so eviction can be budgeted against what is held. */
  readonly bytes: number
  /** Write clock, used for eviction order. Never access order — see admit. */
  readonly mtimeNs: bigint
  readonly summary: HostProfileThreadSummary
}

export interface HostProfileDomainStoreOptions {
  readonly profilePath: string
  readonly authority: HostProfileAuthorityPort
  readonly now?: () => number
  readonly idFactory?: () => string
  /** Fault seam after durable temp fsync and before authoritative rename. */
  readonly beforeAtomicPublish?: (targetPath: string) => void
  /** Called once per newly quarantined thread. This layer carries no logger, so
   *  a skipped record is announced through the caller — without it the skip is
   *  as silent as the whole-Host failure it replaced. */
  readonly onThreadQuarantined?: (threadId: string, reason: 'record-too-large') => void
  /** Summary bytes `listThreadSummaries()` may hold resident. Measured on the
   *  summaries themselves rather than on the records they came from, since the
   *  transcript is 95% of a record and none of it is held. 0 disables the cache
   *  and restores the uncached full re-read. */
  readonly threadCacheMaxBytes?: number
}

type StoredEnsembleParticipant = Record<string, unknown> & {
  id: string
  provider: string
  enabled: boolean
  role: string
  instructions: string
  order: number
}

type StoredEnsembleConfig = Record<string, unknown> & {
  participants: StoredEnsembleParticipant[]
}

const HOST_ENSEMBLE_COMPANIONS = [
  {
    provider: 'claude',
    role: 'Claude',
    instructions: 'Explore the request, identify constraints, and propose the safest path forward.',
    model: 'claude-sonnet-5'
  },
  {
    provider: 'codex',
    role: 'Codex',
    instructions: 'Implement concrete code or workflow changes when the round calls for action.',
    model: 'gpt-5.5'
  },
  {
    provider: 'kimi',
    role: 'Kimi',
    instructions: 'Review prior responses for gaps, edge cases, and test coverage.',
    model: 'kimi-k2.7-code'
  },
  {
    provider: 'grok',
    role: 'Grok',
    instructions: 'Stress-test assumptions, failure modes, and simpler alternatives.',
    model: 'grok-4.6'
  },
  {
    provider: 'ollama',
    role: 'Local',
    instructions:
      'Provide a local second opinion for summaries, triage, and small reasoning tasks.',
    model: 'qwen3.5:9b'
  }
] as const

function storedParticipant(value: unknown): StoredEnsembleParticipant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    !safeId(candidate.id) ||
    !safeId(candidate.provider) ||
    typeof candidate.enabled !== 'boolean' ||
    !safeText(candidate.role, 200) ||
    typeof candidate.instructions !== 'string' ||
    !Number.isSafeInteger(candidate.order)
  ) {
    return null
  }
  return candidate as StoredEnsembleParticipant
}

function storedEnsemble(value: unknown): StoredEnsembleConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.participants) || candidate.participants.length === 0) return null
  const participants = candidate.participants.map(storedParticipant)
  if (participants.some((participant) => participant === null)) return null
  return {
    ...candidate,
    participants: participants as StoredEnsembleParticipant[]
  }
}

function resetStoredParticipantSession(
  participant: StoredEnsembleParticipant
): StoredEnsembleParticipant {
  const {
    taskWraithMcpProfileReceipt: _dropMcpProfileReceipt,
    kimiAcpPostureVersion: _dropKimiPosture,
    promptShellVersion: _dropPromptShell,
    promptDynamicStateVersion: _dropPromptState,
    ...rest
  } = participant
  return {
    ...rest,
    linkedProviderSessionId: null
  }
}

function approvalModeForParticipant(participant: StoredEnsembleParticipant): string {
  switch (participant.permissionPresetId) {
    case 'read_only':
    case 'plan':
      return 'plan'
    case 'workspace_write':
    case 'full_access':
      return 'auto_edit'
    default:
      return 'default'
  }
}

function canonicalParticipantMetadata(
  participant: StoredEnsembleParticipant
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    approvalMode: approvalModeForParticipant(participant)
  }
  if (typeof participant.model === 'string' && participant.model.length > 0) {
    metadata.selectedModelType = participant.model
  }
  if (participant.permissionPresetId === 'plan') metadata.workflowMode = 'plan'
  if (typeof participant.runtimeProfileId === 'string') {
    metadata.runtimeProfileId = participant.runtimeProfileId
  }
  const effort = typeof participant.reasoningEffort === 'string' ? participant.reasoningEffort : ''
  const fast = participant.fastModeEnabled === true
  switch (participant.provider) {
    case 'codex':
      metadata.codexReasoningEffort = effort || 'medium'
      metadata.codexServiceTier =
        typeof participant.serviceTier === 'string' ? participant.serviceTier : fast ? 'fast' : ''
      break
    case 'claude':
      metadata.claudeReasoningEffort = effort || 'medium'
      metadata.claudeFastMode = fast
      break
    case 'kimi':
      metadata.kimiFastMode = fast
      metadata.kimiReasoningEffort = effort || 'on'
      metadata.kimiThinkingEnabled = participant.thinkingEnabled !== false
      break
    case 'grok':
      metadata.grokReasoningEffort = effort
      break
    case 'muse':
      metadata.museReasoningEffort = effort
      break
    case 'mistral':
      metadata.mistralReasoningEffort = effort
      break
    case 'pi':
      metadata.piReasoningEffort = effort
      break
    case 'ollama':
      metadata.ollamaReasoningEffort = effort
      break
    case 'cursor':
      metadata.cursorReasoningEffort = effort
      metadata.cursorFastMode = fast
      break
    case 'antigravity':
      metadata.antigravityReasoningEffort = effort || null
      metadata.antigravityUltraTaskSelected = effort.trim().toLowerCase() === 'ultratask'
      break
  }
  return metadata
}

function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- profile IDs cannot carry terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function safeText(value: unknown, max = MAX_TEXT): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function safeCanonicalIso(value: unknown): value is string {
  if (!safeText(value, 80)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function safeRunUsage(value: unknown): value is HostProfileRunUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  const allowed = new Set([
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'estimatedCostUsd'
  ])
  for (const [key, amount] of Object.entries(value)) {
    if (!allowed.has(key) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      return false
    }
  }
  return true
}

function sameRunUsage(
  left: HostProfileRunUsage | undefined,
  right: HostProfileRunUsage | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function sameWarningSummaries(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function assertPrivateRegular(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe profile file: ${path}`)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Profile file is not owner-only: ${path}`)
  }
}

/**
 * Newest message a terminal can render, scanning back past tool rows.
 *
 * It lives here rather than in the projection because the store is the only
 * layer that reads transcripts, and deriving it once at decode time is what
 * lets every caller downstream work from a summary. Role is checked before
 * the character scan: a multi-megabyte tool result must not be walked just to
 * discover it was never a candidate. Reverse index rather than
 * `[...messages].reverse()`, which copied a 19,000-entry array per thread.
 */
function threadPreview(messages: readonly HostProfileMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
      continue
    }
    if (message.content.length === 0) continue
    const terminalSafe = [...message.content].every((character) => {
      const code = character.charCodeAt(0)
      return code === 0x09 || code === 0x0a || code === 0x0d || (code > 0x1f && code !== 0x7f)
    })
    if (terminalSafe) return message.content.slice(0, MAX_THREAD_PREVIEW)
  }
  return undefined
}

function summarizeThread(thread: HostProfileThread): HostProfileThreadSummary {
  const { messages, ...rest } = thread
  const preview = threadPreview(messages)
  return {
    ...rest,
    messageCount: messages.length,
    ...(preview === undefined ? {} : { latestPreview: preview })
  }
}

function readOptionalJson(path: string, maxBytes: number): unknown | null {
  try {
    assertPrivateRegular(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const before = lstatSync(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes) {
      throw new Error(`Unsafe profile file: ${path}`)
    }
    if (String(opened.ino) !== String(before.ino) || String(opened.dev) !== String(before.dev)) {
      throw new Error(`Profile file changed while opening: ${path}`)
    }
    const raw = readFileSync(fd, 'utf8')
    const after = lstatSync(path)
    if (
      String(after.ino) !== String(before.ino) ||
      String(after.dev) !== String(before.dev) ||
      after.size !== opened.size
    ) {
      throw new Error(`Profile file changed while reading: ${path}`)
    }
    return JSON.parse(raw)
  } finally {
    closeSync(fd)
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicJson(
  path: string,
  value: unknown,
  maxBytes: number,
  beforePublish?: (targetPath: string) => void
): void {
  const parent = dirname(path)
  const targetExists = existsSync(path)
  if (targetExists) assertPrivateRegular(path)
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const body = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(body, 'utf8') > maxBytes)
    throw new Error('Profile document exceeds capacity')
  let fd: number | null = null
  let published = false
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      PRIVATE_FILE_MODE
    )
    fchmodSync(fd, PRIVATE_FILE_MODE)
    writeFileSync(fd, body, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    beforePublish?.(path)
    renameSync(temp, path)
    published = true
    if (process.platform !== 'win32') {
      const verified = lstatSync(path)
      if (!verified.isFile() || verified.isSymbolicLink())
        throw new Error('Unsafe published profile file')
    }
    fsyncDirectory(parent)
  } finally {
    if (fd !== null) closeSync(fd)
    if (!published) {
      try {
        unlinkSync(temp)
      } catch {
        // An orphan O_EXCL temp is never authoritative.
      }
    }
  }
}

function assertProfilePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('Profile path must be absolute')
  const resolved = resolve(path)
  if (resolved === parse(resolved).root) throw new Error('Profile path must not be filesystem root')
  const canonical = realpathSync(resolved)
  const stat = lstatSync(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Profile path is unsafe')
  return canonical
}

function decodeWorkspace(value: unknown): HostProfileWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid workspace')
  const item = value as Record<string, unknown>
  if (!safeId(item.id) || !safeText(item.path)) {
    throw new Error('Invalid workspace')
  }
  if (item.displayName !== undefined && !safeText(item.displayName, 200))
    throw new Error('Invalid workspace')
  const realPath = safeText(item.realPath) ? item.realPath : item.path
  const updatedAt =
    Number.isSafeInteger(item.updatedAt) && (item.updatedAt as number) >= 0 ? item.updatedAt : 0
  return {
    ...item,
    id: item.id,
    path: item.path,
    realPath,
    pinned: item.pinned === true,
    updatedAt
  } as HostProfileWorkspace
}

function decodeMessage(value: unknown): HostProfileMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid profile message')
  const item = value as Record<string, unknown>
  if (
    !safeId(item.id) ||
    !['user', 'assistant', 'system', 'tool', 'error'].includes(String(item.role))
  ) {
    throw new Error('Invalid profile message')
  }
  if (item.runId !== undefined && !safeId(item.runId)) throw new Error('Invalid profile message')
  // Legacy AppStore tool/error carriers may contain provider payload bodies or
  // empty content. Retain them inertly; history projection excludes them.
  if (
    typeof item.content !== 'string' ||
    Buffer.byteLength(item.content, 'utf8') > MAX_CHAT_BYTES ||
    typeof item.timestamp !== 'string' ||
    item.timestamp.length > 200
  ) {
    throw new Error('Invalid profile message')
  }
  return item as unknown as HostProfileMessage
}

function decodeThread(value: unknown): HostProfileThread {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid profile chat')
  const item = value as Record<string, unknown>
  if (
    !safeId(item.appChatId) ||
    (item.scope !== undefined && item.scope !== 'global' && item.scope !== 'workspace') ||
    !safeText(item.title, 200) ||
    !Array.isArray(item.messages) ||
    !Number.isSafeInteger(item.updatedAt)
  ) {
    throw new Error('Invalid profile chat')
  }
  const scope = item.scope === 'workspace' || safeId(item.workspaceId) ? 'workspace' : 'global'
  if (scope === 'workspace' && (!safeId(item.workspaceId) || !safeText(item.workspacePath))) {
    throw new Error('Invalid profile chat')
  }
  item.messages.forEach(decodeMessage)
  if (item.runs !== undefined) {
    if (!Array.isArray(item.runs)) throw new Error('Invalid profile runs')
    const runIds = new Set<string>()
    for (const run of item.runs) {
      if (!run || typeof run !== 'object' || Array.isArray(run))
        throw new Error('Invalid profile run')
      const record = run as Record<string, unknown>
      if (
        !safeId(record.runId) ||
        (record.status !== undefined && !safeText(record.status, 80)) ||
        (record.phase !== undefined &&
          record.phase !== 'starting' &&
          record.phase !== 'streaming' &&
          record.phase !== 'cancelling') ||
        // Legacy AppStore rows may carry opaque/noncanonical historical times;
        // new Host-run writes validate canonical timestamps in updateRun.
        (record.startedAt !== undefined && !safeText(record.startedAt, 80)) ||
        (record.endedAt !== undefined && !safeText(record.endedAt, 80)) ||
        (record.providerSessionId !== undefined && !safeId(record.providerSessionId)) ||
        (record.usage !== undefined && !safeRunUsage(record.usage)) ||
        (record.warningSummaries !== undefined &&
          (!Array.isArray(record.warningSummaries) ||
            record.warningSummaries.length > 16 ||
            record.warningSummaries.some((item) => !safeText(item, 300)))) ||
        (record.errorCode !== undefined &&
          record.errorCode !== 'provider_setup_unavailable' &&
          record.errorCode !== 'provider_launch_failed' &&
          record.errorCode !== 'provider_failed') ||
        runIds.has(record.runId)
      ) {
        throw new Error('Invalid profile run')
      }
      runIds.add(record.runId)
    }
  }
  return {
    ...item,
    appChatId: item.appChatId,
    scope,
    archived: item.archived === true,
    messages: item.messages as HostProfileMessage[],
    updatedAt: item.updatedAt as number,
    ...(Number.isSafeInteger(item.persistenceRevision) && (item.persistenceRevision as number) >= 0
      ? { persistenceRevision: item.persistenceRevision as number }
      : {})
  } as unknown as HostProfileThread
}

export class HostProfileDomainStore {
  private readonly profilePath: string
  private readonly chatsPath: string
  private readonly authority: HostProfileAuthorityPort
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly beforeAtomicPublish?: (targetPath: string) => void
  private readonly quarantinedThreads = new Set<string>()
  private readonly onThreadQuarantined?: (threadId: string, reason: 'record-too-large') => void
  private readonly threadCache = new Map<string, CachedThreadSummary>()
  private readonly threadCacheMaxBytes: number
  private threadCacheBytes = 0
  private threadRecordReadCount = 0

  constructor(options: HostProfileDomainStoreOptions) {
    if (!options?.authority || typeof options.authority.assertProfileAuthority !== 'function') {
      throw new Error('HostProfileDomainStore requires profile authority')
    }
    options.authority.assertProfileAuthority()
    this.authority = options.authority
    this.profilePath = assertProfilePath(options.profilePath)
    this.chatsPath = join(this.profilePath, HOST_PROFILE_CHATS_DIRECTORY)
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.beforeAtomicPublish = options.beforeAtomicPublish
    this.onThreadQuarantined = options.onThreadQuarantined
    this.threadCacheMaxBytes =
      Number.isFinite(options.threadCacheMaxBytes) && Number(options.threadCacheMaxBytes) >= 0
        ? Math.floor(Number(options.threadCacheMaxBytes))
        : DEFAULT_THREAD_CACHE_MAX_BYTES
    this.ensureDirectory(this.chatsPath)
  }

  listWorkspaces(): readonly HostProfileWorkspace[] {
    this.assertAuthority()
    const raw = readOptionalJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      MAX_WORKSPACES_BYTES
    )
    if (raw === null) return []
    if (!Array.isArray(raw)) throw new Error('Invalid workspaces document')
    const records = raw.map(decodeWorkspace)
    const ids = new Set<string>()
    const paths = new Set<string>()
    for (const record of records) {
      if (ids.has(record.id) || paths.has(record.realPath))
        throw new Error('Ambiguous workspace document')
      ids.add(record.id)
      paths.add(record.realPath)
    }
    return records
  }

  registerWorkspace(input: {
    path: string
    displayName?: string
    pinned?: boolean
  }): HostProfileWorkspace {
    const realPath = this.assertWorkspaceDirectory(input.path)
    const current = [...this.listWorkspaces()]
    const existing = current.find((workspace) => workspace.realPath === realPath)
    const next: HostProfileWorkspace = {
      ...(existing ?? {}),
      id: existing?.id ?? this.newId(),
      path: realPath,
      realPath,
      ...(input.displayName !== undefined
        ? { displayName: this.requireText(input.displayName, 200) }
        : {}),
      pinned: input.pinned ?? existing?.pinned ?? false,
      updatedAt: this.now()
    }
    const records = existing
      ? current.map((workspace) => (workspace.id === existing.id ? next : workspace))
      : [...current, next]
    atomicJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      records,
      MAX_WORKSPACES_BYTES,
      this.beforeAtomicPublish
    )
    return next
  }

  upsertWorkspaceRecord(input: {
    workspaceId: string
    record: {
      path: string
      displayName: string
      createdAt: number
      lastOpenedAt: number
      pinned: boolean
      branch?: string
      geminiWorktree?: { enabled: boolean; name?: string }
    }
  }): HostProfileWorkspace {
    this.assertAuthority()
    this.requireId(input.workspaceId)
    const path = this.requireText(input.record.path, MAX_TEXT)
    const realPath = this.assertWorkspaceDirectory(path)
    const displayName = this.requireText(input.record.displayName, 200)
    if (
      !Number.isSafeInteger(input.record.createdAt) ||
      input.record.createdAt < 0 ||
      !Number.isSafeInteger(input.record.lastOpenedAt) ||
      input.record.lastOpenedAt < 0 ||
      typeof input.record.pinned !== 'boolean'
    ) {
      throw new Error('Invalid workspace record')
    }
    const branch =
      input.record.branch === undefined ? undefined : this.requireText(input.record.branch, 512)
    let geminiWorktree: Record<string, unknown> | undefined
    if (input.record.geminiWorktree !== undefined) {
      if (typeof input.record.geminiWorktree.enabled !== 'boolean') {
        throw new Error('Invalid workspace record')
      }
      geminiWorktree = { enabled: input.record.geminiWorktree.enabled }
      if (input.record.geminiWorktree.name !== undefined) {
        geminiWorktree.name = this.requireText(input.record.geminiWorktree.name, 200)
      }
    }
    const current = [...this.listWorkspaces()]
    const existing = current.find((workspace) => workspace.id === input.workspaceId)
    if (
      current.some(
        (workspace) => workspace.id !== input.workspaceId && workspace.realPath === realPath
      )
    ) {
      throw new Error('Workspace path is already registered')
    }
    const next: HostProfileWorkspace = {
      ...(existing ?? {}),
      id: input.workspaceId,
      path,
      realPath,
      displayName,
      createdAt: input.record.createdAt,
      lastOpenedAt: input.record.lastOpenedAt,
      pinned: input.record.pinned,
      updatedAt: this.now()
    }
    const mutableNext = next as Record<string, unknown>
    if (branch !== undefined) mutableNext.branch = branch
    if (geminiWorktree !== undefined) {
      mutableNext.geminiWorktree = geminiWorktree
    }
    const records = existing
      ? current.map((workspace) => (workspace.id === input.workspaceId ? next : workspace))
      : [...current, next]
    atomicJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      records,
      MAX_WORKSPACES_BYTES,
      this.beforeAtomicPublish
    )
    return next
  }

  removeWorkspaceRecord(workspaceId: string): boolean {
    this.assertAuthority()
    this.requireId(workspaceId)
    const current = [...this.listWorkspaces()]
    if (!current.some((workspace) => workspace.id === workspaceId)) return false
    atomicJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      current.filter((workspace) => workspace.id !== workspaceId),
      MAX_WORKSPACES_BYTES,
      this.beforeAtomicPublish
    )
    return true
  }

  clearWorkspaceRecords(): number {
    this.assertAuthority()
    const count = this.listWorkspaces().length
    if (count === 0) return 0
    atomicJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      [],
      MAX_WORKSPACES_BYTES,
      this.beforeAtomicPublish
    )
    return count
  }

  createThread(input: {
    scope: 'global' | 'workspace'
    workspaceId?: string
    title?: string
  }): HostProfileThread {
    this.assertAuthority()
    const scope = input?.scope
    if (scope !== 'global' && scope !== 'workspace') throw new Error('Invalid thread scope')
    const now = this.now()
    const record: HostProfileThread = {
      appChatId: this.newId(),
      scope,
      ...(scope === 'workspace' ? this.workspaceThreadFields(input.workspaceId) : {}),
      title: input.title === undefined ? 'New chat' : this.requireText(input.title, 200),
      archived: false,
      messages: [],
      persistenceRevision: 0,
      updatedAt: now
    }
    this.writeThread(record)
    return record
  }

  getThread(threadId: string): HostProfileThread | null {
    this.assertAuthority()
    this.requireId(threadId)
    const raw = readOptionalJson(this.chatPath(threadId), MAX_CHAT_BYTES)
    if (raw === null) return null
    const thread = decodeThread(raw)
    if (thread.appChatId !== threadId) throw new Error('Chat identity mismatch')
    return thread
  }

  /** Threads the directory sweep skipped because the record exceeds the read
   *  cap. This layer takes no logger by design, so the set is exposed. */
  get quarantinedThreadIds(): readonly string[] {
    return [...this.quarantinedThreads].sort()
  }

  /** Chat records decoded from disk. A pass that re-reads nothing is the whole
   *  point of the cache, so the count is exposed rather than inferred: this
   *  layer takes no logger, same as quarantinedThreadIds. */
  get threadRecordReads(): number {
    return this.threadRecordReadCount
  }

  /** Resident summary bytes, so a caller can see the budget being respected. */
  get cachedThreadSummaryBytes(): number {
    return this.threadCacheBytes
  }

  /** One stat serves the size cap, the structural guards and the cache key.
   *  bigint mode is not incidental: `mtimeNs` is what makes an in-place
   *  rewrite inside the same millisecond visible to the identity check. */
  private statRecord(path: string): BigIntStats | null {
    try {
      return lstatSync(path, { bigint: true })
    } catch {
      // Deliberate deferral, not a swallow: a record that vanished between
      // readdir and here was skipped by getThread's null return before, and
      // throwing here would fail the whole listing for a race.
      return null
    }
  }

  /**
   * The cache key, and with it the security posture of a cache hit.
   *
   * `mode` is in here so a file whose permissions were widened underneath a
   * resident record can never be served from cache: the identity changes, the
   * pass falls through to a real read, and readOptionalJson's owner-only guard
   * fails closed exactly as it did before there was a cache. Same for a path
   * that became a symlink. Do not drop a field to save a comparison — each one
   * is what keeps a hit as safe as a read.
   *
   * `mtimeNs` rather than `mtimeMs` because an in-place rewrite that keeps the
   * inode and the byte length is invisible at millisecond resolution.
   */
  private recordIdentity(stat: BigIntStats): string {
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.size}:${stat.mode}`
  }

  private dropThreadSummary(threadId: string): void {
    const entry = this.threadCache.get(threadId)
    if (!entry) return
    this.threadCache.delete(threadId)
    this.threadCacheBytes -= entry.bytes
  }

  private admitThreadSummary(
    threadId: string,
    stat: BigIntStats,
    summary: HostProfileThreadSummary
  ): void {
    this.dropThreadSummary(threadId)
    // Measured on the summary, not on the record: the file is 95% messages by
    // bytes and the summary carries none of them, so budgeting by `stat.size`
    // would reserve twenty times what is actually held.
    const bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
    if (bytes > this.threadCacheMaxBytes) return
    while (this.threadCacheBytes + bytes > this.threadCacheMaxBytes) {
      // Evict the least recently WRITTEN summary, never the least recently
      // read. The sweep touches every thread every pass, so an access-ordered
      // policy evicts each entry immediately before its next use and holds a
      // 0% hit rate forever. Write order is stable across a sweep, so a full
      // cache converges instead of thrashing.
      let evictId: string | null = null
      let evictMtimeNs = stat.mtimeNs
      for (const [candidateId, entry] of this.threadCache) {
        if (entry.mtimeNs < evictMtimeNs) {
          evictId = candidateId
          evictMtimeNs = entry.mtimeNs
        }
      }
      // Nothing resident is older than this candidate, so admitting it would
      // only displace fresher summaries. Leave the cache exactly as it is.
      if (evictId === null) return
      this.dropThreadSummary(evictId)
    }
    this.threadCache.set(threadId, {
      identity: this.recordIdentity(stat),
      bytes,
      mtimeNs: stat.mtimeNs,
      summary
    })
    this.threadCacheBytes += bytes
  }

  private threadSummaryFor(
    threadId: string,
    path: string,
    stat: BigIntStats
  ): HostProfileThreadSummary | null {
    const identity = this.recordIdentity(stat)
    const cached = this.threadCache.get(threadId)
    if (cached && cached.identity === identity) return cached.summary
    const thread = this.getThread(threadId)
    if (!thread) {
      this.dropThreadSummary(threadId)
      return null
    }
    this.threadRecordReadCount += 1
    const summary = summarizeThread(thread)
    // Re-stat AFTER the read. readOptionalJson already fails closed on an
    // inode or size change mid-read, but a record rewritten between this
    // stat and that read must not be cached under the identity it no longer
    // has — otherwise the stale copy is served until the next write.
    const after = this.statRecord(path)
    if (after && this.recordIdentity(after) === identity) {
      this.admitThreadSummary(threadId, stat, summary)
    } else {
      this.dropThreadSummary(threadId)
    }
    return summary
  }

  /**
   * Walk `chats/`, applying every structural guard, and hand each readable
   * record's identity to `visit`. Returns the ids actually visited, so a
   * caller holding per-thread state can retire whatever the directory no
   * longer names.
   */
  private sweepChatRecords(
    visit: (threadId: string, path: string, stat: BigIntStats) => void
  ): Set<string> {
    this.assertAuthority()
    this.ensureDirectory(this.chatsPath)
    const visited = new Set<string>()
    for (const entry of readdirSync(this.chatsPath, { withFileTypes: true })) {
      if (this.isRecognizedTemp(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error('Unsafe chat directory entry')
        continue
      }
      if (!entry.name.endsWith('.json')) throw new Error('Unsafe chat directory entry')
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe chat directory entry')
      const id = entry.name.slice(0, -'.json'.length)
      if (!safeId(id)) throw new Error('Unsafe chat filename')
      const path = this.chatPath(id)
      const stat = this.statRecord(path)
      // Vanished between readdir and stat. getThread's readOptionalJson
      // returned null for exactly this race before, so the entry is skipped
      // rather than failing the whole listing.
      if (!stat) continue
      if (stat.size > BigInt(MAX_CHAT_BYTES)) {
        // A record too large to read is a capacity problem, not tampering —
        // every structural guard above still fails closed. Quarantine THIS
        // thread rather than the whole listing: one oversized chat previously
        // took the entire Host down, which silently forced the app onto the
        // in-process Host for every launch.
        if (!this.quarantinedThreads.has(id)) {
          this.quarantinedThreads.add(id)
          this.onThreadQuarantined?.(id, 'record-too-large')
        }
        continue
      }
      this.quarantinedThreads.delete(id)
      visited.add(id)
      visit(id, path, stat)
    }
    return visited
  }

  /**
   * Every thread, minus the messages array — the read the Host projection and
   * the run ports actually want, and the only one on a hot path.
   *
   * Cached against the exact file that produced each summary, so an unchanged
   * pass costs one stat per thread instead of a parse. `listThreads()` stays
   * the uncached whole-record primitive for a caller that genuinely needs
   * transcripts; nothing on a timer should be calling it.
   */
  listThreadSummaries(): readonly HostProfileThreadSummary[] {
    const summaries: HostProfileThreadSummary[] = []
    const visited = this.sweepChatRecords((id, path, stat) => {
      const summary = this.threadSummaryFor(id, path, stat)
      if (summary) summaries.push(summary)
    })
    // A deleted or quarantined chat must not stay resident: the cache is keyed
    // by thread id, and nothing else would revisit an id the sweep skipped.
    for (const threadId of [...this.threadCache.keys()]) {
      if (!visited.has(threadId)) this.dropThreadSummary(threadId)
    }
    return summaries
  }

  /**
   * Every thread WITH its transcript, uncached.
   *
   * Nothing on a timer may call this. It reads and parses the entire chat
   * corpus on every call — measured 3.3s on a real 689MB profile — which is
   * exactly what saturated the Host's event loop when the reconciler and the
   * run ports were using it. They read `listThreadSummaries()` now, and this
   * is left as the honest primitive for a caller that truly needs messages.
   */
  listThreads(): readonly HostProfileThread[] {
    const records: HostProfileThread[] = []
    this.sweepChatRecords((id) => {
      const thread = this.getThread(id)
      if (!thread) return
      this.threadRecordReadCount += 1
      records.push(thread)
    })
    return records
  }

  configureThread(input: {
    threadId: string
    title?: string
    providerId?: string
    modelId?: string
    reasoningId?: string
    postureId?: 'read_only' | 'plan' | 'default' | 'workspace_write'
    postureConsent?: true
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    this.assertIdle(current)
    const metadata = { ...(current.providerMetadata ?? {}) }
    if (input.modelId !== undefined)
      metadata.selectedModelType = this.requireText(input.modelId, 512)
    if (input.reasoningId !== undefined)
      metadata.reasoningEffort = this.requireText(input.reasoningId, 512)
    let workflowMode = current.workflowMode
    if (input.postureId !== undefined) {
      const posture = this.posture(input.postureId)
      if (input.postureConsent !== undefined && input.postureConsent !== true) {
        throw new Error('Invalid posture consent')
      }
      if (input.postureId === 'workspace_write' && input.postureConsent !== true) {
        throw new Error('Workspace-write posture requires explicit consent')
      }
      metadata.approvalMode = posture.approvalMode
      metadata.permissionPresetId = posture.permissionPresetId
      if (input.postureId === 'workspace_write') metadata.explicitConsentAcknowledged = true
      else delete metadata.explicitConsentAcknowledged
      workflowMode = posture.workflowMode
    }
    const next: HostProfileThread = {
      ...current,
      ...(input.title !== undefined ? { title: this.requireText(input.title, 200) } : {}),
      ...(input.providerId !== undefined
        ? { provider: this.requireText(input.providerId, 512) }
        : {}),
      ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
      ...(workflowMode !== undefined ? { workflowMode } : {}),
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    // Provider switch hygiene: stale provider sessions must not survive.
    if (input.providerId !== undefined && input.providerId !== current.provider) {
      delete (next as Record<string, unknown>).linkedProviderSessionId
      delete (next as Record<string, unknown>).linkedGeminiSessionId
      delete (next as Record<string, unknown>).taskWraithMcpProfileReceipt
    }
    this.writeThread(next)
    return next
  }

  setThreadKind(input: {
    threadId: string
    targetKind: 'single' | 'ensemble'
    canonicalProviderId?: string
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    const currentKind = current.chatKind === 'ensemble' ? 'ensemble' : 'single'
    const targetKind = input.targetKind === 'ensemble' ? 'ensemble' : 'single'
    if (currentKind === targetKind) return current
    this.assertIdle(current)
    const currentEnsemble = storedEnsemble(current.ensemble)
    if (
      currentKind === 'ensemble' &&
      isEnsembleRoundDispatchLive(currentEnsemble?.activeRound as never)
    ) {
      throw new Error('Thread is active')
    }

    const now = this.now()
    const nowIso = new Date(now).toISOString()
    const currentMetadata =
      current.providerMetadata && typeof current.providerMetadata === 'object'
        ? { ...current.providerMetadata }
        : {}

    if (targetKind === 'single') {
      if (!currentEnsemble) throw new Error('Ensemble configuration is unavailable')
      const canonicalProviderId = input.canonicalProviderId
      if (!safeId(canonicalProviderId)) throw new Error('Canonical provider is required')
      const canonicalParticipant = currentEnsemble.participants.find(
        (participant) => participant.provider === canonicalProviderId
      )
      if (!canonicalParticipant) throw new Error('Canonical provider is not in the Ensemble')
      const { activeRound: _dropActiveRound, ...stashableConfig } = currentEnsemble
      const providerMetadata = {
        ...currentMetadata,
        ...canonicalParticipantMetadata(canonicalParticipant),
        stashedEnsemble: {
          config: {
            ...stashableConfig,
            participants: currentEnsemble.participants.map(resetStoredParticipantSession)
          },
          provider: canonicalProviderId,
          stashedAt: nowIso
        }
      }
      const {
        ensemble: _dropEnsemble,
        linkedProviderSessionId: _dropProviderSession,
        linkedGeminiSessionId: _dropGeminiSession,
        taskWraithMcpProfileReceipt: _dropMcpProfileReceipt,
        ...withoutEnsemble
      } = current
      const next: HostProfileThread = {
        ...withoutEnsemble,
        chatKind: 'single',
        provider: canonicalProviderId,
        providerMetadata,
        persistenceRevision: this.nextRevision(current),
        updatedAt: now
      }
      this.writeThread(next)
      return next
    }

    if (!safeId(current.provider)) throw new Error('Thread provider is required')
    const stash =
      currentMetadata.stashedEnsemble && typeof currentMetadata.stashedEnsemble === 'object'
        ? (currentMetadata.stashedEnsemble as Record<string, unknown>)
        : null
    const stashedConfig = storedEnsemble(stash?.config)
    const restorable = stash?.provider === current.provider && stashedConfig !== null
    let ensemble: StoredEnsembleConfig
    if (restorable && stashedConfig) {
      ensemble = {
        ...stashedConfig,
        participants: stashedConfig.participants.map(resetStoredParticipantSession),
        updatedAt: nowIso
      }
    } else {
      const selectedModelType = currentMetadata.selectedModelType
      const selectedModel =
        selectedModelType === 'custom' && typeof currentMetadata.customModel === 'string'
          ? currentMetadata.customModel
          : typeof selectedModelType === 'string'
            ? selectedModelType
            : undefined
      const permissionPresetId =
        currentMetadata.approvalMode === 'plan'
          ? current.workflowMode === 'plan'
            ? 'plan'
            : 'read_only'
          : currentMetadata.approvalMode === 'auto_edit'
            ? 'workspace_write'
            : 'default'
      const effortKey =
        current.provider === 'codex'
          ? 'codexReasoningEffort'
          : current.provider === 'claude'
            ? 'claudeReasoningEffort'
            : current.provider === 'kimi'
              ? 'kimiReasoningEffort'
              : current.provider === 'grok'
                ? 'grokReasoningEffort'
                : current.provider === 'muse'
                  ? 'museReasoningEffort'
                  : current.provider === 'mistral'
                    ? 'mistralReasoningEffort'
                    : current.provider === 'pi'
                      ? 'piReasoningEffort'
                      : current.provider === 'ollama'
                        ? 'ollamaReasoningEffort'
                        : current.provider === 'cursor'
                          ? 'cursorReasoningEffort'
                          : current.provider === 'antigravity'
                            ? 'antigravityReasoningEffort'
                            : null
      const reasoningEffort =
        effortKey && typeof currentMetadata[effortKey] === 'string'
          ? currentMetadata[effortKey]
          : undefined
      const seed: StoredEnsembleParticipant = {
        id: `ensemble-seed-${this.newId()}`,
        provider: current.provider,
        enabled: true,
        role: current.provider,
        instructions: '',
        order: 1,
        permissionPresetId,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(typeof currentMetadata.runtimeProfileId === 'string'
          ? { runtimeProfileId: currentMetadata.runtimeProfileId }
          : {}),
        ...(current.provider === 'codex'
          ? {
              fastModeEnabled: currentMetadata.codexServiceTier === 'fast',
              ...(typeof currentMetadata.codexServiceTier === 'string'
                ? { serviceTier: currentMetadata.codexServiceTier }
                : {})
            }
          : {}),
        ...(current.provider === 'claude'
          ? { fastModeEnabled: currentMetadata.claudeFastMode === true }
          : {}),
        ...(current.provider === 'kimi'
          ? {
              fastModeEnabled: currentMetadata.kimiFastMode === true,
              thinkingEnabled: currentMetadata.kimiThinkingEnabled !== false
            }
          : {}),
        ...(current.provider === 'cursor'
          ? { fastModeEnabled: currentMetadata.cursorFastMode === true }
          : {})
      }
      const companionTemplate =
        HOST_ENSEMBLE_COMPANIONS.find((candidate) => candidate.provider !== current.provider) ??
        HOST_ENSEMBLE_COMPANIONS[0]
      const companion: StoredEnsembleParticipant = {
        id: `ensemble-companion-${this.newId()}`,
        provider: companionTemplate.provider,
        enabled: true,
        role: companionTemplate.role,
        instructions: companionTemplate.instructions,
        order: 2,
        model: companionTemplate.model,
        permissionPresetId: 'default'
      }
      ensemble = {
        enabled: true,
        maxParticipants: MAX_ENSEMBLE_PARTICIPANTS,
        orchestrationMode: 'turn_bound',
        maxContinuationHops: 6,
        participants: [seed, companion],
        bossmanParticipantId: seed.id,
        captainParticipantIds: [companion.id],
        secondInCommandParticipantId: companion.id,
        updatedAt: nowIso
      }
    }
    const { stashedEnsemble: _consumeStash, ...remainingMetadata } = currentMetadata
    const next: HostProfileThread = {
      ...current,
      chatKind: 'ensemble',
      ensemble,
      ...(Object.keys(remainingMetadata).length > 0
        ? { providerMetadata: remainingMetadata }
        : { providerMetadata: undefined }),
      persistenceRevision: this.nextRevision(current),
      updatedAt: now
    }
    delete (next as Record<string, unknown>).linkedProviderSessionId
    delete (next as Record<string, unknown>).linkedGeminiSessionId
    delete (next as Record<string, unknown>).taskWraithMcpProfileReceipt
    this.writeThread(next)
    return next
  }

  archiveThread(threadId: string, archived: boolean): HostProfileThread {
    this.assertAuthority()
    if (typeof archived !== 'boolean') throw new Error('Invalid archive state')
    const current = this.requireThread(threadId)
    if (current.archived === archived) return current
    this.assertIdle(current)
    const next = {
      ...current,
      archived,
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  deleteThreadRecord(input: { threadId: string; expectedRevision: number }): boolean {
    this.assertAuthority()
    this.requireId(input.threadId)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('Invalid expected revision')
    }
    const path = this.chatPath(input.threadId)
    let fd: number | null = null
    try {
      try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
      const opened = fstatSync(fd)
      if (
        !opened.isFile() ||
        opened.isSymbolicLink() ||
        opened.nlink !== 1 ||
        opened.size < 1 ||
        opened.size > MAX_CHAT_BYTES ||
        (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
      ) {
        throw new Error('Unsafe profile file')
      }
      const current = decodeThread(JSON.parse(readFileSync(fd, 'utf8')) as unknown)
      if (current.appChatId !== input.threadId) throw new Error('Chat identity mismatch')
      if ((current.persistenceRevision ?? 0) !== input.expectedRevision) {
        throw new Error('Thread persistence revision mismatch')
      }
      this.assertIdle(current)

      const currentPath = lstatSync(path)
      if (
        !currentPath.isFile() ||
        currentPath.isSymbolicLink() ||
        currentPath.nlink !== 1 ||
        String(currentPath.ino) !== String(opened.ino) ||
        String(currentPath.dev) !== String(opened.dev) ||
        currentPath.size !== opened.size
      ) {
        throw new Error('Profile file changed before deletion')
      }
      unlinkSync(path)
      fsyncDirectory(this.chatsPath)
      return true
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  persistThreadRecord(input: {
    threadId: string
    record: unknown
    expectedRevision: number
  }): HostProfileThread {
    this.assertAuthority()
    this.requireId(input.threadId)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error('Invalid expected revision')
    }
    const decoded = decodeThread(input.record)
    if (decoded.appChatId !== input.threadId) {
      throw new Error('Thread identity mismatch')
    }
    const current = this.getThread(input.threadId)
    if (current === null) {
      if (input.expectedRevision !== 0) {
        throw new Error('Thread is not found')
      }
    } else if ((current.persistenceRevision ?? 0) !== input.expectedRevision) {
      throw new Error('Thread persistence revision mismatch')
    }
    const next: HostProfileThread = {
      ...decoded,
      persistenceRevision: current === null ? 0 : this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  appendTranscript(input: {
    threadId: string
    runId?: string
    role: HostProfileMessage['role']
    content: string
    timestamp?: string
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    const runId = input.runId
    if (runId !== undefined) this.requireId(runId)
    if (input.role !== 'user' && input.role !== 'assistant' && input.role !== 'system') {
      throw new Error('Invalid transcript role')
    }
    if (!safeText(input.content)) throw new Error('Invalid transcript content')
    const timestamp = input.timestamp ?? new Date(this.now()).toISOString()
    if (!this.isCanonicalIso(timestamp)) throw new Error('Invalid transcript timestamp')
    const message: HostProfileMessage = {
      id: this.newId(),
      ...(runId !== undefined ? { runId } : {}),
      role: input.role,
      content: input.content,
      timestamp
    }
    const messages = [...current.messages, message]
    const next = {
      ...current,
      messages,
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  updateRun(input: {
    threadId: string
    runId: string
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    provider?: string
    requestedModel?: string
    phase?: 'starting' | 'streaming' | 'cancelling'
    startedAt?: string
    endedAt?: string
    providerSessionId?: string
    usage?: HostProfileRunUsage
    warningSummaries?: readonly string[]
    errorCode?: 'provider_setup_unavailable' | 'provider_launch_failed' | 'provider_failed'
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    this.requireId(input.runId)
    if (!['running', 'completed', 'failed', 'cancelled'].includes(input.status)) {
      throw new Error('Invalid run status')
    }
    if (
      input.phase !== undefined &&
      input.phase !== 'starting' &&
      input.phase !== 'streaming' &&
      input.phase !== 'cancelling'
    ) {
      throw new Error('Invalid run phase')
    }
    if (input.startedAt !== undefined && !safeCanonicalIso(input.startedAt)) {
      throw new Error('Invalid run start timestamp')
    }
    if (input.endedAt !== undefined && !safeCanonicalIso(input.endedAt)) {
      throw new Error('Invalid run end timestamp')
    }
    if (input.providerSessionId !== undefined && !safeId(input.providerSessionId)) {
      throw new Error('Invalid provider session')
    }
    if (input.usage !== undefined && !safeRunUsage(input.usage)) {
      throw new Error('Invalid run usage')
    }
    if (
      input.warningSummaries !== undefined &&
      (!Array.isArray(input.warningSummaries) ||
        input.warningSummaries.length > 16 ||
        input.warningSummaries.some((item) => !safeText(item, 300)))
    ) {
      throw new Error('Invalid run warnings')
    }
    if (
      input.errorCode !== undefined &&
      input.errorCode !== 'provider_setup_unavailable' &&
      input.errorCode !== 'provider_launch_failed' &&
      input.errorCode !== 'provider_failed'
    ) {
      throw new Error('Invalid run error code')
    }
    const runs = [...(current.runs ?? [])]
    const index = runs.findIndex((run) => run.runId === input.runId)
    const prior = index >= 0 ? runs[index] : undefined
    if (!prior && input.status !== 'running') throw new Error('Run must begin as running')
    const priorTerminalStatus = prior ? this.terminalRunStatus(prior) : null
    if (prior && priorTerminalStatus) {
      if (
        priorTerminalStatus === input.status &&
        prior.endedAt === input.endedAt &&
        prior.providerSessionId === input.providerSessionId &&
        sameRunUsage(prior.usage, input.usage) &&
        sameWarningSummaries(prior.warningSummaries, input.warningSummaries) &&
        prior.errorCode === input.errorCode
      ) {
        return current
      }
      throw new Error('Terminal run cannot change state')
    }
    if (prior?.startedAt && input.startedAt !== undefined && prior.startedAt !== input.startedAt) {
      throw new Error('Run start timestamp cannot change')
    }
    if (
      prior?.phase &&
      input.phase &&
      this.runPhaseRank(input.phase) < this.runPhaseRank(prior.phase)
    ) {
      throw new Error('Run phase cannot move backwards')
    }
    if (!prior && input.status !== 'running') throw new Error('Run must begin as running')
    const run: HostProfileRun = {
      ...(prior ?? {}),
      runId: input.runId,
      status: input.status,
      ...(input.provider !== undefined ? { provider: this.requireText(input.provider, 512) } : {}),
      ...(input.requestedModel !== undefined
        ? { requestedModel: this.requireText(input.requestedModel, 512) }
        : {}),
      ...(input.phase !== undefined
        ? { phase: input.phase }
        : prior?.phase
          ? { phase: prior.phase }
          : {}),
      ...(prior?.startedAt
        ? { startedAt: prior.startedAt }
        : { startedAt: input.startedAt ?? new Date(this.now()).toISOString() }),
      ...(input.status === 'running'
        ? {}
        : { endedAt: input.endedAt ?? new Date(this.now()).toISOString() }),
      ...(input.providerSessionId !== undefined
        ? { providerSessionId: input.providerSessionId }
        : {}),
      ...(input.usage !== undefined ? { usage: { ...input.usage } } : {}),
      ...(input.warningSummaries !== undefined
        ? { warningSummaries: [...input.warningSummaries] }
        : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {})
    }
    if (index >= 0) runs[index] = run
    else runs.push(run)
    const next = {
      ...current,
      runs,
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  threadHistory(request: HostThreadHistoryRequest): HostThreadHistoryPage {
    this.assertAuthority()
    const thread = this.requireThread(request.threadId)
    const projected = this.historyEntries(thread)
    const total = projected.length
    const end = request.before?.cursor ?? total
    const generation = thread.persistenceRevision ?? 0
    if (request.before && request.before.generation !== generation)
      throw new Error('History generation mismatch')
    if (!Number.isSafeInteger(end) || end < 0 || end > total)
      throw new Error('History cursor is invalid')
    const start = Math.max(0, end - request.limit)
    const entries = projected.slice(start, end)
    return {
      threadId: thread.appChatId,
      generation,
      cursor: total,
      entries,
      ...(start > 0 ? { nextBefore: { generation, cursor: start } } : {})
    }
  }

  historySince(request: HostHistorySinceRequest): HostHistorySinceResult {
    this.assertAuthority()
    const thread = this.requireThread(request.threadId)
    const cursor = this.historyEntries(thread).length
    const generation = thread.persistenceRevision ?? 0
    return {
      kind: 'full_resnapshot_required',
      threadId: thread.appChatId,
      generation,
      cursor,
      clientGeneration: request.since.generation,
      clientCursor: request.since.cursor,
      reason:
        request.since.generation === generation && request.since.cursor === cursor
          ? 'retention_gap'
          : request.since.generation !== generation
            ? 'generation_mismatch'
            : 'cursor_mismatch'
    }
  }

  private assertAuthority(): void {
    this.authority.assertProfileAuthority()
  }

  private ensureDirectory(path: string): void {
    this.assertAuthority()
    try {
      mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    } catch {
      throw new Error('Profile directory cannot be initialized')
    }
    const before = lstatSync(path)
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('Unsafe profile directory')
    }
    if (process.platform === 'win32') return

    // Legacy Desktop profiles created `chats/` with the process umask (often
    // 0755). The standalone and in-process Hosts both require owner-only
    // profile state, so tighten that known app-owned directory during takeover
    // instead of making every existing installation fail before discovery is
    // published. Bind the repair to an O_NOFOLLOW directory descriptor and
    // verify the pathname still names the same inode after fchmod.
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0)
    )
    try {
      const opened = fstatSync(fd)
      if (
        !opened.isDirectory() ||
        String(opened.ino) !== String(before.ino) ||
        String(opened.dev) !== String(before.dev)
      ) {
        throw new Error('Profile directory changed while opening')
      }
      if ((opened.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
        fchmodSync(fd, PRIVATE_DIRECTORY_MODE)
        fsyncSync(fd)
      }
      const repaired = fstatSync(fd)
      const current = lstatSync(path)
      if (
        !repaired.isDirectory() ||
        (repaired.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        String(current.ino) !== String(repaired.ino) ||
        String(current.dev) !== String(repaired.dev) ||
        (current.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
      ) {
        throw new Error('Profile directory owner-only repair could not be verified')
      }
    } finally {
      closeSync(fd)
    }
  }

  private assertWorkspaceDirectory(path: string): string {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error('Workspace path must be absolute')
    const resolved = resolve(path)
    if (resolved === parse(resolved).root) throw new Error('Workspace path must not be root')
    const direct = lstatSync(resolved)
    if (!direct.isDirectory() || direct.isSymbolicLink())
      throw new Error('Workspace path is unsafe')
    const real = realpathSync(resolved)
    const stat = statSync(real)
    if (!stat.isDirectory()) throw new Error('Workspace path is not a directory')
    return real
  }

  private workspaceThreadFields(
    workspaceId: string | undefined
  ): Pick<HostProfileThread, 'workspaceId' | 'workspacePath'> {
    this.requireId(workspaceId)
    const workspace = this.listWorkspaces().find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace is not registered')
    return { workspaceId: workspace.id, workspacePath: workspace.realPath }
  }

  private requireThread(threadId: string): HostProfileThread {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error('Thread is not found')
    return thread
  }

  private writeThread(thread: HostProfileThread): void {
    this.assertAuthority()
    this.requireId(thread.appChatId)
    atomicJson(this.chatPath(thread.appChatId), thread, MAX_CHAT_BYTES, this.beforeAtomicPublish)
  }

  private chatPath(threadId: string): string {
    this.requireId(threadId)
    return join(this.chatsPath, `${threadId}.json`)
  }

  private newId(): string {
    const id = this.idFactory()
    this.requireId(id)
    return id
  }

  private requireId(value: unknown): asserts value is string {
    if (!safeId(value)) throw new Error('Profile identity is invalid')
  }

  private requireText(value: unknown, max: number): string {
    if (!safeText(value, max)) throw new Error('Profile value is invalid')
    return value
  }

  private assertIdle(thread: HostProfileThread): void {
    if ((thread.runs ?? []).some((run) => this.isActiveRun(run))) {
      throw new Error('Thread is active')
    }
  }

  private isActiveRun(run: HostProfileRun): boolean {
    if (this.terminalRunStatus(run)) return false
    const status = typeof run.status === 'string' ? run.status.toLowerCase() : ''
    // Unknown/no-status records without a proven terminal timestamp fail
    // closed as active; setup must not mutate a possibly live legacy run.
    return ![
      'completed',
      'success',
      'succeeded',
      'failed',
      'error',
      'cancelled',
      'canceled'
    ].includes(status)
  }

  private terminalRunStatus(
    run: HostProfileRun
  ): 'completed' | 'failed' | 'cancelled' | 'unknown' | null {
    switch (typeof run.status === 'string' ? run.status.toLowerCase() : '') {
      case 'completed':
      case 'success':
      case 'succeeded':
        return 'completed'
      case 'failed':
      case 'error':
        return 'failed'
      case 'cancelled':
      case 'canceled':
        return 'cancelled'
      default:
        return this.isCanonicalIso(run.endedAt) ? 'unknown' : null
    }
  }

  private isCanonicalIso(value: unknown): value is string {
    return safeCanonicalIso(value)
  }

  private runPhaseRank(phase: NonNullable<HostProfileRun['phase']>): number {
    switch (phase) {
      case 'starting':
        return 0
      case 'streaming':
        return 1
      case 'cancelling':
        return 2
    }
  }

  private isRecognizedTemp(name: string): boolean {
    if (name.startsWith('.') && name.endsWith('.tmp')) return true
    const match = /^(.+)\.json\.(\d+)\.([A-Za-z0-9_-]+)\.tmp$/.exec(name)
    return match !== null && safeId(match[1])
  }

  private nextRevision(thread: HostProfileThread): number {
    const current = thread.persistenceRevision ?? 0
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Profile persistence revision is invalid')
    }
    return current + 1
  }

  private historyEntries(thread: HostProfileThread): HostTranscriptHistoryEntry[] {
    return thread.messages.flatMap((message) => {
      if (
        (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') ||
        !safeText(message.content)
      ) {
        return []
      }
      return [
        {
          entryId: message.id,
          role: message.role,
          createdAt: Number.isFinite(Date.parse(message.timestamp))
            ? Date.parse(message.timestamp)
            : 0,
          text: message.content
        }
      ]
    })
  }

  private posture(posture: string): {
    approvalMode: string
    permissionPresetId: 'read_only' | 'default' | 'workspace_write'
    workflowMode: 'normal' | 'plan'
  } {
    switch (posture) {
      case 'read_only':
        return { approvalMode: 'plan', permissionPresetId: 'read_only', workflowMode: 'normal' }
      case 'plan':
        return { approvalMode: 'plan', permissionPresetId: 'read_only', workflowMode: 'plan' }
      case 'default':
        return { approvalMode: 'default', permissionPresetId: 'default', workflowMode: 'normal' }
      case 'workspace_write':
        return {
          approvalMode: 'default',
          permissionPresetId: 'workspace_write',
          workflowMode: 'normal'
        }
      default:
        throw new Error('Invalid posture')
    }
  }
}
