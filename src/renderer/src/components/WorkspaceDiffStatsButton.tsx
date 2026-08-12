import { AnimatedDiffNumber } from './AnimatedDiffNumber'

interface WorkspaceDiffStatsButtonProps {
  filesChanged: number
  additions: number
  deletions: number
  onOpen: () => void
  title?: string
}

export function WorkspaceDiffStatsButton({
  filesChanged,
  additions,
  deletions,
  onOpen,
  title
}: WorkspaceDiffStatsButtonProps): React.JSX.Element {
  const fileLabel = filesChanged === 1 ? 'file' : 'files'
  const openTitle =
    title || `Open Diff Studio for ${filesChanged} uncommitted ${fileLabel} in the working tree`

  return (
    <button
      type="button"
      className="composer-above-bar-files-cluster composer-above-bar-stat-clickable"
      onClick={onOpen}
      aria-label={openTitle}
      title={openTitle}
    >
      <span className="composer-above-bar-files">
        <AnimatedDiffNumber value={filesChanged} strong />{' '}
        {filesChanged === 1 ? 'file changed' : 'files changed'}
      </span>
      {(additions > 0 || deletions > 0) && (
        <span className="composer-above-bar-stats">
          <AnimatedDiffNumber value={additions} prefix="+" className="composer-diff-add" />
          <AnimatedDiffNumber value={deletions} prefix="-" className="composer-diff-del" />
        </span>
      )}
    </button>
  )
}
