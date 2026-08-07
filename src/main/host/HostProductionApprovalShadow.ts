/**
 * Host Arc Wave 5c Phase 2 — AppStore pending-approval shadow → Host family.
 *
 * WHAT THIS IS. Desktop pending approvals live in ApprovalService registries
 * keyed by an AppStore-minted approvalId. Host approval cards from the
 * deferred bridge are keyed by a Host-minted challengeId. Those namespaces
 * never intersect, so a renderer can dual-read only when main shadow-publishes
 * the AppStore pending set into the Host approvals family keyed by the SAME
 * approvalId. This adapter owns that mapping.
 *
 * BOUNDARIES:
 * - zero electron / AppStore / ApprovalService value imports;
 * - constructs allowlisted HostApprovalProjection fields only;
 * - never invents a Host command id (commandId is the shadow sentinel + id);
 * - never forwards body, actions, provider, or preview onto the wire.
 *
 * HONESTY:
 * - createdAt is 0 — the registries do not track creation time; unknown is
 *   not epoch fabrication of "now";
 * - a throwing listPending propagates (fail closed, never a false empty);
 * - every listApprovals call re-reads (no cache of a moving set).
 */

import type { HostApprovalProjection } from '../../shared/hostProtocol'
import type { HostProductionApprovalListPort } from './HostProductionSuppliers'

/**
 * Sentinel commandId prefix for AppStore-shadow rows.
 *
 * A real Host-command approval carries a UUID commandId. Desktop dual-read
 * membership must only join on rows stamped with this prefix so deferred-bridge
 * / TUI cards never filter Desktop AppStore membership.
 */
export const HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX = 'appstore-shadow:' as const

/** Wire commandId bound — matches hostProtocol HOST_PROTOCOL_MAX_ID. */
const HOST_COMMAND_ID_MAX = 512
/** Compact summary bound — shorter than the protocol warning ceiling. */
const HOST_APPROVAL_SHADOW_SUMMARY_MAX = 120
/** Fixed vocabulary width for actionKind on the shadow path. */
const HOST_APPROVAL_SHADOW_ACTION_KIND_MAX = 128

/**
 * Thin pending-row shape the composition root adapts from ApprovalService
 * (or any other AppStore-side registry). Deliberately narrow so this module
 * never pulls store symbols.
 */
export interface HostPendingApprovalShadowEntry {
  readonly approvalId: string
  /** Source kind → wire actionKind (e.g. mcpTools, shellCommands). */
  readonly kind: string
  readonly title?: string
  readonly threadId?: string
}

export interface HostProductionApprovalShadowDeps {
  listPending: () => readonly HostPendingApprovalShadowEntry[]
}

function isUsableApprovalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function boundText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Map AppStore pending entries into allowlisted HostApprovalProjection rows.
 *
 * Exported for unit pins; production callers should use
 * {@link createHostProductionApprovalShadow}.
 */
export function mapPendingApprovalShadowsToHostApprovals(
  entries: readonly HostPendingApprovalShadowEntry[]
): HostApprovalProjection[] {
  if (!Array.isArray(entries) || entries.length === 0) return []

  const rows: HostApprovalProjection[] = []
  for (const entry of entries) {
    if (!entry || !isUsableApprovalId(entry.approvalId)) continue

    // Keep the AppStore approvalId VERBATIM — it is the renderer join key.
    const approvalId = entry.approvalId
    const commandId = `${HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX}${approvalId}`
    // Skip when the sentinel cannot carry the id within the wire bound.
    if (commandId.length > HOST_COMMAND_ID_MAX || approvalId.length > HOST_COMMAND_ID_MAX) {
      continue
    }

    const kind = typeof entry.kind === 'string' ? entry.kind : ''
    const actionKind = boundText(kind, HOST_APPROVAL_SHADOW_ACTION_KIND_MAX)

    const title =
      typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : undefined
    const summary = boundText(title ?? 'Approval requested', HOST_APPROVAL_SHADOW_SUMMARY_MAX)

    // ALLOWLIST REBUILD: only these fields reach the wire.
    const row: HostApprovalProjection = {
      approvalId,
      commandId,
      status: 'pending',
      actionKind,
      createdAt: 0,
      summary
    }
    if (typeof entry.threadId === 'string' && entry.threadId.length > 0) {
      row.threadId = entry.threadId
    }
    rows.push(row)
  }
  return rows
}

/**
 * Build the optional `approvals` port for createHostProductionBootstrap /
 * createHostProductionSuppliers.
 */
export function createHostProductionApprovalShadow(
  deps: HostProductionApprovalShadowDeps
): HostProductionApprovalListPort {
  if (!deps || typeof deps.listPending !== 'function') {
    throw new Error('HostProductionApprovalShadow requires listPending to be a function')
  }
  return {
    listApprovals(): HostApprovalProjection[] {
      // Live read every call — no caching of a moving pending set.
      // Throws propagate: fail closed, never paint a false empty.
      return mapPendingApprovalShadowsToHostApprovals(deps.listPending())
    }
  }
}
