import type {
  ChatMessage,
  DiffFileSummary,
  DiffFileSummaryOwner,
  DiffFileStatus,
  ToolActivity,
  ToolDiffFileSummary
} from '../../../main/store/types'
import {
  deriveToolDiffSummary,
  estimateLineChanges,
  isErroredToolStatus,
  parseUnifiedDiffSummary
} from './ToolParser'

/**
 * "Task complete" file-change extractor — the fallback path the renderer
 * uses when the run's exact git-diff snapshot is unavailable.
 *
 * Pulls per-file additions/deletions out of in-message tool activities
 * across providers (Codex apply_patch, Claude Edit/Write/MultiEdit,
 * Gemini MCP write_file/replace, raw apply_patch tool calls, ...).
 *
 * Critical invariants:
 *  - When NO contributor provides a line count for a file, `additions` /
 *    `deletions` stay `undefined` on the returned summary so the UI can
 *    render `...` rather than a misleading `0`.
 *  - When at least one contributor provides numbers, undefined contributions
 *    do NOT collapse to `0` — they're skipped. This keeps the running totals
 *    honest instead of artificially anchored at zero.
 *  - Status precedence: `created` > `deleted` > `modified`. A file first
 *    created and then edited shows as `created`. A file first edited and
 *    then deleted shows as `deleted`.
 */

const RENDERABLE_FILE_STATUSES = new Set<DiffFileStatus>([
  'created',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'binary',
  'too_large',
  'hidden_sensitive'
])

const WRITE_LIKE_TOOL_NAMES = new Set([
  'replace',
  'write_file',
  'create_file',
  'edit_file',
  'delete_file',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'strreplaceeditor'
])

const CREATE_HINT_TOOL_NAMES = new Set([
  'create_file',
  'createfile',
  'create_directory',
  'write_file',
  'write'
])

const DELETE_HINT_TOOL_NAMES = new Set(['delete_file', 'deletefile', 'delete_path', 'deletepath'])

const STATUS_PRIORITY: Record<DiffFileStatus, number> = {
  created: 3,
  deleted: 2,
  renamed: 1,
  modified: 0,
  untracked: 0,
  binary: 0,
  too_large: 0,
  hidden_sensitive: 0,
  noise: 0
}

export interface PerFileContribution {
  path: string
  status: DiffFileStatus
  additions?: number
  deletions?: number
}

interface AccumulatorEntry {
  path: string
  status: DiffFileStatus
  additions?: number
  deletions?: number
  contributors: number
  statedContributors: number
  owners: DiffFileSummaryOwner[]
}

function looksWriteLike(toolName: string): boolean {
  const normalised = (toolName || '').toLowerCase()
  if (!normalised) return false
  if (WRITE_LIKE_TOOL_NAMES.has(normalised)) return true
  if (normalised.endsWith('__write_file')) return true
  if (normalised.endsWith('__replace')) return true
  if (normalised.endsWith('__create_file')) return true
  if (normalised.endsWith('__edit_file')) return true
  if (normalised.endsWith('__create_directory')) return true
  if (normalised.endsWith('__delete_path')) return true
  if (normalised.endsWith('__move_path')) return true
  if (normalised.endsWith('__rename_path')) return true
  if (normalised.endsWith('__edit')) return true
  if (normalised.endsWith('__apply_patch')) return true
  return false
}

function normalisePath(value: string, workspacePath?: string | null): string {
  const normalised = value.replace(/\\/g, '/')
  const workspace = (workspacePath || '').replace(/\\/g, '/')
  if (!workspace) return normalised
  const ws = workspace.endsWith('/') ? workspace : `${workspace}/`
  return normalised.startsWith(ws) ? normalised.slice(ws.length) : normalised
}

function isCreateHintToolName(toolName: string): boolean {
  const name = (toolName || '').toLowerCase()
  return (
    CREATE_HINT_TOOL_NAMES.has(name) ||
    name.endsWith('__create_file') ||
    name.endsWith('__create_directory') ||
    name.endsWith('__write_file')
  )
}

function isDeleteHintToolName(toolName: string): boolean {
  const name = (toolName || '').toLowerCase()
  return (
    DELETE_HINT_TOOL_NAMES.has(name) ||
    name.endsWith('__delete_file') ||
    name.endsWith('__delete_path')
  )
}

function statusFromToolName(toolName: string): DiffFileStatus | null {
  const name = (toolName || '').toLowerCase()
  if (isCreateHintToolName(name)) return 'created'
  if (isDeleteHintToolName(name)) return 'deleted'
  if (name === 'move_path' || name === 'rename_path') return 'renamed'
  return null
}

function normaliseFileStatus(
  raw: ToolDiffFileSummary['status'] | string | undefined,
  fallback: DiffFileStatus
): DiffFileStatus {
  if (!raw) return fallback
  const value = String(raw).toLowerCase()
  if (value === 'add' || value === 'create' || value === 'created' || value === 'new')
    return 'created'
  if (value === 'delete' || value === 'deleted' || value === 'remove' || value === 'removed')
    return 'deleted'
  if (value === 'rename' || value === 'renamed') return 'renamed'
  if (
    value === 'modify' ||
    value === 'modified' ||
    value === 'edit' ||
    value === 'update' ||
    value === 'updated' ||
    value === 'update_file' ||
    value === 'edit_file'
  )
    return 'modified'
  if (RENDERABLE_FILE_STATUSES.has(value as DiffFileStatus)) return value as DiffFileStatus
  return fallback
}

function readStringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function readNumericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    const numeric =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(numeric)) return Math.max(0, Math.trunc(numeric))
  }
  return undefined
}

function countNonEmptyLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  // Trailing newline produces an extra empty entry; count meaningful lines.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function countDiffStatsFromUnifiedDiff(diff: string): { additions?: number; deletions?: number } {
  if (!diff.trim()) return {}
  let additions = 0
  let deletions = 0
  let counted = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      additions += 1
      counted = true
    } else if (line.startsWith('-')) {
      deletions += 1
      counted = true
    }
  }
  if (!counted) return {}
  return { additions, deletions }
}

function unifiedDiffDeletesFile(diff: string): boolean {
  if (!diff.trim()) return false
  if (/^deleted file mode\s+/m.test(diff)) return true
  return /^---\s+(?:a\/.+|[^/\s].*)$/m.test(diff) && /^\+\+\+\s+\/dev\/null$/m.test(diff)
}

function reconcileStatusWithEvidence(
  status: DiffFileStatus,
  diff: string,
  trustLifecycleStatus = false
): DiffFileStatus {
  if (status !== 'deleted') return status
  if (diff) return unifiedDiffDeletesFile(diff) ? 'deleted' : 'modified'
  return trustLifecycleStatus ? 'deleted' : 'modified'
}

/** Extract per-file additions/deletions from a single Codex-style change record. */
function extractContributionFromChangeRecord(
  raw: unknown,
  fallbackPath: string,
  fallbackStatus: DiffFileStatus,
  workspacePath?: string | null,
  options: { trustLifecycleStatus?: boolean } = {}
): PerFileContribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const rawPath = readStringField(record, [
    'path',
    'filePath',
    'file_path',
    'target',
    'target_file',
    'target_file_path'
  ])
  const path = rawPath ? normalisePath(rawPath.trim(), workspacePath) : fallbackPath
  if (!path) return null

  const kindOrType = readStringField(record, ['kind', 'type', 'operation', 'status'])
  let status = normaliseFileStatus(kindOrType, fallbackStatus)

  let additions = readNumericField(record, ['additions', 'added', 'linesAdded', 'insertions'])
  let deletions = readNumericField(record, ['deletions', 'deleted', 'linesDeleted', 'removals'])
  const diff = readStringField(record, ['unified_diff', 'unifiedDiff', 'diff', 'patch'])

  status = reconcileStatusWithEvidence(status, diff, options.trustLifecycleStatus)

  // No directly-attached numstat: try per-file unified diff / patch content.
  if (additions === undefined && deletions === undefined) {
    if (diff) {
      const counts = countDiffStatsFromUnifiedDiff(diff)
      additions = counts.additions
      deletions = counts.deletions
    }
  }

  // For `add` / `delete` types with full content, infer counts from the content body.
  if (additions === undefined && deletions === undefined) {
    const content = readStringField(record, ['content', 'new_content', 'newContent'])
    if (content) {
      const lineCount = countNonEmptyLines(content)
      if (status === 'deleted') deletions = lineCount
      else additions = lineCount
    }
  }

  return { path, status, additions, deletions }
}

/** Extract per-file contributions from a Claude `MultiEdit` parameters payload. */
function extractMultiEditContribution(
  parameters: Record<string, unknown>,
  fallbackPath: string,
  workspacePath?: string | null
): PerFileContribution | null {
  const edits = parameters.edits
  if (!Array.isArray(edits) || edits.length === 0) return null
  const rawPath = readStringField(parameters, ['file_path', 'filePath', 'path'])
  const path = rawPath ? normalisePath(rawPath.trim(), workspacePath) : fallbackPath
  if (!path) return null
  let additions = 0
  let deletions = 0
  let touched = false
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue
    const item = edit as Record<string, unknown>
    const oldString = item.old_string ?? item.oldString
    const newString = item.new_string ?? item.newString
    if (typeof oldString === 'string') {
      deletions += oldString.split('\n').length
      touched = true
    }
    if (typeof newString === 'string') {
      additions += newString.split('\n').length
      touched = true
    }
  }
  if (!touched) return null
  return { path, status: 'modified', additions, deletions }
}

/**
 * Extract every file the activity touched, with per-file additions/deletions
 * preserved as `undefined` when the activity provides no signal for them.
 *
 * Exported for tests; the aggregator below combines contributions across an
 * entire chat transcript.
 */
export function extractToolFileContributions(
  activity: ToolActivity,
  workspacePath?: string | null
): PerFileContribution[] {
  if (!activity) return []
  // A write/edit whose RESULT was an error or user-rejection did NOT touch
  // the file — the read-only gate (or the tool itself) refused it. Drop it
  // here so it never reaches any getLiveToolFileDiffSummaries consumer: the
  // "N files changed" pill, the Task Complete "Created/Edited/Deleted"
  // summary, the per-workspace Diff Studio map, or the Review-changes /
  // Create-PR run diff. The activity's diffSummary still describes what it
  // WANTED to change, but a denied edit must not count as an applied one.
  if (isErroredToolStatus(activity.status)) return []
  const toolName = activity.toolName || ''
  const parameters = activity.parameters || {}
  const fallbackStatus = statusFromToolName(toolName) ?? 'modified'
  const trustToolLifecycleStatus = fallbackStatus === 'deleted'

  const contributions: PerFileContribution[] = []
  const seen = new Set<string>()

  const addContribution = (entry: PerFileContribution | null) => {
    if (!entry || !entry.path) return
    const key = `${entry.path}::${entry.status}`
    if (seen.has(key)) return
    seen.add(key)
    contributions.push(entry)
  }

  const fallbackPathRaw =
    readStringField(parameters, [
      'file_path',
      'filePath',
      'path',
      'target',
      'target_file',
      'target_file_path'
    ]) ||
    (activity.filePath ?? activity.affectedFilePath ?? '')
  const fallbackPath = fallbackPathRaw
    ? normalisePath(String(fallbackPathRaw).trim(), workspacePath)
    : ''

  // 1. Honour a pre-computed diffSummary from the activity itself.
  const diffSummary = activity.diffSummary
  if (diffSummary?.files && diffSummary.files.length > 0) {
    for (const file of diffSummary.files) {
      const recordCandidate = file as unknown as Record<string, unknown>
      addContribution(
        extractContributionFromChangeRecord(
          recordCandidate,
          fallbackPath,
          fallbackStatus,
          workspacePath,
          {
            trustLifecycleStatus:
              trustToolLifecycleStatus || activity.diffSummary?.source === 'patch_preview'
          }
        )
      )
    }
  }

  // 2. Per-provider rich payloads on parameters (Codex `changes`, Gemini `changes`, etc).
  if (Array.isArray(parameters.changes)) {
    for (const change of parameters.changes) {
      addContribution(
        extractContributionFromChangeRecord(change, fallbackPath, fallbackStatus, workspacePath, {
          trustLifecycleStatus: trustToolLifecycleStatus
        })
      )
    }
  }

  // 3. Aggregated patch/diff preview at the activity level.
  if (contributions.length === 0) {
    const patchText = [
      typeof parameters.patchPreview === 'string' ? parameters.patchPreview : '',
      typeof parameters.patch_preview === 'string' ? parameters.patch_preview : '',
      typeof parameters.patch === 'string' ? parameters.patch : '',
      typeof parameters.diff === 'string' ? parameters.diff : '',
      typeof parameters.unifiedDiff === 'string' ? parameters.unifiedDiff : '',
      typeof parameters.unified_diff === 'string' ? parameters.unified_diff : ''
    ].find((value) => value && value.trim())
    if (patchText) {
      const patchSummary = parseUnifiedDiffSummary(patchText)
      if (patchSummary?.files) {
        for (const file of patchSummary.files) {
          const status = reconcileStatusWithEvidence(
            normaliseFileStatus(file.status as string | undefined, fallbackStatus),
            '',
            true
          )
          addContribution({
            path: file.path ? normalisePath(file.path, workspacePath) : fallbackPath,
            status,
            additions: file.additions,
            deletions: file.deletions
          })
        }
      }
    }
  }

  // 4. Claude MultiEdit (edits[] payload).
  if (contributions.length === 0) {
    const multiEdit = extractMultiEditContribution(parameters, fallbackPath, workspacePath)
    if (multiEdit) addContribution(multiEdit)
  }

  // 5. Whole-file content / string replacement on a single-file path.
  if (contributions.length === 0 && fallbackPath && looksWriteLike(toolName)) {
    // `deriveToolDiffSummary` already handles old_string/new_string and `content`.
    // We trust the tool name's status hint over the derived file status because
    // `deriveToolDiffSummary` collapses everything that isn't `create_file` to
    // `modified` — but `write_file` and `write` mean "create-or-overwrite", so
    // we want to surface `created` in the panel.
    const explicitStatusFromTool = statusFromToolName(toolName)
    const derived =
      activity.diffSummary ||
      deriveToolDiffSummary(toolName, parameters, activity.resultSummary || activity.outputPreview)
    if (derived?.files && derived.files.length > 0) {
      for (const file of derived.files) {
        const status = reconcileStatusWithEvidence(
          explicitStatusFromTool ??
            normaliseFileStatus(file.status as string | undefined, fallbackStatus),
          '',
          explicitStatusFromTool === 'deleted' || derived.source === 'patch_preview'
        )
        addContribution({
          path: file.path ? normalisePath(file.path, workspacePath) : fallbackPath,
          status,
          additions: file.additions,
          deletions: file.deletions
        })
      }
    } else {
      // Final fallback: at least record the file with `undefined` counts so the
      // row renders (just without a `+x -y` pill).
      const estimate = estimateLineChanges(parameters)
      addContribution({
        path: fallbackPath,
        status: fallbackStatus,
        additions: estimate.additions,
        deletions: estimate.deletions
      })
    }
  }

  return contributions
}

function mergeStatus(
  existing: DiffFileStatus | undefined,
  incoming: DiffFileStatus
): DiffFileStatus {
  if (!existing) return incoming
  const existingPriority = STATUS_PRIORITY[existing] ?? 0
  const incomingPriority = STATUS_PRIORITY[incoming] ?? 0
  return incomingPriority > existingPriority ? incoming : existing
}

function mergeNumeric(
  existing: number | undefined,
  incoming: number | undefined
): number | undefined {
  if (incoming === undefined) return existing
  if (existing === undefined) return incoming
  return existing + incoming
}

function readMetadataString(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
  const value = (record as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function ownerFromActivity(
  message: ChatMessage,
  activity: ToolActivity
): DiffFileSummaryOwner | null {
  const messageMetadata = message.metadata || {}
  const activityMetadata = activity.metadata || {}
  const provider =
    readMetadataString(activityMetadata, 'ensembleProvider') ||
    readMetadataString(messageMetadata, 'ensembleProvider') ||
    readMetadataString(activityMetadata, 'provider') ||
    readMetadataString(messageMetadata, 'provider')
  const participantId =
    readMetadataString(activityMetadata, 'ensembleParticipantId') ||
    readMetadataString(messageMetadata, 'ensembleParticipantId')
  const role =
    readMetadataString(messageMetadata, 'ensembleRole') ||
    readMetadataString(messageMetadata, 'role') ||
    readMetadataString(messageMetadata, 'guestRole')
  if (!provider && !participantId && !role) return null
  return {
    ...(provider ? { provider: provider as DiffFileSummaryOwner['provider'] } : {}),
    ...(participantId ? { participantId } : {}),
    ...(role ? { role } : {})
  }
}

function ownerKey(owner: DiffFileSummaryOwner): string {
  return [owner.participantId || '', owner.provider || '', owner.role || ''].join('|')
}

function mergeOwners(
  existing: DiffFileSummaryOwner[],
  incoming: DiffFileSummaryOwner | null
): DiffFileSummaryOwner[] {
  if (!incoming) return existing
  const key = ownerKey(incoming)
  if (existing.some((owner) => ownerKey(owner) === key)) return existing
  return [...existing, incoming]
}

function buildSummary(entry: AccumulatorEntry): DiffFileSummary {
  return {
    path: entry.path,
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    ...(entry.owners.length > 0 ? { owners: entry.owners } : {}),
    previewKind: 'none'
  }
}

function reconcileLiveStatusWithWorkspace(
  liveStatus: DiffFileStatus,
  workspaceStatus: DiffFileStatus
): DiffFileStatus {
  if (liveStatus === workspaceStatus) return liveStatus
  if (liveStatus === 'deleted' && workspaceStatus !== 'deleted') {
    return workspaceStatus === 'untracked' ? 'created' : workspaceStatus
  }
  if (liveStatus === 'created' && workspaceStatus === 'modified') return 'modified'
  if (liveStatus === 'modified' && workspaceStatus === 'deleted') return 'deleted'
  return liveStatus
}

function mergeWorkspacePreview(
  summary: DiffFileSummary,
  workspaceSummary: DiffFileSummary
): DiffFileSummary {
  const hasWorkspacePreview =
    Boolean(workspaceSummary.diffText) ||
    workspaceSummary.previewKind !== 'none' ||
    workspaceSummary.diffTextTruncated !== undefined ||
    workspaceSummary.diffTextOmittedLines !== undefined ||
    workspaceSummary.diffTextOriginalBytes !== undefined ||
    workspaceSummary.isBinary !== undefined ||
    workspaceSummary.isSensitive !== undefined ||
    workspaceSummary.sizeBytes !== undefined ||
    workspaceSummary.staged !== undefined ||
    workspaceSummary.unstaged !== undefined

  if (!hasWorkspacePreview) return summary

  const merged = { ...summary }
  if (!merged.diffText && workspaceSummary.diffText) {
    merged.diffText = workspaceSummary.diffText
  }
  if (merged.previewKind === 'none' && workspaceSummary.previewKind !== 'none') {
    merged.previewKind = workspaceSummary.previewKind
  }
  if (
    merged.diffTextTruncated === undefined &&
    workspaceSummary.diffTextTruncated !== undefined
  ) {
    merged.diffTextTruncated = workspaceSummary.diffTextTruncated
  }
  if (
    merged.diffTextOmittedLines === undefined &&
    workspaceSummary.diffTextOmittedLines !== undefined
  ) {
    merged.diffTextOmittedLines = workspaceSummary.diffTextOmittedLines
  }
  if (
    merged.diffTextOriginalBytes === undefined &&
    workspaceSummary.diffTextOriginalBytes !== undefined
  ) {
    merged.diffTextOriginalBytes = workspaceSummary.diffTextOriginalBytes
  }
  if (merged.isBinary === undefined && workspaceSummary.isBinary !== undefined) {
    merged.isBinary = workspaceSummary.isBinary
  }
  if (merged.isSensitive === undefined && workspaceSummary.isSensitive !== undefined) {
    merged.isSensitive = workspaceSummary.isSensitive
  }
  if (merged.sizeBytes === undefined && workspaceSummary.sizeBytes !== undefined) {
    merged.sizeBytes = workspaceSummary.sizeBytes
  }
  if (merged.staged === undefined && workspaceSummary.staged !== undefined) {
    merged.staged = workspaceSummary.staged
  }
  if (merged.unstaged === undefined && workspaceSummary.unstaged !== undefined) {
    merged.unstaged = workspaceSummary.unstaged
  }
  return merged
}

/**
 * Aggregate per-file change summaries across every tool activity in the chat.
 *
 * The renderer feeds this to the "Task complete" panel when the exact run
 * diff is unavailable. Returned entries may carry `additions: undefined` —
 * the caller must treat that as "unknown" (render `...`) rather than `0`.
 */
export function getLiveToolFileDiffSummaries(
  messages: ChatMessage[] = [],
  workspacePath?: string | null
): DiffFileSummary[] {
  const accumulator = new Map<string, AccumulatorEntry>()
  for (const message of messages) {
    const activities = message?.toolActivities
    if (!activities) continue
    for (const activity of activities) {
      const contributions = extractToolFileContributions(activity, workspacePath)
      const owner = ownerFromActivity(message, activity)
      for (const contribution of contributions) {
        const existing = accumulator.get(contribution.path)
        const hasStat = contribution.additions !== undefined || contribution.deletions !== undefined
        if (!existing) {
          accumulator.set(contribution.path, {
            path: contribution.path,
            status: contribution.status,
            additions: contribution.additions,
            deletions: contribution.deletions,
            contributors: 1,
            statedContributors: hasStat ? 1 : 0,
            owners: owner ? [owner] : []
          })
          continue
        }
        accumulator.set(contribution.path, {
          path: existing.path,
          status: mergeStatus(existing.status, contribution.status),
          additions: mergeNumeric(existing.additions, contribution.additions),
          deletions: mergeNumeric(existing.deletions, contribution.deletions),
          contributors: existing.contributors + 1,
          statedContributors: existing.statedContributors + (hasStat ? 1 : 0),
          owners: mergeOwners(existing.owners, owner)
        })
      }
    }
  }
  return Array.from(accumulator.values())
    .filter((entry) => entry.path && RENDERABLE_FILE_STATUSES.has(entry.status))
    .map(buildSummary)
}

/**
 * Returns true when at least one returned summary has missing line counts.
 * The renderer uses this to decide whether the `· live est.` qualifier
 * should appear next to the change-count header.
 */
export function liveSummariesAreFuzzy(summaries: DiffFileSummary[]): boolean {
  if (!summaries || summaries.length === 0) return false
  return summaries.some((entry) => entry.additions === undefined && entry.deletions === undefined)
}

/**
 * Overlay numstat-style counts (from a workspace `getDiff` call) onto an
 * existing set of live summaries. Used when the in-message extractor can't
 * determine line counts but a fresh git diff snapshot is available.
 *
 * - Any summary missing `additions`/`deletions` is filled in from the
 *   overlay (matched by normalised path).
 * - Summaries that already have line counts are NOT overwritten — the
 *   provider-emitted hints win, because they describe what THIS run did
 *   even if intervening edits have happened since.
 * - Overlay-only files are NOT added unless `addMissing` is true, so we
 *   don't surface unrelated workspace dirt as if the agent edited it.
 */
export function applyWorkspaceDiffOverlay(
  summaries: DiffFileSummary[],
  workspaceSummaries: DiffFileSummary[] | undefined,
  workspacePath?: string | null,
  options: { addMissing?: boolean } = {}
): DiffFileSummary[] {
  if (!Array.isArray(workspaceSummaries) || workspaceSummaries.length === 0) return summaries
  const lookup = new Map<string, DiffFileSummary>()
  for (const summary of workspaceSummaries) {
    if (!summary?.path) continue
    lookup.set(normalisePath(summary.path, workspacePath), summary)
  }
  const seen = new Set<string>()
  const overlaid = summaries.map((summary) => {
    const key = normalisePath(summary.path, workspacePath)
    seen.add(key)
    const match = lookup.get(key)
    if (!match) return summary
    const nextStatus = reconcileLiveStatusWithWorkspace(summary.status, match.status)
    const baseSummary =
      nextStatus === summary.status
        ? summary
        : {
            ...summary,
            status: nextStatus
          }
    if (summary.additions !== undefined || summary.deletions !== undefined) {
      return mergeWorkspacePreview(baseSummary, match)
    }
    if (match.additions === undefined && match.deletions === undefined) {
      return mergeWorkspacePreview(baseSummary, match)
    }
    return mergeWorkspacePreview(
      {
        ...summary,
        status: nextStatus,
        additions: match.additions,
        deletions: match.deletions
      },
      match
    )
  })
  if (!options.addMissing) return overlaid
  for (const [path, match] of lookup.entries()) {
    if (seen.has(path)) continue
    if (!RENDERABLE_FILE_STATUSES.has(match.status)) continue
    overlaid.push({
      ...match,
      path,
      status: match.status,
      additions: match.additions,
      deletions: match.deletions,
      previewKind: match.previewKind || 'none'
    })
  }
  return overlaid
}

export const __test__ = {
  countDiffStatsFromUnifiedDiff,
  extractMultiEditContribution,
  unifiedDiffDeletesFile
}
