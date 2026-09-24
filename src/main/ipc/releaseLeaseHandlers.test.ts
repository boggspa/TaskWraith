import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  RELEASE_LEASE_GRANT_CHANNEL,
  RELEASE_LEASE_REVOKE_CHANNEL,
  RELEASE_LEASE_STATUS_CHANNEL,
  registerReleaseLeaseHandlers,
  unregisterReleaseLeaseHandlers,
  type ReleaseLeaseHandlerDeps
} from './releaseLeaseHandlers'
import type {
  ReleaseAuthorizationLease,
  ReleaseAuthorizationLeaseGrantInput
} from '../ReleaseAuthorizationLease'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
}))

const EVENT = { sender: { id: 1 } }

function handlerFor(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = handlers.get(channel)
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function leaseFixture(
  overrides: Partial<ReleaseAuthorizationLease> = {}
): ReleaseAuthorizationLease {
  return {
    id: 'lease-1',
    commandClasses: 'all',
    grantedAt: '2026-09-05T18:00:00.000Z',
    expiresAt: '2026-09-05T20:00:00.000Z',
    origin: 'desktop-ui',
    ...overrides
  }
}

type GrantMock = Mock<(input?: ReleaseAuthorizationLeaseGrantInput) => ReleaseAuthorizationLease>
type ActiveMock = Mock<() => ReleaseAuthorizationLease[]>
type RevokeMock = Mock<(leaseId?: string) => number>

interface Harness {
  deps: ReleaseLeaseHandlerDeps
  grant: GrantMock
  active: ActiveMock
  revoke: RevokeMock
}

function harness(): Harness {
  const grant: GrantMock = vi.fn(() => leaseFixture())
  const active: ActiveMock = vi.fn(() => [leaseFixture()])
  const revoke: RevokeMock = vi.fn(() => 1)
  const deps: ReleaseLeaseHandlerDeps = { leaseRegistry: { grant, active, revoke } }
  registerReleaseLeaseHandlers(deps)
  return { deps, grant, active, revoke }
}

describe('release lease handlers', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('registers exactly the grant/status/revoke channels', () => {
    harness()
    expect([...handlers.keys()].sort()).toEqual(
      [
        RELEASE_LEASE_GRANT_CHANNEL,
        RELEASE_LEASE_STATUS_CHANNEL,
        RELEASE_LEASE_REVOKE_CHANNEL
      ].sort()
    )
    expect(RELEASE_LEASE_GRANT_CHANNEL).toBe('release-lease-grant')
    expect(RELEASE_LEASE_STATUS_CHANNEL).toBe('release-lease-status')
    expect(RELEASE_LEASE_REVOKE_CHANNEL).toBe('release-lease-revoke')
  })

  it('grants through the injected registry with a desktop-ui origin stamp', async () => {
    const { grant } = harness()
    const lease = leaseFixture({ id: 'lease-9' })
    grant.mockReturnValue(lease)
    const result = await handlerFor(RELEASE_LEASE_GRANT_CHANNEL)(EVENT, { minutes: 30 })
    expect(grant).toHaveBeenCalledTimes(1)
    expect(grant).toHaveBeenCalledWith({ minutes: 30, origin: 'desktop-ui' })
    expect(result).toBe(lease)
  })

  it('grants with an empty input when the renderer passes nothing', async () => {
    const { grant } = harness()
    await handlerFor(RELEASE_LEASE_GRANT_CHANNEL)(EVENT)
    expect(grant).toHaveBeenCalledWith({ origin: 'desktop-ui' })
  })

  it('overrides any caller-supplied origin with desktop-ui', async () => {
    const { grant } = harness()
    await handlerFor(RELEASE_LEASE_GRANT_CHANNEL)(EVENT, { minutes: 10, origin: 'host' })
    expect(grant).toHaveBeenCalledWith({ minutes: 10, origin: 'desktop-ui' })
  })

  it('returns the active leases for status', async () => {
    const { active } = harness()
    const leases = [leaseFixture({ id: 'a' }), leaseFixture({ id: 'b' })]
    active.mockReturnValue(leases)
    const result = await handlerFor(RELEASE_LEASE_STATUS_CHANNEL)(EVENT)
    expect(active).toHaveBeenCalledTimes(1)
    expect(result).toBe(leases)
  })

  it('revokes one lease by id', async () => {
    const { revoke } = harness()
    const result = await handlerFor(RELEASE_LEASE_REVOKE_CHANNEL)(EVENT, 'lease-7')
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('lease-7')
    expect(result).toEqual({ revoked: 1 })
  })

  it('revokes all leases when no id is given', async () => {
    const { revoke } = harness()
    revoke.mockReturnValue(3)
    const result = await handlerFor(RELEASE_LEASE_REVOKE_CHANNEL)(EVENT)
    expect(revoke).toHaveBeenCalledWith(undefined)
    expect(result).toEqual({ revoked: 3 })
  })

  it('unregisters all three channels', () => {
    harness()
    expect(handlers.size).toBe(3)
    unregisterReleaseLeaseHandlers()
    expect(handlers.size).toBe(0)
  })
})
