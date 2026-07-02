import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMessage } from '../../../main/store/types'

export interface TranscriptMessageContextMenuSelection {
  anchor: { x: number; y: number }
  message: ChatMessage
  copyContent: string
  copySource?: 'message-content' | 'subthread-return-body' | 'static'
  label: string
  pinned: boolean
  copyOnly?: boolean
}

export interface TranscriptMessageContextMenuItem {
  id: 'copy' | 'pin' | 'side-chat' | 'delete'
  label: string
  intent?: 'danger'
  disabled?: boolean
  onSelect: () => void
}

interface TranscriptMessageContextMenuProps {
  selection: TranscriptMessageContextMenuSelection | null
  onCopyMessage: (messageId: string, content: string) => void
  onDeleteMessage?: (messageId: string) => void
  onTogglePinMessage?: (messageId: string) => void
  onOpenSideChatFromMessage?: (message: ChatMessage) => void
  onClose: () => void
}

function focusMenuButton(
  menu: HTMLDivElement,
  direction: 'first' | 'last' | 'next' | 'previous'
): void {
  const buttons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('.transcript-message-context-menu-item:not(:disabled)')
  )
  if (buttons.length === 0) return
  const activeIndex = buttons.findIndex((button) => button === document.activeElement)
  if (direction === 'first') {
    buttons[0]?.focus()
    return
  }
  if (direction === 'last') {
    buttons[buttons.length - 1]?.focus()
    return
  }
  const fallbackIndex = direction === 'next' ? -1 : 0
  const currentIndex = activeIndex >= 0 ? activeIndex : fallbackIndex
  const delta = direction === 'next' ? 1 : -1
  const nextIndex = (currentIndex + delta + buttons.length) % buttons.length
  buttons[nextIndex]?.focus()
}

function canOpenSideChatFromMessage(message: ChatMessage): boolean {
  return message.metadata?.kind !== 'channelInbound'
}

export function buildTranscriptMessageContextMenuItems({
  selection,
  onCopyMessage,
  onDeleteMessage,
  onTogglePinMessage,
  onOpenSideChatFromMessage
}: Omit<TranscriptMessageContextMenuProps, 'onClose'> & {
  selection: TranscriptMessageContextMenuSelection
}): TranscriptMessageContextMenuItem[] {
  const { message, copyContent, pinned } = selection
  const items: TranscriptMessageContextMenuItem[] = [
    {
      id: 'copy',
      label: 'Copy message',
      disabled: copyContent.length === 0,
      onSelect: () => onCopyMessage(message.id, copyContent)
    }
  ]
  if (!selection.copyOnly && onTogglePinMessage) {
    items.push({
      id: 'pin',
      label: pinned ? 'Unpin message' : 'Pin message',
      onSelect: () => onTogglePinMessage(message.id)
    })
  }
  if (!selection.copyOnly && onOpenSideChatFromMessage && canOpenSideChatFromMessage(message)) {
    items.push({
      id: 'side-chat',
      label: 'Open side chat',
      onSelect: () => onOpenSideChatFromMessage(message)
    })
  }
  if (!selection.copyOnly && onDeleteMessage) {
    items.push({
      id: 'delete',
      label: 'Delete message',
      intent: 'danger',
      onSelect: () => onDeleteMessage(message.id)
    })
  }
  return items
}

export function TranscriptMessageContextMenu({
  selection,
  onCopyMessage,
  onDeleteMessage,
  onTogglePinMessage,
  onOpenSideChatFromMessage,
  onClose
}: TranscriptMessageContextMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!selection) return
    const handlePointerDown = (event: globalThis.MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      onClose()
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [selection, onClose])

  useEffect(() => {
    if (!selection) return
    requestAnimationFrame(() => {
      if (!menuRef.current) return
      focusMenuButton(menuRef.current, 'first')
    })
  }, [selection])

  if (!selection) return null

  const items = buildTranscriptMessageContextMenuItems({
    selection,
    onCopyMessage,
    onDeleteMessage,
    onTogglePinMessage,
    onOpenSideChatFromMessage
  })
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const left = Math.max(8, Math.min(selection.anchor.x, viewportWidth - 224))
  const top = Math.max(8, Math.min(selection.anchor.y, viewportHeight - 220))

  const menu = (
    <div
      ref={menuRef}
      className="transcript-message-context-menu"
      style={{ position: 'fixed', left: `${left}px`, top: `${top}px` }}
      role="menu"
      aria-label={`Actions for ${selection.label}`}
      onKeyDown={(event) => {
        if (!menuRef.current) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          focusMenuButton(menuRef.current, 'next')
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          focusMenuButton(menuRef.current, 'previous')
        } else if (event.key === 'Home') {
          event.preventDefault()
          focusMenuButton(menuRef.current, 'first')
        } else if (event.key === 'End') {
          event.preventDefault()
          focusMenuButton(menuRef.current, 'last')
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`transcript-message-context-menu-item${
            item.intent === 'danger' ? ' is-danger' : ''
          }`}
          disabled={item.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (item.disabled) return
            item.onSelect()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}
