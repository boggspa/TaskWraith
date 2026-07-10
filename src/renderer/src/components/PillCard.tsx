import { forwardRef, type ButtonHTMLAttributes } from 'react'

export interface PillCardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Optional feature class for the inset capsule that holds the card content. */
  innerClassName?: string
}

function joinClassNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

/**
 * Shared large-format sibling to PillButton and SegmentedControl. The outer
 * button provides the glass rim while the inset span provides the nested pill;
 * callers own only their content layout and local colour tokens.
 */
export const PillCard = forwardRef<HTMLButtonElement, PillCardProps>(function PillCard(
  { children, className, innerClassName, type = 'button', ...props },
  ref
) {
  return (
    <button {...props} ref={ref} type={type} className={joinClassNames('pill-card', className)}>
      <span className={joinClassNames('pill-card-inner', innerClassName)}>{children}</span>
    </button>
  )
})

PillCard.displayName = 'PillCard'
