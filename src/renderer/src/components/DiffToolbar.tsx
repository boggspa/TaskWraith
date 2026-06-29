import type { DiffViewMode } from './DiffViewerTypes'

export interface DiffToolbarProps {
  changedCount: number
  totalCount: number
  hideNoise: boolean
  fileFilter: string
  viewMode: DiffViewMode
  onHideNoiseChange: (hideNoise: boolean) => void
  onFileFilterChange: (fileFilter: string) => void
  onViewModeChange: (viewMode: DiffViewMode) => void
}

export function DiffToolbar({
  changedCount,
  totalCount,
  hideNoise,
  fileFilter,
  viewMode,
  onHideNoiseChange,
  onFileFilterChange,
  onViewModeChange
}: DiffToolbarProps) {
  return (
    <div className="diff-studio-toolbar">
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {changedCount} of {totalCount} changed
      </span>
      <input
        className="diff-file-filter"
        type="search"
        aria-label="Filter changed files"
        value={fileFilter}
        onChange={(event) => onFileFilterChange(event.target.value)}
        placeholder="Filter files"
      />
      <label
        style={{
          fontSize: 'var(--font-size-xs)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          color: 'var(--text-secondary)',
          cursor: 'pointer'
        }}
      >
        <input
          type="checkbox"
          checked={hideNoise}
          onChange={(event) => onHideNoiseChange(event.target.checked)}
        />
        Hide noise
      </label>
      <div className="diff-view-toggle" role="group" aria-label="Diff view mode">
        <button
          type="button"
          className={viewMode === 'inline' ? 'active' : ''}
          aria-pressed={viewMode === 'inline'}
          onClick={() => onViewModeChange('inline')}
        >
          Inline
        </button>
        <button
          type="button"
          className={viewMode === 'split' ? 'active' : ''}
          aria-pressed={viewMode === 'split'}
          onClick={() => onViewModeChange('split')}
        >
          Split
        </button>
      </div>
    </div>
  )
}
