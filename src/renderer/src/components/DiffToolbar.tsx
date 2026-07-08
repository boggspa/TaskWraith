import type { DiffViewMode } from './DiffViewerTypes'

export interface DiffStageCounts {
  mixed: number
  staged: number
  unstaged: number
  untracked: number
  other: number
}

export type DiffStageGroupFilter = keyof DiffStageCounts

export interface DiffToolbarProps {
  changedCount: number
  totalCount: number
  stageCounts?: DiffStageCounts
  activeStageGroup?: DiffStageGroupFilter | null
  hideNoise: boolean
  fileFilter: string
  viewMode: DiffViewMode
  onStageGroupChange?: (stageGroup: DiffStageGroupFilter | null) => void
  onHideNoiseChange: (hideNoise: boolean) => void
  onFileFilterChange: (fileFilter: string) => void
  onViewModeChange: (viewMode: DiffViewMode) => void
}

export function DiffToolbar({
  changedCount,
  totalCount,
  stageCounts,
  activeStageGroup = null,
  hideNoise,
  fileFilter,
  viewMode,
  onStageGroupChange,
  onHideNoiseChange,
  onFileFilterChange,
  onViewModeChange
}: DiffToolbarProps) {
  const stageChips = stageCounts
    ? [
        { key: 'mixed' as const, label: 'Mixed', value: stageCounts.mixed },
        { key: 'unstaged' as const, label: 'Unstaged', value: stageCounts.unstaged },
        { key: 'staged' as const, label: 'Staged', value: stageCounts.staged },
        { key: 'untracked' as const, label: 'Untracked', value: stageCounts.untracked },
        { key: 'other' as const, label: 'Other', value: stageCounts.other }
      ].filter((item) => item.value > 0 || activeStageGroup === item.key)
    : []

  return (
    <div className="diff-studio-toolbar">
      <span className="diff-toolbar-count">
        {changedCount} of {totalCount} changed
      </span>
      {stageChips.length > 0 && (
        <div
          className="diff-stage-counts"
          aria-label="Visible change groups"
          role="group"
        >
          {stageChips.map((chip) => (
            <button
              key={chip.key}
              className="diff-stage-count-chip"
              data-stage-group={chip.key}
              data-active={activeStageGroup === chip.key ? 'true' : undefined}
              type="button"
              aria-pressed={activeStageGroup === chip.key}
              onClick={() =>
                onStageGroupChange?.(activeStageGroup === chip.key ? null : chip.key)
              }
              title={`${chip.value} ${chip.label.toLowerCase()} changed file${
                chip.value === 1 ? '' : 's'
              } visible${activeStageGroup === chip.key ? '; click to show all groups' : ''}`}
            >
              <span>{chip.label}</span>
              <strong>{chip.value}</strong>
            </button>
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
      <label className="diff-noise-toggle">
        <input
          className="diff-noise-checkbox"
          type="checkbox"
          checked={hideNoise}
          onChange={(event) => onHideNoiseChange(event.target.checked)}
        />
        <span className="diff-noise-toggle-text">Hide noise</span>
      </label>
      <div
        className="segmented-control segmented-control--compact diff-view-toggle"
        role="radiogroup"
        aria-label="Diff view mode"
      >
        <button
          type="button"
          className={`segmented-control-segment ${viewMode === 'inline' ? 'is-active' : ''}`}
          role="radio"
          aria-checked={viewMode === 'inline'}
          onClick={() => onViewModeChange('inline')}
        >
          Inline
        </button>
        <button
          type="button"
          className={`segmented-control-segment ${viewMode === 'split' ? 'is-active' : ''}`}
          role="radio"
          aria-checked={viewMode === 'split'}
          onClick={() => onViewModeChange('split')}
        >
          Split
        </button>
      </div>
    </div>
  )
}
