import type { ChatRecord } from './types'
import {
  copyThreadCatalogueChrome,
  type ThreadCatalogueChrome
} from '../../host-shared/thread-catalogue/ThreadCatalogueChrome'
export * from '../../host-shared/thread-catalogue/ThreadCatalogueChrome'
export function projectThreadCatalogueChrome(chat: ChatRecord): ThreadCatalogueChrome {
  const chrome = copyThreadCatalogueChrome(chat)
  let lastUserMessageAt: number | undefined
  let preview = ''
  const recent: string[] = []
  for (let index = (chat.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = chat.messages[index]
    if (!preview && typeof message.content === 'string') preview = message.content.slice(0, 1024)
    if (recent.length < 8 && typeof message.content === 'string')
      recent.push(message.content.slice(0, 180))
    if (message.role === 'user' && lastUserMessageAt === undefined) {
      const timestamp = Date.parse(message.timestamp)
      if (Number.isFinite(timestamp)) lastUserMessageAt = timestamp
    }
    if (recent.length >= 8 && lastUserMessageAt !== undefined) break
  }
  chrome.searchText = [chat.title, chat.provider, chat.appChatId, ...recent]
    .filter(Boolean)
    .join(' ')
    .slice(0, 4096)
  chrome.searchPreview = preview
  if (lastUserMessageAt !== undefined) chrome.lastUserMessageAt = lastUserMessageAt
  return chrome
}
