import * as path from 'node:path'
import { isSafeChatId } from '../../shared/ChatPath'

/**
 * The thread's log files in a journal directory, named exactly as the app's
 * journal writes them (`src/main/store/IncrementalChatJournal`). The single
 * definition every reader (head, fold, seed, owner service) resolves through,
 * so a rename cannot split them.
 */
export function threadLogFiles(
  directory: string,
  chatId: string
): { active: string; sealed: string; checkpoint: string } {
  if (!isSafeChatId(chatId)) throw new Error('Invalid thread id')
  return {
    active: path.join(directory, `${chatId}.mutations.jsonl`),
    sealed: path.join(directory, `${chatId}.sealed.mutations.jsonl`),
    checkpoint: path.join(directory, `${chatId}.checkpoint.json`)
  }
}
