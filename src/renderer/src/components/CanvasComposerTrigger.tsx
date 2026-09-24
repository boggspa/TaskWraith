import type { JSX, Ref } from 'react'

interface CanvasComposerTriggerProps {
  triggerRef?: Ref<HTMLButtonElement>
  disabled?: boolean
  open?: boolean
  onClick?: () => void
}

/** Shared Canvas button chrome; the caller owns the app bridge and popover. */
export function CanvasComposerTrigger({
  triggerRef,
  disabled,
  open = false,
  onClick
}: CanvasComposerTriggerProps): JSX.Element {
  return (
    <button
      ref={triggerRef}
      type="button"
      className="composer-canvas-trigger composer-hint-pill composer-hint-pill--left"
      onClick={onClick}
      disabled={disabled}
      aria-label="Open Canvas"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-hint-label="Canvas"
      data-composer-control="canvas"
    >
      <span className="composer-control-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </span>
    </button>
  )
}
