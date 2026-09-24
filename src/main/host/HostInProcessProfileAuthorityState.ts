/**
 * One-process handoff of the exact profile lease acquired before Electron main
 * is dynamically imported. The composition root receives only an assertion
 * port; the lease object and its opaque owner token never cross that boundary.
 */

import type { HostProfileAuthorityPort } from '../../host-runtime/HostProfileDomainStore'

export interface HostInProcessProfileLeasePort {
  readonly path: string
  assertHeld(): void
}

interface PreparedInProcessProfileAuthority {
  readonly profilePath: string
  readonly lease: HostInProcessProfileLeasePort
  readonly authority: HostProfileAuthorityPort
}

let prepared: PreparedInProcessProfileAuthority | null = null

export function publishInProcessProfileAuthority(input: {
  readonly profilePath: string
  readonly lease: HostInProcessProfileLeasePort
}): HostProfileAuthorityPort {
  if (
    !input ||
    typeof input.profilePath !== 'string' ||
    input.profilePath.length === 0 ||
    !input.lease ||
    input.lease.path !== input.profilePath ||
    typeof input.lease.assertHeld !== 'function'
  ) {
    throw new Error('In-process profile authority requires the exact profile lease')
  }
  if (prepared) throw new Error('An in-process profile authority is already prepared')
  input.lease.assertHeld()
  const authority = Object.freeze({
    assertProfileAuthority: () => input.lease.assertHeld()
  })
  prepared = Object.freeze({
    profilePath: input.profilePath,
    lease: input.lease,
    authority
  })
  return authority
}

export function getInProcessProfileAuthority(profilePath: string): HostProfileAuthorityPort | null {
  if (!prepared) return null
  if (prepared.profilePath !== profilePath) {
    throw new Error('In-process profile authority does not match the Desktop profile')
  }
  prepared.lease.assertHeld()
  return prepared.authority
}

export function clearInProcessProfileAuthority(
  expectedLease?: HostInProcessProfileLeasePort
): boolean {
  if (!prepared || (expectedLease && prepared.lease !== expectedLease)) return false
  prepared = null
  return true
}
