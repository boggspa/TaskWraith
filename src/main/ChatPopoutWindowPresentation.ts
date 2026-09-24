import {
  chatPopoutWindowPreset,
  type ChatPopoutPresentation
} from '../shared/chatPopoutPresentation'

export interface ChatPopoutResizableWindow {
  setMinimumSize(width: number, height: number): void
  setSize(width: number, height: number, animate?: boolean): void
  setTitle(title: string): void
}

/** Apply presentation without replacing the renderer, preserving its live draft and scroll state. */
export function applyChatPopoutWindowPresentation(
  window: ChatPopoutResizableWindow,
  presentation: ChatPopoutPresentation,
  animate = true
): void {
  const preset = chatPopoutWindowPreset(presentation)
  window.setMinimumSize(preset.minWidth, preset.minHeight)
  window.setSize(preset.width, preset.height, animate)
  window.setTitle(preset.title)
}
