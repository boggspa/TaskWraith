/**
 * Pure projection helpers: AppStore pending approvals → FleetWavePendingApproval[].
 * TranscriptPanel wires these; no React here.
 */

import type { FleetWavePendingApproval } from '../../../shared/fleetWave'
import { isCanvasEvalApprovalToolName } from './agentApprovalPreview'
import type { AgentApprovalRequest } from './agentApprovalTypes'

const SHORT_BODY_LIMIT = 160

function collectPreviewPaths(preview: unknown): string[] {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return []
  const p = preview as Record<string, unknown>
  const out: string[] = []

  const pushPath = (value: unknown) => {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) out.push(trimmed)
      return
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      const nested =
        typeof record.path === 'string'
          ? record.path
          : typeof record.filePath === 'string'
            ? record.filePath
            : typeof record.file_path === 'string'
              ? record.file_path
              : ''
      const trimmed = nested.trim()
      if (trimmed) out.push(trimmed)
    }
  }

  if (Array.isArray(p.paths)) {
    for (const entry of p.paths) pushPath(entry)
  } else if (typeof p.path === 'string') {
    pushPath(p.path)
  } else if (Array.isArray(p.files)) {
    for (const entry of p.files) pushPath(entry)
  }

  return out
}

function shortBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  if (trimmed.length <= SHORT_BODY_LIMIT) return trimmed
  return `${trimmed.slice(0, SHORT_BODY_LIMIT - 1)}…`
}

function isExcludedFromFleetWaveElevation(approval: AgentApprovalRequest): boolean {
  const preview = approval.preview
  const toolName =
    preview && typeof preview === 'object' && !Array.isArray(preview)
      ? (preview as { toolName?: unknown }).toolName
      : undefined
  if (preview?.requiresExactDesktopReview === true) return true
  if (isCanvasEvalApprovalToolName(toolName)) return true
  if (isCanvasEvalApprovalToolName(approval.method)) return true
  const method = String(approval.method || '').toLowerCase()
  if (method.includes('canvas_eval')) return true
  if (typeof toolName === 'string' && toolName.toLowerCase().includes('canvas_eval')) return true
  return false
}

/** Stable coarse fingerprint for Allow-all grouping. */
export function fleetWaveApprovalScopeKey(approval: AgentApprovalRequest): string {
  const preview =
    approval.preview && typeof approval.preview === 'object' && !Array.isArray(approval.preview)
      ? (approval.preview as Record<string, unknown>)
      : null
  const method = String(approval.method ?? '')
  const kind = preview && typeof preview.kind === 'string' ? preview.kind : ''
  const toolName = preview && typeof preview.toolName === 'string' ? preview.toolName : ''
  const sortedPathsJoined = [...new Set(collectPreviewPaths(preview))].sort().join(',')
  // Shell asks use { kind:'command', command } with no paths — command text is
  // the load-bearing differentiator for Allow-all (omit → every shell collapses).
  const command = preview && typeof preview.command === 'string' ? preview.command.trim() : ''
  if (!method && !kind && !toolName && !sortedPathsJoined && !command) return '__unset__'
  return `${method}|${kind}|${toolName}|${sortedPathsJoined}|${command}`
}

export function toFleetWavePendingApproval(
  approval: AgentApprovalRequest
): FleetWavePendingApproval | null {
  if (!approval?.id) return null
  if (isExcludedFromFleetWaveElevation(approval)) return null
  const title = typeof approval.title === 'string' ? approval.title.trim() : ''
  const summary = title || shortBody(typeof approval.body === 'string' ? approval.body : '')
  if (!summary) return null
  return {
    approvalId: approval.id,
    scopeKey: fleetWaveApprovalScopeKey(approval),
    summary
  }
}

/**
 * Head then queue for each worker chatId, preserving worker order.
 * Skips nulls / excluded canvas_eval / exact-desktop-review rows.
 */
export function collectFleetWavePendingApprovals(
  workerChatIds: string[],
  byChatId: Record<string, AgentApprovalRequest | null | undefined>,
  queueByChatId: Record<string, readonly AgentApprovalRequest[] | undefined>
): FleetWavePendingApproval[] {
  const out: FleetWavePendingApproval[] = []
  for (const chatId of workerChatIds) {
    const head = byChatId[chatId]
    if (head) {
      const mapped = toFleetWavePendingApproval(head)
      if (mapped) out.push(mapped)
    }
    const queue = queueByChatId[chatId]
    if (queue) {
      for (const approval of queue) {
        const mapped = toFleetWavePendingApproval(approval)
        if (mapped) out.push(mapped)
      }
    }
  }
  return out
}

/** Approval IDs in `pending` whose scopeKey matches — for sequential respond. */
export function approvalIdsForAllowAllSameScope(
  pending: readonly FleetWavePendingApproval[],
  scopeKey: string
): string[] {
  return pending.filter((row) => row.scopeKey === scopeKey).map((row) => row.approvalId)
}
