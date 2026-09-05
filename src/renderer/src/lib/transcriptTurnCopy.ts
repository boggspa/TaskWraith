import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  HydratedToolActivityDetail,
  ToolActivity,
  ToolActivityDetailRef
} from '../../../main/store/types'
import { groupedTranscriptMessageIds } from './transcriptToolMessageGrouping'

/** A turn is one recorded run, including its prompt, even when other seats
 * interleave with it. Legacy messages fall back to the enclosing user turn. */
export function selectTranscriptTurnMessages(
  messages: readonly ChatMessage[],
  target: ChatMessage,
  runs: readonly ChatRun[] = []
): ChatMessage[] {
  const ids = new Set([target.id, ...groupedTranscriptMessageIds(target)])
  const index = messages.findIndex((message) => ids.has(message.id))
  if (index < 0) return []
  const source = messages[index]
  const runId = source.runId || runs.find((run) => run.promptMessageId === source.id)?.runId
  if (runId) {
    const promptId = runs.find((run) => run.runId === runId)?.promptMessageId
    return messages.filter((message) => message.runId === runId || message.id === promptId)
  }
  let start = index
  while (start > 0 && messages[start].role !== 'user') start -= 1
  let end = index + 1
  while (end < messages.length && messages[end].role !== 'user') end += 1
  return messages.slice(start, end)
}

function fenced(text: string, language = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function activityMarkdown(activity: ToolActivity): string {
  const output = activity.resultSummary || activity.outputSummary || activity.outputPreview
  return [
    `### ${activity.displayName || activity.toolName} (${activity.status})`,
    activity.parameters && Object.keys(activity.parameters).length > 0
      ? fenced(JSON.stringify(activity.parameters, null, 2), 'json')
      : '',
    output || ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function transcriptTurnMarkdown(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => {
      const metadata = message.metadata
      const owner = metadata?.ensembleRole || metadata?.ensembleProvider || message.role
      return [
        `## ${owner}${message.timestamp ? ` · ${message.timestamp}` : ''}`,
        message.content,
        ...(message.toolActivities || []).map(activityMarkdown)
      ]
        .filter(Boolean)
        .join('\n\n')
    })
    .join('\n\n---\n\n')
}

export interface TranscriptTurnCopySource {
  chat: ChatRecord | null
  messages: readonly ChatMessage[]
}

interface TranscriptTurnCopyApi {
  getChat: (chatId: string) => Promise<ChatRecord | null>
  getToolActivityDetails: (refs: ToolActivityDetailRef[]) => Promise<HydratedToolActivityDetail[]>
}

/** Load history only on click: viewport paging/folds must never truncate a
 * turn copy. Overlay the current window to include unflushed streaming text. */
export async function loadTranscriptTurnMarkdown(
  source: TranscriptTurnCopySource,
  target: ChatMessage,
  api: TranscriptTurnCopyApi
): Promise<string> {
  const chat = source.chat?.appChatId ? await api.getChat(source.chat.appChatId) : source.chat
  if (source.chat?.appChatId && !chat) throw new Error('This task could not be loaded.')
  const liveById = new Map(source.messages.map((message) => [message.id, message]))
  const messages = (chat?.messages || []).map((message) => {
    const live = liveById.get(message.id)
    liveById.delete(message.id)
    return live || message
  })
  messages.push(...liveById.values())
  messages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
  const selected = selectTranscriptTurnMessages(messages, target, chat?.runs)
  if (selected.length === 0) throw new Error('This turn is no longer available.')
  const refs = selected.flatMap((message) =>
    (message.toolActivities || []).flatMap((activity) =>
      activity.detailRef ? [activity.detailRef] : []
    )
  )
  const hydrated = new Map<string, ToolActivity>()
  // Keep each request within the existing activity-detail IPC batch limit.
  for (let index = 0; index < refs.length; index += 512) {
    const batch = refs.slice(index, index + 512)
    const details = await api.getToolActivityDetails(batch)
    for (const detail of details) hydrated.set(JSON.stringify(detail.ref), detail.activity)
    if (batch.some((ref) => !hydrated.has(JSON.stringify(ref)))) {
      throw new Error('Some turn activity could not be loaded. Try copying again.')
    }
  }
  return transcriptTurnMarkdown(
    selected.map((message) => ({
      ...message,
      toolActivities: message.toolActivities?.map((activity) =>
        activity.detailRef
          ? { ...activity, ...hydrated.get(JSON.stringify(activity.detailRef)) }
          : activity
      )
    }))
  )
}
