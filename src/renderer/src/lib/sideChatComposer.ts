export type SideChatComposerKeyEvent = {
  key: string
  shiftKey: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  nativeEvent: {
    isComposing?: boolean
  }
  preventDefault: () => void
  stopPropagation: () => void
}

export function shouldSubmitSideChatComposerKey(event: SideChatComposerKeyEvent): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
}

export function handleSideChatComposerKeyDown(
  event: SideChatComposerKeyEvent,
  submit: () => void
): boolean {
  if (!shouldSubmitSideChatComposerKey(event)) return false
  event.preventDefault()
  event.stopPropagation()
  submit()
  return true
}
