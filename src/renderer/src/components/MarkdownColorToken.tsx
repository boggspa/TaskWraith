import type { CSSProperties, ReactNode } from 'react'

interface MarkdownColorStyle extends CSSProperties {
  '--markdown-color-token': string
}

export function MarkdownColorToken({
  color,
  children
}: {
  color: string
  children: ReactNode
}): ReactNode {
  const style: MarkdownColorStyle = { '--markdown-color-token': color }
  return (
    <span
      className="markdown-color-token"
      data-color-token={color}
      title={`Color ${color}`}
      style={style}
    >
      {children}
      <span className="markdown-color-token-swatch" aria-hidden="true" />
    </span>
  )
}
