import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  computeComposerPlanPopoverPosition,
  type ComposerPlanPopoverPosition
} from './ComposerPlanPopoverButton'
import { ProviderGlyph } from './icons/ProviderGlyph'

interface ComposerEnsembleToggleButtonProps {
  enabled: boolean
  visible: boolean
  onToggle: (enabled: boolean) => void
  composerStyle?: string
  disabled?: boolean
}

export function ComposerEnsembleToggleButton({
  enabled,
  visible,
  onToggle,
  composerStyle = 'default',
  disabled = false
}: ComposerEnsembleToggleButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<ComposerPlanPopoverPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const rect = trigger.getBoundingClientRect()
    const popoverHeight = popoverRef.current?.offsetHeight || 118
    setPosition(
      computeComposerPlanPopoverPosition(
        rect,
        { width: window.innerWidth, height: window.innerHeight },
        { width: 236, height: popoverHeight }
      )
    )
  }, [])

  const closePopover = useCallback((restoreFocus = true): void => {
    setOpen(false)
    if (restoreFocus && typeof window !== 'undefined') {
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
  }, [])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    updatePosition()
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePopover()
    }
    const handlePointer = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      closePopover(false)
    }
    const handleReposition = (): void => updatePosition()
    window.addEventListener('keydown', handleKey)
    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [closePopover, open, updatePosition])

  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  if (!visible) return null

  const title = enabled ? 'Ensemble on' : 'Ensemble off'
  const selectMode = (nextEnabled: boolean): void => {
    setOpen(false)
    if (nextEnabled !== enabled) onToggle(nextEnabled)
  }

  const popover =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-ensemble-toggle-popover shell-${composerStyle}${position?.placement === 'below' ? ' is-below' : ''}`}
            role="dialog"
            aria-label="Ensemble"
            style={
              position
                ? { left: `${position.left}px`, top: `${position.top}px` }
                : { left: '0px', top: '0px', visibility: 'hidden' }
            }
          >
            <div className="composer-ensemble-toggle-popover-header">
              <span className="composer-ensemble-toggle-popover-title">Ensemble</span>
              <span className="composer-ensemble-toggle-state">{enabled ? 'On' : 'Off'}</span>
            </div>
            <div
              className="composer-ensemble-toggle-segmented"
              role="group"
              aria-label="Ensemble mode"
            >
              <button
                type="button"
                className={enabled ? 'is-active' : ''}
                onClick={() => selectMode(true)}
                aria-pressed={enabled}
              >
                On
              </button>
              <button
                type="button"
                className={enabled ? '' : 'is-active'}
                onClick={() => selectMode(false)}
                aria-pressed={!enabled}
              >
                Off
              </button>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <span className="composer-ensemble-toggle-control-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-ensemble-toggle-button composer-hint-pill${enabled ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        data-hint-label="Ensemble"
        onClick={() => setOpen((value) => !value)}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
      >
        <ProviderGlyph provider="ensemble" />
      </button>
      {popover}
    </span>
  )
}
