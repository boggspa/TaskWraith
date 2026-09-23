import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { MainSourceProbe } from '../mainSourceProbe.testutil'

/**
 * The periodic reclaim (Host-lifetime S5) retires a lapsed holder's LEASE and
 * must never touch the mutation commit FENCE: the fence is the only thing
 * serialising two tool calls of one run (same-owner claims never conflict in
 * the authority), and its over-strict, live-only reclaim is what keeps a
 * slow-but-alive holder from ever becoming a second writer. These pins walk
 * the real AST and THROW when a subject is renamed or deleted, so they cannot
 * keep passing over a region that no longer contains the claim.
 */
function method(probe: MainSourceProbe, className: string, methodName: string): ts.Node {
  let found: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name.getText(probe.source) === methodName &&
          member.body
        ) {
          found = member.body
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(probe.source)
  if (!found) {
    throw new Error(
      `${probe.source.fileName} declares no method \`${className}.${methodName}\`. It was renamed, moved ` +
        'or deleted — update this test to the claim that replaced it rather than deleting the assertion.'
    )
  }
  return found
}

/** Identifier occurrences in the AST; doc comments are not nodes and do not count. */
function identifierCount(probe: MainSourceProbe, name: string): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) count += 1
    ts.forEachChild(node, visit)
  }
  visit(probe.source)
  return count
}

/** Declared type text of one member of an `interface Name {...}`; throws when absent. */
function memberType(probe: MainSourceProbe, interfaceName: string, member: string): string {
  let found: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const candidate of node.members) {
        if (
          ts.isPropertySignature(candidate) &&
          candidate.name.getText(probe.source) === member &&
          candidate.type
        ) {
          found = probe.text(candidate.type).replace(/\s+/g, ' ')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(probe.source)
  if (found === undefined) {
    throw new Error(
      `${probe.source.fileName} declares no \`${interfaceName}.${member}\`. It was renamed, moved ` +
        'or deleted — update this test to the claim that replaced it rather than deleting the assertion.'
    )
  }
  return found
}

/** Bodies of the arrow callbacks passed to `.filter(...)` inside `scope`, whitespace-free. */
function filterPredicates(probe: MainSourceProbe, scope: ts.Node): string[] {
  return probe
    .callsTo(scope, 'filter')
    .map((call) => call.arguments[0])
    .filter((arg): arg is ts.ArrowFunction => Boolean(arg) && ts.isArrowFunction(arg))
    .map((arrow) => probe.text(arrow.body).replace(/\s+/g, ''))
}

function importSpecifiers(probe: MainSourceProbe): string[] {
  const specifiers: string[] = []
  for (const statement of probe.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text)
    }
  }
  return specifiers
}

const FENCE_MUTATORS = [
  'acquire',
  'release',
  'withFence',
  'reclaim',
  'tryCreateFence',
  'tryWriteNewRegularFile',
  'unlinkSync',
  'renameSync',
  'linkSync'
]

describe('workspace-lock commit fence isolation', () => {
  const authority = new MainSourceProbe(
    'WorkspaceLockAuthority.ts',
    new URL('./WorkspaceLockAuthority.ts', import.meta.url)
  )
  const runtime = new MainSourceProbe(
    'WorkspaceLockRuntime.ts',
    new URL('../WorkspaceLockRuntime.ts', import.meta.url)
  )
  const fence = new MainSourceProbe(
    'WorkspaceMutationCommitFence.ts',
    new URL('./WorkspaceMutationCommitFence.ts', import.meta.url)
  )

  it('the authority never imports or names the commit fence', () => {
    expect(importSpecifiers(authority)).not.toContain('./WorkspaceMutationCommitFence')
    expect(identifierCount(authority, 'WorkspaceMutationCommitFence')).toBe(0)
    // Positive control for the scan itself: the runtime does construct the fence.
    expect(runtime.construction('WorkspaceMutationCommitFence')).toHaveLength(1)
  })

  it('the periodic pass consults the fence through the read-only owner port and nothing else', () => {
    const pass = method(authority, 'WorkspaceLockAuthority', 'runPeriodicRecoveryOnce')
    const guard = method(authority, 'WorkspaceLockAuthority', 'holderOwnsCommitFence')
    const sweep = method(authority, 'WorkspaceLockAuthority', 'sweepDeadHolderHeartbeats')
    const audit = method(authority, 'WorkspaceLockAuthority', 'recordReclaimAudit')
    expect(authority.callsTo(guard, 'readCommitFenceOwner')).toHaveLength(1)
    expect(authority.callsTo(pass, 'holderOwnsCommitFence')).toHaveLength(1)
    expect(authority.callsTo(pass, 'sweepDeadHolderHeartbeats')).toHaveLength(1)
    expect(authority.callsTo(pass, 'recordReclaimAudit').length).toBeGreaterThanOrEqual(1)
    for (const scope of [pass, guard, sweep, audit]) {
      for (const forbidden of FENCE_MUTATORS) {
        expect(authority.callsTo(scope, forbidden), forbidden).toHaveLength(0)
      }
    }
    // The reclaim itself is an ordinary `recover` frame under the transition
    // mutex, replayable by every build on the shared root.
    expect(authority.callsTo(pass, 'commitUnderFence')).toHaveLength(1)
    const appends = authority.callsTo(pass, 'appendWorkspaceLockWalEvent')
    expect(appends.map((call) => authority.propText(call, 1, 'kind'))).toEqual(["'recover'"])
    // The periodic decision can only retire a lease: its type admits no
    // status but `recovered`, and its body names neither relabel status.
    expect(memberType(authority, 'PeriodicRecoveryDecision', 'status')).toBe("'recovered'")
    const decision = authority.fn('periodicRecoveryDecision')
    expect(authority.text(decision)).not.toMatch(/status:\s*'(orphan_live|recovery_blocked|held)'/)
    const statuses = [...authority.text(decision).matchAll(/status:\s*'([a-z_]+)'/g)].map(
      (match) => match[1]
    )
    expect(statuses.length).toBeGreaterThanOrEqual(2)
    expect(new Set(statuses)).toEqual(new Set(['recovered']))
    // Positive control: boot keeps its relabel, and it is a different function.
    expect(authority.text(authority.fn('recoveryDecision'))).toMatch(/'orphan_live'/)
    expect(authority.callsTo(pass, 'recoveryDecision')).toHaveLength(0)
    expect(authority.callsTo(pass, 'periodicRecoveryDecision')).toHaveLength(1)
  })

  it('the runtime port is a plain readFence over the claim partition, wired into open()', () => {
    const port = runtime.fn('readCommitFenceOwnerForClaim')
    expect(runtime.callsTo(port, 'readFence')).toHaveLength(1)
    expect(runtime.callsTo(port, 'mutationFencePartitionKeys')).toHaveLength(1)
    for (const forbidden of FENCE_MUTATORS) {
      expect(runtime.callsTo(port, forbidden), forbidden).toHaveLength(0)
    }
    expect(runtime.typeMembers('WorkspaceMutationCommitFenceLike')).toEqual([
      'acquire',
      'release',
      'readFence'
    ])
    const open = method(runtime, 'WorkspaceLockRuntime', 'open')
    const authorityOpen = runtime
      .callsTo(open, 'open')
      .find((call) => runtime.text(call.expression) === 'WorkspaceLockAuthority.open')
    if (!authorityOpen) throw new Error('WorkspaceLockRuntime.open no longer opens the authority')
    expect(runtime.propText(authorityOpen, 0, 'dependencies')).toContain(
      'readCommitFenceOwner: (claim) => readCommitFenceOwnerForClaim(mutationFence, claim)'
    )
  })

  it('the commit fence serializer keeps its over-strict live-only shape', () => {
    const acquire = method(fence, 'WorkspaceMutationCommitFence', 'acquire')
    expect(fence.callsTo(acquire, 'tryCreateFence')).toHaveLength(1)
    expect(fence.callsTo(acquire, 'observeExact')).toHaveLength(1)
    expect(fence.construction('WorkspaceMutationCommitFenceBusyError', acquire)).toHaveLength(1)
    fence.guard(acquire, "observation.state === 'identity_unavailable'")
    fence.guard(
      acquire,
      "observation.state === 'live' && observation.processBirthIdentity === existing.processBirthIdentity"
    )
    const reclaim = method(fence, 'WorkspaceMutationCommitFence', 'reclaim')
    expect(fence.callsTo(reclaim, 'acquireReclaimGuard')).toHaveLength(1)
    expect(fence.callsTo(reclaim, 'readFence').length).toBeGreaterThanOrEqual(2)
    expect(fence.callsTo(reclaim, 'observeExact')).toHaveLength(1)
    const readFence = method(fence, 'WorkspaceMutationCommitFence', 'readFence')
    for (const forbidden of FENCE_MUTATORS) {
      expect(fence.callsTo(readFence, forbidden), forbidden).toHaveLength(0)
    }
  })

  it('same-owner claims still skip conflict detection, so the fence stays the only in-run serializer', () => {
    const acquireMany = method(authority, 'WorkspaceLockAuthority', 'acquireMany')
    expect(filterPredicates(authority, acquireMany)).toContain(
      '!sameLeaseOwner(lease.owner,owner)&&workspaceLockClaimsConflict(lease.claim,claim)'
    )
    const replace = method(authority, 'WorkspaceLockAuthority', 'replaceAcquisition')
    expect(filterPredicates(authority, replace)).toContain(
      '!replacedIds.has(lease.leaseId)&&!sameLeaseOwner(lease.owner,owner)&&workspaceLockClaimsConflict(lease.claim,claim)'
    )
  })
})
