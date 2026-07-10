import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type PillButtonSize = 'regular' | 'compact'
export type PillButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `ghost` is retained as a readable alias for the neutral secondary treatment. */
  variant?: PillButtonVariant
  size?: PillButtonSize
  /** Marks an in-flight action as busy and prevents repeat activation. */
  loading?: boolean
}

function pillButtonClassName(
  variant: PillButtonVariant,
  size: PillButtonSize,
  className?: string
): string {
  const classes = ['segmented-control-action']
  if (size === 'compact') classes.push('segmented-control-action--compact')
  if (variant === 'primary') classes.push('segmented-control-action--primary')
  if (variant === 'danger') classes.push('segmented-control-action--danger')
  if (className) classes.push(className)
  return classes.join(' ')
}

/**
 * Shared standalone rounded action. This deliberately stays a native button,
 * so forms, keyboard activation, refs, labels, and normal button attributes
 * all retain their browser behaviour.
 */
export const PillButton = forwardRef<HTMLButtonElement, PillButtonProps>(function PillButton(
  {
    variant = 'secondary',
    size = 'regular',
    loading = false,
    disabled = false,
    type = 'button',
    className,
    'aria-busy': ariaBusy,
    ...props
  },
  ref
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={pillButtonClassName(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading ? true : ariaBusy}
      data-loading={loading ? 'true' : undefined}
    />
  )
})

PillButton.displayName = 'PillButton'
