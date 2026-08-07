/**
 * Host Arc Wave 5c Phase 2 — HostProductionApprovalShadow pins.
 *
 * RED-first: these pins existed against the missing adapter before the
 * implementation landed (same discipline as HostProductionProviderAdmission).
 *
 * WHAT IS BEING PINNED. Desktop pending approvals live in ApprovalService
 * registries keyed by an AppStore-minted approvalId; Host approval cards
 * from the deferred bridge are keyed by a Host-minted challengeId. The two
 * namespaces never intersect, so a renderer can only dual-read when main
 * shadow-publishes the AppStore pending set into the Host approvals family
 * keyed by the SAME approvalId. This adapter owns that mapping.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX,
  createHostProductionApprovalShadow,
  mapPendingApprovalShadowsToHostApprovals,
  type HostPendingApprovalShadowEntry
} from './HostProductionApprovalShadow'

function entry(
  overrides: Partial<HostPendingApprovalShadowEntry> = {}
): HostPendingApprovalShadowEntry {
  return {
    approvalId: '1700000000000-abc123',
    kind: 'mcpTools',
    title: 'Allow Pi to run a gated tool?',
    threadId: 'chat-1',
    ...overrides
  }
}

describe('mapPendingApprovalShadowsToHostApprovals', () => {
  it('returns empty for zero pending entries (a measured none)', () => {
    expect(mapPendingApprovalShadowsToHostApprovals([])).toEqual([])
  })

  it('keeps the AppStore approvalId verbatim — it is the renderer join key', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(rows).toHaveLength(1)
    expect(rows[0].approvalId).toBe('1700000000000-abc123')
  })

  it('stamps the shadow sentinel as commandId — never a fabricated Host command id', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(rows[0].commandId).toBe(
      `${HOST_APPROVAL_SHADOW_COMMAND_ID_PREFIX}1700000000000-abc123`
    )
  })

  it('marks every shadow row pending with the source kind as actionKind', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(rows[0].status).toBe('pending')
    expect(rows[0].actionKind).toBe('mcpTools')
  })

  it('emits createdAt 0 — the registries do not track creation time, and unknown is not epoch', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(rows[0].createdAt).toBe(0)
  })

  it('carries the title as a bounded summary, falling back to a fixed label', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(rows[0].summary).toBe('Allow Pi to run a gated tool?')

    const untitled = mapPendingApprovalShadowsToHostApprovals([entry({ title: undefined })])
    expect(untitled[0].summary).toBe('Approval requested')
  })

  it('bounds an over-long summary rather than forwarding it', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry({ title: 'x'.repeat(500) })])
    expect(rows[0].summary.length).toBeLessThanOrEqual(120)
  })

  it('bounds an over-long actionKind to a fixed vocabulary width', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry({ kind: 'k'.repeat(500) })])
    expect(rows[0].actionKind.length).toBeLessThanOrEqual(128)
  })

  it('emits threadId only when present', () => {
    const withThread = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(withThread[0].threadId).toBe('chat-1')

    const without = mapPendingApprovalShadowsToHostApprovals([entry({ threadId: undefined })])
    expect('threadId' in without[0]).toBe(false)
  })

  it('skips rows whose approvalId cannot carry the sentinel within the wire bound', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([
      entry({ approvalId: '' }),
      entry({ approvalId: '   ' }),
      entry({ approvalId: 'y'.repeat(4096) })
    ])
    expect(rows).toEqual([])
  })

  it('allowlists fields — no provider, body, actions or preview leak onto the wire', () => {
    const rows = mapPendingApprovalShadowsToHostApprovals([entry()])
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['actionKind', 'approvalId', 'commandId', 'createdAt', 'status', 'summary', 'threadId'].sort()
    )
  })
})

describe('createHostProductionApprovalShadow', () => {
  it('requires a listPending function', () => {
    expect(() =>
      createHostProductionApprovalShadow({} as never)
    ).toThrow('HostProductionApprovalShadow requires listPending to be a function')
  })

  it('reads live on every listApprovals call (no caching of a moving set)', () => {
    const listPending = vi.fn(() => [entry()])
    const port = createHostProductionApprovalShadow({ listPending })
    expect(port.listApprovals()).toHaveLength(1)
    expect(port.listApprovals()).toHaveLength(1)
    expect(listPending).toHaveBeenCalledTimes(2)
  })

  it('lets a source throw propagate — fail closed, never a false empty', () => {
    const port = createHostProductionApprovalShadow({
      listPending: () => {
        throw new Error('registry unavailable')
      }
    })
    expect(() => port.listApprovals()).toThrow('registry unavailable')
  })
})
