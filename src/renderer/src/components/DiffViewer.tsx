import { useEffect, useMemo, useState } from 'react'
import type { DiffFileSummary } from '../../../main/store/types'
import type {
  GitFileStatus,
  GitRepositorySnapshot
} from '../../../main/services/GitService'
import { DiffDetail } from './DiffDetail'
import { DiffFileList } from './DiffFileList'
import { DiffToolbar, type DiffStageCounts, type DiffStageGroupFilter } from './DiffToolbar'
import type { DiffViewMode } from './DiffViewerTypes'

interface DiffViewerProps {
  diff: {
    type: string
    text?: string
    statusText?: string
    diffText?: string
    summaries?: DiffFileSummary[]
  } | null
  workspacePath?: string
  gitSnapshot?: GitRepositorySnapshot | null
  busyPath?: string
  selectionRequest?: DiffSelectionRequest | null
  onSelectedPathChange?: (path: string | null) => void
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}

interface DiffSelectionRequest {
  path: string
  nonce: number
}

const normalizeAbsolutePath = (path: string): string => {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

const repoPathForWorkspacePath = (
  workspacePath: string | undefined,
  repoRoot: string | undefined,
  filePath: string
): string => {
  if (!workspacePath || !repoRoot) return filePath
  const normalizedWorkspace = normalizeAbsolutePath(workspacePath)
  const normalizedRepo = normalizeAbsolutePath(repoRoot)
  if (normalizedWorkspace === normalizedRepo) return filePath
  if (normalizedWorkspace.startsWith(`${normalizedRepo}/`)) {
    return `${normalizedWorkspace.slice(normalizedRepo.length + 1)}/${filePath}`
  }
  return filePath
}

const emptyDiffStageCounts = (): DiffStageCounts => ({
  mixed: 0,
  other: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0
})

export const diffStageGroupForSummary = (
  summary: DiffFileSummary,
  gitStatus?: GitFileStatus
): DiffStageGroupFilter => {
  if (gitStatus?.staged && gitStatus?.unstaged) return 'mixed'
  if (gitStatus?.unstaged) return 'unstaged'
  if (gitStatus?.staged) return 'staged'
  if (summary.status === 'untracked') return 'untracked'
  return 'other'
}

export const diffStageGroupLabel = (stageGroup: DiffStageGroupFilter): string => {
  switch (stageGroup) {
    case 'mixed':
      return 'Mixed'
    case 'unstaged':
      return 'Unstaged'
    case 'staged':
      return 'Staged'
    case 'untracked':
      return 'Untracked'
    default:
      return 'Other'
  }
}

export function resolveVisibleDiffSelection(
  summaries: DiffFileSummary[],
  selectedPath: string | null
): DiffFileSummary | null {
  if (summaries.length === 0) return null
  return summaries.find((summary) => summary.path === selectedPath) || summaries[0] || null
}

export function DiffViewer({
  diff,
  workspacePath,
  gitSnapshot,
  busyPath,
  selectionRequest,
  onSelectedPathChange,
  onOpenFile,
  onStageFile,
  onUnstageFile
}: DiffViewerProps) {
  const [hideNoise, setHideNoise] = useState(true)
  const [fileFilter, setFileFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<DiffViewMode>('inline')
  const [stageGroupFilter, setStageGroupFilter] = useState<DiffStageGroupFilter | null>(null)

  const summaries = diff?.summaries || []
  const normalizedFileFilter = fileFilter.trim().toLowerCase()
  const gitStatusByPath = useMemo(() => {
    const byPath = new Map<string, GitFileStatus>()
    for (const file of gitSnapshot?.files ?? []) {
      byPath.set(file.path, file)
    }
    return byPath
  }, [gitSnapshot?.files])
  const repoPathForSummary = useMemo(
    () => (summary: DiffFileSummary) =>
      repoPathForWorkspacePath(workspacePath, gitSnapshot?.repoRoot, summary.path),
    [gitSnapshot?.repoRoot, workspacePath]
  )
  const textFilteredSummaries = summaries.filter((summary) => {
    if (hideNoise && summary.isNoise) return false
    if (!normalizedFileFilter) return true
    const repoPath = repoPathForSummary(summary)
    return (
      summary.path.toLowerCase().includes(normalizedFileFilter) ||
      repoPath.toLowerCase().includes(normalizedFileFilter) ||
      summary.status.toLowerCase().includes(normalizedFileFilter)
    )
  })
  const filteredSummaries = stageGroupFilter
    ? textFilteredSummaries.filter(
        (summary) =>
          diffStageGroupForSummary(summary, gitStatusByPath.get(repoPathForSummary(summary))) ===
          stageGroupFilter
      )
    : textFilteredSummaries
  const visibleStageCounts = useMemo(() => {
    const counts = emptyDiffStageCounts()
    for (const summary of textFilteredSummaries) {
      const gitStatus = gitStatusByPath.get(repoPathForSummary(summary))
      counts[diffStageGroupForSummary(summary, gitStatus)] += 1
    }
    return counts
  }, [gitStatusByPath, repoPathForSummary, textFilteredSummaries])
  const selectedSummary = resolveVisibleDiffSelection(filteredSummaries, selectedPath)
  const selectedGitStatus = selectedSummary
    ? gitStatusByPath.get(repoPathForSummary(selectedSummary))
    : undefined
  const hiddenNoiseCount = hideNoise ? summaries.filter((summary) => summary.isNoise).length : 0
  const emptyDiffMessage = normalizedFileFilter
    ? `No changed files match "${fileFilter.trim()}".`
    : stageGroupFilter
      ? `No ${diffStageGroupLabel(stageGroupFilter).toLowerCase()} changed files to display.`
    : hiddenNoiseCount > 0
      ? `0 shown; ${hiddenNoiseCount} hidden by Hide noise.`
      : 'No changes to display.'

  useEffect(() => {
    if (!selectionRequest?.path) return
    setSelectedPath(selectionRequest.path)
    setFileFilter('')
    setHideNoise(false)
    setStageGroupFilter(null)
  }, [selectionRequest])

  useEffect(() => {
    const visiblePath = selectedSummary?.path ?? null
    if (selectedPath !== visiblePath) {
      setSelectedPath(visiblePath)
    }
  }, [selectedPath, selectedSummary?.path])

  useEffect(() => {
    onSelectedPathChange?.(selectedSummary?.path ?? null)
  }, [onSelectedPathChange, selectedSummary?.path])

  if (!diff)
    return (
      <div
        style={{
          color: 'var(--text-muted)',
          padding: 'var(--space-md)',
          fontSize: 'var(--font-size-sm)'
        }}
      >
        Run a task to see changes.
      </div>
    )
  if (diff.type === 'not_repo' || diff.type === 'no_changes')
    return (
      <div
        style={{
          color: 'var(--text-muted)',
          padding: 'var(--space-md)',
          fontSize: 'var(--font-size-sm)'
        }}
      >
        {diff.text || diff.statusText || 'No changes.'}
      </div>
    )
  if (diff.type === 'error')
    return (
      <div
        style={{
          color: 'var(--danger)',
          padding: 'var(--space-md)',
          fontSize: 'var(--font-size-sm)'
        }}
      >
        {diff.text}
      </div>
    )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <DiffToolbar
        changedCount={filteredSummaries.length}
        totalCount={summaries.length}
        stageCounts={visibleStageCounts}
        activeStageGroup={stageGroupFilter}
        hideNoise={hideNoise}
        fileFilter={fileFilter}
        viewMode={viewMode}
        onStageGroupChange={setStageGroupFilter}
        onHideNoiseChange={setHideNoise}
        onFileFilterChange={setFileFilter}
        onViewModeChange={setViewMode}
      />

      {filteredSummaries.length === 0 ? (
        <div
          style={{
            padding: 'var(--space-md)',
            color: 'var(--text-muted)',
            fontSize: 'var(--font-size-sm)'
          }}
        >
          {emptyDiffMessage}
        </div>
      ) : (
        <>
          <DiffFileList
            summaries={filteredSummaries}
            selectedPath={selectedSummary?.path}
            workspacePath={workspacePath}
            gitStatusByPath={gitStatusByPath}
            repoPathForSummary={repoPathForSummary}
            busyPath={busyPath}
            onSelectPath={setSelectedPath}
            onOpenFile={onOpenFile}
            onStageFile={onStageFile}
            onUnstageFile={onUnstageFile}
          />
          {selectedSummary && (
            <DiffDetail
              key={selectedSummary.path}
              summary={selectedSummary}
              gitStatus={selectedGitStatus}
              busyPath={busyPath}
              viewMode={viewMode}
              onOpenFile={onOpenFile}
              onStageFile={onStageFile}
              onUnstageFile={onUnstageFile}
            />
          )}
        </>
      )}
    </div>
  )
}
