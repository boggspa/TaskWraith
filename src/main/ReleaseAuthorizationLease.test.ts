import { describe, expect, it } from 'vitest'
import {
  RELEASE_LEASE_DEFAULT_MINUTES,
  RELEASE_LEASE_MAX_MINUTES,
  ReleaseAuthorizationLeaseRegistry
} from './ReleaseAuthorizationLease'
import { releaseCommandBlockReason } from './ReleaseCommandPolicy'

function registryAt(startMs: number) {
  let nowMs = startMs
  let seq = 0
  const registry = new ReleaseAuthorizationLeaseRegistry({
    now: () => nowMs,
    idFactory: () => `lease-${++seq}`
  })
  return {
    registry,
    advanceMinutes: (minutes: number) => {
      nowMs += minutes * 60_000
    }
  }
}

const START = Date.parse('2026-08-18T12:00:00.000Z')

describe('ReleaseAuthorizationLeaseRegistry', () => {
  it('returns no approval without a lease, so the gate stays closed by default', () => {
    const { registry } = registryAt(START)
    expect(
      registry.approvalFor({
        command: 'git push --force origin v1.9.6',
        source: 'approvedMcpShell'
      })
    ).toBeNull()
  })

  it('satisfies the release gate on a route that previously had no approval source', () => {
    const { registry } = registryAt(START)
    const command = 'git push --force origin refs/tags/v1.9.6'

    // Without the lease this is exactly the wall the release stalled against.
    expect(releaseCommandBlockReason(command)).toContain('release-class command')

    registry.grant({ minutes: 60, note: 'AFK release run' })
    const approval = registry.approvalFor({ command, source: 'approvedMcpShell' })

    expect(approval?.commandClass).toBe('git push')
    expect(approval?.approval).toEqual({
      allowReleaseCommand: true,
      approvalSource: 'approvedMcpShell'
    })
    expect(releaseCommandBlockReason(command, approval?.approval)).toBeNull()
  })

  it('carries the approval source of the calling route rather than a fixed one', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30 })
    for (const source of [
      'approvedMcpShell',
      'approvedMcpTask',
      'approvedBackgroundProcess',
      'approvedHostCommand'
    ] as const) {
      const approval = registry.approvalFor({ command: 'npm publish', source })
      expect(approval?.approval.approvalSource).toBe(source)
      expect(releaseCommandBlockReason('npm publish', approval?.approval)).toBeNull()
    }
  })

  it('ignores commands that are not release-class so ordinary work never consumes a lease', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30 })
    expect(
      registry.approvalFor({ command: 'npm run build', source: 'approvedMcpShell' })
    ).toBeNull()
    expect(registry.approvalFor({ command: 'git status', source: 'approvedMcpShell' })).toBeNull()
  })

  it('honours a command-class scope and refuses classes outside it', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30, commandClasses: ['git push'] })
    expect(
      registry.approvalFor({ command: 'git push origin master', source: 'approvedMcpShell' })
    ).not.toBeNull()
    expect(
      registry.approvalFor({ command: 'npm publish --access public', source: 'approvedMcpShell' })
    ).toBeNull()
    expect(
      registry.approvalFor({ command: 'gh release create v1.9.6', source: 'approvedMcpShell' })
    ).toBeNull()
  })

  it('honours a workspace scope', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30, workspacePath: '/Users/dev/AGBench' })
    expect(
      registry.approvalFor({
        command: 'git push',
        source: 'approvedMcpShell',
        workspacePath: '/Users/dev/AGBench'
      })
    ).not.toBeNull()
    expect(
      registry.approvalFor({
        command: 'git push',
        source: 'approvedMcpShell',
        workspacePath: '/Users/dev/other-repo'
      })
    ).toBeNull()
    // A workspace-scoped lease must not answer an unscoped query either.
    expect(registry.approvalFor({ command: 'git push', source: 'approvedMcpShell' })).toBeNull()
  })

  it('expires, and stops approving the moment it does', () => {
    const { registry, advanceMinutes } = registryAt(START)
    registry.grant({ minutes: 15 })
    advanceMinutes(14)
    expect(registry.approvalFor({ command: 'git push', source: 'approvedMcpShell' })).not.toBeNull()
    advanceMinutes(2)
    expect(registry.approvalFor({ command: 'git push', source: 'approvedMcpShell' })).toBeNull()
    expect(registry.active()).toHaveLength(0)
  })

  it('clamps the grant to the ceiling and defaults a missing duration', () => {
    const { registry } = registryAt(START)
    const clamped = registry.grant({ minutes: RELEASE_LEASE_MAX_MINUTES * 10 })
    expect(Date.parse(clamped.expiresAt) - START).toBe(RELEASE_LEASE_MAX_MINUTES * 60_000)

    const defaulted = registry.grant({})
    expect(Date.parse(defaulted.expiresAt) - START).toBe(RELEASE_LEASE_DEFAULT_MINUTES * 60_000)

    const negative = registry.grant({ minutes: -5 })
    expect(Date.parse(negative.expiresAt) - START).toBe(RELEASE_LEASE_DEFAULT_MINUTES * 60_000)
  })

  it('approves a caller-named class, which is how a package script reaches the gate', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30, commandClasses: ['package script release:mac'] })
    expect(
      registry.approvalForClass('package script release:mac', { source: 'approvedMcpTask' })
        ?.approval.approvalSource
    ).toBe('approvedMcpTask')
    expect(
      registry.approvalForClass('package script deploy:prod', { source: 'approvedMcpTask' })
    ).toBeNull()
    expect(registry.approvalForClass('', { source: 'approvedMcpTask' })).toBeNull()
  })

  it('lets an all-scope lease cover a class it could never have enumerated', () => {
    const { registry } = registryAt(START)
    registry.grant({ minutes: 30 })
    expect(
      registry.approvalForClass('package script notarize:mac', { source: 'approvedMcpTask' })
    ).not.toBeNull()
  })

  it('revokes a single lease by id and every lease without one', () => {
    const { registry } = registryAt(START)
    const first = registry.grant({ minutes: 30 })
    registry.grant({ minutes: 30 })
    expect(registry.revoke(first.id)).toBe(1)
    expect(registry.active()).toHaveLength(1)
    expect(registry.revoke()).toBe(1)
    expect(registry.approvalFor({ command: 'git push', source: 'approvedMcpShell' })).toBeNull()
  })
})
