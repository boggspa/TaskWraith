import { useId, type KeyboardEvent, type ReactNode } from 'react'

export type SegmentedControlAriaMode = 'radio' | 'pressed'

export interface SegmentedControlOption<Value extends string> {
  value: Value
  label: ReactNode
  disabled?: boolean
  title?: string
  ariaLabel?: string
  className?: string
  dataSegment?: string
}

export interface SegmentedControlProps<Value extends string> {
  value: Value
  options: readonly SegmentedControlOption<Value>[]
  onValueChange: (value: Value) => void | Promise<void>
  ariaLabel: string
  className?: string
  size?: 'regular' | 'compact'
  disabled?: boolean
  busy?: boolean
  /** Keep focus stable during an async operation while still reporting busy state. */
  disableWhileBusy?: boolean
  /**
   * Radio is the default for local value selection. Pressed buttons preserve
   * the existing immediate-action semantics used by remote access controls.
   */
  ariaMode?: SegmentedControlAriaMode
}

function joinClassNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

function focusSegment<Value extends string>(root: HTMLElement, value: Value): void {
  const escapedValue = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value
  root.querySelector<HTMLButtonElement>(`[data-segmented-control-value="${escapedValue}"]`)?.focus()
}

/**
 * Shared mutually-exclusive rounded control. It owns only the presentation and
 * keyboard/ARIA contract; state remains controlled by the caller.
 */
export function SegmentedControl<Value extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  className,
  size = 'regular',
  disabled = false,
  busy = false,
  disableWhileBusy = true,
  ariaMode = 'radio'
}: SegmentedControlProps<Value>): React.JSX.Element {
  const id = useId()
  const interactionBlocked = disabled || busy
  const nativeControlsDisabled = disabled || (busy && disableWhileBusy)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))

  const select = (next: SegmentedControlOption<Value>): void => {
    if (interactionBlocked || next.disabled || next.value === value) return
    void onValueChange(next.value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (ariaMode !== 'radio' || interactionBlocked || options.length < 2) return
    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : event.key === 'Home'
            ? -Infinity
            : event.key === 'End'
              ? Infinity
              : 0
    if (direction === 0) return
    event.preventDefault()
    let nextIndex = index
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      if (direction === -Infinity) nextIndex = 0
      else if (direction === Infinity) nextIndex = options.length - 1
      else nextIndex = (nextIndex + direction + options.length) % options.length
      const next = options[nextIndex]
      if (!next?.disabled) {
        select(next)
        focusSegment(event.currentTarget.parentElement!, next.value)
        return
      }
      if (direction === -Infinity || direction === Infinity) return
    }
  }

  return (
    <div
      id={id}
      className={joinClassNames(
        'segmented-control',
        size === 'compact' && 'segmented-control--compact',
        className
      )}
      role={ariaMode === 'radio' ? 'radiogroup' : 'group'}
      aria-label={ariaLabel}
      aria-busy={busy ? 'true' : undefined}
      aria-disabled={interactionBlocked ? 'true' : undefined}
    >
      {options.map((option, index) => {
        const active = option.value === value
        const optionDisabled = nativeControlsDisabled || option.disabled === true
        return (
          <button
            key={option.value}
            type="button"
            role={ariaMode === 'radio' ? 'radio' : undefined}
            aria-checked={ariaMode === 'radio' ? active : undefined}
            aria-pressed={ariaMode === 'pressed' ? active : undefined}
            aria-label={option.ariaLabel}
            title={option.title}
            data-segment={option.dataSegment}
            data-segmented-control-value={option.value}
            className={joinClassNames(
              'segmented-control-segment',
              active && 'is-active',
              option.className
            )}
            disabled={optionDisabled}
            tabIndex={ariaMode === 'radio' && !optionDisabled ? (index === selectedIndex ? 0 : -1) : undefined}
            onClick={() => select(option)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
