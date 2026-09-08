import { join } from 'node:path'
export function preparedThreadDirectory(profilePath: string, chatId: string): string {
  return join(profilePath, 'thread-catalogue-v1', 'prepared', chatId)
}
