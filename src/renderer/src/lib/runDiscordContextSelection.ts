import type { DiscordContextSelection } from '../../../main/channels/DiscordContextService'

export interface ExplicitRunDiscordContextSelection {
  value: DiscordContextSelection | null | undefined
}

/**
 * Resolve the run-only Discord snapshot selection without crossing chat/pane
 * ownership. An explicit target selection always wins, including explicit
 * `null`: a resting pane with no context must never inherit the focused pane's
 * visible context. Focused composer dispatches retain the legacy fallback.
 */
export function resolveRunDiscordContextSelection(input: {
  existingPrompt?: string
  selectedChatId?: string | null
  currentComposerChatId?: string | null
  currentSelection?: DiscordContextSelection | null
  targetSelection?: ExplicitRunDiscordContextSelection
}): DiscordContextSelection | undefined {
  if (input.existingPrompt) return undefined
  if (input.targetSelection) return input.targetSelection.value || undefined
  return input.selectedChatId && input.selectedChatId === input.currentComposerChatId
    ? input.currentSelection || undefined
    : undefined
}
