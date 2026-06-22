import type { ChatMessage } from '../../../main/store/types'

function isExactDoubledContent(liveContent: string, incomingContent: string): boolean {
  if (!incomingContent) return false
  if (liveContent.length !== incomingContent.length * 2) return false
  return liveContent === `${incomingContent}${incomingContent}`
}

export function shouldPreferLiveAssistantContent(
  incoming: ChatMessage,
  live: ChatMessage | undefined
): boolean {
  if (!live || live.role !== 'assistant' || incoming.role !== 'assistant') return false
  const liveContent = live.content || ''
  const incomingContent = incoming.content || ''
  if (liveContent.length <= incomingContent.length) return false
  // During active/recent runs the renderer keeps longer live assistant text
  // over stale chat-updated broadcasts. If the longer text is exactly a
  // duplicated copy of the authoritative incoming text, prefer the broadcast so
  // a local cumulative-append glitch can self-heal instead of sticking around.
  if (isExactDoubledContent(liveContent, incomingContent)) return false
  return true
}
