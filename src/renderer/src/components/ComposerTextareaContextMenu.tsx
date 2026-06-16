import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface ComposerSpellcheckContext {
  misspelledWord: string
  dictionarySuggestions: string[]
}

interface ComposerTextareaContextMenuProps {
  anchor: { x: number; y: number } | null
  spellcheckContext?: ComposerSpellcheckContext | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onValueChange: (value: string) => void
  onClose: () => void
}

interface MenuButtonItem {
  type: 'button'
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  onSelect: () => void
}

interface MenuLabelItem {
  type: 'label'
  id: string
  label: string
}

interface MenuSeparatorItem {
  type: 'separator'
  id: string
}

type MenuItem = MenuButtonItem | MenuLabelItem | MenuSeparatorItem

function applyTextareaValue(
  textarea: HTMLTextAreaElement,
  nextValue: string,
  selectionStart: number,
  selectionEnd: number,
  onValueChange: (value: string) => void
): void {
  onValueChange(nextValue)
  requestAnimationFrame(() => {
    textarea.focus()
    textarea.setSelectionRange(selectionStart, selectionEnd)
  })
}

function hasSelection(textarea: HTMLTextAreaElement): boolean {
  return textarea.selectionStart !== textarea.selectionEnd
}

function syncTextareaValueFromDom(
  textarea: HTMLTextAreaElement,
  onValueChange: (value: string) => void
): void {
  requestAnimationFrame(() => {
    onValueChange(textarea.value)
    textarea.focus()
  })
}

export function useComposerTextareaContextMenu(): {
  anchor: { x: number; y: number } | null
  spellcheckContext: ComposerSpellcheckContext | null
  setAnchor: (anchor: { x: number; y: number } | null) => void
  handleContextMenu: (event: MouseEvent<HTMLTextAreaElement>) => void
} {
  const [anchor, setAnchorState] = useState<{ x: number; y: number } | null>(null)
  const [spellcheckContext, setSpellcheckContext] = useState<ComposerSpellcheckContext | null>(null)
  const spellcheckRequestIdRef = useRef(0)

  const setAnchor = useCallback((nextAnchor: { x: number; y: number } | null): void => {
    setAnchorState(nextAnchor)
    if (!nextAnchor) {
      spellcheckRequestIdRef.current += 1
      setSpellcheckContext(null)
    }
  }, [])

  const requestSpellcheckContext = useCallback((point: { x: number; y: number }): void => {
    const requestId = ++spellcheckRequestIdRef.current
    const load = (): void => {
      void window.api
        .getLastSpellcheckContext(point)
        .then((context) => {
          if (spellcheckRequestIdRef.current !== requestId) return
          if (!context?.misspelledWord) {
            setSpellcheckContext(null)
            return
          }
          setSpellcheckContext({
            misspelledWord: context.misspelledWord,
            dictionarySuggestions: context.dictionarySuggestions || []
          })
        })
        .catch(() => {
          if (spellcheckRequestIdRef.current === requestId) {
            setSpellcheckContext(null)
          }
        })
    }
    window.setTimeout(load, 0)
    window.setTimeout(load, 40)
  }, [])

  const handleContextMenu = (event: MouseEvent<HTMLTextAreaElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const point = { x: event.clientX, y: event.clientY }
    setAnchorState(point)
    setSpellcheckContext(null)
    requestSpellcheckContext(point)
  }

  return { anchor, spellcheckContext, setAnchor, handleContextMenu }
}

export function ComposerTextareaContextMenu({
  anchor,
  spellcheckContext,
  textareaRef,
  onValueChange,
  onClose
}: ComposerTextareaContextMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!anchor) return
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
  }, [anchor, onClose])

  if (!anchor) return null

  const textarea = textareaRef.current
  const selectionActive = textarea ? hasSelection(textarea) : false
  const hasText = Boolean(textarea?.value)
  const suggestions = spellcheckContext?.dictionarySuggestions || []

  const items: MenuItem[] = [
    ...(spellcheckContext?.misspelledWord
      ? [
          {
            type: 'label' as const,
            id: 'spellcheck-label',
            label: 'Spelling'
          },
          ...(suggestions.length > 0
            ? suggestions.map((suggestion, index) => ({
                type: 'button' as const,
                id: `spellcheck-suggestion-${index}`,
                label: suggestion,
                onSelect: () => {
                  if (!textarea) return
                  textarea.focus()
                  void window.api
                    .replaceMisspelling(suggestion)
                    .then(() => syncTextareaValueFromDom(textarea, onValueChange))
                    .catch(() => undefined)
                  onClose()
                }
              }))
            : [
                {
                  type: 'button' as const,
                  id: 'spellcheck-no-suggestions',
                  label: 'No suggestions',
                  disabled: true,
                  onSelect: () => undefined
                }
              ]),
          {
            type: 'button' as const,
            id: 'spellcheck-add-word',
            label: `Add "${spellcheckContext.misspelledWord}" to dictionary`,
            onSelect: () => {
              textarea?.focus()
              void window.api
                .addWordToSpellCheckerDictionary(spellcheckContext.misspelledWord)
                .catch(() => undefined)
              onClose()
            }
          },
          {
            type: 'separator' as const,
            id: 'spellcheck-separator'
          }
        ]
      : []),
    {
      type: 'button',
      id: 'cut',
      label: 'Cut',
      shortcut: '⌘X',
      disabled: !selectionActive,
      onSelect: () => {
        if (!textarea || !selectionActive) return
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const selected = textarea.value.slice(start, end)
        void navigator.clipboard.writeText(selected).catch(() => undefined)
        const nextValue = textarea.value.slice(0, start) + textarea.value.slice(end)
        applyTextareaValue(textarea, nextValue, start, start, onValueChange)
        onClose()
      }
    },
    {
      type: 'button',
      id: 'copy',
      label: 'Copy',
      shortcut: '⌘C',
      disabled: !selectionActive,
      onSelect: () => {
        if (!textarea || !selectionActive) return
        const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
        void navigator.clipboard.writeText(selected).catch(() => undefined)
        onClose()
      }
    },
    {
      type: 'button',
      id: 'paste',
      label: 'Paste',
      shortcut: '⌘V',
      onSelect: () => {
        if (!textarea) return
        void navigator.clipboard
          .readText()
          .then((text) => {
            const start = textarea.selectionStart
            const end = textarea.selectionEnd
            const nextValue = textarea.value.slice(0, start) + text + textarea.value.slice(end)
            const caret = start + text.length
            applyTextareaValue(textarea, nextValue, caret, caret, onValueChange)
            onClose()
          })
          .catch(() => {
            textarea.focus()
            document.execCommand('paste')
            applyTextareaValue(
              textarea,
              textarea.value,
              textarea.selectionStart,
              textarea.selectionEnd,
              onValueChange
            )
            onClose()
          })
      }
    },
    {
      type: 'button',
      id: 'select-all',
      label: 'Select All',
      shortcut: '⌘A',
      disabled: !hasText,
      onSelect: () => {
        if (!textarea || !hasText) return
        textarea.focus()
        textarea.select()
        onClose()
      }
    }
  ]

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const left = Math.max(8, Math.min(anchor.x, viewportWidth - 240))
  const top = Math.max(8, Math.min(anchor.y, viewportHeight - 280))

  const menu = (
    <div
      ref={menuRef}
      className="composer-textarea-context-menu"
      style={{ position: 'fixed', left: `${left}px`, top: `${top}px` }}
      role="menu"
      aria-label="Composer text actions"
    >
      {items.map((item) => {
        if (item.type === 'separator') {
          return (
            <div
              key={item.id}
              className="composer-textarea-context-menu-separator"
              role="separator"
            />
          )
        }
        if (item.type === 'label') {
          return (
            <div key={item.id} className="composer-textarea-context-menu-heading" role="presentation">
              {item.label}
            </div>
          )
        }
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="composer-textarea-context-menu-item"
            disabled={item.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
            }}
          >
            <span className="composer-textarea-context-menu-label">{item.label}</span>
            {item.shortcut ? (
              <span className="composer-textarea-context-menu-shortcut">{item.shortcut}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}
