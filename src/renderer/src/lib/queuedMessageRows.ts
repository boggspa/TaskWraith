import type { DiscordContextSelection } from '../../../main/channels/DiscordContextService'
import type {
  ChatMessage,
  ChatRecord,
  EnsembleQueuedPromptState,
  RunQueueJob
} from '../../../main/store/types'
import { midRunQueuedMessageId } from '../../../shared/midRunSteeringQueue'
import type { QueuedMessageRowEntry } from '../components/QueuedMessagesAboveRow'
import type { ImageAttachment } from './imageAttachments'
import {
  attachmentKindMetadata,
  getImageName,
  persistedAttachmentMetadata,
  sanitizeImagePath
} from './imageAttachments'
import type { QueuedRunRequest } from './runRequestTypes'

export const collectRunQueueJobIds = (jobs: RunQueueJob[]): Set<string> => {
  const ids = new Set<string>()
  for (const job of jobs) {
    if (job.runId) ids.add(job.runId)
    if (job.id) ids.add(job.id)
  }
  return ids
}

export const queuedRunRequestChatId = (request: QueuedRunRequest): string | undefined =>
  request.chatRecord?.appChatId

export const discordContextSelectionSummary = (
  selection: DiscordContextSelection | null | undefined
): string => {
  if (!selection) return ''
  const channel = selection.channelName?.trim() || selection.channelId
  const guild = selection.guildName?.trim()
  return `Discord context${guild ? ` from ${guild}` : ''}: #${channel} (last ${selection.limit} messages)`
}

export const queuedRunDisplayPrompt = (request: QueuedRunRequest): string =>
  request.displayPrompt ||
  request.prompt ||
  discordContextSelectionSummary(request.discordContextSelection)

export const queuedRunScheduledRunAt = (request: QueuedRunRequest): string | undefined =>
  request.scheduledRunAt

export const ensembleQueuedPromptsFromRound = (
  round: NonNullable<ChatRecord['ensemble']>['activeRound'] | null | undefined
): string[] => {
  if (!round) return []
  if (Array.isArray(round.queuedPrompts) && round.queuedPrompts.length > 0) {
    return round.queuedPrompts
  }
  return round.queuedPrompt ? [round.queuedPrompt] : []
}

/**
 * Map durable/queue attachment snapshots back into composer ImageAttachment
 * rows so Edit-from-queue restores the files the user originally attached.
 */
export const mapQueuedAttachmentsForComposer = (
  attachments:
    | readonly {
        id?: string | null
        path?: string | null
        name?: string | null
        kind?: 'file' | 'directory' | null
        persistenceVersion?: unknown
        sha256?: unknown
        mimeType?: unknown
        byteLength?: unknown
      }[]
    | null
    | undefined,
  idPrefix = 'queued-edit'
): ImageAttachment[] => {
  if (!attachments?.length) return []
  const mapped: ImageAttachment[] = []
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]
    const path = sanitizeImagePath(attachment?.path || '')
    if (!path) continue
    mapped.push({
      id:
        typeof attachment?.id === 'string' && attachment.id.trim()
          ? attachment.id
          : `${idPrefix}-attachment-${index}`,
      path,
      name:
        (typeof attachment?.name === 'string' && attachment.name.trim()) ||
        getImageName(path),
      ...attachmentKindMetadata(attachment),
      ...persistedAttachmentMetadata(attachment)
    })
  }
  return mapped
}

/**
 * Keep the prompt-only mirror and the versioned structured mirror in lockstep
 * after a renderer-local queue mutation. Without this, Edit/Delete/append
 * optimistically rewrote `queuedPrompts` while leaving `queuedPromptEntries`
 * at the previous length — later recovery treated the mismatch as corrupt and
 * dropped attachment authority for the whole FIFO.
 */
export const alignEnsembleQueuedPromptEntries = (
  previousPrompts: string[],
  previousEntries: EnsembleQueuedPromptState[] | null | undefined,
  nextPrompts: string[],
  options?: {
    /** Prefer index-accurate removal when the caller knows which FIFO slot left. */
    removedIndex?: number
    /** Prefer end-append when the caller knows a single optimistic enqueue. */
    appendedPrompt?: string
  }
): EnsembleQueuedPromptState[] | undefined => {
  if (!Array.isArray(previousEntries)) {
    return undefined
  }
  if (previousEntries.length !== previousPrompts.length) {
    // Already desynced — clear structured authority rather than invent it.
    return nextPrompts.length === 0 ? [] : undefined
  }

  if (
    typeof options?.removedIndex === 'number' &&
    options.removedIndex >= 0 &&
    options.removedIndex < previousPrompts.length &&
    nextPrompts.length === previousPrompts.length - 1 &&
    nextPrompts.every(
      (prompt, index) =>
        prompt ===
        previousPrompts[index < options.removedIndex! ? index : index + 1]
    )
  ) {
    return [
      ...previousEntries.slice(0, options.removedIndex),
      ...previousEntries.slice(options.removedIndex + 1)
    ]
  }

  if (
    typeof options?.appendedPrompt === 'string' &&
    nextPrompts.length === previousPrompts.length + 1 &&
    nextPrompts.slice(0, previousPrompts.length).every(
      (prompt, index) => prompt === previousPrompts[index]
    ) &&
    nextPrompts[nextPrompts.length - 1] === options.appendedPrompt
  ) {
    return [
      ...previousEntries,
      {
        persistenceVersion: 1,
        id: `optimistic-queued-${Date.now()}-${nextPrompts.length - 1}`,
        prompt: options.appendedPrompt,
        imageAttachments: []
      }
    ]
  }

  // Generic realign: consume previous entries left-to-right by prompt match.
  // Callers with known index/append mutations should prefer the options above
  // so duplicate prompt text cannot reassign the wrong attachment payload.
  const remaining = previousEntries.map((entry, index) => ({ entry, index }))
  const aligned: EnsembleQueuedPromptState[] = []
  for (let nextIndex = 0; nextIndex < nextPrompts.length; nextIndex += 1) {
    const prompt = nextPrompts[nextIndex]
    const matchAt = remaining.findIndex(({ entry }) => entry.prompt === prompt)
    if (matchAt >= 0) {
      const [match] = remaining.splice(matchAt, 1)
      aligned.push(match.entry)
      continue
    }
    aligned.push({
      persistenceVersion: 1,
      id: `optimistic-queued-${Date.now()}-${nextIndex}`,
      prompt,
      imageAttachments: []
    })
  }
  return aligned
}

export const ensembleRoundQueuePatch = (
  round: NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>,
  nextPrompts: string[],
  options?: {
    removedIndex?: number
    appendedPrompt?: string
  }
): Pick<
  NonNullable<NonNullable<ChatRecord['ensemble']>['activeRound']>,
  'queuedPrompt' | 'queuedPrompts' | 'queuedPromptEntries'
> => {
  const previousPrompts = ensembleQueuedPromptsFromRound(round)
  const alignedEntries = alignEnsembleQueuedPromptEntries(
    previousPrompts,
    round.queuedPromptEntries,
    nextPrompts,
    options
  )
  return {
    queuedPrompt: nextPrompts[0],
    queuedPrompts: nextPrompts,
    queuedPromptEntries: alignedEntries
  }
}

export const appendLocalQueuedRunEntries = ({
  entries,
  queuedRuns,
  runQueueJobs,
  chatId,
  queuedRunFallbackId
}: {
  entries: QueuedMessageRowEntry[]
  queuedRuns: QueuedRunRequest[]
  runQueueJobs: RunQueueJob[]
  chatId: string
  queuedRunFallbackId: (request: QueuedRunRequest) => string
}): QueuedMessageRowEntry[] => {
  const knownRunQueueJobIds = collectRunQueueJobIds(runQueueJobs)
  const merged = entries.slice()
  const entryIds = new Set(merged.map((entry) => entry.id))
  for (const request of queuedRuns) {
    const id = queuedRunFallbackId(request)
    if (entryIds.has(id)) continue
    if (queuedRunRequestChatId(request) !== chatId) continue
    if (request.appRunId && knownRunQueueJobIds.has(request.appRunId)) continue
    merged.push({
      id,
      provider: request.provider,
      prompt: queuedRunDisplayPrompt(request),
      scheduledRunAt: queuedRunScheduledRunAt(request),
      dmTargetParticipantId: request.dmTargetParticipantId
    })
    entryIds.add(id)
  }
  return merged
}

/**
 * Keep a promoted Steer at the head of the renderer's request mirror until
 * main reports a terminal queue state. The durable queue sorter consults this
 * mirror, so this is scheduling state as well as optimistic UI state. Reusing
 * the same run id replaces the older copy instead of creating a second turn.
 */
export const reserveQueuedRunAtFront = (
  queuedRuns: QueuedRunRequest[],
  request: QueuedRunRequest,
  queuedRunFallbackId: (request: QueuedRunRequest) => string
): QueuedRunRequest[] => {
  const runId = request.appRunId
  const fallbackId = queuedRunFallbackId(request)
  const remaining = queuedRuns.filter((candidate) =>
    runId ? candidate.appRunId !== runId : queuedRunFallbackId(candidate) !== fallbackId
  )
  const ownerToken = (request as unknown as Record<string, unknown>).steerOwnerToken
  if (typeof ownerToken !== 'string' || !ownerToken.trim()) return [request, ...remaining]

  // Steering reservations outrank ordinary queue work, but remain FIFO with
  // one another. Blind prepending let later text jump an earlier structured
  // steer waiting for a provider boundary.
  const firstOrdinary = remaining.findIndex((candidate) => {
    const candidateOwner = (candidate as unknown as Record<string, unknown>).steerOwnerToken
    return typeof candidateOwner !== 'string' || !candidateOwner.trim()
  })
  const insertionIndex = firstOrdinary < 0 ? remaining.length : firstOrdinary
  return [
    ...remaining.slice(0, insertionIndex),
    request,
    ...remaining.slice(insertionIndex)
  ]
}

/**
 * A solo Steer is projected into the transcript before its durable queue job
 * reaches the provider. Boundary-only delivery can then move that job back to
 * `queued`, while the renderer-local request mirror may briefly coexist before
 * the durable echo. Neither is a second user message, so neither should render
 * as a duplicate row above the composer once the exact transcript projection
 * exists.
 *
 * Validate the full correlation rather than hiding by queue status or prompt
 * text: ordinary queued requests remain visible, and a malformed/foreign row
 * cannot suppress one merely by borrowing a run id.
 */
export const filterTranscriptBackedQueuedRunEntries = (
  entries: QueuedMessageRowEntry[],
  messages: readonly ChatMessage[] | null | undefined,
  options: { preserveRunIds?: ReadonlySet<string> } = {}
): QueuedMessageRowEntry[] => {
  if (entries.length === 0 || !messages?.length) return entries

  const transcriptBackedRunIds = new Set<string>()
  for (const message of messages) {
    const runId = message.metadata?.midRunQueueRunId
    if (
      message.role !== 'user' ||
      message.metadata?.kind !== 'midRunSteering' ||
      message.metadata?.midRunQueueSource !== 'soloSteer' ||
      typeof runId !== 'string' ||
      !runId ||
      message.id !== midRunQueuedMessageId(runId)
    ) {
      continue
    }
    transcriptBackedRunIds.add(runId)
  }
  if (transcriptBackedRunIds.size === 0) return entries

  const filtered = entries.filter(
    (entry) =>
      options.preserveRunIds?.has(entry.id) === true || !transcriptBackedRunIds.has(entry.id)
  )
  return filtered.length === entries.length ? entries : filtered
}

export const preserveOptimisticEnsembleQueue = (
  incoming: ChatRecord,
  local: ChatRecord | null | undefined
): ChatRecord => {
  const incomingRound = incoming.ensemble?.activeRound
  const localRound = local?.ensemble?.activeRound
  if (
    incoming.chatKind !== 'ensemble' ||
    !incomingRound ||
    !localRound ||
    incomingRound.roundId !== localRound.roundId ||
    incomingRound.status !== 'running' ||
    localRound.status !== 'running'
  ) {
    return incoming
  }
  const incomingQueue = ensembleQueuedPromptsFromRound(incomingRound)
  const localQueue = ensembleQueuedPromptsFromRound(localRound)
  if (localQueue.length <= incomingQueue.length) return incoming

  // Only preserve when main's queue is a true prefix of local. A shorter
  // authoritative queue that removed a steered/deleted item (or cleared)
  // must win — otherwise a stale mid-run absorb broadcast that still
  // carried the item can restore it after an optimistic splice, and this
  // helper then rejects the later empty/shorter update forever.
  if (!incomingQueue.every((prompt, index) => localQueue[index] === prompt)) {
    return incoming
  }

  const localEntries = Array.isArray(localRound.queuedPromptEntries)
    ? localRound.queuedPromptEntries
    : null
  if (localEntries && localEntries.length === localQueue.length) {
    const localOnlyEntries = localEntries.slice(incomingQueue.length)
    const allOptimisticTails = localOnlyEntries.every(
      (entry) =>
        typeof entry?.id === 'string' && entry.id.startsWith('optimistic-queued')
    )
    if (!allOptimisticTails) return incoming
  } else if (incomingQueue.length === 0) {
    // Empty main queue vs longer local without optimistic-entry proof:
    // treat main as cleared (post-steer / post-delete), not "unechoed append".
    return incoming
  }

  // Local has optimistic tail(s) main has not yet echoed. Keep main's
  // structured mirror for the shared prefix and extend with empty-attachment
  // placeholders so prompt/entry lengths never diverge.
  const incomingEntries = Array.isArray(incomingRound.queuedPromptEntries)
    ? incomingRound.queuedPromptEntries
    : undefined
  const localOnly = localQueue.slice(incomingQueue.length)
  const nextEntries =
    incomingEntries && incomingEntries.length === incomingQueue.length
      ? [
          ...incomingEntries,
          ...localOnly.map((prompt, index) => ({
            persistenceVersion: 1 as const,
            id: `optimistic-queued-tail-${incomingRound.roundId}-${index}`,
            prompt,
            imageAttachments: [] as EnsembleQueuedPromptState['imageAttachments']
          }))
        ]
      : alignEnsembleQueuedPromptEntries(
          ensembleQueuedPromptsFromRound(localRound),
          localRound.queuedPromptEntries,
          localQueue
        )

  return {
    ...incoming,
    ensemble: {
      ...incoming.ensemble!,
      activeRound: {
        ...incomingRound,
        queuedPrompt: localQueue[0],
        queuedPrompts: localQueue,
        queuedPromptEntries: nextEntries
      }
    }
  }
}
