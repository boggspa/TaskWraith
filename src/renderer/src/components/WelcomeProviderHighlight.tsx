import type { CSSProperties, ReactNode } from 'react'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'

export interface WelcomeProviderHighlightProps {
  provider: string | null | undefined
  modelId?: string | null
  modelLabel?: string | null
  children: ReactNode
}

/**
 * Provider-aware emphasis for solo welcome headings.
 *
 * Ollama and Pi are runtime seats whose selected model can carry an exclusive
 * upstream-brand spoof. Resolve that hue through the same canonical table as
 * the composer trigger and transcript surfaces, then set both welcome custom
 * properties inline so the upstream wins over the seat-level CSS fallback in
 * every theme. Unknown models intentionally fall back to Ollama green or Pi
 * slate through `resolveProviderHueClass`.
 */
export function WelcomeProviderHighlight({
  provider,
  modelId,
  modelLabel,
  children
}: WelcomeProviderHighlightProps): React.JSX.Element {
  const hueClass = resolveProviderHueClass(provider, modelId, modelLabel) || 'gemini'
  const color = `var(--provider-${hueClass}-color, var(--accent))`
  const style = {
    '--welcome-provider-color': color,
    '--workspace-name-glow-color': color
  } as CSSProperties

  return (
    <strong
      className={`workspace-name-glow provider-${hueClass}`}
      data-welcome-provider-hue={hueClass}
      style={style}
    >
      {children}
    </strong>
  )
}
