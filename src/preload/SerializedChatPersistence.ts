import type { ChatRecord } from '../main/store/types'

type CanonicalChatResult = ChatRecord | null

export interface CanonicalChatSaveResult {
  chat: ChatRecord
  previous: ChatRecord | null
  accepted: boolean
}

/**
 * What a canonical refusal discarded.
 *
 * `ChatService.saveChatInternal` rejects a whole-record save whose
 * `persistenceRevision` does not match the canonical record and returns that
 * canonical record unchanged, so the caller's promise RESOLVES and every field
 * the payload authored is dropped. In the field that is indistinguishable from
 * a renderer-side pre-revert, a fence throw, or a delivery that simply never
 * carried the edit — which is why "I set it and it came back" has been
 * diagnosed three times from structure alone. Reporting the refusal makes the
 * revision gap and the discarded field set observable at the moment it happens.
 */
export interface ChatSaveRejection {
  chatId: string
  /** Revision the payload was derived from. */
  snapshotRevision: number
  /** Revision the canonical record actually holds. */
  canonicalRevision: number
  /** Top-level fields whose authored value the refusal discarded. */
  discardedFields: string[]
  /** Whether this payload had already been rebased onto a known lineage. */
  rebased: boolean
}

interface AcceptedChatLineage {
  /** Exact main-returned canonical records that still have queued descendants. */
  basesByRevision: Map<number, ChatRecord>
  /** Latest accepted canonical record produced from this lineage. */
  canonical: ChatRecord
}

const MAIN_OWNED_FIELDS = new Set<keyof ChatRecord>([
  'persistenceRevision',
  'updatedAt'
])

/** Fields whose values jointly describe host/workspace ownership. */
const WORKSPACE_IDENTITY_FIELDS: ReadonlyArray<keyof ChatRecord> = [
  'appChatId',
  'scope',
  'workspaceId',
  'workspacePath',
  'parentChatId',
  'parentChatRelation',
  'sideChatContext',
  'forkContext',
  'delegationContext'
]

/**
 * Runtime continuity and signed-grant state can span several top-level fields.
 * Never synthesize a combination when both sides changed this group.
 */
const SESSION_AND_GRANT_FIELDS: ReadonlyArray<keyof ChatRecord> = [
  'provider',
  'linkedProviderSessionId',
  'linkedGeminiSessionId',
  'taskWraithMcpProfileReceipt',
  'seatGeneration',
  'contextCompactionSummary',
  'providerMetadata',
  'ensemble',
  'runs',
  'settingsSnapshot',
  'requestedModel',
  'lastActualModel'
]

/**
 * Chat records are structured-clone/JSON-shaped data. Keep equality local to
 * the sandboxed preload instead of importing Node's `util`, which Electron's
 * sandbox intentionally does not expose to preload scripts.
 */
function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false
  }

  const leftIsArray = Array.isArray(left)
  if (leftIsArray !== Array.isArray(right)) return false
  if (leftIsArray) {
    const leftArray = left as unknown[]
    const rightArray = right as unknown[]
    if (leftArray.length !== rightArray.length) return false
    for (let index = 0; index < leftArray.length; index += 1) {
      if (!isDeepStrictEqual(leftArray[index], rightArray[index])) return false
    }
    return true
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      isDeepStrictEqual(leftRecord[key], rightRecord[key])
  )
}

/** Default reporter: the preload has no logger of its own, and the renderer
 *  console is where a live repro is already being watched. */
function reportChatSaveRejection(rejection: ChatSaveRejection): void {
  console.warn(
    `[chat-save] canonical refused a stale whole-record save for ${rejection.chatId}: ` +
      `payload revision ${rejection.snapshotRevision} vs canonical ${rejection.canonicalRevision}` +
      `${rejection.rebased ? ' (rebased)' : ''}. Discarded: ` +
      `${rejection.discardedFields.length > 0 ? rejection.discardedFields.join(', ') : '(nothing)'}`
  )
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'> | null): number {
  const revision = chat?.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}

function hasField(record: ChatRecord, field: keyof ChatRecord): boolean {
  return Object.prototype.hasOwnProperty.call(record, field)
}

function sameField(
  left: ChatRecord,
  right: ChatRecord,
  field: keyof ChatRecord
): boolean {
  const leftHasField = hasField(left, field)
  if (leftHasField !== hasField(right, field)) return false
  return !leftHasField || isDeepStrictEqual(left[field], right[field])
}

function groupChanged(
  base: ChatRecord,
  snapshot: ChatRecord,
  fields: ReadonlyArray<keyof ChatRecord>
): boolean {
  return fields.some((field) => !sameField(base, snapshot, field))
}

function sameGroup(
  left: ChatRecord,
  right: ChatRecord,
  fields: ReadonlyArray<keyof ChatRecord>
): boolean {
  return fields.every((field) => sameField(left, right, field))
}

function protectedGroupConflicts(
  base: ChatRecord,
  canonical: ChatRecord,
  candidate: ChatRecord,
  fields: ReadonlyArray<keyof ChatRecord>
): boolean {
  return (
    groupChanged(base, canonical, fields) &&
    groupChanged(base, candidate, fields) &&
    !sameGroup(canonical, candidate, fields)
  )
}

/**
 * Merge only disjoint top-level changes. Nested edits to the same top-level
 * field are deliberately conflicts: without field-specific semantics there is
 * no honest way to know whether an array deletion, session update, or grant
 * mutation may be combined.
 */
function rebaseQueuedSnapshot(
  base: ChatRecord,
  canonical: ChatRecord,
  candidate: ChatRecord
): ChatRecord | null {
  const baseRevision = persistenceRevision(base)
  const canonicalRevision = persistenceRevision(canonical)
  if (
    candidate.appChatId !== base.appChatId ||
    canonical.appChatId !== base.appChatId ||
    persistenceRevision(candidate) !== baseRevision ||
    canonicalRevision <= baseRevision
  ) {
    return null
  }

  if (
    protectedGroupConflicts(base, canonical, candidate, WORKSPACE_IDENTITY_FIELDS) ||
    protectedGroupConflicts(base, canonical, candidate, SESSION_AND_GRANT_FIELDS)
  ) {
    return null
  }

  const merged: Partial<ChatRecord> = {}
  const fields = new Set<keyof ChatRecord>([
    ...(Object.keys(base) as Array<keyof ChatRecord>),
    ...(Object.keys(canonical) as Array<keyof ChatRecord>),
    ...(Object.keys(candidate) as Array<keyof ChatRecord>)
  ])
  for (const field of fields) {
    if (MAIN_OWNED_FIELDS.has(field)) continue
    const canonicalChanged = !sameField(base, canonical, field)
    const candidateChanged = !sameField(base, candidate, field)
    const source = !candidateChanged
      ? canonical
      : !canonicalChanged
        ? candidate
        : sameField(canonical, candidate, field)
          ? canonical
          : null
    if (!source) return null
    if (hasField(source, field)) {
      ;(merged as Record<keyof ChatRecord, unknown>)[field] = source[field]
    }
  }

  // Main owns both values. Preserve its exact timestamp and advance only to
  // the canonical revision that this three-way merge was based upon.
  merged.updatedAt = canonical.updatedAt
  merged.persistenceRevision = canonicalRevision
  return merged as ChatRecord
}

/**
 * Serialize whole-record chat writes inside one renderer process.
 *
 * Queue order is not proof that one snapshot was derived from another: two
 * renderer components can enqueue independent whole-record clones carrying the
 * same optimistic revision. Advance a queued save only after rebasing its
 * disjoint top-level changes against main's exact prior + accepted records;
 * otherwise main's CAS rejects the original stale clone without losing data.
 */
export class SerializedChatPersistence {
  private readonly tails = new Map<string, Promise<CanonicalChatResult>>()
  private readonly acceptedLineageByChatId = new Map<string, AcceptedChatLineage>()
  private readonly pendingRevisionCountsByChatId = new Map<string, Map<number, number>>()

  constructor(
    private readonly saveRemote: (chat: ChatRecord) => Promise<CanonicalChatSaveResult>,
    private readonly onRejected: (rejection: ChatSaveRejection) => void = reportChatSaveRejection
  ) {}

  /**
   * Observation only: never changes what `save` returns, what the lineage
   * retains, or whether a caller sees an error. A reporter that throws is
   * swallowed for the same reason.
   */
  private reportRejection(
    chatId: string,
    payload: ChatRecord,
    canonical: ChatRecord,
    rebased: boolean
  ): void {
    try {
      const discardedFields: string[] = []
      const fields = new Set<keyof ChatRecord>([
        ...(Object.keys(payload) as Array<keyof ChatRecord>),
        ...(Object.keys(canonical) as Array<keyof ChatRecord>)
      ])
      for (const field of fields) {
        if (MAIN_OWNED_FIELDS.has(field)) continue
        if (!sameField(payload, canonical, field)) discardedFields.push(String(field))
      }
      this.onRejected({
        chatId,
        snapshotRevision: persistenceRevision(payload),
        canonicalRevision: persistenceRevision(canonical),
        discardedFields: discardedFields.sort(),
        rebased
      })
    } catch {
      // A diagnostic must never alter the outcome of a save.
    }
  }

  save(chat: ChatRecord): Promise<ChatRecord> {
    const chatId = chat.appChatId
    // Capture the whole-record snapshot at invocation time. A queued IPC call
    // must not observe later in-place mutations made by its renderer caller.
    const snapshot = structuredClone(chat)
    const snapshotRevision = persistenceRevision(snapshot)
    this.retainPendingRevision(chatId, snapshotRevision)
    return this.enqueue(chatId, async () => {
      try {
        const lineage = this.acceptedLineageByChatId.get(chatId)
        const base = lineage?.basesByRevision.get(snapshotRevision)
        const rebased =
          lineage && base
            ? rebaseQueuedSnapshot(base, lineage.canonical, snapshot)
            : null
        const payload = rebased ?? snapshot
        const result = await this.saveRemote(payload)
        if (result.accepted === false) {
          this.reportRejection(chatId, payload, result.chat, rebased !== null)
        }
        if (result.accepted && result.previous) {
          const previous = structuredClone(result.previous)
          const canonical = structuredClone(result.chat)
          const extendsKnownLineage =
            lineage && isDeepStrictEqual(lineage.canonical, previous)
          const basesByRevision = extendsKnownLineage
            ? new Map(lineage.basesByRevision)
            : new Map<number, ChatRecord>()
          basesByRevision.set(persistenceRevision(previous), previous)
          basesByRevision.set(persistenceRevision(canonical), canonical)
          this.acceptedLineageByChatId.set(chatId, {
            basesByRevision,
            canonical
          })
        } else if (
          !lineage ||
          !isDeepStrictEqual(lineage.canonical, result.chat)
        ) {
          // A rejection may report a canonical record from outside this known
          // lineage. Do not use stale renderer history to advance later saves.
          this.acceptedLineageByChatId.delete(chatId)
        }
        return result.chat
      } catch (error) {
        // IPC failure is ambiguous: main may have committed before the reply
        // was lost. Discard the lineage rather than lending that revision.
        this.acceptedLineageByChatId.delete(chatId)
        throw error
      } finally {
        this.releasePendingRevision(chatId, snapshotRevision)
      }
    }) as Promise<ChatRecord>
  }

  /** Serialize another canonical chat mutation (for example `/clear`). */
  run(
    chatId: string,
    operation: () => Promise<CanonicalChatResult>
  ): Promise<CanonicalChatResult> {
    return this.enqueue(chatId, async () => {
      const result = await operation()
      // No exact pre-mutation base accompanies arbitrary canonical operations,
      // so they terminate any renderer-side rebase lineage.
      this.acceptedLineageByChatId.delete(chatId)
      return result
    })
  }

  private retainPendingRevision(chatId: string, revision: number): void {
    const counts =
      this.pendingRevisionCountsByChatId.get(chatId) ?? new Map<number, number>()
    counts.set(revision, (counts.get(revision) ?? 0) + 1)
    this.pendingRevisionCountsByChatId.set(chatId, counts)
  }

  private releasePendingRevision(chatId: string, revision: number): void {
    const counts = this.pendingRevisionCountsByChatId.get(chatId)
    if (counts) {
      const nextCount = (counts.get(revision) ?? 1) - 1
      if (nextCount > 0) counts.set(revision, nextCount)
      else counts.delete(revision)
      if (counts.size === 0) this.pendingRevisionCountsByChatId.delete(chatId)
    }

    const lineage = this.acceptedLineageByChatId.get(chatId)
    if (!lineage) return
    // Accepted records exist only to rebase snapshots that were already queued
    // from an older revision. Once the last pending revision drains there is no
    // descendant left that can consume this lineage, so retaining `canonical`
    // would pin one complete ChatRecord (including its transcript) for the
    // lifetime of every renderer preload.
    if (!counts || counts.size === 0) {
      this.acceptedLineageByChatId.delete(chatId)
      return
    }
    const canonicalRevision = persistenceRevision(lineage.canonical)
    for (const knownRevision of lineage.basesByRevision.keys()) {
      if (knownRevision !== canonicalRevision && !counts?.has(knownRevision)) {
        lineage.basesByRevision.delete(knownRevision)
      }
    }
  }

  private enqueue(
    chatId: string,
    operation: () => Promise<CanonicalChatResult>
  ): Promise<CanonicalChatResult> {
    const previous = this.tails.get(chatId)
    const queued = (previous ? previous.catch(() => null) : Promise.resolve(null)).then(
      operation
    )
    const tracked: Promise<CanonicalChatResult> = queued.finally(() => {
      if (this.tails.get(chatId) === tracked) this.tails.delete(chatId)
    })
    this.tails.set(chatId, tracked)
    return tracked
  }
}
