import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  ToolActivity,
  ToolActivityCommitEvidence,
  ToolActivityDetailRef
} from './types'
import { resolveCatalogToolName } from '../../shared/canonicalToolCoalesce'
import type {
  AuthoredChatTranscriptMutation,
  ChatTranscriptMutationOperation
} from './ChatRecordMutation'
import type { ChatTranscriptOp } from '../../shared/chatUpdateTransport'

export const TOOL_DETAIL_EXTERNALIZATION_GENERATION = 1

/**
 * Serialized-detail size above which a SEALED activity in a still-running run
 * moves its raw payload behind a `detailRef` mid-run (perf-epic T5 hot case).
 * Below it, activities stay fully inline until their run turns terminal, so
 * small-payload record readers (todo extraction from `parameters`, receipts,
 * iOS previews) keep seeing exactly what they see today. Jumbo payloads are
 * the ones that were already truncated or skipped by bounded projections.
 */
export const LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES = 64 * 1024

export interface ToolActivityDetailSink {
  (runId: string, activity: ToolActivity): ToolActivityDetailRef | null
}

export interface ExternalizeToolActivityDetailsOptions {
  /**
   * Last persisted record. The orchestrator re-attaches its in-memory activity
   * objects — heavy fields included — on every 250 ms flush, so a mid-run
   * strip only stays stripped if each save can re-adopt the ref the previous
   * save minted. Without it every save would re-append the same bytes.
   */
  previousChat?: ChatRecord | null
  /**
   * Sync ranged read of an archived detail. Required at run-terminal to fold a
   * live-externalized activity (ref + summaries inline) without orphaning the
   * raw bytes that exist only in the archive.
   */
  readArchivedDetail?: (ref: ToolActivityDetailRef) => ToolActivity | null
}

export interface ChatToolDetailExternalizationResult {
  chat: ChatRecord
  externalizedActivityCount: number
  completedRunIds: string[]
  /**
   * Every activity whose persisted form this pass rewrote, by activity id.
   * Callers substitute these into authored mutation ops so journal replay
   * reproduces the stripped record byte-for-byte.
   */
  strippedActivitiesById: Map<string, ToolActivity>
  /**
   * Stripped ids whose new form is NOT guaranteed equal to what the previous
   * record already held (fresh stages, terminal folds). Authored ops may only
   * be trusted when they mention every one of these ids; otherwise the caller
   * must fall back to derived diffing, exactly as terminal saves do today.
   * Ref re-adoptions and hydration echoes are deliberately absent: an authored
   * save that did not mention them asserts the producer saw no change, and the
   * previous record already carries the stripped form.
   */
  opRequiredActivityIds: Set<string>
}

const HEAVY_TOOL_ACTIVITY_FIELDS = [
  'parameters',
  'resultSummary',
  'outputPreview',
  'rawUseEvent',
  'rawResultEvent',
  'outputSummary'
] as const satisfies readonly (keyof ToolActivity)[]

/** The unbounded machine payloads — the fields the perf ADR names as the live
 * amplifiers. Bounded presentation fields stay inline until run-terminal. */
const LIVE_TOOL_DETAIL_FIELDS = [
  'parameters',
  'rawUseEvent',
  'rawResultEvent'
] as const satisfies readonly (keyof ToolActivity)[]

function isTerminalRun(run: ChatRun, hasLaterRun: boolean): boolean {
  const status = String(run.status || '')
    .trim()
    .toLowerCase()
  if (
    status === 'running' ||
    status === 'pending' ||
    status === 'starting' ||
    status === 'sleeping'
  ) {
    return false
  }
  const terminalStatus =
    status === 'success' ||
    status === 'success_with_warnings' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'error'
  // `status` can flip before the provider exit/terminal save reaches the
  // store. Require an explicit seal for the latest run; a later run is itself
  // durable proof that an older status-only record crossed its turn boundary.
  return Boolean(
    run.endedAt || run.cancelled || run.exitCode !== undefined || (hasLaterRun && terminalStatus)
  )
}

/**
 * An activity whose raw payload can no longer change: the provider delivered
 * its terminal status and stamped `endedAt` in the same event. The raw trio is
 * write-once at that seal — the adoption guard below keys on exactly the
 * fields that event stamps (status, endedAt, durationMs).
 */
function isSealedToolActivity(activity: ToolActivity): boolean {
  return (
    (activity.status === 'success' || activity.status === 'warning' || activity.status === 'error') &&
    Boolean(activity.endedAt)
  )
}

function validDetailRef(ref: ToolActivityDetailRef | undefined): ref is ToolActivityDetailRef {
  return Boolean(
    ref && ref.schemaVersion === 1 && ref.storage === 'run_event_artifact' && ref.byteLength > 0
  )
}

export function hasExternalizableToolActivityDetail(activity: ToolActivity): boolean {
  return HEAVY_TOOL_ACTIVITY_FIELDS.some((field) => activity[field] !== undefined)
}

function hasLiveExternalizableRawDetail(activity: ToolActivity): boolean {
  return LIVE_TOOL_DETAIL_FIELDS.some((field) => activity[field] !== undefined)
}

export function compactToolActivityWithDetailRef(
  activity: ToolActivity,
  detailRef: ToolActivityDetailRef
): ToolActivity {
  const compact = { ...withCommitEvidence(activity), detailRef }
  for (const field of HEAVY_TOOL_ACTIVITY_FIELDS) delete compact[field]
  return compact
}

function stripLiveToolDetail(
  activity: ToolActivity,
  detailRef: ToolActivityDetailRef
): ToolActivity {
  const stripped = { ...withCommitEvidence(activity), detailRef }
  for (const field of LIVE_TOOL_DETAIL_FIELDS) delete stripped[field]
  return stripped
}

/** Caps for the receipt lift — a command line plus git's receipt and --stat
 * block; anything larger is not commit output. */
export const COMMIT_EVIDENCE_COMMAND_LIMIT = 4 * 1024
export const COMMIT_EVIDENCE_RECEIPT_LIMIT = 32 * 1024

/** `git … commit` within one pipeline segment (chain separators end the search
 * so `git add x && git commit` matches on its own segment). */
const SHELL_GIT_COMMIT_COMMAND_RE = /\bgit\b[^\n|&;]{0,200}?\bcommit\b/

function activityParameterString(activity: ToolActivity, keys: readonly string[]): string | null {
  const containers: unknown[] = [activity.parameters]
  const rawUse =
    activity.rawUseEvent && typeof activity.rawUseEvent === 'object'
      ? (activity.rawUseEvent as Record<string, unknown>)
      : null
  containers.push(rawUse?.input, rawUse?.args, rawUse?.parameters)
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue
    for (const key of keys) {
      const value = (container as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  return null
}

function collectReceiptFragments(value: unknown, fragments: string[], depth = 0): void {
  if (value === null || value === undefined || depth > 4 || fragments.length > 80) return
  if (typeof value === 'string') {
    if (value.trim()) fragments.push(value)
    return
  }
  if (typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectReceiptFragments(item, fragments, depth + 1)
    return
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectReceiptFragments(entry, fragments, depth + 1)
  }
}

function buildCommitEvidence(activity: ToolActivity): ToolActivityCommitEvidence | null {
  // Mirror the close-out harvester's activity classification exactly
  // (closeoutCommitActivityKind in taskWraithCloseoutMessage.ts): the catalog
  // tool decides first, the shell category second, loose text last.
  const catalogTool = resolveCatalogToolName(activity.toolName || '')
  let kind: 'dedicated' | 'shell' | null = null
  if (catalogTool === 'git_commit') {
    kind = 'dedicated'
  } else if (
    catalogTool === 'run_shell_command' ||
    activity.category?.toLowerCase() === 'shell'
  ) {
    kind = 'shell'
  } else {
    const text = `${activity.toolName || ''} ${activity.displayName || ''}`.toLowerCase()
    kind = text.includes('git_commit') || text.includes('git commit') ? 'dedicated' : null
  }
  if (!kind) return null
  const command = activityParameterString(activity, ['command', 'cmd', 'script'])
  if (kind === 'shell' && (!command || !SHELL_GIT_COMMIT_COMMAND_RE.test(command))) return null

  const fragments: string[] = []
  collectReceiptFragments(activity.resultSummary, fragments)
  collectReceiptFragments(activity.outputPreview, fragments)
  collectReceiptFragments(activity.rawResultEvent, fragments)
  const receiptText = fragments.join('\n').slice(0, COMMIT_EVIDENCE_RECEIPT_LIMIT)
  if (!receiptText.trim()) return null

  const cwd = activityParameterString(activity, ['cwd', 'workdir', 'workingDirectory'])
  return {
    ...(command ? { command: command.slice(0, COMMIT_EVIDENCE_COMMAND_LIMIT) } : {}),
    ...(cwd ? { cwd } : {}),
    receiptText
  }
}

/** Lift commit receipts into a bounded survivor field before stripping deletes
 * the payloads they live in. Idempotent: already-stamped evidence is kept, so
 * re-strips of a stripped form (no raw fields left) cannot erase it. */
function withCommitEvidence(activity: ToolActivity): ToolActivity {
  if (activity.commitEvidence) return activity
  const evidence = buildCommitEvidence(activity)
  return evidence ? { ...activity, commitEvidence: evidence } : activity
}

/**
 * Component sizes memoized by object identity. The orchestrator keeps the same
 * raw event objects across flushes, so the steady state is a WeakMap hit per
 * save; a record re-read from disk re-measures once per process.
 */
const detailComponentSizeCache = new WeakMap<object, number>()

function componentBytes(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return value.length
  if (typeof value === 'object') {
    const cached = detailComponentSizeCache.get(value as object)
    if (cached !== undefined) return cached
    let bytes = 0
    try {
      bytes = JSON.stringify(value)?.length ?? 0
    } catch {
      // Unserializable detail cannot be archived either; treating it as empty
      // keeps it inline, which matches serializeDetail's own failure path.
      bytes = 0
    }
    detailComponentSizeCache.set(value as object, bytes)
    return bytes
  }
  return 8
}

export function estimateLiveToolActivityDetailBytes(activity: ToolActivity): number {
  return (
    componentBytes(activity.parameters) +
    componentBytes(activity.rawUseEvent) +
    componentBytes(activity.rawResultEvent) +
    componentBytes(activity.resultSummary) +
    componentBytes(activity.outputPreview) +
    componentBytes(activity.outputSummary) +
    512
  )
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === undefined || right === undefined) return false
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

type LiveDecision =
  | { kind: 'echo' }
  | { kind: 'adopt'; ref: ToolActivityDetailRef }
  | { kind: 'stage' }
  | null

/**
 * Traverse newly-terminal runs exactly once, and — when options are provided —
 * keep sealed jumbo activities of still-running runs stripped on every save.
 * The sink stages complete activities in durable storage; only successful
 * stages are replaced by lightweight transcript rows. A run is stamped only
 * when every detail row was safely externalized, so failures remain retryable
 * without data loss.
 */
export function externalizeToolActivityDetails(
  chat: ChatRecord,
  sink: ToolActivityDetailSink,
  options?: ExternalizeToolActivityDetailsOptions
): ChatToolDetailExternalizationResult {
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  const terminalCandidateRunIds = new Set<string>()
  const liveRunIds = new Set<string>()
  // Live externalization is opt-in via options: without the previous record
  // for ref re-adoption, every save would re-append the same detail bytes.
  const liveEnabled = options !== undefined
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (isTerminalRun(run, index < runs.length - 1)) {
      if (run.toolDetailExternalizationGeneration !== TOOL_DETAIL_EXTERNALIZATION_GENERATION) {
        terminalCandidateRunIds.add(run.runId)
      }
    } else if (liveEnabled) {
      liveRunIds.add(run.runId)
    }
  }
  const strippedActivitiesById = new Map<string, ToolActivity>()
  const opRequiredActivityIds = new Set<string>()
  const unchanged: ChatToolDetailExternalizationResult = {
    chat,
    externalizedActivityCount: 0,
    completedRunIds: [],
    strippedActivitiesById,
    opRequiredActivityIds
  }
  if (terminalCandidateRunIds.size === 0 && liveRunIds.size === 0) return unchanged

  // Lazy previous-record lookup: built on the first sealed re-delivery, keyed
  // (runId, activityId), restricted to live runs so a long history costs nothing.
  let previousActivityByKey: Map<string, ToolActivity> | null = null
  const previousMessages = options?.previousChat?.messages
  const previousActivity = (runId: string, activityId: string): ToolActivity | undefined => {
    if (!previousMessages) return undefined
    if (!previousActivityByKey) {
      previousActivityByKey = new Map()
      for (const message of previousMessages) {
        const messageRunId = message.runId
        if (!messageRunId || !liveRunIds.has(messageRunId)) continue
        const activities = message.toolActivities
        if (!Array.isArray(activities)) continue
        for (const activity of activities) {
          previousActivityByKey.set(`${messageRunId}\n${activity.id}`, activity)
        }
      }
    }
    return previousActivityByKey.get(`${runId}\n${activityId}`)
  }

  const decideLive = (runId: string, activity: ToolActivity): LiveDecision => {
    if (!hasLiveExternalizableRawDetail(activity)) return null
    // A ref alongside raw fields is a hydration echo: the archive already owns
    // those bytes, the record merge reinstated them. Strip without staging.
    if (validDetailRef(activity.detailRef)) return { kind: 'echo' }
    if (!isSealedToolActivity(activity)) return null
    const previous = previousActivity(runId, activity.id)
    if (
      previous &&
      validDetailRef(previous.detailRef) &&
      previous.status === activity.status &&
      previous.endedAt === activity.endedAt &&
      previous.durationMs === activity.durationMs &&
      !hasLiveExternalizableRawDetail(previous)
    ) {
      return { kind: 'adopt', ref: previous.detailRef }
    }
    if (estimateLiveToolActivityDetailBytes(activity) >= LIVE_TOOL_DETAIL_EXTERNALIZE_BYTES) {
      return { kind: 'stage' }
    }
    return null
  }

  // Detection pass: the steady state of a streaming save with nothing to strip
  // must not allocate a 20k-element messages array four times a second.
  let actionable = false
  for (const message of chat.messages) {
    const runId = message.runId
    const activities = message.toolActivities
    if (!runId || !Array.isArray(activities)) continue
    if (terminalCandidateRunIds.has(runId)) {
      if (activities.some(hasExternalizableToolActivityDetail)) {
        actionable = true
        break
      }
    } else if (liveRunIds.has(runId)) {
      if (activities.some((activity) => decideLive(runId, activity) !== null)) {
        actionable = true
        break
      }
    }
  }
  if (!actionable) return unchanged

  const incompleteRunIds = new Set<string>()
  let externalizedActivityCount = 0
  let messagesChanged = false
  const nextMessages = chat.messages.map((message: ChatMessage) => {
    const runId = message.runId
    const activities = message.toolActivities
    if (!runId || !Array.isArray(activities)) return message
    const terminalMessage = terminalCandidateRunIds.has(runId)
    const liveMessage = !terminalMessage && liveRunIds.has(runId)
    if (!terminalMessage && !liveMessage) return message

    let activitiesChanged = false
    const nextActivities = activities.map((activity) => {
      if (liveMessage) {
        const decision = decideLive(runId, activity)
        if (!decision) return activity
        if (decision.kind === 'echo' || decision.kind === 'adopt') {
          const ref = decision.kind === 'echo' ? activity.detailRef! : decision.ref
          const stripped = stripLiveToolDetail(activity, ref)
          strippedActivitiesById.set(activity.id, stripped)
          activitiesChanged = true
          externalizedActivityCount += 1
          return stripped
        }
        let detailRef: ToolActivityDetailRef | null = null
        try {
          detailRef = sink(runId, activity)
        } catch {
          detailRef = null
        }
        // A failed stage stays inline and simply retries on a later save; a
        // live run has no stamp to withhold.
        if (!detailRef) return activity
        const stripped = stripLiveToolDetail(activity, detailRef)
        strippedActivitiesById.set(activity.id, stripped)
        opRequiredActivityIds.add(activity.id)
        activitiesChanged = true
        externalizedActivityCount += 1
        return stripped
      }

      if (!hasExternalizableToolActivityDetail(activity)) return activity

      if (validDetailRef(activity.detailRef)) {
        // Terminal fold of a live-externalized activity: the archive owns the
        // raw trio; the record still carries bounded summaries. Stripping them
        // is only safe once the archive provably covers what is stripped.
        const archived = options?.readArchivedDetail
          ? safeReadArchivedDetail(options.readArchivedDetail, activity.detailRef)
          : null
        if (!archived) {
          incompleteRunIds.add(runId)
          return activity
        }
        const archiveCoversInline = HEAVY_TOOL_ACTIVITY_FIELDS.every(
          (field) => activity[field] === undefined || jsonEqual(activity[field], archived[field])
        )
        if (archiveCoversInline) {
          const stripped = compactToolActivityWithDetailRef(activity, activity.detailRef)
          strippedActivitiesById.set(activity.id, stripped)
          opRequiredActivityIds.add(activity.id)
          activitiesChanged = true
          externalizedActivityCount += 1
          return stripped
        }
        const { detailRef: _staleRef, ...currentWithoutRef } = activity
        // Overlay only defined values: an in-memory record can carry explicit
        // `undefined` keys, and a bare spread would clobber archived raw with
        // them. JSON round-trips never distinguish the two, so absent wins.
        const merged: ToolActivity = { ...archived }
        for (const [key, value] of Object.entries(currentWithoutRef)) {
          if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value
        }
        let refreshedRef: ToolActivityDetailRef | null = null
        try {
          refreshedRef = sink(runId, merged)
        } catch {
          refreshedRef = null
        }
        if (!refreshedRef) {
          incompleteRunIds.add(runId)
          return activity
        }
        const stripped = compactToolActivityWithDetailRef(activity, refreshedRef)
        strippedActivitiesById.set(activity.id, stripped)
        opRequiredActivityIds.add(activity.id)
        activitiesChanged = true
        externalizedActivityCount += 1
        return stripped
      }

      let detailRef: ToolActivityDetailRef | null = null
      try {
        detailRef = sink(runId, activity)
      } catch {
        detailRef = null
      }
      if (!detailRef) {
        incompleteRunIds.add(runId)
        return activity
      }
      const stripped = compactToolActivityWithDetailRef(activity, detailRef)
      strippedActivitiesById.set(activity.id, stripped)
      opRequiredActivityIds.add(activity.id)
      activitiesChanged = true
      externalizedActivityCount += 1
      return stripped
    })
    if (!activitiesChanged) return message
    messagesChanged = true
    return { ...message, toolActivities: nextActivities }
  })

  const completedRunIds: string[] = []
  let runsChanged = false
  const nextRuns = runs.map((run) => {
    if (!terminalCandidateRunIds.has(run.runId) || incompleteRunIds.has(run.runId)) return run
    completedRunIds.push(run.runId)
    runsChanged = true
    return {
      ...run,
      toolDetailExternalizationGeneration: TOOL_DETAIL_EXTERNALIZATION_GENERATION
    }
  })
  if (!messagesChanged && !runsChanged) {
    return {
      chat,
      externalizedActivityCount,
      completedRunIds,
      strippedActivitiesById,
      opRequiredActivityIds
    }
  }
  return {
    chat: {
      ...chat,
      messages: messagesChanged ? nextMessages : chat.messages,
      runs: runsChanged ? nextRuns : runs
    },
    externalizedActivityCount,
    completedRunIds,
    strippedActivitiesById,
    opRequiredActivityIds
  }
}

function safeReadArchivedDetail(
  read: (ref: ToolActivityDetailRef) => ToolActivity | null,
  ref: ToolActivityDetailRef
): ToolActivity | null {
  try {
    return read(ref)
  } catch {
    return null
  }
}

/** Legacy terminal-only entry point; live externalization stays off. */
export function externalizeTerminalToolActivityDetails(
  chat: ChatRecord,
  sink: ToolActivityDetailSink
): ChatToolDetailExternalizationResult {
  return externalizeToolActivityDetails(chat, sink)
}

function substituteActivityList(
  activities: readonly ToolActivity[] | undefined,
  strippedById: ReadonlyMap<string, ToolActivity>
): ToolActivity[] | undefined {
  if (!Array.isArray(activities)) return undefined
  let changed = false
  const next = activities.map((activity) => {
    const replacement = strippedById.get(activity.id)
    if (!replacement || replacement === activity) return activity
    changed = true
    return replacement
  })
  return changed ? next : undefined
}

function substituteMessage(
  message: ChatMessage,
  strippedById: ReadonlyMap<string, ToolActivity>
): ChatMessage | undefined {
  const substituted = substituteActivityList(message.toolActivities, strippedById)
  return substituted ? { ...message, toolActivities: substituted } : undefined
}

function substituteMessageList(
  messages: readonly ChatMessage[],
  strippedById: ReadonlyMap<string, ToolActivity>
): ChatMessage[] | undefined {
  let changed = false
  const next = messages.map((message) => {
    const substituted = substituteMessage(message, strippedById)
    if (!substituted) return message
    changed = true
    return substituted
  })
  return changed ? next : undefined
}

/**
 * Substitute externalized activity payloads into an authored mutation so the
 * durable op stream and the renderer wire both replay to the stripped record.
 * Returns the input object untouched when nothing matches.
 */
export function substituteToolActivitiesInAuthoredMutation(
  authored: AuthoredChatTranscriptMutation,
  strippedById: ReadonlyMap<string, ToolActivity>
): AuthoredChatTranscriptMutation {
  if (strippedById.size === 0) return authored
  let changed = false

  const operations = authored.operations.map((operation): ChatTranscriptMutationOperation => {
    switch (operation.type) {
      case 'messages_splice': {
        const messages = substituteMessageList(operation.messages, strippedById)
        if (!messages) return operation
        changed = true
        return { ...operation, messages }
      }
      case 'message_put': {
        const message = substituteMessage(operation.message, strippedById)
        if (!message) return operation
        changed = true
        return { ...operation, message }
      }
      case 'tool_activities_splice': {
        const activities = substituteActivityList(operation.activities, strippedById)
        if (!activities) return operation
        changed = true
        return { ...operation, activities }
      }
      case 'tool_activity_put': {
        const replacement = strippedById.get(operation.activityId)
        if (!replacement || replacement === operation.activity) return operation
        changed = true
        return { ...operation, activity: replacement }
      }
      default:
        return operation
    }
  })

  let transcriptOps: ChatTranscriptOp[] | null = authored.transcriptOps
  if (Array.isArray(authored.transcriptOps)) {
    let opsChanged = false
    const nextOps = authored.transcriptOps.map((operation): ChatTranscriptOp => {
      if (operation.op === 'append') {
        const messages = substituteMessageList(operation.messages, strippedById)
        if (!messages) return operation
        opsChanged = true
        return { ...operation, messages }
      }
      if (operation.op === 'update') {
        const message = substituteMessage(operation.message, strippedById)
        if (!message) return operation
        opsChanged = true
        return { ...operation, message }
      }
      return operation
    })
    if (opsChanged) {
      transcriptOps = nextOps
      changed = true
    }
  }

  if (!changed) return authored
  return { ...authored, operations, transcriptOps }
}

/**
 * True when the authored ops mention every one of the given activity ids —
 * the precondition for trusting authored ops on a save whose externalization
 * rewrote activities the previous record did not already hold in that form.
 */
export function authoredMutationMentionsActivityIds(
  authored: AuthoredChatTranscriptMutation,
  activityIds: ReadonlySet<string>
): boolean {
  if (activityIds.size === 0) return true
  const mentioned = new Set<string>()
  const noteActivities = (activities: readonly ToolActivity[] | undefined): void => {
    if (!Array.isArray(activities)) return
    for (const activity of activities) mentioned.add(activity.id)
  }
  for (const operation of authored.operations) {
    switch (operation.type) {
      case 'messages_splice':
        for (const message of operation.messages) noteActivities(message.toolActivities)
        break
      case 'message_put':
        noteActivities(operation.message.toolActivities)
        break
      case 'tool_activities_splice':
        noteActivities(operation.activities)
        break
      case 'tool_activity_put':
        mentioned.add(operation.activityId)
        break
      default:
        break
    }
  }
  for (const id of activityIds) {
    if (!mentioned.has(id)) return false
  }
  return true
}
