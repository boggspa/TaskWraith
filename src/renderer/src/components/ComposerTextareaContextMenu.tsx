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
  isValueTargetCurrent?: () => boolean
  onPasteClipboardAttachment?: () => Promise<boolean>
  onOpenFromElectron?: (
    point: { x: number; y: number },
    spellcheckContext: ComposerSpellcheckContext | null
  ) => void
  onClose: () => void
}

interface ComposerSpellcheckContextMenuPayload {
  point: { x: number; y: number }
  spellcheckContext: ComposerSpellcheckContext | null
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
  onValueChange: (value: string) => void,
  isValueTargetCurrent?: () => boolean
): void {
  if (isValueTargetCurrent && !isValueTargetCurrent()) return
  onValueChange(nextValue)
  requestAnimationFrame(() => {
    if (isValueTargetCurrent && !isValueTargetCurrent()) return
    textarea.focus()
    textarea.setSelectionRange(selectionStart, selectionEnd)
  })
}

function hasSelection(textarea: HTMLTextAreaElement): boolean {
  return textarea.selectionStart !== textarea.selectionEnd
}

function normalizeSpellcheckContext(
  context: ComposerSpellcheckContext | null | undefined
): ComposerSpellcheckContext | null {
  if (!context?.misspelledWord) return null
  return {
    misspelledWord: context.misspelledWord,
    dictionarySuggestions: Array.isArray(context.dictionarySuggestions)
      ? context.dictionarySuggestions
      : []
  }
}

function pointTargetsTextarea(
  textarea: HTMLTextAreaElement,
  point: { x: number; y: number }
): boolean {
  const rect = textarea.getBoundingClientRect()
  const inside =
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  if (!inside) return false
  return document.elementFromPoint(point.x, point.y) === textarea
}

function pointsAreNear(
  a: { x: number; y: number },
  b: { x: number; y: number },
  delta = 2
): boolean {
  return Math.abs(a.x - b.x) <= delta && Math.abs(a.y - b.y) <= delta
}

function syncTextareaValueFromDom(
  textarea: HTMLTextAreaElement,
  onValueChange: (value: string) => void,
  isValueTargetCurrent?: () => boolean
): void {
  requestAnimationFrame(() => {
    if (isValueTargetCurrent && !isValueTargetCurrent()) return
    onValueChange(textarea.value)
    textarea.focus()
  })
}

function focusMenuButton(menu: HTMLDivElement, direction: 'first' | 'last' | 'next' | 'previous'): void {
  const buttons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('.composer-textarea-context-menu-item:not(:disabled)')
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

export function useComposerTextareaContextMenu(): {
  anchor: { x: number; y: number } | null
  spellcheckContext: ComposerSpellcheckContext | null
  setAnchor: (anchor: { x: number; y: number } | null) => void
  openContextMenu: (
    point: { x: number; y: number },
    spellcheckContext?: ComposerSpellcheckContext | null
  ) => void
  handleContextMenu: (event: MouseEvent<HTMLTextAreaElement>) => void
} {
  const [anchor, setAnchorState] = useState<{ x: number; y: number } | null>(null)
  const [spellcheckContext, setSpellcheckContext] = useState<ComposerSpellcheckContext | null>(null)
  const spellcheckRequestIdRef = useRef(0)
  const electronOpenRef = useRef<{ point: { x: number; y: number }; openedAt: number } | null>(null)
  const fallbackTimerRef = useRef<number | null>(null)

  const clearPendingFallback = useCallback((): void => {
    if (fallbackTimerRef.current === null) return
    window.clearTimeout(fallbackTimerRef.current)
    fallbackTimerRef.current = null
  }, [])

  const setAnchor = useCallback((nextAnchor: { x: number; y: number } | null): void => {
    setAnchorState(nextAnchor)
    if (!nextAnchor) {
      clearPendingFallback()
      spellcheckRequestIdRef.current += 1
      setSpellcheckContext(null)
    }
  }, [clearPendingFallback])

  const openContextMenu = useCallback(
    (
      point: { x: number; y: number },
      context: ComposerSpellcheckContext | null = null
    ): void => {
      clearPendingFallback()
      electronOpenRef.current = { point, openedAt: performance.now() }
      spellcheckRequestIdRef.current += 1
      setAnchorState(point)
      setSpellcheckContext(normalizeSpellcheckContext(context))
    },
    [clearPendingFallback]
  )

  useEffect(() => clearPendingFallback, [clearPendingFallback])

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
          setSpellcheckContext(normalizeSpellcheckContext(context))
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
    event.stopPropagation()
    const point = { x: event.clientX, y: event.clientY }
    clearPendingFallback()
    fallbackTimerRef.current = window.setTimeout(() => {
      fallbackTimerRef.current = null
      const electronOpen = electronOpenRef.current
      if (
        electronOpen &&
        performance.now() - electronOpen.openedAt < 250 &&
        pointsAreNear(electronOpen.point, point)
      ) {
        return
      }
      spellcheckRequestIdRef.current += 1
      setAnchorState(point)
      setSpellcheckContext(null)
      requestSpellcheckContext(point)
    }, 50)
  }

  return { anchor, spellcheckContext, setAnchor, openContextMenu, handleContextMenu }
}

export function ComposerTextareaContextMenu({
  anchor,
  spellcheckContext,
  textareaRef,
  onValueChange,
  isValueTargetCurrent,
  onPasteClipboardAttachment,
  onOpenFromElectron,
  onClose
}: ComposerTextareaContextMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!onOpenFromElectron) return undefined
    return window.api.onSpellcheckContextMenu((payload: ComposerSpellcheckContextMenuPayload) => {
      const textarea = textareaRef.current
      if (!textarea || !pointTargetsTextarea(textarea, payload.point)) return
      onOpenFromElectron(payload.point, normalizeSpellcheckContext(payload.spellcheckContext))
    })
  }, [onOpenFromElectron, textareaRef])

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
        return
      }
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
                    .replaceMisspelling({ suggestion, point: anchor })
                    .then(() => syncTextareaValueFromDom(textarea, onValueChange, isValueTargetCurrent))
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
                .addWordToSpellCheckerDictionary({ point: anchor })
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
        const value = textarea.value
        const selected = textarea.value.slice(start, end)
        void navigator.clipboard
          .writeText(selected)
          .then(() => {
            const nextValue = value.slice(0, start) + value.slice(end)
            applyTextareaValue(textarea, nextValue, start, start, onValueChange, isValueTargetCurrent)
            onClose()
          })
          .catch(() => {
            textarea.focus()
            onClose()
          })
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
        textarea.focus()
        const start = textarea.selectionStart
        const end = textarea.selectionEnd
        const value = textarea.value
        let nativePasteSucceeded = false
        try {
          nativePasteSucceeded = document.execCommand('paste')
        } catch {
          nativePasteSucceeded = false
        }
        if (nativePasteSucceeded) {
          syncTextareaValueFromDom(textarea, onValueChange, isValueTargetCurrent)
          onClose()
          return
        }
        void (async () => {
          const pastedAttachment = onPasteClipboardAttachment
            ? await onPasteClipboardAttachment().catch(() => false)
            : false
          if (pastedAttachment) {
            onClose()
            return
          }
          try {
            const text = await navigator.clipboard.readText()
            const nextValue = value.slice(0, start) + text + value.slice(end)
            const caret = start + text.length
            applyTextareaValue(
              textarea,
              nextValue,
              caret,
              caret,
              onValueChange,
              isValueTargetCurrent
            )
            onClose()
          } catch {
            textarea.focus()
            applyTextareaValue(
              textarea,
              textarea.value,
              textarea.selectionStart,
              textarea.selectionEnd,
              onValueChange,
              isValueTargetCurrent
            )
            onClose()
          }
        })()
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
