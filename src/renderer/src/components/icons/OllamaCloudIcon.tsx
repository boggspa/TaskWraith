export const OLLAMA_CLOUD_MODEL_CLASSIFIER_LABEL = 'Ollama Cloud model'

export function OllamaCloudIcon({
  className,
  decorative = false
}: {
  className?: string
  decorative?: boolean
}): React.JSX.Element {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : OLLAMA_CLOUD_MODEL_CLASSIFIER_LABEL}
      focusable="false"
    >
      {!decorative && <title>{OLLAMA_CLOUD_MODEL_CLASSIFIER_LABEL}</title>}
      <path d="M5.15 13.75h7.55a3.05 3.05 0 0 0 .48-6.06 4.45 4.45 0 0 0-8.42-1.2A3.65 3.65 0 0 0 5.15 13.75Z" />
      <path d="M9 11.6V7.15m0 0L7.35 8.8M9 7.15l1.65 1.65" />
    </svg>
  )
}
