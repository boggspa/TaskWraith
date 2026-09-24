import type { ChatRecord } from './types'
import {
  buildThreadCatalogueSearchText,
  computeThreadCatalogueSearchScan,
  copyThreadCatalogueChrome,
  type ThreadCatalogueChrome
} from '../../host-shared/thread-catalogue/ThreadCatalogueChrome'
export * from '../../host-shared/thread-catalogue/ThreadCatalogueChrome'
export function projectThreadCatalogueChrome(chat: ChatRecord): ThreadCatalogueChrome {
  const chrome = copyThreadCatalogueChrome(chat)
  const scan = computeThreadCatalogueSearchScan(chat.messages ?? [])
  chrome.searchText = buildThreadCatalogueSearchText({
    title: chat.title,
    provider: chat.provider,
    chatId: chat.appChatId,
    recent: scan.recent
  })
  chrome.searchPreview = scan.preview
  if (scan.lastUserMessageAt !== undefined) chrome.lastUserMessageAt = scan.lastUserMessageAt
  return chrome
}
