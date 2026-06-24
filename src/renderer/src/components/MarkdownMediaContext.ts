import { createContext } from 'react'
import type { ChatMediaRef } from './ChatMediaPanel'

/**
 * Context that provides a transcript message's media refs (+ the chat's
 * workspace path) to the nested markdown renderer, so the `img` override can
 * resolve a `![](src)` placeholder to its safe bounded thumbnail without prop
 * drilling through ReactMarkdown.
 *
 * The value is stabilised by the providing component (MarkdownMessage /
 * RevealingMarkdownMessage) so it changes identity only when the refs that
 * affect inline rendering actually change — a streaming re-render with no new
 * media leaves the value (and therefore the inline images) untouched.
 *
 * `undefined` (the default, and what's provided when a message has no image
 * refs) means every `![]()` renders as the inert placeholder — the original
 * pre-PR3 behaviour.
 */
export interface MarkdownMediaContextValue {
  refs: readonly ChatMediaRef[]
  workspacePath?: string
}

export const MarkdownMediaContext = createContext<MarkdownMediaContextValue | undefined>(undefined)
