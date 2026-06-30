import type { DiffViewMode } from './DiffViewerTypes'

export interface DiffStageCounts {
  mixed: number
  staged: number
  unstaged: number
  untracked: number
  other: number
}

export interface DiffToolbarProps {
  changedCount: number
  totalCount: number
  stageCounts?: DiffStageCounts
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
  stageCounts,
  hideNoise,
  fileFilter,
  viewMode,
  onHideNoiseChange,
  onFileFilterChange,
  onViewModeChange
}: DiffToolbarProps) {
  const stageChips = stageCounts
    ? [
        { key: 'mixed', label: 'Mixed', value: stageCounts.mixed },
        { key: 'unstaged', label: 'Unstaged', value: stageCounts.unstaged },
        { key: 'staged', label: 'Staged', value: stageCounts.staged },
        { key: 'untracked', label: 'Untracked', value: stageCounts.untracked },
        { key: 'other', label: 'Other', value: stageCounts.other }
      ].filter((item) => item.value > 0)
    : []

  return (
    <div className="diff-studio-toolbar">
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {changedCount} of {totalCount} changed
      </span>
      {stageChips.length > 0 && (
        <div
          className="diff-stage-counts"
          aria-label="Visible change groups"
          role="group"
        >
          {stageChips.map((chip) => (
            <span
              key={chip.key}
              className="diff-stage-count-chip"
              data-stage-group={chip.key}
              title={`${chip.value} ${chip.label.toLowerCase()} changed file${
                chip.value === 1 ? '' : 's'
              } visible`}
            >
              <span>{chip.label}</span>
              <strong>{chip.value}</strong>
            </span>
          ))}
        </div>
      )}
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
