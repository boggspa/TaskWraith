import { useEffect, useRef, useState } from 'react'

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
  const previousValueRef = useRef(normalizedValue)
  const [displayValue, setDisplayValue] = useState(normalizedValue)
  const [animationTick, setAnimationTick] = useState(0)
  const [direction, setDirection] = useState<'up' | 'down' | 'steady'>('steady')

  useEffect(() => {
    const previousValue = previousValueRef.current
    if (normalizedValue === previousValue) return
    previousValueRef.current = normalizedValue
    setDirection(normalizedValue > previousValue ? 'up' : 'down')
    setDisplayValue(normalizedValue)
    setAnimationTick((current) => current + 1)
  }, [normalizedValue])

  const digitCount = `${prefix}${displayValue}`.length
  const classNames = [
    'composer-odometer-number',
    direction !== 'steady' ? `is-${direction}` : '',
    animationTick > 0 ? 'is-changing' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')
  const valueText = `${prefix}${displayValue}`
  const ValueTag = strong ? 'strong' : 'span'

  return (
    <span
      className={classNames}
      style={{ '--composer-odometer-digits': digitCount } as React.CSSProperties}
      aria-label={valueText}
    >
      <ValueTag key={animationTick} className="composer-odometer-number-value">
        {valueText}
      </ValueTag>
    </span>
  )
}
