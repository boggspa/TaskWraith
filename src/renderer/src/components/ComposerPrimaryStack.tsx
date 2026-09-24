import React from 'react'

export function ComposerPrimaryStack({
  enabled,
  children
}: {
  enabled: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (!enabled) return <>{children}</>
  return <div className="composer-primary-stack">{children}</div>
}
