import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

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
  type ChannelAgentRevocation
} from '../../shared/collaboration/ChannelAgentProtocol'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import {
  ChannelAgentAuthorityStateError,
  type ChannelAgentAuthoritySnapshot,
  type ConsumeChannelAgentDispatchInput
} from './ChannelAgentAuthorityState'
import {
  CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX,
  CHANNEL_AGENT_AUTHORITY_MAX_FILE_BYTES,
  ChannelAgentAuthorityStore,
  ChannelAgentAuthorityStoreError,
  channelAgentAuthorityFileHash,
  hashChannelAgentAuthoritySnapshot,
  type ChannelAgentAuthorityStoreErrorCode,
  type ChannelAgentAuthorityStoreOptions
} from './ChannelAgentAuthorityStore'

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
const agentKeys = generateIdentityKeyPair()
const agentPublicKeyB64 = exportRawEd25519PublicKey(agentKeys.publicKey).toString('base64')
const ownerFingerprint = channelAgentPublicKeyFingerprint(
  exportRawEd25519PublicKey(ownerKeys.publicKey).toString('base64')
)

const roots: string[] = []
let clock = NOW
let nonce = 0

interface TestEnvelope {
  schemaVersion: 1
  channelIdHash: string
  ownerPublicKeyFingerprint: string
  snapshotHash: string
  snapshot: ChannelAgentAuthoritySnapshot
}

function resolveOwner(_channelId: string, ownerMemberId: string) {
  return ownerMemberId === OWNER_MEMBER_ID ? ownerKeys.publicKey : null
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tw-channel-agent-authority-'))
  roots.push(root)
  return root
}

function tempStorage(): string {
  return join(tempRoot(), 'private', 'channel-agent-authority')
}

function makeStore(
  storageDirectory: string,
  overrides: Partial<ChannelAgentAuthorityStoreOptions> = {}
): ChannelAgentAuthorityStore {
  return new ChannelAgentAuthorityStore({
    resolveOwnerPublicKey: resolveOwner,
    platform: 'darwin',
    now: () => clock,
    randomId: () => `test-${++nonce}`,
    ...overrides,
    storageDirectory
  })
}

function authorityPath(storageDirectory: string, channelId = CHANNEL_ID): string {
  return join(
    storageDirectory,
    `${channelAgentAuthorityFileHash(channelId)}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}`
  )
}

function readEnvelope(storageDirectory: string, channelId = CHANNEL_ID): TestEnvelope {
  return JSON.parse(
    readFileSync(authorityPath(storageDirectory, channelId), 'utf8')
  ) as TestEnvelope
}

function writeEnvelope(
  storageDirectory: string,
  envelope: TestEnvelope,
  channelId = CHANNEL_ID
): void {
  writeFileSync(authorityPath(storageDirectory, channelId), `${JSON.stringify(envelope)}\n`, {
    mode: 0o600
  })
}

function delegationValue(overrides: Partial<ChannelAgentDelegation> = {}): ChannelAgentDelegation {
  return {
    schemaVersion: 1,
    delegationId: DELEGATION_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_MEMBER_ID,
    agentMemberId: AGENT_MEMBER_ID,
    agentSeatId: AGENT_SEAT_ID,
    agentPublicKeyB64,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: ISSUED_AT,
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
    maxPostBytes: 8_000,
    ...overrides
  }
}

function signedDelegation(overrides: Partial<ChannelAgentDelegation> = {}) {
  return signChannelAgentDelegation(ownerKeys.privateKey, delegationValue(overrides))
}

function grantValue(overrides: Partial<ChannelAgentDispatchGrant> = {}): ChannelAgentDispatchGrant {
  return {
    schemaVersion: 1,
    grantId: GRANT_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_MEMBER_ID,
    agentMemberId: AGENT_MEMBER_ID,
    agentSeatId: AGENT_SEAT_ID,
    agentPublicKeyB64,
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

function signedGrant(overrides: Partial<ChannelAgentDispatchGrant> = {}) {
  return signChannelAgentDispatchGrant(ownerKeys.privateKey, grantValue(overrides))
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

function signedRevocation(overrides: Partial<ChannelAgentRevocation> = {}) {
  return signChannelAgentRevocation(ownerKeys.privateKey, revocationValue(overrides))
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
    agentPublicKeyB64,
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
  return signChannelAgentPost(agentKeys.privateKey, postValue(overrides))
}

function readyStore(storageDirectory: string): ChannelAgentAuthorityStore {
  const store = makeStore(storageDirectory)
  store.registerDelegation(signedDelegation())
  store.registerDispatchGrant(signedGrant())
  return store
}

function expectStoreError(
  operation: () => unknown,
  code: ChannelAgentAuthorityStoreErrorCode
): ChannelAgentAuthorityStoreError {
  let caught: unknown
  try {
    operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ChannelAgentAuthorityStoreError)
  expect(caught).toMatchObject({ code })
  return caught as ChannelAgentAuthorityStoreError
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

afterEach(() => {
  clock = NOW
  nonce = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ChannelAgentAuthorityStore', () => {
  it('persists one hashed, owner-pinned, mode-restricted authority file per Channel', () => {
    const storageDirectory = tempStorage()
    const store = makeStore(storageDirectory)
    expect(store.snapshot(CHANNEL_ID)).toBeNull()
    expect(store.registerDelegation(signedDelegation())).toBe('stored')
    expect(store.registerDelegation(signedDelegation())).toBe('existing')
    expect(store.registerDispatchGrant(signedGrant())).toBe('stored')

    const path = authorityPath(storageDirectory)
    const envelope = readEnvelope(storageDirectory)
    expect(Object.keys(envelope).sort()).toEqual([
      'channelIdHash',
      'ownerPublicKeyFingerprint',
      'schemaVersion',
      'snapshot',
      'snapshotHash'
    ])
    expect(envelope.channelIdHash).toBe(channelAgentAuthorityFileHash(CHANNEL_ID))
    expect(envelope.ownerPublicKeyFingerprint).toBe(ownerFingerprint)
    expect(envelope.snapshotHash).toBe(hashChannelAgentAuthoritySnapshot(envelope.snapshot))
    expect(envelope.snapshot).toMatchObject({ channelId: CHANNEL_ID, revision: 2 })
    expect(path).not.toContain(CHANNEL_ID)
    expect(statSync(storageDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)).toEqual(envelope.snapshot)

    const secondChannel = 'channel-2'
    expect(
      store.registerDelegation(
        signedDelegation({ channelId: secondChannel, delegationId: 'delegation-2' })
      )
    ).toBe('stored')
    expect(
      readdirSync(storageDirectory).filter((name) => name.endsWith('.authority.json'))
    ).toHaveLength(2)
    expect(store.snapshot(secondChannel)).toMatchObject({ channelId: secondChannel, revision: 1 })
  })

  it('durably consumes before returning, survives restart, deduplicates, and exhausts budget', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)

    const first = makeStore(storageDirectory).consumeDispatch(CHANNEL_ID, consumeInput())
    expect(first).toMatchObject({
      kind: 'authorized',
      consumption: { recordedRevision: 3, dispatchOrdinal: 1 },
      remainingDispatches: 1
    })
    expect(readEnvelope(storageDirectory).snapshot).toMatchObject({
      revision: 3,
      consumptions: [{ triggerMessageId: 'message-1', dispatchOrdinal: 1 }]
    })

    const restarted = makeStore(storageDirectory)
    expect(
      restarted.consumeDispatch(
        CHANNEL_ID,
        consumeInput({ mentionerMemberId: OWNER_MEMBER_ID, at: EXPIRES_AT })
      )
    ).toMatchObject({ kind: 'duplicate', consumption: { dispatchOrdinal: 1 } })
    expect(
      restarted.consumeDispatch(
        CHANNEL_ID,
        consumeInput({ triggerMessageId: 'message-2', mentionerMemberId: OWNER_MEMBER_ID })
      )
    ).toMatchObject({ kind: 'authorized', consumption: { dispatchOrdinal: 2 } })
    expect(
      restarted.consumeDispatch(CHANNEL_ID, consumeInput({ triggerMessageId: 'message-3' }))
    ).toEqual({ kind: 'denied', reason: 'dispatch_budget_exhausted' })
    expect(restarted.snapshot(CHANNEL_ID)).toMatchObject({ revision: 4 })
  })

  it('verifies post authority from the durable file without mutating or trusting stale memory', () => {
    const storageDirectory = tempStorage()
    const store = readyStore(storageDirectory)
    store.consumeDispatch(CHANNEL_ID, consumeInput())
    const before = readFileSync(authorityPath(storageDirectory), 'utf8')
    const post = signedPost()

    expect(
      makeStore(storageDirectory).verifyPostAuthority(CHANNEL_ID, {
        signedPost: post,
        acceptedAt: NOW + 200
      })
    ).toMatchObject({
      kind: 'authorized',
      authorityRevision: 3,
      consumption: { triggerMessageId: 'message-1' },
      signedPost: post
    })
    expect(readFileSync(authorityPath(storageDirectory), 'utf8')).toBe(before)

    store.registerRevocation(signedRevocation({ revokedAt: NOW + 200 }))
    expect(
      makeStore(storageDirectory).verifyPostAuthority(CHANNEL_ID, {
        signedPost: post,
        acceptedAt: NOW + 200
      })
    ).toEqual({ kind: 'denied', reason: 'authority_revoked' })
    expect(
      makeStore(storageDirectory).verifyPostAuthority(CHANNEL_ID, {
        signedPost: post,
        acceptedAt: NOW + 200,
        authorityRevision: 3
      })
    ).toMatchObject({ kind: 'authorized', authorityRevision: 3 })
    expect(
      makeStore(tempStorage()).verifyPostAuthority(CHANNEL_ID, {
        signedPost: post,
        acceptedAt: NOW + 200
      })
    ).toEqual({ kind: 'denied', reason: 'delegation_missing' })
  })

  it('returns the durable winner when no-clobber creation races re-entrantly', () => {
    const storageDirectory = tempStorage()
    const delegation = signedDelegation()
    let competitorResult: 'stored' | 'existing' | undefined
    let entered = false
    const racingResolver: ChannelAgentAuthorityStoreOptions['resolveOwnerPublicKey'] = (
      channelId,
      ownerMemberId
    ) => {
      if (!entered) {
        entered = true
        competitorResult = makeStore(storageDirectory).registerDelegation(delegation)
      }
      return resolveOwner(channelId, ownerMemberId)
    }

    const observed = makeStore(storageDirectory, {
      resolveOwnerPublicKey: racingResolver
    }).registerDelegation(delegation)
    expect(competitorResult).toBe('stored')
    expect(observed).toBe('existing')
    expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)).toMatchObject({ revision: 1 })
    expect(readdirSync(storageDirectory)).toEqual([
      `${channelAgentAuthorityFileHash(CHANNEL_ID)}${CHANNEL_AGENT_AUTHORITY_FILE_SUFFIX}`
    ])
  })

  it('retries compare-and-replace so concurrent consumptions get distinct durable ordinals', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    let competitorResult: ReturnType<ChannelAgentAuthorityStore['consumeDispatch']> | undefined
    let entered = false
    let localNonce = 0
    const racingStore = makeStore(storageDirectory, {
      randomId: () => {
        if (!entered) {
          entered = true
          competitorResult = makeStore(storageDirectory).consumeDispatch(
            CHANNEL_ID,
            consumeInput({ triggerMessageId: 'message-competitor' })
          )
        }
        return `outer-${++localNonce}`
      }
    })

    const observed = racingStore.consumeDispatch(
      CHANNEL_ID,
      consumeInput({ triggerMessageId: 'message-observed' })
    )
    expect(competitorResult).toMatchObject({
      kind: 'authorized',
      consumption: { dispatchOrdinal: 1 }
    })
    expect(observed).toMatchObject({
      kind: 'authorized',
      consumption: { dispatchOrdinal: 2 },
      remainingDispatches: 0
    })
    expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)?.consumptions).toMatchObject([
      { triggerMessageId: 'message-competitor', dispatchOrdinal: 1 },
      { triggerMessageId: 'message-observed', dispatchOrdinal: 2 }
    ])
    expect(readdirSync(storageDirectory).every((name) => !name.includes('.tmp-'))).toBe(true)
  })

  it('revalidates after owner-resolution callbacks and retries a concurrent read', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    let entered = false
    const racingResolver: ChannelAgentAuthorityStoreOptions['resolveOwnerPublicKey'] = (
      channelId,
      ownerMemberId
    ) => {
      if (!entered) {
        entered = true
        makeStore(storageDirectory).registerRevocation(signedRevocation())
      }
      return resolveOwner(channelId, ownerMemberId)
    }

    const snapshot = makeStore(storageDirectory, {
      resolveOwnerPublicKey: racingResolver
    }).snapshot(CHANNEL_ID)
    expect(snapshot).toMatchObject({
      revision: 3,
      revocations: [{ signedRevocation: { revocation: { revocationId: 'revocation-1' } } }]
    })
  })

  it('never returns authorization when persistence fails and leaves prior authority intact', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    const before = readFileSync(authorityPath(storageDirectory), 'utf8')
    const failing = makeStore(storageDirectory, { randomId: () => 'missing/path' })

    expectStoreError(
      () => failing.consumeDispatch(CHANNEL_ID, consumeInput()),
      'persistence_failed'
    )
    expect(readFileSync(authorityPath(storageDirectory), 'utf8')).toBe(before)
    expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)?.consumptions).toEqual([])
  })

  it('preserves the file without quarantine when the pinned owner key is unavailable or drifts', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    const path = authorityPath(storageDirectory)
    const before = readFileSync(path, 'utf8')

    for (const resolver of [
      () => null,
      () => otherOwnerKeys.publicKey,
      () => {
        throw new Error('SECRET_OWNER_RESOLVER_DIAGNOSTIC')
      }
    ]) {
      const error = expectStoreError(
        () => makeStore(storageDirectory, { resolveOwnerPublicKey: resolver }).snapshot(CHANNEL_ID),
        'recovery_blocked'
      )
      expect(error.message).not.toContain('SECRET_OWNER_RESOLVER_DIAGNOSTIC')
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(readdirSync(storageDirectory).some((name) => name.includes('.corrupt-'))).toBe(false)
    }
    expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)).toMatchObject({ revision: 2 })
  })

  it.each([
    'invalid-json',
    'bad-hash',
    'wrong-root',
    'tampered-signature',
    'lost-consumption'
  ] as const)(
    'quarantines %s and blocks silent regeneration until explicit erasure',
    (corruption) => {
      const storageDirectory = tempStorage()
      const store = readyStore(storageDirectory)
      if (corruption === 'lost-consumption') {
        store.consumeDispatch(CHANNEL_ID, consumeInput())
      }
      const path = authorityPath(storageDirectory)
      if (corruption === 'invalid-json') {
        writeFileSync(path, '{not-json', { mode: 0o600 })
      } else {
        const envelope = readEnvelope(storageDirectory)
        if (corruption === 'bad-hash') {
          envelope.snapshotHash = '0'.repeat(64)
        } else if (corruption === 'wrong-root') {
          ;(envelope.snapshot as { channelId: string }).channelId = 'channel-other'
          envelope.snapshotHash = hashChannelAgentAuthoritySnapshot(envelope.snapshot)
        } else if (corruption === 'tampered-signature') {
          ;(
            envelope.snapshot.delegations[0].signedDelegation as {
              ownerSignatureB64: string
            }
          ).ownerSignatureB64 = Buffer.alloc(64).toString('base64')
          envelope.snapshotHash = hashChannelAgentAuthoritySnapshot(envelope.snapshot)
        } else {
          ;(envelope.snapshot.consumptions as Array<unknown>).splice(0, 1)
          envelope.snapshotHash = hashChannelAgentAuthoritySnapshot(envelope.snapshot)
        }
        writeEnvelope(storageDirectory, envelope)
      }

      expectStoreError(() => makeStore(storageDirectory).snapshot(CHANNEL_ID), 'recovery_blocked')
      expect(existsSync(path)).toBe(false)
      expect(
        readdirSync(storageDirectory).filter((name) => name.includes('.corrupt-'))
      ).toHaveLength(1)
      expectStoreError(
        () => makeStore(storageDirectory).registerDelegation(signedDelegation()),
        'recovery_blocked'
      )
      expect(makeStore(storageDirectory).eraseChannel(CHANNEL_ID)).toBe(1)
      expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)).toBeNull()
    }
  )

  it('rejects semantic mutations without changing the durable file', () => {
    const storageDirectory = tempStorage()
    const store = makeStore(storageDirectory)
    expect(() => store.registerDispatchGrant(signedGrant())).toThrow(
      ChannelAgentAuthorityStateError
    )
    expect(existsSync(storageDirectory)).toBe(false)

    store.registerDelegation(signedDelegation())
    const before = readFileSync(authorityPath(storageDirectory), 'utf8')
    expect(() =>
      store.registerDelegation(
        signChannelAgentDelegation(
          otherOwnerKeys.privateKey,
          delegationValue({ maxPostBytes: 7_999 })
        )
      )
    ).toThrow(ChannelAgentAuthorityStateError)
    expect(() => store.registerRevocation(signedRevocation({ targetId: 'missing' }))).toThrow(
      ChannelAgentAuthorityStateError
    )
    expect(readFileSync(authorityPath(storageDirectory), 'utf8')).toBe(before)
  })

  it('repairs restrictive modes and quarantines an authority-path symlink without following it', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    const path = authorityPath(storageDirectory)
    chmodSync(storageDirectory, 0o755)
    chmodSync(path, 0o644)
    expect(makeStore(storageDirectory).snapshot(CHANNEL_ID)).toMatchObject({ revision: 2 })
    expect(statSync(storageDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const external = join(tempRoot(), 'external-authority.json')
    const raw = readFileSync(path, 'utf8')
    writeFileSync(external, raw, { mode: 0o600 })
    rmSync(path)
    symlinkSync(external, path)
    expectStoreError(() => makeStore(storageDirectory).snapshot(CHANNEL_ID), 'recovery_blocked')
    expect(readFileSync(external, 'utf8')).toBe(raw)
    expect(existsSync(path)).toBe(false)
    expect(makeStore(storageDirectory).eraseChannel(CHANNEL_ID)).toBe(1)
    expect(readFileSync(external, 'utf8')).toBe(raw)
  })

  it('quarantines an oversized sparse file before reading it', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    truncateSync(authorityPath(storageDirectory), CHANNEL_AGENT_AUTHORITY_MAX_FILE_BYTES + 1)
    expectStoreError(() => makeStore(storageDirectory).snapshot(CHANNEL_ID), 'recovery_blocked')
    expect(readdirSync(storageDirectory).some((name) => name.includes('.corrupt-'))).toBe(true)
  })

  it('erases one Channel or the whole store without touching unrelated files or symlink targets', () => {
    const storageDirectory = tempStorage()
    const store = readyStore(storageDirectory)
    const secondChannel = 'channel-2'
    store.registerDelegation(
      signedDelegation({ channelId: secondChannel, delegationId: 'delegation-2' })
    )
    const firstPath = authorityPath(storageDirectory)
    writeFileSync(`${firstPath}.tmp-stale`, 'stale')
    writeFileSync(`${firstPath}.corrupt-stale`, 'stale')
    writeFileSync(join(storageDirectory, 'sentinel.txt'), 'preserve')

    expect(store.eraseChannel(CHANNEL_ID)).toBe(3)
    expect(store.snapshot(secondChannel)).toMatchObject({ revision: 1 })
    expect(readFileSync(join(storageDirectory, 'sentinel.txt'), 'utf8')).toBe('preserve')

    const external = join(tempRoot(), 'external-sentinel')
    writeFileSync(external, 'preserve')
    symlinkSync(external, `${authorityPath(storageDirectory, secondChannel)}.tmp-link`)
    writeFileSync(join(storageDirectory, 'f'.repeat(64) + '.authority.json.backup'), 'preserve')
    expect(store.purgeAll()).toBe(2)
    expect(readdirSync(storageDirectory).sort()).toEqual([
      'f'.repeat(64) + '.authority.json.backup',
      'sentinel.txt'
    ])
    expect(readFileSync(external, 'utf8')).toBe('preserve')
  })

  it('rejects unsafe roots and ids while containing path-shaped protocol identifiers', () => {
    expectStoreError(
      () =>
        new ChannelAgentAuthorityStore({
          storageDirectory: 'relative/path',
          resolveOwnerPublicKey: resolveOwner
        }),
      'persistence_failed'
    )
    const storageDirectory = tempStorage()
    for (const invalid of ['', ' leading', 'line\nbreak', 'x'.repeat(513)]) {
      expectStoreError(() => makeStore(storageDirectory).snapshot(invalid), 'invalid_channel')
    }

    const pathShapedChannel = '../still-a-protocol-identifier'
    makeStore(storageDirectory).registerDelegation(
      signedDelegation({ channelId: pathShapedChannel, delegationId: 'delegation-shaped' })
    )
    expect(dirname(authorityPath(storageDirectory, pathShapedChannel))).toBe(storageDirectory)
    expect(readdirSync(dirname(storageDirectory))).toEqual(['channel-agent-authority'])
  })

  it('rejects a symlinked storage directory without mutating its target', () => {
    const root = tempRoot()
    const target = join(root, 'target')
    const storageDirectory = join(root, 'authority-link')
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel'), 'preserve')
    symlinkSync(target, storageDirectory)

    expectStoreError(() => makeStore(storageDirectory).snapshot(CHANNEL_ID), 'recovery_blocked')
    expect(readdirSync(target)).toEqual(['sentinel'])
    expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('preserve')
  })

  it('detects owner-fingerprint envelope drift without destroying recovery evidence', () => {
    const storageDirectory = tempStorage()
    readyStore(storageDirectory)
    const envelope = jsonClone(readEnvelope(storageDirectory))
    envelope.ownerPublicKeyFingerprint = '0'.repeat(64)
    writeEnvelope(storageDirectory, envelope)
    const before = readFileSync(authorityPath(storageDirectory), 'utf8')

    expectStoreError(() => makeStore(storageDirectory).snapshot(CHANNEL_ID), 'recovery_blocked')
    expect(readFileSync(authorityPath(storageDirectory), 'utf8')).toBe(before)
    expect(readdirSync(storageDirectory).some((name) => name.includes('.corrupt-'))).toBe(false)
  })
})
