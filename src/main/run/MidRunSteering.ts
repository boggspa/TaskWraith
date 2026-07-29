/**
 * Mid-run steering — append-now / deliver-at-boundary.
 *
 * Historically every "message arrives while the chat is busy" lane was
 * destructive or invisible: the ensemble composer Steer cancelled the active
 * round and started a fresh one ("interrupted the active speaker"), and a
 * scheduled in-thread message firing on a busy chat was silently skipped by
 * the scheduler tick until the chat idled — nothing appeared in the
 * transcript at fire time.
 *
 * This module is the bookkeeping + policy core for the replacement
 * behavior: the user-visible message is appended to the transcript
 * IMMEDIATELY (timestamped at arrival), and DELIVERY to the live provider
 * happens at the next natural boundary instead of restarting anything:
 *
 *  - Ensemble: every hop's prompt is rebuilt from the live chat record
 *    (`buildEnsembleParticipantPrompt` delta transcript, full AND slim
 *    turns), so an appended user message reaches every subsequent seat
 *    natively. The registry only tracks WHO has accepted a dispatch since the
 *    entry arrived. If an interjection lands during the final hop, the
 *    orchestrator grants an eligible foreground seat one same-round boundary
 *    turn — no cancellation, replacement round, or continuation-hop charge.
 *  - Solo scheduled: the message is appended at fire time; the ordinary
 *    sealed scheduled dispatch later delivers it at the run boundary, with
 *    the duplicate transcript seed suppressed and the already-appended
 *    message excluded from injected history.
 *
 * Everything here is pure/in-memory. Loss of the registry (restart) is safe
 * by construction: the transcript message is durable, ensemble delta windows
 * deliver transcript content regardless of registry state, and the scheduled
 * seed path falls back to its legacy append when it cannot find the
 * fire-time message.
 */
import type { ChatMessage, ProviderId, ScheduledTask } from '../store/types'

export type MidRunSteeringSource = 'ensembleSteer' | 'scheduledTask'

export interface MidRunSteeringEntry {
  id: string
  chatId: string
  /** Transcript message id appended at arrival time. */
  messageId: string
  text: string
  source: MidRunSteeringSource
  createdAtIso: string
  /** Present for `source: 'scheduledTask'` — dedupes the fire-time append. */
  scheduledTaskId?: string
  /**
   * Ensemble seats dispatched AFTER this entry arrived. Their hop prompt's
   * delta transcript ("messages since your last turn") carries the message,
   * so dispatch IS delivery for a seat. Solo delivery uses `deliveredAtIso`.
   */
  deliveredToParticipantIds: string[]
  deliveredAtIso?: string
}

/** Per-chat cap. Entries beyond it drop oldest-first — the transcript remains
 * the durable record; the registry only exists to steer delivery bookkeeping,
 * and an unbounded list would leak on a chat nobody ever runs again. */
const MAX_ENTRIES_PER_CHAT = 20

export class MidRunSteeringRegistry {
  private entriesByChatId = new Map<string, MidRunSteeringEntry[]>()
  private counter = 0

  register(input: {
    chatId: string
    messageId: string
    text: string
    source: MidRunSteeringSource
    createdAtIso: string
    scheduledTaskId?: string
  }): MidRunSteeringEntry {
    this.counter += 1
    const entry: MidRunSteeringEntry = {
      id: `midrun-steering-${this.counter}`,
      chatId: input.chatId,
      messageId: input.messageId,
      text: input.text,
      source: input.source,
      createdAtIso: input.createdAtIso,
      ...(input.scheduledTaskId ? { scheduledTaskId: input.scheduledTaskId } : {}),
      deliveredToParticipantIds: []
    }
    const existing = this.entriesByChatId.get(input.chatId) || []
    const next = [...existing, entry]
    this.entriesByChatId.set(
      input.chatId,
      next.length > MAX_ENTRIES_PER_CHAT ? next.slice(next.length - MAX_ENTRIES_PER_CHAT) : next
    )
    return entry
  }

  pendingForChat(chatId: string): MidRunSteeringEntry[] {
    return [...(this.entriesByChatId.get(chatId) || [])]
  }

  entryForScheduledTask(chatId: string, scheduledTaskId: string): MidRunSteeringEntry | null {
    return (
      (this.entriesByChatId.get(chatId) || []).find(
        (entry) => entry.scheduledTaskId === scheduledTaskId && !entry.deliveredAtIso
      ) || null
    )
  }

  /**
   * Ensemble boundary bookkeeping: a participant dispatch composed after
   * `createdAtIso` carries the entry in its delta transcript. Marks every
   * live entry as delivered-to that participant. Returns the entries marked
   * for the first time for this participant (callers may use the count for
   * telemetry; empty means nothing new).
   */
  markDeliveredToParticipant(chatId: string, participantId: string): MidRunSteeringEntry[] {
    const marked: MidRunSteeringEntry[] = []
    for (const entry of this.entriesByChatId.get(chatId) || []) {
      if (entry.deliveredAtIso) continue
      if (entry.deliveredToParticipantIds.includes(participantId)) continue
      entry.deliveredToParticipantIds.push(participantId)
      marked.push(entry)
    }
    return marked
  }

  /**
   * Live-delivery variant of `markDeliveredToParticipant`: marks ONLY the
   * named entries as seen by this participant. The blanket form is right for a
   * dispatch, whose hop prompt carries everything that existed at compose
   * time; a live mid-turn steer delivers exactly the entries the provider
   * confirmed, so anything that arrived afterwards must stay unseen.
   */
  markEntriesDeliveredToParticipant(
    chatId: string,
    participantId: string,
    entryIds: string[]
  ): MidRunSteeringEntry[] {
    if (entryIds.length === 0) return []
    const ids = new Set(entryIds)
    const marked: MidRunSteeringEntry[] = []
    for (const entry of this.entriesByChatId.get(chatId) || []) {
      if (!ids.has(entry.id)) continue
      if (entry.deliveredAtIso) continue
      if (entry.deliveredToParticipantIds.includes(participantId)) continue
      entry.deliveredToParticipantIds.push(participantId)
      marked.push(entry)
    }
    return marked
  }

  /**
   * Entries no ensemble participant has been dispatched against since they
   * arrived. These are the "interjection landed during the final hop" cases
   * the same-round boundary fallback exists for.
   */
  undeliveredToAnyParticipant(chatId: string): MidRunSteeringEntry[] {
    return (this.entriesByChatId.get(chatId) || []).filter(
      (entry) => !entry.deliveredAtIso && entry.deliveredToParticipantIds.length === 0
    )
  }

  /** Solo/terminal consumption (for example, a scheduled seed dispatch). */
  markDelivered(chatId: string, entryIds: string[], nowIso: string): void {
    if (entryIds.length === 0) return
    const ids = new Set(entryIds)
    for (const entry of this.entriesByChatId.get(chatId) || []) {
      if (ids.has(entry.id) && !entry.deliveredAtIso) {
        entry.deliveredAtIso = nowIso
      }
    }
    this.prune(chatId)
  }

  clearForChat(chatId: string): void {
    this.entriesByChatId.delete(chatId)
  }

  private prune(chatId: string): void {
    const remaining = (this.entriesByChatId.get(chatId) || []).filter(
      (entry) => !entry.deliveredAtIso
    )
    if (remaining.length === 0) {
      this.entriesByChatId.delete(chatId)
    } else {
      this.entriesByChatId.set(chatId, remaining)
    }
  }
}

/**
 * Deterministic transcript id for a scheduled message appended at fire time.
 * Deterministic so the scheduler tick (which re-fires while the chat stays
 * busy) and the idle-time seed can both recognize an existing append across
 * process restarts — the chat record is the durable dedupe, not the registry.
 * The legacy seed id shape is `scheduled-user-<uuid>`; this shape is
 * distinguishable by its `-fired-` segment.
 */
export function scheduledSteeringMessageId(taskId: string, firedAtIso: string): string {
  const firedMs = Date.parse(firedAtIso)
  return `scheduled-user-fired-${taskId}-${Number.isFinite(firedMs) ? firedMs : 0}`
}

/**
 * Restart recovery for the fire-time scheduled append. The in-memory registry
 * disappears on restart; the deterministic transcript id is the durable
 * occurrence receipt.
 */
export function findScheduledSteeringMessage(
  messages: readonly ChatMessage[],
  taskId: string,
  firedAtIso: string | null | undefined
): ChatMessage | null {
  if (!firedAtIso) return null
  const messageId = scheduledSteeringMessageId(taskId, firedAtIso)
  return messages.find((message) => message.id === messageId && message.role === 'user') || null
}

export function buildMidRunSteeringUserMessage(input: {
  id: string
  content: string
  timestampIso: string
}): ChatMessage {
  return {
    id: input.id,
    role: 'user',
    content: input.content,
    timestamp: input.timestampIso,
    // An open-union kind (ChatMessage.metadata.kind accepts arbitrary
    // strings): renderers treat unknown kinds on user rows as plain user
    // messages, so no renderer/iOS vocabulary work is required for the
    // message to appear instantly.
    metadata: { kind: 'midRunSteering' }
  }
}

/**
 * Absorb eligibility for an ensemble steer. Absorption (append + deliver at
 * the next hop boundary) replaces the historical cancel-round-and-restart
 * ONLY for the plain case; anything that changes the round's SHAPE keeps the
 * legacy interrupt semantics:
 *  - attachments: hop payloads can't grow image lanes mid-round,
 *  - DM target / exact picker: a targeted steer scopes the round to one
 *    seat — that is a routing change, not an interjection,
 *  - discord context / external grants: round-scoped capabilities are
 *    resolved at round start and must not silently widen mid-flight.
 */
export function midRunSteeringAbsorbEligible(input: {
  mode: string | undefined
  roundLive: boolean
  text: string
  hasImageAttachments: boolean
  hasDmTarget: boolean
  hasDiscordContext: boolean
  hasExternalPathGrants: boolean
}): boolean {
  if (input.mode !== 'steer') return false
  if (!input.roundLive) return false
  if (!input.text.trim()) return false
  if (input.hasImageAttachments) return false
  if (input.hasDmTarget) return false
  if (input.hasDiscordContext) return false
  if (input.hasExternalPathGrants) return false
  return true
}

/**
 * Per-provider context adapter for delivering steering content.
 *
 * `transcript-delta` — ensemble hops, EVERY provider: the hop prompt is
 * rebuilt from the live chat record, and both full and slim ensemble turns
 * embed a "new since your previous turn" tagged transcript, so the appended
 * message arrives natively. No prompt surgery, nothing to inject.
 *
 * `prompt-with-history-exclusion` — solo boundary dispatch for providers
 * whose turn composition injects host transcript (kimi legacy, grok ACP,
 * cursor, mistral, ollama, and sessionless codex/claude/pi dispatches): the
 * steering message is ALREADY in `chat.messages`, and the composed prompt
 * carries the same text as `finalPrompt`. Without exclusion the provider
 * reads the content twice (once as history, once as the request). The
 * tail-dedupe inside prompt composition only catches the case where the
 * steering message is the LAST message — mid-run appends are followed by the
 * live run's assistant output, so the explicit id-based exclusion is
 * required.
 *
 * `prompt-verbatim` — solo boundary dispatch for session-native resumes
 * (claude/codex resuming a provider session id, and pi, whose CLI session is
 * chat-deterministic and NEVER receives host transcript injection —
 * re-sending history to pi duplicates its native context). The provider has
 * its own memory of the conversation and has simply not seen the steering
 * text; the prompt carries it verbatim. History exclusion is still safe to
 * apply (these lanes inject no history), so callers may pass the exclusion
 * ids unconditionally.
 */
export type SteeringContextPlan =
  | { kind: 'transcript-delta' }
  | { kind: 'prompt-with-history-exclusion' }
  | { kind: 'prompt-verbatim' }

export function planSteeringContext(input: {
  lane: 'ensemble-hop' | 'solo-boundary'
  provider: ProviderId
  resumeProviderSessionId?: string | null
}): SteeringContextPlan {
  if (input.lane === 'ensemble-hop') {
    return { kind: 'transcript-delta' }
  }
  if (input.provider === 'pi') {
    // pi ignores payload session ids entirely (chat-deterministic
    // `--session-id taskwraith-<chatId>`); its session already holds the
    // conversation and must never receive injected history.
    return { kind: 'prompt-verbatim' }
  }
  if (
    (input.provider === 'claude' || input.provider === 'codex') &&
    input.resumeProviderSessionId
  ) {
    return { kind: 'prompt-verbatim' }
  }
  return { kind: 'prompt-with-history-exclusion' }
}

/**
 * LIVE delivery — the one lane that does not wait for a boundary.
 *
 * Every provider in the fleet composes its turn once at dispatch, so an
 * interjection can only reach it at the NEXT dispatch. Pi is the exception:
 * `pi --mode rpc` holds stdin open for the whole turn, and a `{type:'steer'}`
 * frame written mid-turn is delivered by pi itself at its next internal turn
 * boundary — including an extra turn when the interjection lands during what
 * would have been the final assistant message (live-probed on pi 0.82.1,
 * 2026-07-29; see src/main/pi/PiSteerDelivery.ts for the full findings).
 *
 * The win is concrete: the seat that is RUNNING when the interjection arrives
 * is exactly the seat the boundary model cannot reach. A confirmed live
 * delivery marks that seat delivered, so the same-round boundary fallback is
 * unnecessary for an interjection the panel has already seen.
 *
 * Deliberately conservative:
 *  - `enabled` is an explicit opt-in (default OFF) until this is exercised
 *    end-to-end in the real app. Off, behavior is exactly the pre-existing
 *    boundary delivery.
 *  - A settled run is refused. Pi acks a post-settle steer `success:true` and
 *    then never delivers it, so attempting one would look like a success and
 *    strand the message.
 *  - Attempting a live steer is never load-bearing: if the write fails, or pi
 *    never confirms the drain, the entry simply stays undelivered and the
 *    ordinary boundary path carries it as before.
 */
export function liveSteerDeliverySupported(provider: ProviderId): boolean {
  return provider === 'pi'
}

export function planLiveSteerDelivery(input: {
  enabled: boolean
  provider: ProviderId
  text: string
  /** A stdin writer is still registered for this run's transport. */
  hasLiveTransport: boolean
  /** The run's terminal result has already been projected. */
  runSettled: boolean
}): boolean {
  if (!input.enabled) return false
  if (!liveSteerDeliverySupported(input.provider)) return false
  if (!input.text.trim()) return false
  if (!input.hasLiveTransport) return false
  // Probe finding 3: after `agent_settled` pi still acks the frame but runs no
  // further turn. Never write into a settled run.
  if (input.runSettled) return false
  return true
}

/** Shared filter for ComposerService's `excludeMessageIds` input. */
export function filterMessagesExcludingIds<T extends { id: string }>(
  messages: T[],
  excludeMessageIds: string[] | undefined
): T[] {
  if (!excludeMessageIds || excludeMessageIds.length === 0) return messages
  const excluded = new Set(excludeMessageIds)
  return messages.filter((message) => !excluded.has(message.id))
}

/**
 * Scheduler-tick policy for a due task whose chat is busy. The tick keeps
 * its skip (never collide with a live run) — but a plain solo task now
 * appends its message at fire time so the user sees it land when the
 * countdown ends. Ensemble tasks and workflow loops keep the pure skip:
 * ensemble occurrences own seal/elevation machinery that must keep flowing
 * through the fresh-round path unchanged, and loop iterations are autonomous
 * re-prompts, not user-authored messages.
 */
export function shouldAppendScheduledSteeringOnBusy(input: {
  taskKind: ScheduledTask['kind']
  hasWorkflowLoop: boolean
  chatIsEnsemble: boolean
}): boolean {
  if (input.taskKind === 'ensemble') return false
  if (input.hasWorkflowLoop) return false
  if (input.chatIsEnsemble) return false
  return true
}

// NOTE: no run-exit nudge is needed for boundary delivery — the scheduler
// timer already re-polls a `due` task every SCHEDULED_DUE_RETRY_DELAY_MS
// (1s), so a fire-time-appended message dispatches within ~1s of the chat
// idling via the existing tick.
