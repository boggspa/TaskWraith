import { describe, expect, it } from 'vitest'
import {
  decodeHostLocalTransportClientFrame,
  HOST_LOCAL_TRANSPORT_VERSION
} from '../../shared/hostProtocolTransport'
import {
  decodeThreadCatalogueMaintenanceQuery,
  decodeThreadCatalogueReadQuery
} from '../../shared/threadCatalogueProtocol'

const CHAT = 'chat-1'
const WITNESS = 'ab'.repeat(32)
const AT = '2026-10-05T12:00:00.000Z'

/** A `prepare` query: one of the maintenance methods that predates the fold RPC. */
const PREPARE = {
  method: 'prepare',
  chatId: CHAT,
  recoveryToken: 'token-1',
  sourceWitness: WITNESS,
  mutation: { kind: 'prune-blackboard', atMs: 1_000 }
}

/** A `fold-owned-log` query carrying one batch that takes the log from revision 2 to 3. */
const FOLD = {
  method: 'fold-owned-log',
  chatId: CHAT,
  recoveryToken: 'token-1',
  sourceWitness: WITNESS,
  headRevision: 3,
  updatedAt: AT,
  profileAuthority: 'authority-1',
  logEntries: [
    {
      format: 'taskwraith-chat-mutation',
      version: 1,
      chatId: CHAT,
      baseRevision: 2,
      revision: 3,
      savedAt: AT,
      operations: []
    }
  ]
}

describe('maintenance queries that predate the fold and reestablish methods', () => {
  const earlier: Array<[string, Record<string, unknown>]> = [
    ['repair-source', { method: 'repair-source', chatId: CHAT }],
    ['changed', { method: 'changed', chatId: CHAT }],
    ['begin-recovery', { method: 'begin-recovery', chatId: CHAT, desktopWriterId: 'desk-a' }],
    ['end-recovery', { method: 'end-recovery', chatId: CHAT, recoveryToken: 'token-1' }],
    [
      'adopt-prepared',
      { method: 'adopt-prepared', chatId: CHAT, recoveryToken: 'token-1', preparedId: 'prep-1' }
    ],
    ['prepared', { method: 'prepared', preparedId: 'prep-1' }],
    ['discard-prepared', { method: 'discard-prepared', preparedId: 'prep-1' }],
    ['prepare', PREPARE],
    ['owner', { method: 'owner', owner: { writer: 'desktop', writerId: 'desk-a', pid: 4101 } }],
    ['erase of one chat', { method: 'erase', chatId: CHAT }],
    ['erase of every chat', { method: 'erase' }]
  ]

  it.each(earlier)('still accepts %s unchanged', (_name, query) => {
    expect(decodeThreadCatalogueMaintenanceQuery(query)).toEqual(query)
  })

  it('still accepts a prepare of each older mutation kind', () => {
    const mutations = [
      { kind: 'prune-blackboard', atMs: 1_000 },
      { kind: 'repair-title', at: AT },
      { kind: 'recover-worker-control', at: AT },
      {
        kind: 'expire-wakeup',
        family: 'solo',
        wakeupId: 'wake-1',
        expectedWakeAt: AT,
        expiredAt: AT
      },
      { kind: 'settle-runs', nowIso: AT, minAgeMs: 0, runs: [{ runId: 'run-1' }] }
    ]
    for (const mutation of mutations)
      expect(decodeThreadCatalogueMaintenanceQuery({ ...PREPARE, mutation })).toEqual({
        ...PREPARE,
        mutation
      })
  })

  it('does not require the generation an erase gained with finish-erasure', () => {
    // An earlier client sends `erase` with no generation; a newer one may
    // send a field the erase decode has no use for. Neither is refused.
    expect(decodeThreadCatalogueMaintenanceQuery({ method: 'erase', chatId: CHAT })).toEqual({
      method: 'erase',
      chatId: CHAT
    })
    expect(
      decodeThreadCatalogueMaintenanceQuery({ method: 'erase', chatId: CHAT, generation: 'g-1' })
    ).toEqual({ method: 'erase', chatId: CHAT })
  })

  it('drops fields a newer client adds rather than rejecting the query', () => {
    expect(decodeThreadCatalogueMaintenanceQuery({ ...PREPARE, futureField: 'x' })).toEqual(PREPARE)
    expect(
      decodeThreadCatalogueMaintenanceQuery({
        method: 'begin-recovery',
        chatId: CHAT,
        desktopWriterId: 'desk-a',
        futureField: 'x'
      })
    ).toEqual({ method: 'begin-recovery', chatId: CHAT, desktopWriterId: 'desk-a' })
  })
})

describe('fold-owned-log requires every field its decoder names', () => {
  it('accepts the complete query', () => {
    expect(decodeThreadCatalogueMaintenanceQuery(FOLD)).toEqual(FOLD)
  })

  it('accepts a fold with no batches to carry', () => {
    expect(decodeThreadCatalogueMaintenanceQuery({ ...FOLD, logEntries: [] })).toEqual({
      ...FOLD,
      logEntries: []
    })
  })

  it('rejects a query missing headRevision', () => {
    const { headRevision: _omitted, ...withoutHead } = FOLD
    expect(decodeThreadCatalogueMaintenanceQuery(withoutHead)).toBeNull()
  })

  it.each([
    'chatId',
    'recoveryToken',
    'sourceWitness',
    'headRevision',
    'updatedAt',
    'profileAuthority',
    'logEntries'
  ])('rejects a query missing %s', (field) => {
    const query: Record<string, unknown> = { ...FOLD }
    delete query[field]
    expect(decodeThreadCatalogueMaintenanceQuery(query)).toBeNull()
  })

  it.each<[string, Record<string, unknown>]>([
    ['a head revision below 1', { headRevision: 0 }],
    ['a fractional head revision', { headRevision: 3.5 }],
    ['a head revision sent as text', { headRevision: '3' }],
    ['a witness that is not 64 lower-case hex characters', { sourceWitness: 'AB'.repeat(32) }],
    ['a witness that is too short', { sourceWitness: 'ab' }],
    ['a timestamp that is not ISO-8601', { updatedAt: 'yesterday' }],
    ['an empty profile authority', { profileAuthority: '' }],
    ['an unsafe chat id', { chatId: '../escape' }],
    ['log entries that are not a list', { logEntries: {} }],
    ['a head that is not the last batch’s revision', { headRevision: 4 }],
    ['a batch for another chat', { logEntries: [{ ...FOLD.logEntries[0], chatId: 'chat-2' }] }],
    [
      'a batch that does not move the revision forward',
      { logEntries: [{ ...FOLD.logEntries[0], baseRevision: 3 }] }
    ],
    [
      'batches that leave a gap',
      {
        logEntries: [
          { ...FOLD.logEntries[0], baseRevision: 0, revision: 1 },
          { ...FOLD.logEntries[0], baseRevision: 2, revision: 3 }
        ]
      }
    ],
    [
      'a batch in another log format version',
      { logEntries: [{ ...FOLD.logEntries[0], version: 2 }] }
    ]
  ])('rejects %s', (_name, override) => {
    expect(decodeThreadCatalogueMaintenanceQuery({ ...FOLD, ...override })).toBeNull()
  })
})

describe('methods this decoder does not know', () => {
  it.each([
    ['an unknown future method', { method: 'unknown-future-thing', chatId: CHAT }],
    ['a query with no method', { chatId: CHAT }],
    ['a method of the wrong type', { method: 7, chatId: CHAT }],
    ['a method differing only in case', { ...FOLD, method: 'Fold-Owned-Log' }]
  ])('rejects %s', (_name, query) => {
    expect(decodeThreadCatalogueMaintenanceQuery(query)).toBeNull()
  })

  it.each([null, undefined, 'fold-owned-log', 42, true])('rejects %j as a query', (value) => {
    expect(decodeThreadCatalogueMaintenanceQuery(value)).toBeNull()
  })

  it('rejects a reestablish-erasure without the generation an older query never carried', () => {
    expect(
      decodeThreadCatalogueMaintenanceQuery({ method: 'reestablish-erasure', chatId: CHAT })
    ).toBeNull()
  })

  it('keeps every maintenance method off the read-only surface', () => {
    for (const query of [
      FOLD,
      PREPARE,
      { method: 'reestablish-erasure', chatId: CHAT, generation: 'g-1' },
      { method: 'unknown-future-thing' }
    ])
      expect(decodeThreadCatalogueReadQuery(query)).toBeNull()
  })
})

describe('maintenance queries on the Host transport', () => {
  function frame(params: unknown): unknown {
    return {
      type: 'request',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: 'request-1',
      kind: 'thread.catalogue.maintenance',
      params
    }
  }

  it('carries an earlier query and a fold alike', () => {
    for (const params of [PREPARE, FOLD, { method: 'reestablish-erasure', generation: 'g-1' }])
      expect(decodeHostLocalTransportClientFrame(frame(params))).toEqual({
        ok: true,
        value: {
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'request-1',
          kind: 'thread.catalogue.maintenance',
          params
        }
      })
  })

  it('closes with one invalid_payload rejection for a malformed or unknown query', () => {
    const { headRevision: _omitted, ...withoutHead } = FOLD
    for (const params of [withoutHead, { method: 'unknown-future-thing' }, null])
      expect(decodeHostLocalTransportClientFrame(frame(params))).toEqual({
        ok: false,
        error: { code: 'invalid_payload' }
      })
  })

  it('rejects a request kind a build does not know, and a transport version it does not speak', () => {
    expect(
      decodeHostLocalTransportClientFrame({
        ...(frame(PREPARE) as object),
        kind: 'thread.catalogue.future'
      })
    ).toEqual({ ok: false, error: { code: 'unknown_request_kind' } })
    expect(
      decodeHostLocalTransportClientFrame({
        ...(frame(PREPARE) as object),
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION + 1
      })
    ).toEqual({ ok: false, error: { code: 'unsupported_transport_version' } })
  })
})
