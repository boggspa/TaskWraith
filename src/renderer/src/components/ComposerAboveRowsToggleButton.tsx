interface ComposerAboveRowsToggleButtonProps {
  minimized: boolean
  onToggle: (minimized: boolean) => void
}

/**
 * A deliberately direct control: unlike the neighbouring icon buttons it has no
 * menu. It tucks the composer's optional rows (workspace, roster, queue, and
 * attachment strips) behind the typing surface, then restores them on the next
 * press.
 */
export function ComposerAboveRowsToggleButton({
  minimized,
  onToggle
}: ComposerAboveRowsToggleButtonProps): React.JSX.Element {
  const label = minimized ? 'Show composer above rows' : 'Minimise composer above rows'

  return (
    <button
      type="button"
      className={`composer-above-rows-toggle-button composer-hint-pill composer-hint-pill--left${
        minimized ? ' is-active' : ''
      }`}
      data-hint-label={minimized ? 'Show rows' : 'Minimise rows'}
      title={label}
      aria-label={label}
      aria-pressed={minimized}
      onClick={() => onToggle(!minimized)}
    >
      <span className="composer-control-icon composer-above-rows-toggle-glyph" aria-hidden>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 3.25h10M3 12.75h10" />
          <path d="M8 5.15v5.55" />
          <path d="m5.8 8.5 2.2 2.2 2.2-2.2" />
        </svg>
      </span>
    </button>
  )
}
