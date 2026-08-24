import { isAbsolute, parse, resolve } from 'node:path'

import type { HostBootstrapWelcome, HostCapability } from '../../shared/hostProtocol'
import type { HostExternalEnsureResult, HostExternalSupervisor } from './HostExternalSupervisor'

const PRODUCTION_CAPABILITY_FLOOR: readonly HostCapability[] = [
  'commands',
  'receipts',
  'setup',
  'provider-catalog',
  'provider-auth',
  'history',
  'health'
]

export interface PreparedExternalHost {
  readonly profilePath: string
  readonly cutoverId: string
  readonly supervisor: HostExternalSupervisor
  readonly result: HostExternalEnsureResult
}

let prepared: PreparedExternalHost | null = null

function assertProfile(profilePath: string): void {
  if (
    typeof profilePath !== 'string' ||
    !isAbsolute(profilePath) ||
    resolve(profilePath) !== profilePath ||
    profilePath === parse(profilePath).root
  ) {
    throw new Error('Prepared external Host requires a canonical non-root profile.')
  }
}

function cloneWelcome(welcome: HostBootstrapWelcome): HostBootstrapWelcome {
  if (
    !welcome ||
    welcome.hostVersion !== 'node-host-v1' ||
    !PRODUCTION_CAPABILITY_FLOOR.every((capability) => welcome.capabilities.includes(capability))
  ) {
    throw new Error('Prepared external Host is not a production Node Host.')
  }
  return {
    ...welcome,
    authenticatedClient: { ...welcome.authenticatedClient },
    capabilities: [...welcome.capabilities]
  }
}

/** Publish one authenticated preparation for the later dynamically imported Desktop graph. */
export function publishPreparedExternalHost(input: PreparedExternalHost): PreparedExternalHost {
  if (
    !input ||
    typeof input.supervisor?.ensureAvailable !== 'function' ||
    typeof input.cutoverId !== 'string' ||
    !input.cutoverId ||
    input.cutoverId.length > 200 ||
    input.cutoverId.trim() !== input.cutoverId ||
    [...input.cutoverId].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    })
  ) {
    throw new Error('Prepared external Host requires its supervisor.')
  }
  assertProfile(input.profilePath)
  if (prepared) throw new Error('A prepared external Host is already pending consumption.')
  const welcome = cloneWelcome(input.result.welcome)
  const result: HostExternalEnsureResult =
    input.result.kind === 'existing'
      ? { kind: 'existing', welcome }
      : { kind: 'launched', pid: input.result.pid, welcome }
  prepared = Object.freeze({
    profilePath: input.profilePath,
    cutoverId: input.cutoverId,
    supervisor: input.supervisor,
    result
  })
  return prepared
}

/** Consume the preparation exactly once and only for the same canonical profile. */
export function consumePreparedExternalHost(profilePath: string): PreparedExternalHost | null {
  assertProfile(profilePath)
  if (!prepared) return null
  if (prepared.profilePath !== profilePath) {
    throw new Error('Prepared external Host profile does not match Desktop profile.')
  }
  const value = prepared
  prepared = null
  return value
}

/** Drop a failed preparation by exact owner; detaches only and never stops the independent Host. */
export function clearPreparedExternalHost(expected?: HostExternalSupervisor): boolean {
  if (!prepared || (expected && prepared.supervisor !== expected)) return false
  const value = prepared
  prepared = null
  value.supervisor.close()
  return true
}
