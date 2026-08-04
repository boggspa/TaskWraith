import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_CAPABILITY_ORDER,
  HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
  HOST_PROTOCOL_MAX_ID,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostAuthenticatedClientIdentity,
  type HostCapability,
  type HostCursorPosition
} from '../../shared/hostProtocol'
import type { HostTransportVerifiedClientContext } from './HostCommandIdentity'
import {
  HostSession,
  assertVerifiedContextMatchesAuthenticatedClient,
  type HostSessionBindRequest,
  type HostSessionPositionPort
} from './HostSession'

const FIXED_SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FIXED_SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function desktopVerified(
  overrides: Partial<HostTransportVerifiedClientContext> = {}
): HostTransportVerifiedClientContext {
  return {
    clientClass: 'desktop',
    clientId: 'desktop-local-1',
    actorId: 'desktop-session-1',
    ...overrides
  }
}

function tuiVerified(
  overrides: Partial<HostTransportVerifiedClientContext> = {}
): HostTransportVerifiedClientContext {
  return {
    clientClass: 'tui',
    clientId: 'tui-session-abc',
    actorId: 'tui-actor-abc',
    subjectId: 'tui-subject-abc',
    ...overrides
  }
}

function iosVerified(
  overrides: Partial<HostTransportVerifiedClientContext> = {}
): HostTransportVerifiedClientContext {
  return {
    clientClass: 'ios',
    clientId: 'ios-pair-client-9',
    actorId: 'ios-pair-subject-9',
    subjectId: 'pair-9',
    ...overrides
  }
}

function desktopAuth(
  overrides: Partial<HostAuthenticatedClientIdentity> = {}
): HostAuthenticatedClientIdentity {
  return {
    clientId: 'desktop-local-1',
    clientClass: 'desktop',
    clientVersion: '1.9.2',
    ...overrides
  }
}

function tuiAuth(
  overrides: Partial<HostAuthenticatedClientIdentity> = {}
): HostAuthenticatedClientIdentity {
  return {
    clientId: 'tui-session-abc',
    clientClass: 'tui',
    clientVersion: '0.4.0',
    subjectId: 'tui-subject-abc',
    ...overrides
  }
}

function iosAuth(
  overrides: Partial<HostAuthenticatedClientIdentity> = {}
): HostAuthenticatedClientIdentity {
  return {
    clientId: 'ios-pair-client-9',
    clientClass: 'ios',
    clientVersion: '1.2.0',
    subjectId: 'pair-9',
    displayName: 'Paired iPhone',
    ...overrides
  }
}

function positionPort(position: HostCursorPosition): HostSessionPositionPort {
  return {
    getPosition: () => ({ ...position })
  }
}

function openSession(
  overrides: {
    position?: HostCursorPosition
    sessionIdFactory?: () => string
    hostCapabilityOffer?: readonly HostCapability[]
    freshness?: 'live' | 'cached' | 'stale'
  } = {}
): HostSession {
  return new HostSession({
    host: { hostId: 'host-local-1', hostVersion: '1.9.2' },
    runtime: positionPort(overrides.position ?? { generation: 3, cursor: 17 }),
    hostCapabilityOffer:
      overrides.hostCapabilityOffer ??
      (['bootstrap', 'snapshot', 'deltas', 'commands', 'receipts', 'health'] as const),
    sessionIdFactory: overrides.sessionIdFactory ?? (() => FIXED_SESSION_A),
    freshness: overrides.freshness
  })
}

function bindRequest(
  verified: HostTransportVerifiedClientContext,
  authenticated: HostAuthenticatedClientIdentity,
  caps: readonly HostCapability[] = ['snapshot', 'deltas', 'health']
): HostSessionBindRequest {
  return {
    verifiedContext: verified,
    authenticatedClient: authenticated,
    clientCapabilityRequest: caps
  }
}

describe('assertVerifiedContextMatchesAuthenticatedClient', () => {
  it('accepts exact Desktop / TUI / iOS field matches', () => {
    expect(
      assertVerifiedContextMatchesAuthenticatedClient(desktopVerified(), desktopAuth())
    ).toEqual({ ok: true, value: true })
    expect(assertVerifiedContextMatchesAuthenticatedClient(tuiVerified(), tuiAuth())).toEqual({
      ok: true,
      value: true
    })
    expect(assertVerifiedContextMatchesAuthenticatedClient(iosVerified(), iosAuth())).toEqual({
      ok: true,
      value: true
    })
  })

  it('rejects class / clientId / subjectId spoof mismatches', () => {
    expect(
      assertVerifiedContextMatchesAuthenticatedClient(
        desktopVerified(),
        desktopAuth({ clientClass: 'ios' })
      )
    ).toMatchObject({ ok: false, error: 'verified clientClass does not match authenticatedClient' })
    expect(
      assertVerifiedContextMatchesAuthenticatedClient(
        desktopVerified(),
        desktopAuth({ clientId: 'other-desktop' })
      )
    ).toMatchObject({ ok: false, error: 'verified clientId does not match authenticatedClient' })
    expect(
      assertVerifiedContextMatchesAuthenticatedClient(
        iosVerified({ subjectId: 'pair-9' }),
        iosAuth({ subjectId: 'pair-OTHER' })
      )
    ).toMatchObject({ ok: false, error: 'verified subjectId does not match authenticatedClient' })
    expect(
      assertVerifiedContextMatchesAuthenticatedClient(
        desktopVerified(),
        desktopAuth({ subjectId: 'unexpected' })
      )
    ).toMatchObject({ ok: false, error: 'verified subjectId does not match authenticatedClient' })
  })
})

describe('HostSession.bind', () => {
  it('binds Desktop, authenticated TUI, and paired iOS with sole-journal position', () => {
    const rows: Array<{
      label: string
      verified: HostTransportVerifiedClientContext
      auth: HostAuthenticatedClientIdentity
      sessionId: string
    }> = [
      {
        label: 'desktop',
        verified: desktopVerified(),
        auth: desktopAuth(),
        sessionId: FIXED_SESSION_A
      },
      {
        label: 'tui',
        verified: tuiVerified(),
        auth: tuiAuth(),
        sessionId: FIXED_SESSION_B
      },
      {
        label: 'ios',
        verified: iosVerified(),
        auth: iosAuth(),
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      }
    ]

    for (const row of rows) {
      const session = openSession({
        position: { generation: 7, cursor: 21 },
        sessionIdFactory: () => row.sessionId
      })
      const result = session.bind(
        bindRequest(row.verified, row.auth, ['health', 'snapshot', 'deltas'])
      )
      expect(result.ok, row.label).toBe(true)
      if (!result.ok) continue
      expect(result.value.sessionId).toBe(row.sessionId)
      expect(result.value.boundGeneration).toBe(7)
      expect(result.value.boundCursor).toBe(21)
      expect(result.value.actor).toEqual({
        actorId: row.verified.actorId,
        clientId: row.verified.clientId,
        clientClass: row.verified.clientClass
      })
      expect('subjectId' in result.value.actor).toBe(false)
      expect(result.value.welcome).toMatchObject({
        type: 'host.welcome',
        protocolVersion: HOST_PROTOCOL_VERSION,
        controlProtocolCompat: HOST_CONTROL_PROTOCOL_COMPAT_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        hostId: 'host-local-1',
        hostVersion: '1.9.2',
        sessionId: row.sessionId,
        generation: 7,
        cursor: 21,
        capabilities: ['snapshot', 'deltas', 'health'],
        freshness: 'live'
      })
      expect(result.value.welcome.authenticatedClient.clientId).toBe(row.auth.clientId)
      expect(result.value.welcome.authenticatedClient.clientClass).toBe(row.auth.clientClass)
    }
  })

  it('intersects capabilities and never invents offers outside the host set', () => {
    const session = openSession({
      hostCapabilityOffer: HOST_CAPABILITY_ORDER
    })
    const result = session.bind(
      bindRequest(desktopVerified(), desktopAuth(), [
        'health',
        'snapshot',
        'health',
        'deltas',
        'bootstrap'
      ])
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Host offer order preserved; request duplicates collapsed.
    expect(result.value.welcome.capabilities).toEqual(['bootstrap', 'snapshot', 'deltas', 'health'])
  })

  it('sources generation/cursor only from the runtime port (not client input)', () => {
    let calls = 0
    const runtime: HostSessionPositionPort = {
      getPosition: () => {
        calls += 1
        return { generation: 11, cursor: 42 }
      }
    }
    const session = new HostSession({
      host: { hostId: 'host-local-1', hostVersion: '1.9.2' },
      runtime,
      hostCapabilityOffer: ['bootstrap', 'snapshot'],
      sessionIdFactory: () => FIXED_SESSION_A
    })
    const result = session.bind(bindRequest(desktopVerified(), desktopAuth(), ['snapshot']))
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.welcome.generation).toBe(11)
    expect(result.value.welcome.cursor).toBe(42)
    expect(result.value.boundGeneration).toBe(11)
    expect(result.value.boundCursor).toBe(42)
  })

  it('rejects identity mismatch / spoof before minting a session', () => {
    const session = openSession()
    const spoof = session.bind(
      bindRequest(desktopVerified(), desktopAuth({ clientId: 'forged-client' }), ['snapshot'])
    )
    expect(spoof.ok).toBe(false)
    expect(session.size()).toBe(0)

    const classSpoof = session.bind(
      bindRequest(desktopVerified(), { ...desktopAuth(), clientClass: 'tui' }, ['snapshot'])
    )
    expect(classSpoof.ok).toBe(false)
    expect(session.size()).toBe(0)
  })

  it('never treats a nested wire actor object as authority', () => {
    const sneakyVerified = {
      ...desktopVerified({ actorId: 'binding-actor', clientId: 'desktop-local-1' }),
      actor: {
        actorId: 'wire-forged-actor',
        clientId: 'wire-forged-client',
        clientClass: 'ios' as const
      }
    } as HostTransportVerifiedClientContext & {
      actor: { actorId: string; clientId: string; clientClass: 'ios' }
    }

    const session = openSession()
    const result = session.bind(bindRequest(sneakyVerified, desktopAuth(), ['snapshot']))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.actor).toEqual({
      actorId: 'binding-actor',
      clientId: 'desktop-local-1',
      clientClass: 'desktop'
    })
  })

  it('rejects client-selected sessionId on the bind request', () => {
    const session = openSession()
    const sneaky = {
      ...bindRequest(desktopVerified(), desktopAuth(), ['snapshot']),
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }
    const result = session.bind(sneaky as HostSessionBindRequest)
    expect(result).toEqual({ ok: false, error: 'sessionId cannot be client-selected' })
    expect(session.size()).toBe(0)
  })

  it('fails closed on unknown / oversized capabilities and unsafe verified fields', () => {
    const session = openSession()
    expect(
      session.bind(
        bindRequest(desktopVerified(), desktopAuth(), ['snapshot', 'not-a-cap' as HostCapability])
      )
    ).toMatchObject({ ok: false, error: 'unknown client capability: not-a-cap' })

    expect(
      session.bind(
        bindRequest(desktopVerified({ clientId: '' }), desktopAuth({ clientId: '' }), ['snapshot'])
      ).ok
    ).toBe(false)

    expect(
      session.bind(
        bindRequest(
          desktopVerified({ actorId: 'x'.repeat(HOST_PROTOCOL_MAX_ID + 1) }),
          desktopAuth(),
          ['snapshot']
        )
      ).ok
    ).toBe(false)
  })

  it('fails closed when the sessionId factory returns a non-UUID', () => {
    const session = openSession({ sessionIdFactory: () => 'not-a-uuid' })
    expect(session.bind(bindRequest(desktopVerified(), desktopAuth(), ['snapshot']))).toEqual({
      ok: false,
      error: 'sessionId mint produced an unsafe or non-UUID value'
    })
  })

  it('keeps the session id, refreshes sole-journal position, and never widens on re-bind', () => {
    let mintCount = 0
    let position = { generation: 3, cursor: 17 }
    let positionCalls = 0
    const session = new HostSession({
      host: { hostId: 'host-local-1', hostVersion: '1.9.2' },
      runtime: {
        getPosition: () => {
          positionCalls += 1
          return { ...position }
        }
      },
      hostCapabilityOffer: ['snapshot', 'commands', 'health'],
      sessionIdFactory: () => {
        mintCount += 1
        return mintCount === 1 ? FIXED_SESSION_A : FIXED_SESSION_B
      }
    })
    const first = session.bind(
      bindRequest(desktopVerified(), desktopAuth(), ['snapshot', 'health'])
    )
    position = { generation: 4, cursor: 29 }
    const second = session.bind(
      bindRequest(desktopVerified(), desktopAuth(), ['snapshot', 'commands'])
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.sessionId).toBe(FIXED_SESSION_A)
    expect(second.value.boundGeneration).toBe(4)
    expect(second.value.boundCursor).toBe(29)
    expect(second.value.welcome.generation).toBe(4)
    expect(second.value.welcome.cursor).toBe(29)
    // `commands` was not in the original grant, while `health` was omitted
    // from the current request: the refreshed grant can only narrow.
    expect(second.value.welcome.capabilities).toEqual(['snapshot'])
    expect(positionCalls).toBe(2)
    expect(mintCount).toBe(1)
    expect(session.size()).toBe(1)
    const found = session.lookup(FIXED_SESSION_A)
    expect(found.ok && found.value === second.value).toBe(true)
  })

  it('fails a re-bind without mutating the existing binding when position is unavailable', () => {
    let shouldThrow = false
    const session = new HostSession({
      host: { hostId: 'host-local-1', hostVersion: '1.9.2' },
      runtime: {
        getPosition: () => {
          if (shouldThrow) throw new Error('offline')
          return { generation: 3, cursor: 17 }
        }
      },
      hostCapabilityOffer: ['snapshot', 'health'],
      sessionIdFactory: () => FIXED_SESSION_A
    })
    const first = session.bind(
      bindRequest(desktopVerified(), desktopAuth(), ['snapshot', 'health'])
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return

    shouldThrow = true
    expect(session.bind(bindRequest(desktopVerified(), desktopAuth(), ['snapshot']))).toEqual({
      ok: false,
      error: 'runtime position unavailable'
    })
    const found = session.lookup(FIXED_SESSION_A)
    expect(found.ok && found.value === first.value).toBe(true)
  })

  it('mints distinct sessions for distinct verified actors', () => {
    let n = 0
    const ids = [FIXED_SESSION_A, FIXED_SESSION_B]
    const session = openSession({
      sessionIdFactory: () => ids[n++]!
    })
    const a = session.bind(bindRequest(desktopVerified(), desktopAuth(), ['snapshot']))
    const b = session.bind(bindRequest(tuiVerified(), tuiAuth(), ['snapshot']))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.value.sessionId).toBe(FIXED_SESSION_A)
    expect(b.value.sessionId).toBe(FIXED_SESSION_B)
    expect(session.size()).toBe(2)
  })
})

describe('HostSession.lookup', () => {
  it('returns the stable binding by host-issued sessionId and rejects unknowns', () => {
    const session = openSession()
    const bound = session.bind(bindRequest(iosVerified(), iosAuth(), ['snapshot', 'health']))
    expect(bound.ok).toBe(true)
    if (!bound.ok) return

    const found = session.lookup(bound.value.sessionId)
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value).toBe(bound.value)

    // Repeated lookup is stable.
    const again = session.lookup(bound.value.sessionId)
    expect(again).toEqual(found)
    expect(again.ok && again.value === bound.value).toBe(true)

    expect(session.lookup('ffffffff-ffff-4fff-8fff-ffffffffffff')).toEqual({
      ok: false,
      error: 'sessionId is unknown'
    })
    expect(session.lookup('')).toMatchObject({ ok: false })
    expect(session.lookup(' bad ')).toMatchObject({ ok: false })
  })
})

describe('HostSession construction guards', () => {
  it('requires safe host identity and a position port', () => {
    expect(
      () =>
        new HostSession({
          host: { hostId: '', hostVersion: '1.9.2' },
          runtime: positionPort({ generation: 0, cursor: 0 }),
          hostCapabilityOffer: ['bootstrap']
        })
    ).toThrow(/hostId/)
    expect(
      () =>
        new HostSession({
          host: { hostId: 'host-1', hostVersion: '' },
          runtime: positionPort({ generation: 0, cursor: 0 }),
          hostCapabilityOffer: ['bootstrap']
        })
    ).toThrow(/hostVersion/)
    expect(
      () =>
        new HostSession({
          host: { hostId: 'host-1', hostVersion: '1.9.2' },
          runtime: null as unknown as HostSessionPositionPort,
          hostCapabilityOffer: ['bootstrap']
        })
    ).toThrow(/runtime/)
  })
})

describe('HostSession structural isolation', () => {
  it('does not import listeners, net/http, Electron, Authority, or composition roots', () => {
    const source = readFileSync(join(__dirname, 'HostSession.ts'), 'utf8')
    const forbidden = [
      'createServer',
      'listen(',
      'node:net',
      'node:http',
      'node:https',
      'electron',
      'AppStoreHostAuthority',
      'EnsembleOrchestrator',
      'BridgeActionExecutor',
      'HostBridgeCommandExecutor',
      'HostDeferredCommandBridge',
      'HostDomainDeltaPublisher',
      "from '../../main/index'",
      "from '../index'"
    ]
    for (const needle of forbidden) {
      expect(source.includes(needle), needle).toBe(false)
    }
    // Position comes from the runtime port type / HostRuntimeBootstrap type-only import.
    expect(source).toContain('HostRuntimeBootstrap')
    expect(source).toContain('buildHostBootstrapWelcome')
    expect(source).toContain('hostActorIdentityFromVerifiedContext')
  })
})

afterEach(() => {
  // no shared mutable fixtures
})
