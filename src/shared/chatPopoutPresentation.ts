export const CHAT_POPOUT_PRESENTATIONS = ['full', 'compact'] as const

export type ChatPopoutPresentation = (typeof CHAT_POPOUT_PRESENTATIONS)[number]

export interface ChatPopoutWindowPreset {
  width: number
  height: number
  minWidth: number
  minHeight: number
  title: string
}

export const CHAT_POPOUT_WINDOW_PRESETS: Record<ChatPopoutPresentation, ChatPopoutWindowPreset> = {
  full: {
    width: 900,
    height: 760,
    minWidth: 520,
    minHeight: 480,
    title: 'TaskWraith Chat'
  },
  compact: {
    width: 430,
    height: 610,
    minWidth: 360,
    minHeight: 420,
    title: 'TaskWraith Compact Companion'
  }
}

export function normalizeChatPopoutPresentation(value: unknown): ChatPopoutPresentation {
  return value === 'compact' ? 'compact' : 'full'
}

export function chatPopoutWindowPreset(
  presentation: ChatPopoutPresentation
): ChatPopoutWindowPreset {
  return CHAT_POPOUT_WINDOW_PRESETS[presentation]
}
