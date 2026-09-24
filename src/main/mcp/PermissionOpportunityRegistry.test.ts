import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  PermissionOpportunityRegistry,
  type IssuedPermissionOpportunity,
  type PermissionOpportunityBinding,
  type PermissionOpportunityIssueResult
} from './PermissionOpportunityRegistry'

const id = (character: string): string => `twp_${character.repeat(43)}`

function binding(
  overrides: Partial<PermissionOpportunityBinding> = {}
): PermissionOpportunityBinding {
  return {
    provider: 'codex',
    runId: 'run-1',
    chatId: 'chat-1',
    profileId: 'taskwraith-gateway-v17',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace/repo',
    workspaceRealPath: '/real/workspace/repo',
    effectiveWorktreePath: '/worktrees/repo',
    providerSessionId: 'provider-session-1',
    participantId: 'participant-1',
    laneId: 'lane-1',
    postureFingerprint: 'posture-1',
    fixedToolAllowlistFingerprint: 'allowlist-1',
    ...overrides
  }
}

function issue(
  registry: PermissionOpportunityRegistry,
  overrides: {
    binding?: Partial<PermissionOpportunityBinding>
    toolName?: 'write_file' | 'replace'
    arguments?: Record<string, unknown>
    failure?: string
    boundaryCode?: 'policy_denied' | 'approval_timeout' | 'workspace_lock_denied'
  } = {}
): PermissionOpportunityIssueResult {
  return registry.issue({
    binding: binding(overrides.binding),
    request: {
      toolName: overrides.toolName ?? 'write_file',
      arguments: overrides.arguments ?? { path: 'notes.txt', content: 'hello' },
      failure: overrides.failure ?? 'File changes denied by TaskWraith.',
      boundaryCode: overrides.boundaryCode ?? 'policy_denied'
    }
  })
}

function issued(result: PermissionOpportunityIssueResult): IssuedPermissionOpportunity {
  if (!result.ok) throw new Error(`Expected opportunity issue: ${result.error}`)
  return result.opportunity
}

function registryWithIds(ids: string[], now: () => number, maxEntries?: number) {
  let index = 0
  return new PermissionOpportunityRegistry({
    now,
    maxEntries,
    createId: () => ids[index++] || id('z')
  })
}

describe('PermissionOpportunityRegistry', () => {
  it('mints high-entropy opaque ids and keeps exact arguments out of safe display metadata', () => {
    const registry = new PermissionOpportunityRegistry()
    const secret = '__PERMISSION_OPPORTUNITY_ARGUMENT_SECRET__'
    const result = issue(registry, { arguments: { path: 'notes.txt', content: secret } })
    const opportunity = issued(result)

    expect(opportunity.permissionOpportunityId).toMatch(/^twp_[A-Za-z0-9_-]{43}$/)
    expect(opportunity.display).toEqual({
      scope: 'one_exact_invocation',
      targetToolName: 'write_file',
      boundaryCode: 'policy_denied'
    })
    expect(result).toMatchObject({ ok: true, deduplicated: false })
    expect(JSON.stringify(opportunity.display)).not.toContain(secret)
    expect(JSON.stringify(opportunity.display)).not.toContain(opportunity.permissionOpportunityId)
  })

  it('binds redemption exactly to provider, run, chat, workspace, worktree, seat, posture, and fixed-tool ceiling', () => {
    let now = 1_000
    const dimensions: Array<Partial<PermissionOpportunityBinding>> = [
      { provider: 'claude' },
      { runId: 'run-2' },
      { chatId: 'chat-2' },
      { profileId: 'taskwraith-gateway-v16' },
      { workspaceId: 'workspace-2' },
      { workspacePath: '/workspace/other' },
      { workspaceRealPath: '/real/workspace/other' },
      { effectiveWorktreePath: '/worktrees/other' },
      { providerSessionId: 'provider-session-2' },
      { participantId: 'participant-2' },
      { laneId: 'lane-2' },
      { postureFingerprint: 'posture-2' },
      { fixedToolAllowlistFingerprint: 'allowlist-2' }
    ]

    for (const [index, mismatch] of dimensions.entries()) {
      const registry = registryWithIds([id(String.fromCharCode(97 + index))], () => now)
      const opportunity = issued(issue(registry))

      expect(
        registry.take({
          permissionOpportunityId: opportunity.permissionOpportunityId,
          binding: binding(mismatch)
        })
      ).toMatchObject({ ok: false, code: 'opportunity_binding_mismatch' })
      // A mismatched caller cannot burn the real seat's opportunity.
      expect(
        registry.take({
          permissionOpportunityId: opportunity.permissionOpportunityId,
          binding: binding()
        })
      ).toMatchObject({ ok: true })
      now += 1
    }
  })

  it('deduplicates equivalent pending opportunities and applies a per-run quota after dedupe', () => {
    const registry = new PermissionOpportunityRegistry({
      maxEntriesPerRun: 1,
      createId: () => id('a')
    })
    const first = issue(registry)
    const duplicate = issue(registry)
    const different = issue(registry, { arguments: { path: 'other.txt', content: 'hello' } })

    expect(first).toMatchObject({ ok: true, deduplicated: false })
    expect(duplicate).toMatchObject({ ok: true, deduplicated: true })
    if (!first.ok || !duplicate.ok) throw new Error('Expected issued opportunities.')
    expect(duplicate.opportunity.permissionOpportunityId).toBe(
      first.opportunity.permissionOpportunityId
    )
    expect(different).toMatchObject({ ok: false, code: 'per_run_quota_exhausted' })
  })

  it('does not count consumed tombstones against the live per-run quota', () => {
    const ids = [id('j'), id('k')]
    const registry = new PermissionOpportunityRegistry({
      maxEntriesPerRun: 1,
      createId: () => ids.shift() || id('l')
    })
    const first = issued(issue(registry))
    expect(
      registry.take({
        permissionOpportunityId: first.permissionOpportunityId,
        binding: binding()
      })
    ).toMatchObject({ ok: true })
    expect(issue(registry, { arguments: { path: 'second.txt', content: 'hello' } })).toMatchObject({
      ok: true
    })
  })

  it('uses pending → reserved → release/consume and leaves only a target-free tombstone after consumption', () => {
    const secret = '__PERMISSION_OPPORTUNITY_TOMBSTONE_SECRET__'
    const registry = new PermissionOpportunityRegistry({ createId: () => id('b') })
    const opportunity = issued(
      issue(registry, { arguments: { path: 'notes.txt', content: secret } })
    )

    const firstReservation = registry.reserve({
      permissionOpportunityId: opportunity.permissionOpportunityId,
      binding: binding()
    })
    expect(firstReservation).toMatchObject({ ok: true })
    if (!firstReservation.ok) throw new Error('Expected reservation.')
    expect(registry.status(opportunity.permissionOpportunityId)).toMatchObject({
      state: 'reserved'
    })
    expect(
      registry.release({
        permissionOpportunityId: opportunity.permissionOpportunityId,
        reservationId: firstReservation.reservation.reservationId,
        binding: binding()
      })
    ).toEqual({ ok: true })
    expect(registry.status(opportunity.permissionOpportunityId)).toMatchObject({ state: 'pending' })

    const secondReservation = registry.reserve({
      permissionOpportunityId: opportunity.permissionOpportunityId,
      binding: binding()
    })
    if (!secondReservation.ok) throw new Error('Expected second reservation.')
    const consumed = registry.consume({
      permissionOpportunityId: opportunity.permissionOpportunityId,
      reservationId: secondReservation.reservation.reservationId,
      binding: binding()
    })
    expect(consumed).toMatchObject({
      ok: true,
      opportunity: {
        request: {
          toolName: 'write_file',
          arguments: { path: 'notes.txt', content: secret },
          boundaryCode: 'policy_denied'
        },
        targetArgumentsSha256: createHash('sha256')
          .update(JSON.stringify({ path: 'notes.txt', content: secret }))
          .digest('hex')
      }
    })
    const tombstone = registry.status(opportunity.permissionOpportunityId)
    expect(tombstone).toMatchObject({ state: 'consumed' })
    expect(JSON.stringify(tombstone)).not.toContain(secret)
    expect(
      registry.take({
        permissionOpportunityId: opportunity.permissionOpportunityId,
        binding: binding()
      })
    ).toMatchObject({ ok: false, code: 'opportunity_already_redeemed' })
  })

  it('rejects forged, replayed, and expired ids and keeps reserved capacity from eviction', () => {
    let now = 1_000
    const registry = registryWithIds([id('c'), id('d')], () => now, 1)
    const opportunity = issued(issue(registry))

    expect(registry.take({ permissionOpportunityId: 'guess', binding: binding() })).toMatchObject({
      ok: false,
      code: 'invalid_opportunity_id'
    })
    expect(registry.take({ permissionOpportunityId: id('e'), binding: binding() })).toMatchObject({
      ok: false,
      code: 'opportunity_not_found'
    })
    const reservation = registry.reserve({
      permissionOpportunityId: opportunity.permissionOpportunityId,
      binding: binding()
    })
    if (!reservation.ok) throw new Error('Expected reservation.')
    expect(issue(registry, { binding: { runId: 'run-2' } })).toMatchObject({
      ok: false,
      code: 'registry_capacity_exhausted'
    })
    expect(
      registry.release({
        permissionOpportunityId: opportunity.permissionOpportunityId,
        reservationId: reservation.reservation.reservationId,
        binding: binding()
      })
    ).toEqual({ ok: true })

    now += 5 * 60 * 1_000
    expect(
      registry.take({
        permissionOpportunityId: opportunity.permissionOpportunityId,
        binding: binding()
      })
    ).toMatchObject({ ok: false, code: 'opportunity_expired' })
  })

  it('enforces issue bounds and only clears a concrete workspace identity', () => {
    const registry = new PermissionOpportunityRegistry({ createId: () => id('f') })
    expect(() => issue(registry, { failure: 'x'.repeat(4_001) })).toThrow(/failure evidence/i)
    expect(() => issue(registry, { arguments: { content: 'x'.repeat(64 * 1_024) } })).toThrow(
      /no larger than/i
    )
    expect(() =>
      registry.issue({
        binding: binding(),
        request: {
          toolName: 'write_file',
          arguments: { path: 'notes.txt', content: 'hello' },
          failure: 'permission denied',
          boundaryCode: 'invented_boundary' as never
        }
      })
    ).toThrow(/recognised host boundary code/i)

    const opportunity = issued(issue(registry))
    expect(registry.clearForWorkspace(undefined)).toBe(0)
    expect(registry.status(opportunity.permissionOpportunityId)).not.toBeNull()
    expect(registry.clearForWorkspace('/worktrees/repo')).toBe(1)
    expect(registry.status(opportunity.permissionOpportunityId)).toBeNull()
  })

  it('fails closed when a custom id factory cannot provide high-entropy ids', () => {
    const registry = new PermissionOpportunityRegistry({ createId: () => 'weak-id' })
    expect(() => issue(registry)).toThrow(/high-entropy identifier/i)
  })
})
