import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'

export interface ComposerPlusPickerItem {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
  active?: boolean
  onSelect: () => void
}

export interface ComposerPlusPickerSection {
  id: string
  title: string
  items: ComposerPlusPickerItem[]
}

interface ComposerPlusPickerProps {
  provider: ProviderId
  composerStyle: ComposerStyle
  sections: ComposerPlusPickerSection[]
  disabled?: boolean
  triggerIcon: ReactNode
  /** Trigger chrome overrides — default to the "+" image-picker bubble. */
  triggerClassName?: string
  triggerControl?: string
  triggerLabel?: string
}

export function ComposerPlusPicker({
  provider,
  composerStyle,
  sections,
  disabled,
  triggerIcon,
  triggerClassName = 'composer-image-picker-btn composer-plus-picker-trigger',
  triggerControl = 'attach',
  triggerLabel = 'Composer tools'
}: ComposerPlusPickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  const visibleSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter(Boolean)
    }))
    .filter((section) => section.items.length > 0)

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (!open) {
        setPosition(null)
        return
      }
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 340))
      const top = rect.top - 8
      setPosition({ left, top })
    })
    return () => {
      cancelled = true
    }
  }, [open, visibleSections.length])

  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [open])

  const handleSelect = (item: ComposerPlusPickerItem): void => {
    if (item.disabled) return
    item.onSelect()
    setOpen(false)
  }

  const popover =
    open && position
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-plus-picker-popover provider-${provider} shell-${composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label="Composer tools"
          >
            {visibleSections.map((section) => (
              <div key={section.id} className="composer-plus-picker-section">
                <div className="composer-combined-picker-column-header">{section.title}</div>
                {section.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`composer-combined-picker-row composer-plus-picker-row ${item.active ? 'is-selected' : ''}`}
                    onClick={() => handleSelect(item)}
                    disabled={item.disabled}
                    title={item.description || item.label}
                  >
                    {item.icon && (
                      <span className="composer-plus-picker-row-icon" aria-hidden>
                        {item.icon}
                      </span>
                    )}
                    <span className="composer-plus-picker-row-copy">
                      <span className="composer-combined-picker-row-label">{item.label}</span>
                      {item.description && (
                        <span className="composer-combined-picker-row-sub">{item.description}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        className={triggerClassName}
        type="button"
        title={triggerLabel}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || visibleSections.length === 0}
        data-composer-control={triggerControl}
      >
        {triggerIcon}
      </button>
      {popover}
    </>
  )
}
