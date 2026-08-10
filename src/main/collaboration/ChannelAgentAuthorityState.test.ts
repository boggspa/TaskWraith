import { generateIdentityKeyPair, exportRawEd25519PublicKey } from '../../shared/e2ee/keys'
import {
  channelAgentPublicKeyFingerprint,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  signChannelAgentRevocation,
  type ChannelAgentDelegation,
  type ChannelAgentDispatchGrant,
  type ChannelAgentPost,
  type ChannelAgentRevocation,
  type SignedChannelAgentDelegation,
  type SignedChannelAgentDispatchGrant,
  type SignedChannelAgentRevocation
} from '../../shared/collaboration/ChannelAgentProtocol'
import { describe, expect, it } from 'vitest'

import {
  ChannelAgentAuthorityState,
  ChannelAgentAuthorityStateError,
  type ChannelAgentAuthoritySnapshot,
  type ChannelAgentAuthorityStateErrorCode,
  type ConsumeChannelAgentDispatchInput
} from './ChannelAgentAuthorityState'

const CHANNEL_ID = 'channel-1'
const OWNER_MEMBER_ID = 'owner-member'
const AGENT_MEMBER_ID = 'agent-member-1'
const AGENT_SEAT_ID = 'pooled-agent-1'
const DELEGATION_ID = 'delegation-1'
const GRANT_ID = 'grant-1'
const ISSUED_AT = 1_000
const NOT_BEFORE = 2_000
const NOW = 3_000
const EXPIRES_AT = 10_000
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const ownerKeys = generateIdentityKeyPair()
const otherOwnerKeys = generateIdentityKeyPair()
const firstAgentKeys = generateIdentityKeyPair()
const secondAgentKeys = generateIdentityKeyPair()
const firstAgentPublicKeyB64 = exportRawEd25519PublicKey(firstAgentKeys.publicKey).toString(
  'base64'
)
const secondAgentPublicKeyB64 = exportRawEd25519PublicKey(secondAgentKeys.publicKey).toString(
  'base64'
)

function delegationValue(overrides: Partial<ChannelAgentDelegation> = {}): ChannelAgentDelegation {
  return {
    schemaVersion: 1,
    delegationId: DELEGATION_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_MEMBER_ID,
    agentMemberId: AGENT_MEMBER_ID,
    agentSeatId: AGENT_SEAT_ID,
    agentPublicKeyB64: firstAgentPublicKeyB64,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: ISSUED_AT,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    maxPostBytes: 8_000,
    ...overrides
  }
}

function signedDelegation(
  overrides: Partial<ChannelAgentDelegation> = {},
  privateKey = ownerKeys.privateKey
): SignedChannelAgentDelegation {
  return signChannelAgentDelegation(privateKey, delegationValue(overrides))
}

function grantValue(overrides: Partial<ChannelAgentDispatchGrant> = {}): ChannelAgentDispatchGrant {
  return {
    schemaVersion: 1,
    grantId: GRANT_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_MEMBER_ID,
    agentMemberId: AGENT_MEMBER_ID,
    agentSeatId: AGENT_SEAT_ID,
    agentPublicKeyB64: firstAgentPublicKeyB64,
    keyGeneration: 1,
    delegationId: DELEGATION_ID,
    trigger: 'mention',
    allowedMentionerMemberIds: ['human-a', OWNER_MEMBER_ID],
    workspaceIdentityHash: HASH_A,
    permissionPostureHash: HASH_B,
    issuedAt: ISSUED_AT,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    maxDispatches: 2,
    ...overrides
  }
}

function signedGrant(
  overrides: Partial<ChannelAgentDispatchGrant> = {},
  privateKey = ownerKeys.privateKey
): SignedChannelAgentDispatchGrant {
  return signChannelAgentDispatchGrant(privateKey, grantValue(overrides))
}

function revocationValue(overrides: Partial<ChannelAgentRevocation> = {}): ChannelAgentRevocation {
  return {
    schemaVersion: 1,
    revocationId: 'revocation-1',
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_MEMBER_ID,
    agentSeatId: AGENT_SEAT_ID,
    keyGeneration: 1,
    targetKind: 'dispatch_grant',
    targetId: GRANT_ID,
    revokedAt: NOW,
    reason: 'owner_revoked',
    ...overrides
  }
}

function signedRevocation(
  overrides: Partial<ChannelAgentRevocation> = {},
  privateKey = ownerKeys.privateKey
): SignedChannelAgentRevocation {
  return signChannelAgentRevocation(privateKey, revocationValue(overrides))
}

function resolveOwner(channelId: string, ownerMemberId: string) {
  return channelId === CHANNEL_ID && ownerMemberId === OWNER_MEMBER_ID ? ownerKeys.publicKey : null
}

function state(): ChannelAgentAuthorityState {
  return ChannelAgentAuthorityState.create({
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_MEMBER_ID,
    resolveOwnerPublicKey: resolveOwner
  })
}

function readyState(
  grantOverrides: Partial<ChannelAgentDispatchGrant> = {}
): ChannelAgentAuthorityState {
  const value = state()
  value.registerDelegation(signedDelegation())
  value.registerDispatchGrant(signedGrant(grantOverrides))
  return value
}

function consumeInput(
  overrides: Partial<ConsumeChannelAgentDispatchInput> = {}
): ConsumeChannelAgentDispatchInput {
  return {
    grantId: GRANT_ID,
    triggerMessageId: 'message-1',
    mentionerMemberId: 'human-a',
    workspaceIdentityHash: HASH_A,
    permissionPostureHash: HASH_B,
    at: NOW,
    ...overrides
  }
}

function postValue(overrides: Partial<ChannelAgentPost> = {}): ChannelAgentPost {
  const content = overrides.content ?? 'Agent result'
  return {
    schemaVersion: 1,
    channelId: CHANNEL_ID,
    agentMemberId: AGENT_MEMBER_ID,
    agentSeatId: AGENT_SEAT_ID,
    agentPublicKeyB64: firstAgentPublicKeyB64,
    keyGeneration: 1,
    delegationId: DELEGATION_ID,
    dispatchGrantId: GRANT_ID,
    triggerMessageId: 'message-1',
    runId: 'run-1',
    runAuthorityHash: HASH_A,
    clientMessageId: 'agent-post-1',
    kind: 'agent.text',
    content,
    contentHash: hashChannelAgentContent(content),
    createdAt: NOW + 100,
    ...overrides
  }
}

function signedPost(overrides: Partial<ChannelAgentPost> = {}) {
  return signChannelAgentPost(firstAgentKeys.privateKey, postValue(overrides))
}

function expectStateError(
  operation: () => unknown,
  code: ChannelAgentAuthorityStateErrorCode
): ChannelAgentAuthorityStateError {
  let caught: unknown
  try {
    operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ChannelAgentAuthorityStateError)
  expect(caught).toMatchObject({ code })
  return caught as ChannelAgentAuthorityStateError
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function mutateSnapshot(
  snapshot: ChannelAgentAuthoritySnapshot,
  mutate: (value: Record<string, unknown>) => void
): unknown {
  const copy = jsonClone(snapshot) as unknown as Record<string, unknown>
  mutate(copy)
  return copy
}

describe('ChannelAgentAuthorityState', () => {
  it('records owner-signed authority idempotently and replays one canonical mutation history', () => {
    const value = state()
    const delegation = signedDelegation()
    const grant = signedGrant()

    expect(value.registerDelegation(delegation)).toBe('stored')
    expect(value.registerDelegation(delegation)).toBe('existing')
    expect(value.registerDispatchGrant(grant)).toBe('stored')
    expect(value.registerDispatchGrant(grant)).toBe('existing')

    const snapshot = value.snapshot()
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      channelId: CHANNEL_ID,
      ownerMemberId: OWNER_MEMBER_ID,
      revision: 2
    })
    expect(snapshot.delegations).toEqual([{ recordedRevision: 1, signedDelegation: delegation }])
    expect(snapshot.dispatchGrants).toEqual([{ recordedRevision: 2, signedDispatchGrant: grant }])
    expect(value.getDelegation(DELEGATION_ID)).toEqual(delegation)
    expect(value.getDispatchGrant(GRANT_ID)).toEqual(grant)

    const reloaded = ChannelAgentAuthorityState.fromSnapshot(snapshot, resolveOwner)
    expect(reloaded.snapshot()).toEqual(snapshot)

    const projected = value.getDelegation(DELEGATION_ID)!
    ;(projected.delegation as { delegationId: string }).delegationId = 'mutated-copy'
    expect(value.getDelegation(DELEGATION_ID)?.delegation.delegationId).toBe(DELEGATION_ID)
  })

  it('rejects unpinned signers, wrong roots, unknown fields, and conflicting ids without mutation', () => {
    const value = state()
    expectStateError(
      () => value.registerDelegation(signedDelegation({}, otherOwnerKeys.privateKey)),
      'signature_invalid'
    )
    expectStateError(
      () => value.registerDelegation(signedDelegation({ channelId: 'channel-2' })),
      'binding_mismatch'
    )
    expectStateError(
      () => value.registerDelegation(signedDelegation({ ownerMemberId: 'other-owner' })),
      'binding_mismatch'
    )
    const withUnknownField = {
      ...signedDelegation(),
      unexpected: true
    }
    expectStateError(() => value.registerDelegation(withUnknownField), 'invalid_input')
    expect(value.snapshot().revision).toBe(0)

    const first = signedDelegation()
    value.registerDelegation(first)
    expectStateError(
      () => value.registerDelegation(signedDelegation({ maxPostBytes: 7_999 })),
      'id_conflict'
    )
    expect(value.snapshot().revision).toBe(1)

    const noOwner = ChannelAgentAuthorityState.create({
      channelId: CHANNEL_ID,
      ownerMemberId: OWNER_MEMBER_ID,
      resolveOwnerPublicKey: () => null
    })
    expectStateError(() => noOwner.registerDelegation(first), 'owner_unavailable')
    const privateOwner = ChannelAgentAuthorityState.create({
      channelId: CHANNEL_ID,
      ownerMemberId: OWNER_MEMBER_ID,
      resolveOwnerPublicKey: () => ownerKeys.privateKey
    })
    expectStateError(() => privateOwner.registerDelegation(first), 'owner_unavailable')
  })

  it('requires a dispatch-scoped matching delegation before it records a grant', () => {
    const value = state()
    expectStateError(() => value.registerDispatchGrant(signedGrant()), 'target_not_found')

    value.registerDelegation(signedDelegation())
    expectStateError(
      () => value.registerDispatchGrant(signedGrant({}, otherOwnerKeys.privateKey)),
      'signature_invalid'
    )
    expectStateError(
      () =>
        value.registerDispatchGrant(
          signedGrant({ agentSeatId: 'another-seat', grantId: 'grant-wrong-seat' })
        ),
      'binding_mismatch'
    )
    expectStateError(
      () =>
        value.registerDispatchGrant(
          signedGrant({ expiresAt: EXPIRES_AT + 1, grantId: 'grant-too-long' })
        ),
      'binding_mismatch'
    )
    expect(value.snapshot().revision).toBe(1)

    const postOnly = state()
    postOnly.registerDelegation(signedDelegation({ scopes: ['channel.post'] }))
    expectStateError(() => postOnly.registerDispatchGrant(signedGrant()), 'binding_mismatch')
  })

  it('consumes each durable trigger once and spends the signed grant budget monotonically', () => {
    const value = readyState({ maxDispatches: 2 })
    const first = value.consumeDispatch(consumeInput())
    expect(first).toEqual({
      kind: 'authorized',
      delegation: signedDelegation(),
      dispatchGrant: signedGrant({ maxDispatches: 2 }),
      consumption: {
        schemaVersion: 1,
        recordedRevision: 3,
        channelId: CHANNEL_ID,
        grantId: GRANT_ID,
        triggerMessageId: 'message-1',
        mentionerMemberId: 'human-a',
        workspaceIdentityHash: HASH_A,
        permissionPostureHash: HASH_B,
        dispatchOrdinal: 1,
        consumedAt: NOW
      },
      remainingDispatches: 1
    })

    const duplicate = value.consumeDispatch(
      consumeInput({
        mentionerMemberId: OWNER_MEMBER_ID,
        workspaceIdentityHash: 'c'.repeat(64),
        permissionPostureHash: 'd'.repeat(64),
        at: EXPIRES_AT
      })
    )
    expect(duplicate).toMatchObject({ kind: 'duplicate', consumption: { dispatchOrdinal: 1 } })

    const second = value.consumeDispatch(
      consumeInput({ triggerMessageId: 'message-2', mentionerMemberId: OWNER_MEMBER_ID })
    )
    expect(second).toMatchObject({
      kind: 'authorized',
      consumption: { recordedRevision: 4, dispatchOrdinal: 2 },
      remainingDispatches: 0
    })
    expect(value.consumeDispatch(consumeInput({ triggerMessageId: 'message-3' }))).toEqual({
      kind: 'denied',
      reason: 'dispatch_budget_exhausted'
    })
    expect(value.snapshot().revision).toBe(4)
    expect(value.getConsumption(GRANT_ID, 'message-1')).toEqual(
      first.kind === 'authorized' ? first.consumption : null
    )
  })

  it('verifies a signed terminal post against the exact consumed authority prefix read-only', () => {
    const value = readyState()
    const consumption = value.consumeDispatch(consumeInput())
    expect(consumption).toMatchObject({ kind: 'authorized' })
    const revision = value.snapshot().revision
    const post = signedPost()

    expect(value.verifyPostAuthority({ signedPost: post, acceptedAt: NOW + 200 })).toEqual({
      kind: 'authorized',
      authorityRevision: revision,
      delegation: signedDelegation(),
      dispatchGrant: signedGrant(),
      consumption: consumption.kind === 'authorized' ? consumption.consumption : null,
      signedPost: post
    })
    expect(value.snapshot().revision).toBe(revision)
  })

  it('denies missing, forged, misbound, expired, and future-revision post authority', () => {
    const withoutConsumption = readyState()
    expect(
      withoutConsumption.verifyPostAuthority({ signedPost: signedPost(), acceptedAt: NOW + 200 })
    ).toEqual({ kind: 'denied', reason: 'dispatch_consumption_missing' })

    const value = readyState()
    value.consumeDispatch(consumeInput())
    expect(
      value.verifyPostAuthority({
        signedPost: signChannelAgentPost(secondAgentKeys.privateKey, postValue()),
        acceptedAt: NOW + 200
      })
    ).toEqual({ kind: 'denied', reason: 'agent_signature_invalid' })
    expect(
      value.verifyPostAuthority({
        signedPost: signedPost({ triggerMessageId: 'message-missing' }),
        acceptedAt: NOW + 200
      })
    ).toEqual({ kind: 'denied', reason: 'dispatch_consumption_missing' })
    expect(
      value.verifyPostAuthority({
        signedPost: signedPost(),
        acceptedAt: EXPIRES_AT
      })
    ).toEqual({ kind: 'denied', reason: 'authority_expired' })
    expect(
      value.verifyPostAuthority({
        signedPost: signedPost(),
        acceptedAt: NOW + 200,
        authorityRevision: value.snapshot().revision + 1
      })
    ).toEqual({ kind: 'denied', reason: 'authority_revision_invalid' })
    expectStateError(
      () =>
        value.verifyPostAuthority({
          signedPost: signedPost(),
          acceptedAt: NOW + 200,
          unexpected: true
        } as never),
      'invalid_input'
    )
  })

  it('uses the logged authority revision so later revocation cannot rewrite a valid post', () => {
    const value = readyState()
    value.consumeDispatch(consumeInput())
    const acceptedRevision = value.snapshot().revision
    const post = signedPost()

    expect(value.registerRevocation(signedRevocation({ revokedAt: NOW + 200 }))).toBe('stored')
    expect(value.verifyPostAuthority({ signedPost: post, acceptedAt: NOW + 200 })).toEqual({
      kind: 'denied',
      reason: 'authority_revoked'
    })
    expect(
      value.verifyPostAuthority({
        signedPost: post,
        acceptedAt: NOW + 200,
        authorityRevision: acceptedRevision
      })
    ).toMatchObject({ kind: 'authorized', authorityRevision: acceptedRevision })
    expect(
      value.verifyPostAuthority({
        signedPost: post,
        acceptedAt: NOW + 200,
        authorityRevision: acceptedRevision - 1
      })
    ).toEqual({ kind: 'denied', reason: 'dispatch_consumption_missing' })
  })

  it.each([
    ['authority_not_yet_valid', { at: NOT_BEFORE - 1 }],
    ['authority_expired', { at: EXPIRES_AT }],
    ['mentioner_not_allowed', { mentionerMemberId: 'human-b' }],
    ['workspace_identity_mismatch', { workspaceIdentityHash: 'c'.repeat(64) }],
    ['permission_posture_mismatch', { permissionPostureHash: 'c'.repeat(64) }]
  ] as const)('denies %s without consuming revision or budget', (reason, override) => {
    const value = readyState()
    expect(value.consumeDispatch(consumeInput(override))).toEqual({ kind: 'denied', reason })
    expect(value.snapshot().revision).toBe(2)
    expect(value.snapshot().consumptions).toEqual([])
  })

  it('rejects malformed consumption input before authority lookup', () => {
    const value = readyState()
    expectStateError(
      () =>
        value.consumeDispatch({
          ...consumeInput(),
          unexpected: true
        } as ConsumeChannelAgentDispatchInput),
      'invalid_input'
    )
    expectStateError(
      () => value.consumeDispatch(consumeInput({ triggerMessageId: 'line\nbreak' })),
      'invalid_input'
    )
    expect(value.snapshot().revision).toBe(2)
  })

  it('applies grant, delegation, and key revocations only to their signed targets', () => {
    const grantScoped = state()
    grantScoped.registerDelegation(signedDelegation())
    grantScoped.registerDispatchGrant(signedGrant())
    grantScoped.registerDispatchGrant(signedGrant({ grantId: 'grant-2' }))
    grantScoped.registerRevocation(signedRevocation())
    expect(grantScoped.consumeDispatch(consumeInput())).toEqual({
      kind: 'denied',
      reason: 'authority_revoked'
    })
    expect(
      grantScoped.consumeDispatch(
        consumeInput({ grantId: 'grant-2', triggerMessageId: 'message-2' })
      )
    ).toMatchObject({ kind: 'authorized' })

    const delegationScoped = readyState()
    delegationScoped.registerRevocation(
      signedRevocation({ targetKind: 'delegation', targetId: DELEGATION_ID })
    )
    expect(delegationScoped.consumeDispatch(consumeInput())).toEqual({
      kind: 'denied',
      reason: 'authority_revoked'
    })

    const keyScoped = readyState()
    keyScoped.registerRevocation(
      signedRevocation({
        targetKind: 'agent_key',
        targetId: channelAgentPublicKeyFingerprint(firstAgentPublicKeyB64)
      })
    )
    expect(keyScoped.consumeDispatch(consumeInput())).toEqual({
      kind: 'denied',
      reason: 'authority_revoked'
    })
  })

  it('uses recorded order at equal timestamps and refuses a retroactive revocation', () => {
    const value = readyState()
    expect(value.consumeDispatch(consumeInput())).toMatchObject({ kind: 'authorized' })
    expect(value.registerRevocation(signedRevocation({ revokedAt: NOW }))).toBe('stored')
    expect(value.consumeDispatch(consumeInput({ triggerMessageId: 'message-2' }))).toEqual({
      kind: 'denied',
      reason: 'authority_revoked'
    })
    expect(
      ChannelAgentAuthorityState.fromSnapshot(value.snapshot(), resolveOwner).snapshot()
    ).toEqual(value.snapshot())

    const retroactive = readyState()
    expect(
      retroactive.consumeDispatch(
        consumeInput({ triggerMessageId: 'message-later', at: NOW + 100 })
      )
    ).toMatchObject({ kind: 'authorized' })
    expectStateError(
      () => retroactive.registerRevocation(signedRevocation({ revokedAt: NOW })),
      'revocation_conflict'
    )
    expect(retroactive.snapshot().revision).toBe(3)
  })

  it('requires contiguous key generations and a signed prior-key revocation before rotation', () => {
    const value = state()
    expectStateError(
      () => value.registerDelegation(signedDelegation({ keyGeneration: 2 })),
      'generation_rollback'
    )
    value.registerDelegation(signedDelegation())
    expectStateError(
      () =>
        value.registerDelegation(
          signedDelegation({
            delegationId: 'delegation-conflicting-key',
            agentPublicKeyB64: secondAgentPublicKeyB64
          })
        ),
      'generation_rollback'
    )
    expectStateError(
      () =>
        value.registerDelegation(
          signedDelegation({
            delegationId: 'delegation-generation-3',
            keyGeneration: 3,
            agentPublicKeyB64: secondAgentPublicKeyB64
          })
        ),
      'generation_rollback'
    )
    expectStateError(
      () =>
        value.registerDelegation(
          signedDelegation({
            delegationId: 'delegation-generation-2',
            keyGeneration: 2,
            agentPublicKeyB64: secondAgentPublicKeyB64,
            notBefore: NOW
          })
        ),
      'revocation_conflict'
    )

    value.registerRevocation(
      signedRevocation({
        targetKind: 'agent_key',
        targetId: channelAgentPublicKeyFingerprint(firstAgentPublicKeyB64),
        reason: 'key_rotated'
      })
    )
    expect(
      value.registerDelegation(
        signedDelegation({
          delegationId: 'delegation-generation-2',
          agentPublicKeyB64: secondAgentPublicKeyB64,
          keyGeneration: 2,
          issuedAt: NOW,
          notBefore: NOW
        })
      )
    ).toBe('stored')
    expectStateError(
      () => value.registerDelegation(signedDelegation({ delegationId: 'delegation-rollback' })),
      'generation_rollback'
    )
  })

  it('rejects missing, misbound, and incorrectly signed revocation targets', () => {
    const value = readyState()
    expectStateError(
      () => value.registerRevocation(signedRevocation({ targetId: 'missing-grant' })),
      'target_not_found'
    )
    expectStateError(
      () => value.registerRevocation(signedRevocation({ agentSeatId: 'wrong-seat' })),
      'target_not_found'
    )
    expectStateError(
      () => value.registerRevocation(signedRevocation({}, otherOwnerKeys.privateKey)),
      'signature_invalid'
    )

    const revocation = signedRevocation()
    expect(value.registerRevocation(revocation)).toBe('stored')
    expect(value.registerRevocation(revocation)).toBe('existing')
    expectStateError(
      () => value.registerRevocation(signedRevocation({ reason: 'channel_closed' })),
      'id_conflict'
    )
  })

  it('scopes trigger deduplication to one grant', () => {
    const value = state()
    value.registerDelegation(signedDelegation())
    value.registerDispatchGrant(signedGrant({ maxDispatches: 1 }))
    value.registerDispatchGrant(signedGrant({ grantId: 'grant-2', maxDispatches: 1 }))

    expect(value.consumeDispatch(consumeInput())).toMatchObject({ kind: 'authorized' })
    expect(value.consumeDispatch(consumeInput({ grantId: 'grant-2' }))).toMatchObject({
      kind: 'authorized',
      consumption: { dispatchOrdinal: 1 }
    })
    expect(value.snapshot().consumptions).toHaveLength(2)
  })

  it('rejects hostile snapshot edits, mutation loss, order rollback, and key-generation replay', () => {
    const value = readyState()
    value.consumeDispatch(consumeInput())
    value.registerRevocation(signedRevocation({ revokedAt: NOW }))
    value.registerDelegation(
      signedDelegation({ delegationId: 'delegation-z', notBefore: NOT_BEFORE + 1 })
    )
    const snapshot = value.snapshot()

    const hostile: unknown[] = [
      mutateSnapshot(snapshot, (copy) => {
        copy.unexpected = true
      }),
      mutateSnapshot(snapshot, (copy) => {
        copy.revision = (copy.revision as number) - 1
      }),
      mutateSnapshot(snapshot, (copy) => {
        const delegations = copy.delegations as Array<Record<string, unknown>>
        delegations[0].recordedRevision = 99
      }),
      mutateSnapshot(snapshot, (copy) => {
        const consumptions = copy.consumptions as Array<Record<string, unknown>>
        consumptions.splice(0, 1)
      }),
      mutateSnapshot(snapshot, (copy) => {
        const consumptions = copy.consumptions as Array<Record<string, unknown>>
        consumptions[0].mentionerMemberId = 'human-b'
      }),
      mutateSnapshot(snapshot, (copy) => {
        const consumptions = copy.consumptions as Array<Record<string, unknown>>
        const revocations = copy.revocations as Array<Record<string, unknown>>
        const prior = consumptions[0].recordedRevision
        consumptions[0].recordedRevision = revocations[0].recordedRevision
        revocations[0].recordedRevision = prior
      }),
      mutateSnapshot(snapshot, (copy) => {
        const delegations = copy.delegations as Array<Record<string, unknown>>
        delegations.reverse()
      }),
      mutateSnapshot(snapshot, (copy) => {
        const delegations = copy.delegations as Array<Record<string, unknown>>
        const signed = delegations[0].signedDelegation as Record<string, unknown>
        signed.ownerSignatureB64 = Buffer.alloc(64).toString('base64')
      })
    ]
    for (const candidate of hostile) {
      expectStateError(
        () => ChannelAgentAuthorityState.fromSnapshot(candidate, resolveOwner),
        'invalid_snapshot'
      )
    }

    expectStateError(
      () => ChannelAgentAuthorityState.fromSnapshot(snapshot, () => null),
      'owner_unavailable'
    )
    expectStateError(
      () =>
        ChannelAgentAuthorityState.fromSnapshot(
          {
            schemaVersion: 1,
            channelId: CHANNEL_ID,
            ownerMemberId: OWNER_MEMBER_ID,
            revision: 0,
            delegations: [],
            dispatchGrants: [],
            revocations: [],
            consumptions: []
          },
          () => null
        ),
      'owner_unavailable'
    )

    const rotated = state()
    rotated.registerDelegation(signedDelegation())
    rotated.registerRevocation(
      signedRevocation({
        targetKind: 'agent_key',
        targetId: channelAgentPublicKeyFingerprint(firstAgentPublicKeyB64),
        reason: 'key_rotated'
      })
    )
    rotated.registerDelegation(
      signedDelegation({
        delegationId: 'delegation-generation-2',
        agentPublicKeyB64: secondAgentPublicKeyB64,
        keyGeneration: 2,
        issuedAt: NOW,
        notBefore: NOW
      })
    )
    const generationReplay = mutateSnapshot(rotated.snapshot(), (copy) => {
      const delegations = copy.delegations as Array<Record<string, unknown>>
      delegations.push({
        recordedRevision: 4,
        signedDelegation: signedDelegation({ delegationId: 'delegation-old-replay' })
      })
      delegations.sort((left, right) => {
        const leftId = (
          (left.signedDelegation as Record<string, unknown>).delegation as Record<string, unknown>
        ).delegationId as string
        const rightId = (
          (right.signedDelegation as Record<string, unknown>).delegation as Record<string, unknown>
        ).delegationId as string
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
      })
      copy.revision = 4
    })
    expectStateError(
      () => ChannelAgentAuthorityState.fromSnapshot(generationReplay, resolveOwner),
      'invalid_snapshot'
    )
  })
})
