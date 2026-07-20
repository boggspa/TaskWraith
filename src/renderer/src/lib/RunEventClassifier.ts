import type { RunEventRecord, RunEventKind } from '../../../main/store/types'

/**
 * RunEventClassifier — Phase K1 (Run Inspector / RunCard).
 *
 * Two APIs in one file, sharing the same helpers (path extraction,
 * record-shape sniffing). Reconciled in Phase K1 cleanup from the
 * parallel `RunEventClassifier.ts` (Codex, RunCard) +
 * `RunInspectorRows.ts` (Claude, RunInspector) twins.
 *
 *   - `classifyRunEvent(event) → ClassifiedRunEvent` — coarse 4-way
 *     classification used by `RunCard` to aggregate counts (#approvals,
 *     #files touched, #tool calls) for the inline chat run boundary.
 *
 *   - `classifyForInspector(event) → InspectorRow` — granular 16-way
 *     discrimination used by `RunInspector` to render one timeline row
 *     per event. Each kind gets a distinct visual treatment.
 *
 * Both are pure. Both never throw — unknown / malformed events fall
 * through to the safe default ('other' / 'raw'). Adding a new
 * `RunEventKind` member in `store/types.ts` will fail compilation in
 * the inspector switch (exhaustiveness guard), which is the intended
 * forcing function.
 */

// ── Codex's RunCard-scoped classification ──────────────────────────────────

export type ClassifiedRunEvent =
  | { kind: 'approval' }
  | { kind: 'file_edit'; files: string[] }
  | { kind: 'tool' }
  | { kind: 'other' }

const FILE_EDIT_TOOL_NAMES = new Set([
  'edit_file',
  'create_file',
  'delete_file',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'replace',
  'write_file',
  'apply_patch',
  'patch'
])

export function classifyRunEvent(event: RunEventRecord): ClassifiedRunEvent {
  if (event.kind.startsWith('approval_')) {
    return { kind: 'approval' }
  }
  if (event.kind !== 'tool') {
    return { kind: 'other' }
  }

  const payload = isRecord(event.payload) ? event.payload : {}
  const toolName = readToolName(payload)
  if (!toolName || !FILE_EDIT_TOOL_NAMES.has(toolName)) {
    return { kind: 'tool' }
  }

  return {
    kind: 'file_edit',
    files: extractFilePaths(payload)
  }
}

function readToolName(payload: Record<string, unknown>): string {
  const raw =
    payload.tool_name ??
    payload.toolName ??
    payload.name ??
    (isRecord(payload.data)
      ? (payload.data.tool_name ?? payload.data.toolName ?? payload.data.name)
      : undefined)
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function extractFilePaths(payload: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  collectPath(payload.path, paths)
  collectPath(payload.filePath, paths)
  collectPath(payload.file_path, paths)
  collectPath(payload.targetPath, paths)
  collectPath(payload.target_path, paths)
  collectPath(payload.from, paths)
  collectPath(payload.to, paths)
  collectPath(payload.source, paths)
  collectPath(payload.destination, paths)

  const parameters = isRecord(payload.parameters) ? payload.parameters : undefined
  if (parameters) {
    collectPath(parameters.path, paths)
    collectPath(parameters.filePath, paths)
    collectPath(parameters.file_path, paths)
    collectPath(parameters.targetPath, paths)
    collectPath(parameters.target_path, paths)
    collectPath(parameters.from, paths)
    collectPath(parameters.to, paths)
    collectPath(parameters.source, paths)
    collectPath(parameters.destination, paths)
    collectChanges(parameters.changes, paths)
  }

  const result = isRecord(payload.result) ? payload.result : undefined
  if (result) {
    collectPath(result.path, paths)
    collectPath(result.filePath, paths)
    collectPath(result.file_path, paths)
    collectChanges(result.changes, paths)
  }

  collectChanges(payload.changes, paths)
  return [...paths]
}

function collectChanges(value: unknown, paths: Set<string>): void {
  if (!Array.isArray(value)) return
  for (const change of value) {
    if (!isRecord(change)) continue
    collectPath(change.path, paths)
    collectPath(change.filePath, paths)
    collectPath(change.file_path, paths)
  }
}

function collectPath(value: unknown, paths: Set<string>): void {
  if (typeof value !== 'string') return
  const path = value.trim()
  if (path) paths.add(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// ── Claude's Inspector-scoped row classification ────────────────────────────

export type InspectorRow =
  | {
      kind: 'approval_request'
      title: string
      /** Discriminator from `payload.preview.kind` (tool/permission/diff/edit/write/…). */
      approvalKind?: string
      toolName?: string
      paths?: string[]
      raw: RunEventRecord
    }
  | {
      kind: 'approval_response'
      decision:
        | 'accept'
        | 'acceptForSession'
        | 'acceptForWorkspace'
        | 'decline'
        | 'cancel'
        | 'unknown'
      raw: RunEventRecord
    }
  | {
      kind: 'approval_timer'
      phase: 'armed' | 'timeout'
      raw: RunEventRecord
    }
  | { kind: 'tool_call'; toolName?: string; raw: RunEventRecord }
  | { kind: 'file_edit'; paths: string[]; operation?: 'edit' | 'write'; raw: RunEventRecord }
  | { kind: 'diff'; paths?: string[]; raw: RunEventRecord }
  | {
      kind: 'subthread_spawn'
      subThreadId?: string
      provider?: string
      delegationPrompt?: string
      raw: RunEventRecord
    }
  | { kind: 'subthread_return'; subThreadId?: string; summaryText?: string; raw: RunEventRecord }
  | { kind: 'subthread_dispatch_failed'; reason?: string; raw: RunEventRecord }
  | {
      kind: 'subthread_autoresume'
      /** Sub-thread whose completion triggered the auto-resume. */
      subThreadId?: string
      /** Continuation run id dispatched on the parent chat. */
      continuationRunId?: string
      raw: RunEventRecord
    }
  | { kind: 'delegation'; raw: RunEventRecord }
  | { kind: 'reply'; length?: number; raw: RunEventRecord }
  | { kind: 'lifecycle'; raw: RunEventRecord }
  | { kind: 'provider_raw'; raw: RunEventRecord }
  | { kind: 'provider_error'; message?: string; raw: RunEventRecord }
  | { kind: 'provider_exit'; code?: number | null; raw: RunEventRecord }
  | { kind: 'timeline'; raw: RunEventRecord }
  | { kind: 'raw'; raw: RunEventRecord }

export type InspectorRowKind = InspectorRow['kind']

type ApprovalDecision = Extract<InspectorRow, { kind: 'approval_response' }>['decision']

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function extractPathsFromPreview(payload: unknown): string[] | undefined {
  if (!isRecord(payload)) return undefined
  const preview = payload.preview
  if (!isRecord(preview)) return undefined
  const changes = preview.changes
  if (!Array.isArray(changes)) return undefined
  const out: string[] = []
  for (const entry of changes) {
    if (isRecord(entry) && typeof entry.path === 'string') out.push(entry.path)
  }
  return out.length > 0 ? out : undefined
}

function approvalPreviewKind(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const preview = payload.preview
  if (!isRecord(preview)) return undefined
  return asString(preview.kind)
}

function approvalToolName(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  const preview = payload.preview
  if (!isRecord(preview)) return undefined
  return asString(preview.toolName)
}

function approvalDecision(payload: unknown): ApprovalDecision {
  if (isRecord(payload) && typeof payload.decision === 'string') {
    const d = payload.decision
    if (
      d === 'accept' ||
      d === 'acceptForSession' ||
      d === 'acceptForWorkspace' ||
      d === 'decline' ||
      d === 'cancel'
    ) {
      return d
    }
  }
  return 'unknown'
}

function extractDiffPaths(event: RunEventRecord): string[] | undefined {
  const payload = event.payload
  if (!isRecord(payload)) return undefined
  if (typeof payload.path === 'string') return [payload.path]
  if (Array.isArray(payload.paths)) {
    const out: string[] = []
    for (const p of payload.paths) if (typeof p === 'string') out.push(p)
    return out.length > 0 ? out : undefined
  }
  return undefined
}

/**
 * Classify a single `RunEventRecord` into an `InspectorRow`. Never
 * throws. Unknown kinds fall through to `{ kind: 'raw' }`.
 */
export function classifyForInspector(event: RunEventRecord): InspectorRow {
  const kind: RunEventKind = event.kind
  switch (kind) {
    case 'approval_request':
      return {
        kind: 'approval_request',
        title: event.summary ?? 'Approval requested',
        approvalKind: approvalPreviewKind(event.payload),
        toolName: approvalToolName(event.payload),
        paths: extractPathsFromPreview(event.payload),
        raw: event
      }
    case 'approval_response':
      return {
        kind: 'approval_response',
        decision: approvalDecision(event.payload),
        raw: event
      }
    case 'approval_timer_armed':
      return { kind: 'approval_timer', phase: 'armed', raw: event }
	    case 'approval_timer_timeout':
	      return { kind: 'approval_timer', phase: 'timeout', raw: event }
	    case 'question_requested':
	    case 'question_answered':
	    case 'question_cancelled':
	      return { kind: 'tool_call', toolName: 'ask_user_question', raw: event }
	    case 'tool': {
      const toolName = isRecord(event.payload) ? asString(event.payload.toolName) : undefined
      return { kind: 'tool_call', toolName, raw: event }
    }
    case 'diff':
      return {
        kind: 'diff',
        paths: extractPathsFromPreview(event.payload) ?? extractDiffPaths(event),
        raw: event
      }
    case 'subthread_spawned': {
      const p = isRecord(event.payload) ? event.payload : {}
      return {
        kind: 'subthread_spawn',
        subThreadId: asString(p.subThreadId),
        provider: asString(p.provider),
        delegationPrompt: asString(p.delegationPrompt),
        raw: event
      }
    }
    case 'subthread_returned': {
      const p = isRecord(event.payload) ? event.payload : {}
      const summaryText = asString(p.summary) ?? asString(p.result) ?? event.summary
      return {
        kind: 'subthread_return',
        subThreadId: asString(p.subThreadId),
        summaryText,
        raw: event
      }
    }
    case 'subthread_dispatch_failed': {
      const p = isRecord(event.payload) ? event.payload : {}
      return {
        kind: 'subthread_dispatch_failed',
        reason: asString(p.reason) ?? asString(p.error) ?? event.summary,
        raw: event
      }
    }
    case 'subthread_autoresume_dispatched': {
      const p = isRecord(event.payload) ? event.payload : {}
      return {
        kind: 'subthread_autoresume',
        subThreadId: asString(p.subThreadId),
        continuationRunId: asString(p.continuationRunId),
        raw: event
      }
    }
    case 'host_rerun_continuation_dispatched': {
      const p = isRecord(event.payload) ? event.payload : {}
      return {
        kind: 'subthread_autoresume',
        subThreadId: asString(p.parentRunId),
        continuationRunId: asString(p.continuationRunId),
        raw: event
      }
    }
    case 'side_chat_created':
      return { kind: 'delegation', raw: event }
    case 'delegation':
      return { kind: 'delegation', raw: event }
    case 'final_message': {
      const p = isRecord(event.payload) ? event.payload : {}
      const text = asString(p.text) ?? asString(p.message) ?? ''
      return { kind: 'reply', length: text ? text.length : undefined, raw: event }
    }
    case 'lifecycle':
    case 'reference_context':
      return { kind: 'lifecycle', raw: event }
    // Audit-orchestration events are surfaced by the bespoke audit run card,
    // not this generic inspector — classify them as lifecycle so the timeline
    // stays readable if they ever appear here.
    case 'audit_phase_start':
    case 'audit_phase_complete':
    case 'audit_finding':
    case 'audit_verdict':
    case 'audit_gate_result':
    case 'audit_provider_substituted':
      // falls through: provider context compaction is also a session-maintenance
      // lifecycle marker.
      // eslint-disable-next-line no-fallthrough
    case 'context_compaction':
      return { kind: 'lifecycle', raw: event }
    case 'timeline':
      return { kind: 'timeline', raw: event }
    case 'provider_raw':
      return { kind: 'provider_raw', raw: event }
    case 'provider_error': {
      const p = isRecord(event.payload) ? event.payload : {}
      const message = asString(p.error) ?? asString(p.message) ?? event.summary
      return { kind: 'provider_error', message, raw: event }
    }
    case 'provider_exit': {
      const p = isRecord(event.payload) ? event.payload : {}
      return { kind: 'provider_exit', code: asNumber(p.code) ?? null, raw: event }
    }
    default: {
      // Exhaustiveness guard: a new RunEventKind member fails compile.
      const _exhaustive: never = kind
      void _exhaustive
      return { kind: 'raw', raw: event }
    }
  }
}

/** Classify an ordered list of events. Preserves order. */
export function classifyEventsForInspector(events: RunEventRecord[]): InspectorRow[] {
  return events.map(classifyForInspector)
}
