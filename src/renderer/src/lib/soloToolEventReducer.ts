import type { ChatMessage, ProviderId, ToolActivity } from '../../../main/store/types'
import { createToolActivity, isToolResultEvent, isToolUseEvent, pairToolResult } from './ToolParser'

interface SoloToolEventReducerOptions {
  createMessageId: () => string
  nowIso?: () => string
  provider?: ProviderId
  runId?: string
}

export interface SoloToolEventReduction {
  messages: ChatMessage[]
  latestToolActivity: ToolActivity | null
  isResult: boolean
}

function toolEventId(event: any): string {
  return (
    event?.data?.tool_id ||
    event?.data?.toolId ||
    event?.data?.id ||
    event?.data?.call_id ||
    `unknown-${Date.now()}`
  )
}

function eventDataWithProvider(data: any, event: any, fallbackProvider?: ProviderId): any {
  const provider = data?.provider ?? event?.provider ?? fallbackProvider
  if (!provider) return data
  const base = data && typeof data === 'object' ? data : {}
  return { ...base, provider }
}

/**
 * Find the message (within the current turn) whose ActivityStack owns the
 * activity `toolId`, scanning backward from the tail and stopping at the
 * turn boundary (a user message — tool calls never span turns). Bounded and
 * chronology-preserving: a result/update belongs at the CALL's position,
 * however many assistant bubbles or system cards streamed in after it.
 */
function findOwningToolMessageIndex(messages: ChatMessage[], toolId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user') break
    if (message.role !== 'tool' && !(message.toolActivities?.length)) continue
    if ((message.toolActivities || []).some((activity) => activity.id === toolId)) return i
  }
  return -1
}

export function reduceSoloToolEventMessages(
  messages: ChatMessage[],
  event: any,
  options: SoloToolEventReducerOptions
): SoloToolEventReduction {
  const createToolMessage = (): ChatMessage => ({
    id: options.createMessageId(),
    role: 'tool',
    content: '',
    timestamp: options.nowIso?.() || new Date().toISOString(),
    ...(options.runId ? { runId: options.runId } : {}),
    toolActivities: []
  })

  const tData = event.data
  const activityData = eventDataWithProvider(tData, event, options.provider)
  const isUse = event.isUse || isToolUseEvent(tData)
  const isResult = event.isResult || isToolResultEvent(tData)
  const tId = toolEventId(event)

  // A result targets the activity WHERE THE CALL RENDERED — search the
  // current turn before considering the tail. Pairing only within the
  // trailing message orphan-duplicated any tool whose result arrived after
  // an assistant bubble or system card had streamed in below it: the
  // original stayed "running" forever in its stack while a settled twin
  // appeared in a fresh stack after the text — the reported
  // chronology-violation symptom. (Per-delta thinking results hit this on
  // every interleaved turn.)
  if (isResult && tId) {
    const owningIndex = findOwningToolMessageIndex(messages, tId)
    if (owningIndex >= 0) {
      const owner = messages[owningIndex]
      const acts = [...(owner.toolActivities || [])]
      const idx = acts.findIndex((activity) => activity.id === tId)
      if (idx >= 0) {
        acts[idx] = pairToolResult(acts[idx], tData)
        return {
          messages: [
            ...messages.slice(0, owningIndex),
            { ...owner, toolActivities: acts },
            ...messages.slice(owningIndex + 1)
          ],
          latestToolActivity: acts[idx],
          isResult
        }
      }
    }
  }

  let nextMessages = messages
  let lastMsgIndex = nextMessages.length - 1
  let lastMsg = nextMessages[lastMsgIndex]
  // Only collapse into an EXISTING tool row when it is the trailing message —
  // i.e. consecutive tool events with no text between them. If the last
  // message is anything else (most commonly a trailing assistant streamed
  // between two tool bursts), start a NEW tool row appended at the end so the
  // tools land at their true sequence position. Reaching back past a trailing
  // assistant to the prior tool row would merge tool bursts that are separated
  // by text into one ActivityStack, destroying the interleaving (text → tools
  // → text → tools collapses to [all tools] → [all text]).
  //
  // A kind-tagged tool row is a transcript CARD (sub-thread return, guest
  // participant reply, …), rendered by its own component ahead of the
  // ActivityStack branch — activities pushed into one are never drawn. Main
  // appends the sub-thread return card as role:'tool' mid-run, so adopting it
  // here froze the transcript for the rest of the burst (2026-08-26: 110
  // events, 8 commits, invisible until the next assistant message). Cards
  // must open a NEW row; only metadata-less burst rows are adoptable.
  if (nextMessages.length === 0 || lastMsg?.role !== 'tool' || lastMsg?.metadata?.kind) {
    const toolMessage = createToolMessage()
    nextMessages = [...nextMessages, toolMessage]
    lastMsgIndex = nextMessages.length - 1
    lastMsg = toolMessage
  }

  const acts = [...(lastMsg.toolActivities || [])]
  let latestToolActivity: ToolActivity | null = null

  if (isUse) {
    const newActivity = createToolActivity(activityData)
    acts.push(newActivity)
    latestToolActivity = newActivity
  } else if (isResult) {
    // Unknown id anywhere in the turn — keep the orphan fallback so the
    // result is never dropped (e.g. a use lost to a reload mid-run).
    const orphan = createToolActivity({
      type: 'tool_use',
      tool_id: tId,
      tool_name: event.name || 'unknown',
      ...(activityData?.provider ? { provider: activityData.provider } : {})
    })
    const paired = pairToolResult(orphan, tData)
    acts.push(paired)
    latestToolActivity = paired
  } else {
    const fallback = createToolActivity({
      type: 'tool_use',
      tool_id: tId,
      tool_name: event.name || 'unknown',
      ...activityData
    })
    fallback.status = 'success'
    acts.push(fallback)
    latestToolActivity = fallback
  }

  return {
    messages: [
      ...nextMessages.slice(0, lastMsgIndex),
      { ...lastMsg, toolActivities: acts },
      ...nextMessages.slice(lastMsgIndex + 1)
    ],
    latestToolActivity,
    isResult
  }
}
