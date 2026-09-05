import type { ChatMessage, ChatRecord, ChatRun, ProviderId } from '../main/store/types'
import { CONTEXT_COMPACTION_MESSAGE_KIND } from './contextCompaction'
import {
  CONTINUITY_BLOCK_MAX_CHARS,
  readSeatCheckpoint,
  SOLO_CONTINUITY_SEAT,
  type ContinuityDelivery,
  type SeatContinuityCheckpoint
} from './threadContinuity'

export type ContinuityContextMode = 'host-fed' | 'native-session'

export interface ContinuityPromptTools {
  checkpoint?: string
  historySearch?: string
  historyRead?: string
}

export interface ContinuityCompactionBoundary {
  messageId: string
  timestamp: string
}

export type ContinuityDeliveryReason =
  | 'disabled'
  | 'context_isolated'
  | 'checkpoint_unavailable'
  | 'cleared_host_fed_context'
  | 'known_from_author_run'
  | 'already_delivered'
  | 'host_fed_repeat'
  | 'native_session_unproven'
  | 'native_delivery_required'

export type ContinuityDeliveryPlan =
  | {
      action: 'omit'
      reason: Extract<
        ContinuityDeliveryReason,
        | 'disabled'
        | 'context_isolated'
        | 'checkpoint_unavailable'
        | 'cleared_host_fed_context'
        | 'known_from_author_run'
        | 'already_delivered'
      >
      checkpoint?: SeatContinuityCheckpoint
      boundary?: ContinuityCompactionBoundary
    }
  | {
      action: 'deliver'
      reason: Extract<
        ContinuityDeliveryReason,
        'host_fed_repeat' | 'native_session_unproven' | 'native_delivery_required'
      >
      checkpoint: SeatContinuityCheckpoint
      boundary?: ContinuityCompactionBoundary
      delivery: ContinuityDelivery
      block: string
    }

export interface ContinuityDeliveryPlanInput {
  chat: Pick<ChatRecord, 'appChatId' | 'messages' | 'runs' | 'continuityCheckpoints'>
  seatId?: string
  provider: ProviderId
  providerSessionId?: string | null
  contextMode: ContinuityContextMode
  enabled: boolean
  contextIsolated: boolean
  tools?: ContinuityPromptTools
}

interface CompactionCandidate extends ContinuityCompactionBoundary {
  timestampMs: number
  transcriptIndex: number
}

type CheckpointWithLifecycle = SeatContinuityCheckpoint & {
  cleared?: boolean
  incarnation?: string | number
}

const SUCCESSFUL_DELIVERY_STATUSES = new Set([
  'success',
  'success_with_warnings',
  'completed',
  'sleeping'
])

const PROMPT_TOOL_NAME = /^[a-zA-Z0-9_.:-]{1,96}$/

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function checkpointIsCleared(checkpoint: SeatContinuityCheckpoint): boolean {
  const lifecycle = checkpoint as CheckpointWithLifecycle
  return lifecycle.cleared === true || checkpoint.text.length === 0
}

function checkpointIncarnation(checkpoint: SeatContinuityCheckpoint): string {
  const value = (checkpoint as CheckpointWithLifecycle).incarnation
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return checkpoint.author.runId
}

function promptToolName(value: unknown): string | null {
  const candidate = text(value)
  return PROMPT_TOOL_NAME.test(candidate) ? candidate : null
}

function stableFingerprint(value: string): string {
  let primary = 0x811c9dc5
  let secondary = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    primary = Math.imul(primary ^ code, 0x01000193) >>> 0
    secondary = Math.imul(secondary ^ (code + index), 0x27d4eb2d) >>> 0
  }
  return `${value.length.toString(36)}-${primary.toString(36)}-${secondary.toString(36)}`
}

function exactCompactionProvider(
  metadata: Record<string, unknown>,
  compaction: Record<string, unknown>,
  provider: ProviderId
): boolean {
  const telemetry = record(compaction.telemetry)
  const identities = [text(metadata.provider), text(telemetry?.provider)].filter(Boolean)
  return identities.length > 0 && identities.every((identity) => identity === provider)
}

function exactCompactionSeat(metadata: Record<string, unknown>, seatId: string): boolean {
  const markerSeat = text(metadata.ensembleParticipantId)
  return seatId === SOLO_CONTINUITY_SEAT ? !markerSeat : markerSeat === seatId
}

function compactionCandidate(
  message: ChatMessage,
  transcriptIndex: number,
  seatId: string,
  provider: ProviderId
): CompactionCandidate | null {
  if (message.metadata?.kind !== CONTEXT_COMPACTION_MESSAGE_KIND) return null
  const metadata = record(message.metadata)
  const compaction = record(metadata?.contextCompaction)
  if (
    !metadata ||
    !compaction ||
    compaction.kind !== 'completed' ||
    !exactCompactionProvider(metadata, compaction, provider) ||
    !exactCompactionSeat(metadata, seatId) ||
    typeof message.id !== 'string' ||
    !message.id
  ) {
    return null
  }
  const timestampMs = Date.parse(message.timestamp)
  if (!Number.isFinite(timestampMs)) return null
  return {
    messageId: message.id,
    timestamp: message.timestamp,
    timestampMs,
    transcriptIndex
  }
}

export function latestSuccessfulContinuityCompaction(input: {
  messages: readonly ChatMessage[]
  seatId: string
  provider: ProviderId
}): ContinuityCompactionBoundary | undefined {
  let latest: CompactionCandidate | null = null
  for (let transcriptIndex = 0; transcriptIndex < input.messages.length; transcriptIndex += 1) {
    const message = input.messages[transcriptIndex]
    const candidate = compactionCandidate(message, transcriptIndex, input.seatId, input.provider)
    if (
      candidate &&
      (!latest ||
        candidate.timestampMs > latest.timestampMs ||
        (candidate.timestampMs === latest.timestampMs &&
          candidate.transcriptIndex > latest.transcriptIndex))
    ) {
      latest = candidate
    }
  }
  return latest
    ? {
        messageId: latest.messageId,
        timestamp: latest.timestamp
      }
    : undefined
}

export function continuityDeliveryKey(input: {
  checkpoint: SeatContinuityCheckpoint
  seatId: string
  provider: ProviderId
  providerSessionId?: string | null
  boundary?: ContinuityCompactionBoundary
}): string {
  const checkpoint = input.checkpoint
  const source = JSON.stringify([
    'taskwraith-continuity-delivery-v1',
    checkpoint.chatId,
    input.seatId,
    checkpoint.revision,
    checkpointIncarnation(checkpoint),
    checkpointIsCleared(checkpoint),
    input.provider,
    text(input.providerSessionId),
    input.boundary?.messageId || '',
    input.boundary?.timestamp || ''
  ])
  return `continuity-v1:${stableFingerprint(source)}`
}

/** Identifies the exact saved note independently of a later native-session choice. */
export function continuityCheckpointSourceId(checkpoint: SeatContinuityCheckpoint): string {
  return `checkpoint-v1:${stableFingerprint(
    JSON.stringify([
      checkpoint.chatId,
      checkpoint.seatId,
      checkpoint.revision,
      checkpoint.updatedAt,
      checkpoint.text,
      checkpoint.references,
      checkpoint.cleared === true
    ])
  )}`
}

function displayIdentity(value: string, maxCodePoints = 160): string {
  const codePoints = Array.from(value)
  return JSON.stringify(
    codePoints.length <= maxCodePoints
      ? value
      : `${codePoints.slice(0, maxCodePoints - 1).join('')}…`
  )
}

function referenceLine(reference: SeatContinuityCheckpoint['references'][number]): string {
  return `- message ${displayIdentity(reference.messageId)}${
    reference.activityId ? `, activity ${displayIdentity(reference.activityId)}` : ''
  }`
}

function promptToolHints(tools: ContinuityPromptTools | undefined): string[] {
  const checkpoint = promptToolName(tools?.checkpoint)
  const historySearch = promptToolName(tools?.historySearch)
  const historyRead = promptToolName(tools?.historyRead)
  const lines: string[] = []
  if (checkpoint) {
    lines.push(
      `Update or clear this private record with ${checkpoint} when its working state changes.`
    )
  }
  if (historySearch && historyRead) {
    lines.push(
      `Earlier evidence stays out of this block. Locate it selectively with ${historySearch}, then read only chosen records with ${historyRead}.`
    )
  }
  return lines
}

function joinedLength(lines: readonly string[]): number {
  return lines.join('\n').length
}

/**
 * Render only checkpoint-authored text and opaque source ids. Transcript and
 * tool-result bodies are deliberately not accepted by this API, so formatting
 * cannot turn a reference into another context dump.
 */
export function formatContinuityCheckpointBlock(
  checkpoint: SeatContinuityCheckpoint,
  tools?: ContinuityPromptTools
): string {
  const cleared = checkpointIsCleared(checkpoint)
  const prefix = [
    '<taskwraith_private_continuity_checkpoint>',
    'Private, seat-authored, and provisional. Use this for orientation only; the current user request and original evidence take precedence.',
    `Source: ${continuityCheckpointSourceId(checkpoint)}`,
    cleared
      ? 'Status: cleared. Disregard any earlier TaskWraith continuity checkpoint for this seat.'
      : 'Checkpoint text (quoted JSON string):'
  ]
  const suffix = [
    ...promptToolHints(tools),
    'This record is supplied on a host-authored turn; provider compaction runs independently.',
    '</taskwraith_private_continuity_checkpoint>'
  ]
  if (cleared) {
    const block = [...prefix, ...suffix].join('\n')
    if (block.length > CONTINUITY_BLOCK_MAX_CHARS) {
      throw new Error('Continuity checkpoint tombstone exceeded its hard prompt budget.')
    }
    return block
  }

  const referenceLines = checkpoint.references.map(referenceLine)
  const emptyQuote = '""'
  const withoutReferences = [...prefix, emptyQuote, ...suffix]
  const quoteBudget = Math.max(
    2,
    CONTINUITY_BLOCK_MAX_CHARS - (joinedLength(withoutReferences) - emptyQuote.length)
  )
  const quoted = JSON.stringify(checkpoint.text)
  if (quoted.length > quoteBudget)
    throw new Error('Checkpoint text exceeds the recovery budget; shorten the note before saving.')
  const selectedReferences: string[] = []
  for (const line of referenceLines) {
    const candidate = [
      ...prefix,
      quoted,
      '',
      'Evidence references (content intentionally omitted):',
      ...selectedReferences,
      line,
      ...suffix
    ]
    if (joinedLength(candidate) > CONTINUITY_BLOCK_MAX_CHARS) break
    selectedReferences.push(line)
  }
  let omitted = referenceLines.length - selectedReferences.length
  let omissionLine =
    omitted > 0 ? `- … ${omitted} more reference(s) retained in the checkpoint` : ''
  while (omissionLine && selectedReferences.length > 0) {
    const candidate = [
      ...prefix,
      quoted,
      '',
      'Evidence references (content intentionally omitted):',
      ...selectedReferences,
      omissionLine,
      ...suffix
    ]
    if (joinedLength(candidate) <= CONTINUITY_BLOCK_MAX_CHARS) break
    selectedReferences.pop()
    omitted += 1
    omissionLine = `- … ${omitted} more reference(s) retained in the checkpoint`
  }
  const references =
    referenceLines.length > 0
      ? [
          '',
          'Evidence references (content intentionally omitted):',
          ...selectedReferences,
          ...(omissionLine ? [omissionLine] : [])
        ]
      : []
  let block = [...prefix, quoted, ...references, ...suffix].join('\n')
  // Reference headings/notices are optional too; never displace accepted note text.
  if (block.length > CONTINUITY_BLOCK_MAX_CHARS) block = [...prefix, quoted, ...suffix].join('\n')
  if (block.length > CONTINUITY_BLOCK_MAX_CHARS) {
    throw new Error('Continuity checkpoint block exceeded its hard prompt budget.')
  }
  return block
}

function successfulRun(run: ChatRun): boolean {
  return Boolean(run.endedAt && SUCCESSFUL_DELIVERY_STATUSES.has(String(run.status || '')))
}

function exactNativeRunContext(
  run: ChatRun,
  provider: ProviderId,
  providerSessionId: string
): boolean {
  return run.provider === provider && run.providerThreadId === providerSessionId
}

function runCarriesDelivery(run: ChatRun, delivery: ContinuityDelivery): boolean {
  const stored = run.continuityCheckpointDelivery
  if (
    stored?.key === delivery.key &&
    stored.seatId === delivery.seatId &&
    stored.revision === delivery.revision
  ) {
    return true
  }
  return false
}

function authorRunKnowsCheckpoint(input: {
  runs: readonly ChatRun[]
  checkpoint: SeatContinuityCheckpoint
  provider: ProviderId
  providerSessionId: string
  boundary?: ContinuityCompactionBoundary
}): boolean {
  if (
    input.checkpoint.author.provider !== input.provider ||
    text(input.checkpoint.author.providerSessionId) !== input.providerSessionId
  ) {
    return false
  }
  const checkpointAt = Date.parse(input.checkpoint.updatedAt)
  const boundaryAt = input.boundary
    ? Date.parse(input.boundary.timestamp)
    : Number.NEGATIVE_INFINITY
  if (!Number.isFinite(checkpointAt) || checkpointAt < boundaryAt) return false
  return input.runs.some((run) => {
    if (
      run.runId !== input.checkpoint.author.runId ||
      !successfulRun(run) ||
      !exactNativeRunContext(run, input.provider, input.providerSessionId)
    ) {
      return false
    }
    const endedAt = Date.parse(run.endedAt || '')
    return Number.isFinite(endedAt) && endedAt >= checkpointAt
  })
}

function hasSuccessfulDelivery(input: {
  runs: readonly ChatRun[]
  delivery: ContinuityDelivery
  checkpoint: SeatContinuityCheckpoint
  provider: ProviderId
  providerSessionId: string
  boundary?: ContinuityCompactionBoundary
}): boolean {
  const checkpointAt = Date.parse(input.checkpoint.updatedAt)
  const boundaryAt = input.boundary
    ? Date.parse(input.boundary.timestamp)
    : Number.NEGATIVE_INFINITY
  const requiredStart = Math.max(checkpointAt, boundaryAt)
  return input.runs.some((run) => {
    const observed = run.continuityCheckpointDelivery
    if (
      observed?.sourceId === continuityCheckpointSourceId(input.checkpoint) &&
      observed.seatId === input.delivery.seatId &&
      observed.revision === input.delivery.revision &&
      observed.provider === input.provider &&
      observed.boundaryId === input.boundary?.messageId &&
      (!observed.providerSessionId || observed.providerSessionId === input.providerSessionId) &&
      successfulRun(run) &&
      exactNativeRunContext(run, input.provider, input.providerSessionId)
    ) {
      return true
    }
    if (
      !successfulRun(run) ||
      !exactNativeRunContext(run, input.provider, input.providerSessionId) ||
      !runCarriesDelivery(run, input.delivery)
    ) {
      return false
    }
    const startedAt = Date.parse(run.startedAt)
    return Number.isFinite(startedAt) && startedAt >= requiredStart
  })
}

/**
 * Decide what the next host-authored provider turn should receive. Provider-
 * native compaction is only observed here as a completed transcript marker;
 * this planner never claims or attempts injection inside the compaction itself.
 */
export function planContinuityDeliveryForNextHostTurn(
  input: ContinuityDeliveryPlanInput
): ContinuityDeliveryPlan {
  if (!input.enabled) return { action: 'omit', reason: 'disabled' }
  if (input.contextIsolated) return { action: 'omit', reason: 'context_isolated' }
  const seatId = text(input.seatId) || SOLO_CONTINUITY_SEAT
  const checkpoint = readSeatCheckpoint(input.chat, seatId)
  if (!checkpoint) return { action: 'omit', reason: 'checkpoint_unavailable' }
  const boundary = latestSuccessfulContinuityCompaction({
    messages: input.chat.messages || [],
    seatId,
    provider: input.provider
  })
  const delivery: ContinuityDelivery = {
    key: continuityDeliveryKey({
      checkpoint,
      seatId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      boundary
    }),
    seatId,
    revision: checkpoint.revision
  }
  if (input.contextMode === 'host-fed') {
    if (checkpointIsCleared(checkpoint)) {
      return { action: 'omit', reason: 'cleared_host_fed_context', checkpoint, boundary }
    }
    return {
      action: 'deliver',
      reason: 'host_fed_repeat',
      checkpoint,
      boundary,
      delivery,
      block: formatContinuityCheckpointBlock(checkpoint, input.tools)
    }
  }
  const providerSessionId = text(input.providerSessionId)
  if (!providerSessionId) {
    return {
      action: 'deliver',
      reason: 'native_session_unproven',
      checkpoint,
      boundary,
      delivery,
      block: formatContinuityCheckpointBlock(checkpoint, input.tools)
    }
  }
  if (
    authorRunKnowsCheckpoint({
      runs: input.chat.runs || [],
      checkpoint,
      provider: input.provider,
      providerSessionId,
      boundary
    })
  ) {
    return { action: 'omit', reason: 'known_from_author_run', checkpoint, boundary }
  }
  if (
    hasSuccessfulDelivery({
      runs: input.chat.runs || [],
      delivery,
      checkpoint,
      provider: input.provider,
      providerSessionId,
      boundary
    })
  ) {
    return { action: 'omit', reason: 'already_delivered', checkpoint, boundary }
  }
  return {
    action: 'deliver',
    reason: 'native_delivery_required',
    checkpoint,
    boundary,
    delivery,
    block: formatContinuityCheckpointBlock(checkpoint, input.tools)
  }
}
