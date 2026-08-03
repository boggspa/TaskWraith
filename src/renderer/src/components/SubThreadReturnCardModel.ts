import type { ChatMessage } from '../../../main/store/types'

export function isSubThreadReturnMessage(message: ChatMessage): boolean {
  return (
    (message.role === 'tool' || message.role === 'system') &&
    message.metadata?.kind === 'subThreadReturn'
  )
}

export function linkedChildReturnRelation(message: ChatMessage): 'subThread' | 'sideChat' {
  return message.metadata?.linkedChildRelation === 'sideChat' ? 'sideChat' : 'subThread'
}

export function subThreadReturnBody(content: string): string {
  const tagged = content.match(
    /<(?:subthread_result|side_chat_result)(?:\s[^>]*)?>\n?([\s\S]*)\n?<\/(?:subthread_result|side_chat_result)>/
  )
  if (tagged) return tagged[1].trim()
  const lines = content.split(/\r?\n/)
  if (!lines[0]?.startsWith('↩ Result from ')) return content
  const bodyStart = lines[1]?.trim() === '' ? 2 : 1
  return lines.slice(bodyStart).join('\n').trimStart()
}
