/**
 * 1.0.6-TV7 — per-WRITE-workspace run diff summaries.
 *
 * A multi-workspace run (a primary workspace + additional WRITE
 * workspaces attached through the composer picker) writes files in more
 * than one place, but the run's stored `runDiff` only captures the
 * PRIMARY workspace. This pure helper projects the run's tool-reported
 * file changes (the same `getLiveToolFileDiffSummaries` source that
 * powers the WRITE workspace rows + the "this run" summary view) into a
 * per-path map so each WRITE workspace is independently reviewable in
 * Diff Studio (TV8).
 *
 * Renderer-only + derived from `messages` — no filesystem snapshots, so
 * it adds no main-process surface and cannot affect the authoritative
 * primary-path snapshot diff. Best-effort: a path with no (non-noise)
 * changes is omitted entirely.
 */

import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  DiffFileSummary,
  DiffFileSummaryOwner,
  ExternalPathGrant,
  ToolActivity
} from '../../../main/store/types'
import { getLiveToolFileDiffSummaries } from './LiveFileDiffSummary'

export interface RunEvidenceScope {
  runIds: Iterable<string>
  runs?: ChatRun[]
}

const COMPLETED_EVIDENCE_STATUSES = new Set<ToolActivity['status']>(['success', 'warning'])

const FAILED_RESULT_STATUSES = new Set([
  'cancelled',
  'denied',
  'error',
  'failed',
  'failure',
  'rejected'
])

const PLAIN_FAILURE_SUMMARY_PATTERNS = [
  /^(?:error|failed|failure|denied|rejected|cancelled)\b(?:$|\s*[:-]|\s)/i,
  /^(?:(?:error|failed)\s*[:-]\s*)?(?:permission denied|approval (?:was )?(?:denied|rejected|cancelled|timed out)|not approved)\b/i,
  /^(?:the\s+)?(?:user|taskwraith|policy)\s+(?:has\s+|was\s+)?(?:denied|rejected|cancelled)\b/i,
  /^(?:the\s+)?(?:file changes?|write|edit|execution|operation|request|tool(?: call)?)\s+(?:(?:was|were)\s+)?(?:denied|rejected|failed|cancelled)\b/i
]

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parsedJsonRecord(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function plainTextSignalsFailure(value: string): boolean {
  const trimmed = value.trim()
  return Boolean(trimmed && PLAIN_FAILURE_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed)))
}

/**
 * Some older durable activities kept the optimistic tool-use status even after
 * a denied MCP tool_result arrived. Inspect the structured result as well as
 * the activity lifecycle status so an attempted edit cannot become evidence of
 * an applied edit merely because the persisted top-level status says success.
 */
function resultSignalsFailure(value: unknown, depth = 0): boolean {
  if (depth > 5 || value == null) return false
  if (typeof value === 'string') {
    const parsed = parsedJsonRecord(value)
    return parsed == null
      ? plainTextSignalsFailure(value)
      : resultSignalsFailure(parsed, depth + 1)
  }
  if (Array.isArray(value)) {
    return value.some((entry) => resultSignalsFailure(entry, depth + 1))
  }
  if (typeof value !== 'object') return false

  const record = value as Record<string, unknown>
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : ''
  if (FAILED_RESULT_STATUSES.has(status)) return true
  if (record.ok === false || record.isError === true) return true
  if (typeof record.error === 'string' ? record.error.trim().length > 0 : record.error === true) {
    return true
  }

  return ['structuredContent', 'result', 'output', 'content', 'text'].some((key) =>
    resultSignalsFailure(record[key], depth + 1)
  )
}

export function isSuccessfulRunEvidenceActivity(activity: ToolActivity): boolean {
  if (!COMPLETED_EVIDENCE_STATUSES.has(activity.status)) return false
  if (resultSignalsFailure(activity.rawResultEvent)) return false
  // Older records occasionally retained only the bounded result summary.
  if (resultSignalsFailure(activity.resultSummary)) return false
  return true
}

function completedActivities(message: ChatMessage): ToolActivity[] {
  return (message.toolActivities || []).filter(isSuccessfulRunEvidenceActivity)
}

/**
 * Select successful tool evidence owned by the requested run ids.
 *
 * New durable rows carry `message.runId` and are selected exactly. Older
 * rows may not. A null-runId row is admitted only when its timestamp falls
 * inside one or more closed run windows and every possible owner is selected.
 * This bounded fallback recovers unambiguous legacy evidence without letting a
 * concurrent or neighbouring run leak into the current completion card.
 */
export function selectRunEvidenceMessages(
  messages: ChatMessage[] | undefined,
  scope: RunEvidenceScope
): ChatMessage[] {
  const selectedRunIds = new Set(Array.from(scope.runIds).filter(Boolean))
  if (selectedRunIds.size === 0 || !Array.isArray(messages)) return []

  type OwnershipWindow = { runId: string; startedAt: number; endedAt: number | null }
  let ownershipWindows: OwnershipWindow[] | null = null
  const getOwnershipWindows = (): OwnershipWindow[] => {
    if (ownershipWindows) return ownershipWindows
    ownershipWindows = (scope.runs || [])
      .map((run) => {
        const startedAt = parseTimestamp(run.startedAt)
        const endedAt = parseTimestamp(run.endedAt)
        if (startedAt === null) return null
        return {
          runId: run.runId,
          startedAt,
          // A live run is an open-ended possible owner. Ignoring it would let a
          // legacy null-runId activity emitted by a concurrent lane leak into a
          // sibling run that happened to finish first.
          endedAt: endedAt !== null && endedAt >= startedAt ? endedAt : null
        }
      })
      .filter((window): window is OwnershipWindow => window !== null)
    return ownershipWindows
  }

  const selected: ChatMessage[] = []
  for (const message of messages) {
    // Modern messages are durably run-stamped. Reject an unrelated row before
    // walking (and sometimes JSON-parsing) its activity results; long-running
    // threads otherwise repeat that work on every streaming transcript update.
    if (message.runId && !selectedRunIds.has(message.runId)) continue
    const activities = completedActivities(message)
    if (activities.length === 0) continue

    let owned = Boolean(message.runId && selectedRunIds.has(message.runId))
    if (!message.runId) {
      const timestamp = parseTimestamp(message.timestamp)
      if (timestamp !== null) {
        const possibleOwners = getOwnershipWindows().filter(
          (window) =>
            timestamp >= window.startedAt &&
            (window.endedAt === null || timestamp <= window.endedAt)
        )
        owned =
          possibleOwners.some(
            (window) => window.endedAt !== null && selectedRunIds.has(window.runId)
          ) &&
          possibleOwners.every((window) => selectedRunIds.has(window.runId))
      }
    }
    if (!owned) continue
    selected.push(
      activities.length === message.toolActivities?.length
        ? message
        : { ...message, toolActivities: activities }
    )
  }
  return selected
}

/** All durable run ids that belong to the active Ensemble round (or the solo run). */
export function selectCompletionRunIds(
  chat: Pick<ChatRecord, 'chatKind' | 'ensemble' | 'runs'> | null | undefined,
  currentRun: Pick<ChatRun, 'runId' | 'ensembleRoundId'> | null | undefined
): Set<string> {
  const runIds = new Set<string>()
  const activeRound = chat?.chatKind === 'ensemble' ? chat.ensemble?.activeRound : undefined
  const roundId = currentRun?.ensembleRoundId || activeRound?.roundId
  if (!roundId) {
    if (currentRun?.runId) runIds.add(currentRun.runId)
    return runIds
  }
  for (const run of chat?.runs || []) {
    if (run.runId && run.ensembleRoundId === roundId) runIds.add(run.runId)
  }
  if (activeRound?.roundId === roundId) {
    for (const participant of activeRound.participants || []) {
      if (participant.runId) runIds.add(participant.runId)
    }
    for (const lane of Object.values(activeRound.lanes || {})) {
      if (lane?.runId) runIds.add(lane.runId)
    }
  }
  if (currentRun?.runId) runIds.add(currentRun.runId)
  return runIds
}

function normalizedAbsolutePath(value: string): string | null {
  const raw = value.trim().replace(/\\/g, '/')
  if (!raw) return null

  let root = ''
  let remainder = ''
  if (/^[A-Za-z]:\//.test(raw)) {
    root = `${raw.slice(0, 2)}/`
    remainder = raw.slice(3)
  } else if (raw.startsWith('//')) {
    root = '//'
    remainder = raw.slice(2)
  } else if (raw.startsWith('/')) {
    root = '/'
    remainder = raw.slice(1)
  } else {
    return null
  }

  const segments: string[] = []
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  // A UNC root needs both a server and share. Treat partial roots as invalid
  // rather than collapsing them into a misleading local absolute path.
  if (root === '//' && segments.length < 2) return null
  return `${root}${segments.join('/')}`
}

function pathComparisonValue(value: string): string {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('//') ? value.toLowerCase() : value
}

function pathUsesCaseInsensitiveComparison(value: string | null | undefined): boolean {
  return Boolean(value && (/^[A-Za-z]:\//.test(value) || value.startsWith('//')))
}

function relativePathWithin(candidate: string, root: string): string | null {
  const candidatePath = normalizedAbsolutePath(candidate)
  const rootPath = normalizedAbsolutePath(root)
  if (!candidatePath || !rootPath) return null
  const comparedCandidate = pathComparisonValue(candidatePath)
  const comparedRoot = pathComparisonValue(rootPath)
  if (comparedCandidate === comparedRoot) return ''
  const prefix = comparedRoot.endsWith('/') ? comparedRoot : `${comparedRoot}/`
  return comparedCandidate.startsWith(prefix) ? candidatePath.slice(prefix.length) : null
}

function normalizedRelativePath(value: string): string | null {
  const raw = value.trim().replace(/\\/g, '/')
  if (!raw || normalizedAbsolutePath(raw)) return null
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

interface WriteWorkspaceGrant {
  path: string
  kind: ExternalPathGrant['kind']
}

function selectWriteWorkspaceGrants(
  grants: ExternalPathGrant[] | undefined
): WriteWorkspaceGrant[] {
  if (!Array.isArray(grants)) return []
  const indexByPath = new Map<string, number>()
  const out: WriteWorkspaceGrant[] = []
  for (const grant of grants) {
    if (!grant || grant.access !== 'write') continue
    const path = typeof grant.path === 'string' ? normalizedAbsolutePath(grant.path) : null
    if (!path) continue
    const comparisonPath = pathComparisonValue(path)
    const kind = grant.kind === 'file' ? 'file' : 'directory'
    const existingIndex = indexByPath.get(comparisonPath)
    if (existingIndex !== undefined) {
      // A path cannot meaningfully be both a file and a directory. Prefer the
      // exact-file interpretation because it is the narrower capability.
      if (kind === 'file' && out[existingIndex].kind !== 'file') {
        out[existingIndex] = { path, kind }
      }
      continue
    }
    indexByPath.set(comparisonPath, out.length)
    out.push({ path, kind })
  }
  return out
}

/** Distinct, in-order WRITE-grant paths (dedupes repeated grants). */
export function selectWriteWorkspacePaths(grants: ExternalPathGrant[] | undefined): string[] {
  return selectWriteWorkspaceGrants(grants).map((grant) => grant.path)
}

function relativePathForGrant(candidate: string, grant: WriteWorkspaceGrant): string | null {
  const candidatePath = normalizedAbsolutePath(candidate)
  if (!candidatePath) return null
  if (grant.kind === 'file') {
    return pathComparisonValue(candidatePath) === pathComparisonValue(grant.path)
      ? candidatePath.slice(candidatePath.lastIndexOf('/') + 1) || null
      : null
  }
  const relativePath = relativePathWithin(candidatePath, grant.path)
  return relativePath || null
}

function outputRootForGrant(grant: WriteWorkspaceGrant): string | null {
  if (grant.kind !== 'file') return grant.path
  const separatorIndex = grant.path.lastIndexOf('/')
  if (separatorIndex < 0) return null
  let parentPath = separatorIndex === 0 ? '/' : grant.path.slice(0, separatorIndex)
  if (/^[A-Za-z]:$/.test(parentPath)) parentPath += '/'
  return normalizedAbsolutePath(parentPath)
}

function evidencePathKey(path: string, workspacePath?: string | null): string {
  const absolutePath = normalizedAbsolutePath(path)
  const workspace = workspacePath ? normalizedAbsolutePath(workspacePath) : null
  if (absolutePath) {
    const relativePath = workspace ? relativePathWithin(absolutePath, workspace) : null
    if (relativePath) {
      return `relative:${pathUsesCaseInsensitiveComparison(workspace) ? relativePath.toLowerCase() : relativePath}`
    }
    return `absolute:${pathComparisonValue(absolutePath)}`
  }
  const relativePath = normalizedRelativePath(path)
  return relativePath
    ? `relative:${pathUsesCaseInsensitiveComparison(workspace) ? relativePath.toLowerCase() : relativePath}`
    : `raw:${path.trim()}`
}

function ownerKey(owner: DiffFileSummaryOwner): string {
  return [owner.participantId || '', owner.provider || '', owner.role || '', owner.order ?? ''].join(
    '\u0000'
  )
}

function mergeSummaryOwners(
  primary: DiffFileSummaryOwner[] | undefined,
  secondary: DiffFileSummaryOwner[] | undefined
): DiffFileSummaryOwner[] | undefined {
  if (!primary?.length && !secondary?.length) return undefined
  const owners: DiffFileSummaryOwner[] = []
  const seen = new Set<string>()
  for (const owner of [...(primary || []), ...(secondary || [])]) {
    const key = ownerKey(owner)
    if (seen.has(key)) continue
    seen.add(key)
    owners.push(owner)
  }
  return owners
}

/**
 * Make the round-wide evidence the completion list, then append any display
 * rows not owned by that round. This is deliberately a list merge rather than
 * just a side-channel prop: TranscriptPanel falls back to its flat display list
 * when a round covers the whole list, so merely computing `roundSummaries`
 * would otherwise keep showing only the final participant's files.
 */
export function mergeCompletionFileChangeSummaries(
  displaySummaries: DiffFileSummary[],
  roundSummaries: DiffFileSummary[],
  workspacePath?: string | null,
  options: { preferDisplayEvidence?: boolean } = {}
): DiffFileSummary[] {
  if (roundSummaries.length === 0) return displaySummaries

  const displayByPath = new Map<string, DiffFileSummary>()
  for (const summary of displaySummaries) {
    displayByPath.set(evidencePathKey(summary.path, workspacePath), summary)
  }

  const merged: DiffFileSummary[] = []
  const seen = new Set<string>()
  const mergedIndexByPath = new Map<string, number>()
  for (const roundSummary of roundSummaries) {
    const key = evidencePathKey(roundSummary.path, workspacePath)
    const existingIndex = mergedIndexByPath.get(key)
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]
      const owners = mergeSummaryOwners(existing.owners, roundSummary.owners)
      const useRoundPreview =
        existing.previewKind === 'none' && roundSummary.previewKind !== 'none'
      // Canonical aliases (dot segments, Windows case variants) are one file.
      // Keep the first row's status/counts so aliases cannot double-count a
      // write, but retain every participant owner and any richer preview.
      merged[existingIndex] = {
        ...existing,
        ...(useRoundPreview
          ? {
              previewKind: roundSummary.previewKind,
              ...(roundSummary.diffText !== undefined ? { diffText: roundSummary.diffText } : {})
            }
          : {}),
        ...(owners ? { owners } : {})
      }
      continue
    }
    seen.add(key)
    const displaySummary = displayByPath.get(key)
    if (!displaySummary) {
      merged.push(roundSummary)
      mergedIndexByPath.set(key, merged.length - 1)
      continue
    }
    const owners = mergeSummaryOwners(roundSummary.owners, displaySummary.owners)
    const preferredSummary = options.preferDisplayEvidence ? displaySummary : roundSummary
    const fallbackSummary = options.preferDisplayEvidence ? roundSummary : displaySummary
    const preserveDisplayPreview =
      options.preferDisplayEvidence ||
      (roundSummary.previewKind === 'none' && displaySummary.previewKind !== 'none')
    merged.push({
      ...fallbackSummary,
      ...preferredSummary,
      ...(preserveDisplayPreview
        ? {
            previewKind: displaySummary.previewKind,
            ...(displaySummary.diffText !== undefined ? { diffText: displaySummary.diffText } : {})
          }
        : {}),
      ...(owners ? { owners } : {})
    })
    mergedIndexByPath.set(key, merged.length - 1)
  }
  for (const summary of displaySummaries) {
    const key = evidencePathKey(summary.path, workspacePath)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(summary)
  }
  return merged
}

/**
 * Build the per-WRITE-path file-change summary map for a completed run.
 * Only paths with at least one non-noise change are included.
 */
export function buildRunDiffByPath(
  messages: ChatMessage[] | undefined,
  grants: ExternalPathGrant[] | undefined,
  scope: RunEvidenceScope
): Record<string, DiffFileSummary[]> {
  const result: Record<string, DiffFileSummary[]> = {}
  const writeGrants = selectWriteWorkspaceGrants(grants)
  if (writeGrants.length === 0) return result
  const evidenceMessages = selectRunEvidenceMessages(messages, scope)
  const summaries = getLiveToolFileDiffSummaries(evidenceMessages).filter(
    (entry) => !entry.isNoise
  )

  for (const summary of summaries) {
    // A file may sit under nested WRITE grants. Assign it once, to the most
    // specific root, rather than presenting the same edit in multiple panes.
    const candidates = writeGrants
      .map((grant) => ({ grant, relativePath: relativePathForGrant(summary.path, grant) }))
      .filter(
        (candidate): candidate is { grant: WriteWorkspaceGrant; relativePath: string } =>
          candidate.relativePath !== null
      )
      .sort(
        (a, b) =>
          b.grant.path.length - a.grant.path.length ||
          Number(b.grant.kind === 'file') - Number(a.grant.kind === 'file')
      )
    const owner = candidates[0]
    if (!owner) continue
    const outputRoot = outputRootForGrant(owner.grant)
    if (!outputRoot) continue
    const list = result[outputRoot] || []
    list.push({ ...summary, path: owner.relativePath })
    result[outputRoot] = list
  }
  return result
}
