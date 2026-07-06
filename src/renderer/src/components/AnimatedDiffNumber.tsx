import type { CSSProperties } from 'react'
import { DigitOdometer } from './DigitOdometer'

interface AnimatedDiffNumberProps {
  value: number
  prefix?: string
  strong?: boolean
  className?: string
}

export function AnimatedDiffNumber({
  value,
  prefix = '',
  strong = false,
  className = ''
}: AnimatedDiffNumberProps): React.JSX.Element {
  const normalizedValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
  const digitCount = `${prefix}${normalizedValue}`.length
  const classNames = [
    'composer-odometer-number',
    className
  ]
    .filter(Boolean)
    .join(' ')
  const valueText = `${prefix}${normalizedValue}`
  const ValueTag = strong ? 'strong' : 'span'
  const odometerSign = prefix === '+' || prefix === '-' ? prefix : undefined

  return (
    <span
      className={classNames}
      style={{ '--composer-odometer-digits': digitCount } as CSSProperties}
    >
      <ValueTag className="composer-odometer-number-value">
        {prefix && !odometerSign ? (
          <span className="composer-odometer-prefix" aria-hidden>
            {prefix}
          </span>
        ) : null}
        <DigitOdometer
          value={normalizedValue}
          sign={odometerSign}
          ariaLabel={valueText}
        />
      </ValueTag>
    </span>
  )
}
