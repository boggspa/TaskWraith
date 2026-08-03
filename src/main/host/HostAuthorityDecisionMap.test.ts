import { describe, expect, it } from 'vitest'

import {
  HOST_STORE_AUTHORITY_DECISIONS,
  HOST_STORE_TO_WIRE_AUTHORITY_DECISION,
  HOST_WIRE_AUTHORITY_DECISIONS,
  HOST_WIRE_TO_STORE_AUTHORITY_DECISION,
  mapHostStoreAuthorityDecisionToWire,
  mapHostWireAuthorityDecisionToStore
} from './HostAuthorityDecisionMap'

describe('HostAuthorityDecisionMap', () => {
  it('lists exactly three store and three wire decisions', () => {
    expect([...HOST_STORE_AUTHORITY_DECISIONS]).toEqual(['allowed', 'denied', 'deferred'])
    expect([...HOST_WIRE_AUTHORITY_DECISIONS]).toEqual(['allow', 'deny', 'ask'])
  })

  it.each([
    ['allowed', 'allow'],
    ['denied', 'deny'],
    ['deferred', 'ask']
  ] as const)('maps store %s → wire %s', (store, wire) => {
    expect(mapHostStoreAuthorityDecisionToWire(store)).toBe(wire)
    expect(HOST_STORE_TO_WIRE_AUTHORITY_DECISION[store]).toBe(wire)
  })

  it.each([
    ['allow', 'allowed'],
    ['deny', 'denied'],
    ['ask', 'deferred']
  ] as const)('maps wire %s → store %s', (wire, store) => {
    expect(mapHostWireAuthorityDecisionToStore(wire)).toBe(store)
    expect(HOST_WIRE_TO_STORE_AUTHORITY_DECISION[wire]).toBe(store)
  })

  it('is a bijection across every listed decision', () => {
    for (const store of HOST_STORE_AUTHORITY_DECISIONS) {
      const wire = mapHostStoreAuthorityDecisionToWire(store)
      expect(wire).not.toBeNull()
      expect(mapHostWireAuthorityDecisionToStore(wire)).toBe(store)
    }
    for (const wire of HOST_WIRE_AUTHORITY_DECISIONS) {
      const store = mapHostWireAuthorityDecisionToStore(wire)
      expect(store).not.toBeNull()
      expect(mapHostStoreAuthorityDecisionToWire(store)).toBe(wire)
    }
  })

  it.each([
    undefined,
    null,
    0,
    1,
    true,
    false,
    {},
    [],
    { decision: 'allowed' },
    '',
    'allow',
    'deny',
    'ask',
    'ALLOWED',
    'Allowed',
    'permit',
    'reject',
    'pending',
    'succeeded',
    'executed',
    'accepted',
    'unknown',
    ' deferred',
    'deferred ',
    'allowed\n'
  ])('store→wire fails closed for untrusted input %# (%j)', (value) => {
    expect(mapHostStoreAuthorityDecisionToWire(value)).toBeNull()
  })

  it.each([
    undefined,
    null,
    0,
    1,
    true,
    false,
    {},
    [],
    { decision: 'allow' },
    '',
    'allowed',
    'denied',
    'deferred',
    'ALLOW',
    'Allow',
    'permit',
    'reject',
    'pending',
    'succeeded',
    'executed',
    'accepted',
    'unknown',
    ' ask',
    'ask ',
    'deny\n'
  ])('wire→store fails closed for untrusted input %# (%j)', (value) => {
    expect(mapHostWireAuthorityDecisionToStore(value)).toBeNull()
  })

  it('does not treat wire tokens as store tokens or the reverse', () => {
    expect(mapHostStoreAuthorityDecisionToWire('allow')).toBeNull()
    expect(mapHostStoreAuthorityDecisionToWire('deny')).toBeNull()
    expect(mapHostStoreAuthorityDecisionToWire('ask')).toBeNull()
    expect(mapHostWireAuthorityDecisionToStore('allowed')).toBeNull()
    expect(mapHostWireAuthorityDecisionToStore('denied')).toBeNull()
    expect(mapHostWireAuthorityDecisionToStore('deferred')).toBeNull()
  })
})
