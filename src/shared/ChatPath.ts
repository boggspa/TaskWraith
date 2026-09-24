import * as path from 'node:path'

export function assertSafeChatId(value: unknown, label = 'Chat id'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  const chatId = value.trim()
  if (chatId !== value || chatId === '.' || chatId === '..' || /[/\\\0]/.test(chatId)) {
    throw new Error(`${label} must be a safe chat id.`)
  }
  return chatId
}

export function isSafeChatId(value: unknown): value is string {
  try {
    assertSafeChatId(value)
    return true
  } catch {
    return false
  }
}

export function chatPathForId(chatsDir: string, chatId: unknown): string {
  const safeId = assertSafeChatId(chatId)
  const root = path.resolve(chatsDir)
  const target = path.resolve(root, `${safeId}.json`)
  if (path.dirname(target) !== root) {
    throw new Error('Chat id must resolve inside the chat store.')
  }
  return target
}
