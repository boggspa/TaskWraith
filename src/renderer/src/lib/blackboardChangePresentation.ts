import type { ChatMessage } from '../../../main/store/types'
import {
  BLACKBOARD_CHANGE_KIND,
  isBlackboardChangePayload,
  type BlackboardChangePayload
} from '../../../shared/blackboardChange'

export type LegacyBlackboardChangePresentation =
  | {
      action: 'updated'
      category: Extract<BlackboardChangePayload, { action: 'updated' }>['category']
      key: string
      changedAt: string
    }
  | { action: 'cleaned'; removedCount: number; changedAt: string }
  | { action: 'pollOpened'; key: string; optionCount: number; changedAt: string }

export type BlackboardChangePresentation =
  | BlackboardChangePayload
  | LegacyBlackboardChangePresentation

const LEGACY_BLACKBOARD_UPDATED =
  /^Blackboard updated: (decision|fact|risk|do-not-repeat|note) \/ (.{1,80})\.$/
const LEGACY_BLACKBOARD_CLEANED = /^Blackboard cleaned: removed (\d{1,2}) (entry|entries)\.$/
const LEGACY_BLACKBOARD_POLL = /^Blackboard poll opened: (.{1,80}) \((\d) choices\)\.$/

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

/** Strict display-only promotion for structured and canonical legacy rows. */
export function resolveBlackboardChangePresentation(
  message: ChatMessage
): BlackboardChangePresentation | null {
  const candidate = message.metadata?.blackboardChange
  if (candidate !== undefined) {
    if (message.role !== 'system' || message.metadata?.kind !== BLACKBOARD_CHANGE_KIND) return null
    return isBlackboardChangePayload(candidate) ? candidate : null
  }
  if (
    message.role !== 'system' ||
    message.metadata?.kind !== 'ensembleRoundStatus' ||
    typeof message.content !== 'string' ||
    !Number.isFinite(Date.parse(message.timestamp)) ||
    message.content.length > 160 ||
    message.content.includes('\n')
  ) {
    return null
  }
  const updated = message.content.match(LEGACY_BLACKBOARD_UPDATED)
  if (updated) {
    if (hasControlCharacters(updated[2])) return null
    return {
      action: 'updated',
      category: updated[1] as Extract<BlackboardChangePayload, { action: 'updated' }>['category'],
      key: updated[2],
      changedAt: message.timestamp
    }
  }
  const poll = message.content.match(LEGACY_BLACKBOARD_POLL)
  if (poll) {
    const optionCount = Number(poll[2])
    if (hasControlCharacters(poll[1]) || optionCount < 2 || optionCount > 6) return null
    return {
      action: 'pollOpened',
      key: poll[1],
      optionCount,
      changedAt: message.timestamp
    }
  }
  const cleaned = message.content.match(LEGACY_BLACKBOARD_CLEANED)
  if (!cleaned) return null
  const removedCount = Number(cleaned[1])
  const expectedNoun = removedCount === 1 ? 'entry' : 'entries'
  if (removedCount < 1 || removedCount > 60 || cleaned[2] !== expectedNoun) return null
  return { action: 'cleaned', removedCount, changedAt: message.timestamp }
}
