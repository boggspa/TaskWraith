import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import {
  applyChatTranscriptOps,
  plainDataEqual,
  type ChatTranscriptOp
} from '../../../shared/chatUpdateTransport'
import {
  buildTailChatTranscriptOps,
  chatPersistenceRevision
} from '../../../shared/rendererChatTranscriptMutation'
function messageById(messages: readonly ChatMessage[], id: string): ChatMessage | undefined {
  return messages.find((message) => message.id === id)
}

export function rebaseTailTranscript(
  base: ChatRecord,
  target: ChatRecord,
  canonical: ChatRecord
): { target: ChatRecord; ops: ChatTranscriptOp[] } | null {
  const desiredOps = buildTailChatTranscriptOps(base.messages, target.messages)
  if (!desiredOps) return null
  const applicable: ChatTranscriptOp[] = []

  for (const operation of desiredOps) {
    if (operation.op === 'append') {
      const canonicalById = new Map(canonical.messages.map((message) => [message.id, message]))
      const existing = operation.messages.filter((message) => canonicalById.has(message.id))
      if (existing.length === operation.messages.length) {
        if (existing.every((message) => plainDataEqual(canonicalById.get(message.id), message))) {
          continue
        }
        return null
      }
      if (existing.length > 0) return null
      applicable.push(operation)
      continue
    }

    const canonicalMessage = messageById(canonical.messages, operation.id)
    const baseMessage = messageById(base.messages, operation.id)
    if (operation.op === 'update') {
      if (plainDataEqual(canonicalMessage, operation.message)) continue
      if (!canonicalMessage || !baseMessage || !plainDataEqual(canonicalMessage, baseMessage)) {
        return null
      }
      applicable.push(operation)
      continue
    }

    if (!canonicalMessage) continue
    if (!baseMessage || !plainDataEqual(canonicalMessage, baseMessage)) return null
    applicable.push(operation)
  }

  const messages = applyChatTranscriptOps(canonical.messages, applicable)
  if (!messages) return null
  return {
    target: { ...canonical, messages },
    ops: applicable
  }
}

export function hasOnlyTranscriptChanges(base: ChatRecord, target: ChatRecord): boolean {
  const ignored = new Set(['messages', 'updatedAt', 'persistenceRevision'])
  for (const key of new Set([...Object.keys(base), ...Object.keys(target)])) {
    if (ignored.has(key)) continue
    if (
      !plainDataEqual(
        (base as unknown as Record<string, unknown>)[key],
        (target as unknown as Record<string, unknown>)[key]
      )
    )
      return false
  }
  return true
}

export interface RendererRecordAdvance {
  record: ChatRecord
  pending: boolean
  conflicts: string[]
}

/** Keep the accepted record complete; replay only edits made after the submitted target. */
export function advanceRendererRecord(
  before: ChatRecord,
  next: ChatRecord,
  current: ChatRecord | null | undefined
): RendererRecordAdvance {
  if (!current) return { record: next, pending: false, conflicts: [] }
  if (chatPersistenceRevision(current) > chatPersistenceRevision(next))
    return { record: current, pending: true, conflicts: [] }
  const conflicts: string[] = []
  const merge = (old: unknown, accepted: unknown, local: unknown, path: string): unknown => {
    if (plainDataEqual(local, old) || plainDataEqual(local, accepted)) return accepted
    if (plainDataEqual(accepted, old)) return local
    if (
      old &&
      accepted &&
      local &&
      typeof old === 'object' &&
      typeof accepted === 'object' &&
      typeof local === 'object' &&
      !Array.isArray(old) &&
      !Array.isArray(accepted) &&
      !Array.isArray(local)
    ) {
      const a = old as Record<string, unknown>,
        b = accepted as Record<string, unknown>,
        c = local as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)])) {
        const value = merge(a[key], b[key], c[key], `${path}.${key}`)
        if (value !== undefined) result[key] = value
      }
      return result
    }
    conflicts.push(path)
    return local
  }
  const oldRuns = new Map((before.runs ?? []).map((run) => [run.runId, run]))
  const localRuns = new Map((current.runs ?? []).map((run) => [run.runId, run]))
  const nextRuns = new Map((next.runs ?? []).map((run) => [run.runId, run]))
  const runs = [...new Set([...nextRuns.keys(), ...localRuns.keys()])].flatMap((id): ChatRun[] => {
    const value = merge(oldRuns.get(id), nextRuns.get(id), localRuns.get(id), `runs.${id}`) as
      | ChatRun
      | undefined
    const canonical = nextRuns.get(id)
    if (
      canonical?.staleSettlementProvenance &&
      canonical.endedAt &&
      (!value ||
        !value.status ||
        ['running', 'active', 'queued', 'starting', 'paused', 'cancelling'].includes(value.status))
    ) {
      conflicts.push(`runs.${id}.status`)
      return [canonical]
    }
    return value ? [value] : []
  })
  const record = { ...next, runs } as ChatRecord
  const ignored = new Set(['messages', 'runs', 'updatedAt', 'persistenceRevision'])
  for (const key of new Set([
    ...Object.keys(before),
    ...Object.keys(next),
    ...Object.keys(current)
  ])) {
    if (ignored.has(key)) continue
    const value = merge(
      (before as unknown as Record<string, unknown>)[key],
      (next as unknown as Record<string, unknown>)[key],
      (current as unknown as Record<string, unknown>)[key],
      key
    )
    if (value === undefined) delete (record as unknown as Record<string, unknown>)[key]
    else (record as unknown as Record<string, unknown>)[key] = value
  }
  if (!plainDataEqual(before.messages, current.messages)) {
    const rebased = rebaseTailTranscript(before, current, next)
    if (rebased) record.messages = rebased.target.messages
    else {
      conflicts.push('messages')
      record.messages = current.messages
      record.persistenceRevision = before.persistenceRevision
    }
  }
  if (chatPersistenceRevision(current) < chatPersistenceRevision(before))
    conflicts.push('persistenceRevision')
  if (conflicts.length) record.persistenceRevision = current.persistenceRevision
  const pending = conflicts.length > 0 || !plainDataEqual(record, next)
  return { record, pending, conflicts: [...new Set(conflicts)] }
}
