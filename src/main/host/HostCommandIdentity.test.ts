import { describe, expect, it } from 'vitest'

import { HOST_PROTOCOL_MAX_ID, type HostClientClass } from '../../shared/hostProtocol'
import {
  HOST_APPROVAL_ID_LEGACY_ALIAS,
  HOST_APPROVAL_ID_MIGRATION_ALIAS,
  HOST_QUESTION_ID_LEGACY_ALIAS,
  HOST_QUESTION_ID_MIGRATION_ALIAS,
  hostActorIdentityFromVerifiedContext,
  isHostUuid,
  isSafeHostIdentifier,
  mintHostCommandId,
  mintHostCommandIdentity,
  mintHostIdempotencyKey,
  parseHostIdempotencyKey,
  resolveHostApprovalId,
  resolveHostQuestionId,
  type HostTransportVerifiedClientContext
} from './HostCommandIdentity'

const FIXED_UUID_A = '11111111-1111-4111-8111-111111111111'
const FIXED_UUID_B = '22222222-2222-4222-8222-222222222222'

function desktopContext(
  overrides: Partial<HostTransportVerifiedClientContext> = {}
): HostTransportVerifiedClientContext {
  return {
    clientClass: 'desktop',
    clientId: 'desktop-local-1',
    actorId: 'desktop-session-1',
    ...overrides
  }
}

function tuiContext(
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

function iosContext(
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

describe('HostCommandIdentity migration aliases', () => {
  it('documents approvalId=toolCallId and questionId=promptId', () => {
    expect(HOST_APPROVAL_ID_MIGRATION_ALIAS).toEqual({
      hostField: 'approvalId',
      legacyField: 'toolCallId'
    })
    expect(HOST_QUESTION_ID_MIGRATION_ALIAS).toEqual({
      hostField: 'questionId',
      legacyField: 'promptId'
    })
    expect(HOST_APPROVAL_ID_LEGACY_ALIAS).toBe('toolCallId')
    expect(HOST_QUESTION_ID_LEGACY_ALIAS).toBe('promptId')
  })

  it('resolves approvalId from either field when they agree', () => {
    expect(resolveHostApprovalId({ approvalId: 'appr-1' })).toEqual({
      ok: true,
      value: 'appr-1'
    })
    expect(resolveHostApprovalId({ toolCallId: 'appr-1' })).toEqual({
      ok: true,
      value: 'appr-1'
    })
    expect(resolveHostApprovalId({ approvalId: 'appr-1', toolCallId: 'appr-1' })).toEqual({
      ok: true,
      value: 'appr-1'
    })
  })

  it('resolves questionId from either field when they agree', () => {
    expect(resolveHostQuestionId({ questionId: 'q-1' })).toEqual({ ok: true, value: 'q-1' })
    expect(resolveHostQuestionId({ promptId: 'q-1' })).toEqual({ ok: true, value: 'q-1' })
    expect(resolveHostQuestionId({ questionId: 'q-1', promptId: 'q-1' })).toEqual({
      ok: true,
      value: 'q-1'
    })
  })

  it('fails closed when alias pairs conflict or are missing/unsafe', () => {
    expect(resolveHostApprovalId({})).toEqual({
      ok: false,
      error: 'approvalId (alias toolCallId) is required'
    })
    expect(resolveHostApprovalId({ approvalId: 'a', toolCallId: 'b' })).toEqual({
      ok: false,
      error: 'approvalId and toolCallId conflict'
    })
    expect(resolveHostQuestionId({ questionId: 'a', promptId: 'b' })).toEqual({
      ok: false,
      error: 'questionId and promptId conflict'
    })
    expect(resolveHostApprovalId({ approvalId: '' }).ok).toBe(false)
    expect(resolveHostApprovalId({ toolCallId: 'x'.repeat(HOST_PROTOCOL_MAX_ID + 1) }).ok).toBe(
      false
    )
    expect(resolveHostQuestionId({ promptId: ' bad' }).ok).toBe(false)
    expect(resolveHostQuestionId({ questionId: 'q\u0000' }).ok).toBe(false)
  })
})

describe('isSafeHostIdentifier', () => {
  it('accepts bounded non-empty strings without control characters', () => {
    expect(isSafeHostIdentifier('ok')).toBe(true)
    expect(isSafeHostIdentifier('a'.repeat(HOST_PROTOCOL_MAX_ID))).toBe(true)
  })

  it('rejects empty, oversized, padded, and control-bearing values', () => {
    expect(isSafeHostIdentifier('')).toBe(false)
    expect(isSafeHostIdentifier('a'.repeat(HOST_PROTOCOL_MAX_ID + 1))).toBe(false)
    expect(isSafeHostIdentifier(' leading')).toBe(false)
    expect(isSafeHostIdentifier('trailing ')).toBe(false)
    expect(isSafeHostIdentifier('has\nnewline')).toBe(false)
    expect(isSafeHostIdentifier('has\u0000null')).toBe(false)
    expect(isSafeHostIdentifier(null)).toBe(false)
    expect(isSafeHostIdentifier(12)).toBe(false)
  })
})

describe('hostActorIdentityFromVerifiedContext', () => {
  it('builds actor identity for Desktop-local, authenticated TUI, and paired iOS', () => {
    const classes: Array<{
      label: string
      context: HostTransportVerifiedClientContext
      clientClass: HostClientClass
    }> = [
      { label: 'desktop-local', context: desktopContext(), clientClass: 'desktop' },
      { label: 'authenticated-tui', context: tuiContext(), clientClass: 'tui' },
      { label: 'paired-ios', context: iosContext(), clientClass: 'ios' }
    ]

    for (const row of classes) {
      const result = hostActorIdentityFromVerifiedContext(row.context)
      expect(result.ok, row.label).toBe(true)
      if (!result.ok) continue
      expect(result.value).toEqual({
        actorId: row.context.actorId,
        clientId: row.context.clientId,
        clientClass: row.clientClass
      })
      // subjectId is binding diagnostics only — never projected onto the actor.
      expect('subjectId' in result.value).toBe(false)
    }
  })

  it('fails closed on empty, oversized, unsafe, or invalid class fields', () => {
    expect(hostActorIdentityFromVerifiedContext(desktopContext({ clientId: '' })).ok).toBe(false)
    expect(hostActorIdentityFromVerifiedContext(desktopContext({ actorId: ' ' })).ok).toBe(false)
    expect(
      hostActorIdentityFromVerifiedContext(
        desktopContext({ clientId: 'c'.repeat(HOST_PROTOCOL_MAX_ID + 1) })
      ).ok
    ).toBe(false)
    expect(
      hostActorIdentityFromVerifiedContext(
        desktopContext({ actorId: `bad${String.fromCharCode(7)}` })
      ).ok
    ).toBe(false)
    expect(
      hostActorIdentityFromVerifiedContext({
        ...desktopContext(),
        clientClass: 'web' as HostClientClass
      }).ok
    ).toBe(false)
    expect(hostActorIdentityFromVerifiedContext(desktopContext({ subjectId: '\n' })).ok).toBe(false)
  })

  it('does not accept a wire actor object as authority (constructs only from context fields)', () => {
    const sneaky = {
      ...desktopContext({ actorId: 'binding-actor', clientId: 'binding-client' }),
      actor: {
        actorId: 'wire-forged-actor',
        clientId: 'wire-forged-client',
        clientClass: 'ios' as const
      }
    } as HostTransportVerifiedClientContext & {
      actor: { actorId: string; clientId: string; clientClass: HostClientClass }
    }

    const result = hostActorIdentityFromVerifiedContext(sneaky)
    expect(result).toEqual({
      ok: true,
      value: {
        actorId: 'binding-actor',
        clientId: 'binding-client',
        clientClass: 'desktop'
      }
    })
  })
})

describe('mintHostCommandId / mintHostIdempotencyKey', () => {
  it('mints UUID commandIds', () => {
    const fixed = mintHostCommandId(() => FIXED_UUID_A)
    expect(fixed).toEqual({ ok: true, value: FIXED_UUID_A })
    expect(isHostUuid(fixed.ok ? fixed.value : '')).toBe(true)

    const live = mintHostCommandId()
    expect(live.ok).toBe(true)
    if (live.ok) {
      expect(isHostUuid(live.value)).toBe(true)
      expect(live.value.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_ID)
    }
  })

  it('mints bounded clientClass:clientId:uuid idempotency keys', () => {
    for (const context of [desktopContext(), tuiContext(), iosContext()]) {
      const minted = mintHostIdempotencyKey(context, () => FIXED_UUID_B)
      expect(minted.ok, context.clientClass).toBe(true)
      if (!minted.ok) continue
      expect(minted.value).toBe(`${context.clientClass}:${context.clientId}:${FIXED_UUID_B}`)
      expect(minted.value.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_ID)

      const parsed = parseHostIdempotencyKey(minted.value)
      expect(parsed).toEqual({
        ok: true,
        value: {
          clientClass: context.clientClass,
          clientId: context.clientId,
          uuid: FIXED_UUID_B
        }
      })
    }
  })

  it('fails closed when the compound idempotency key would exceed the protocol bound', () => {
    // clientClass (7) + ':' + clientId + ':' + uuid(36) must fit in HOST_PROTOCOL_MAX_ID.
    const oversizedClientId = 'c'.repeat(HOST_PROTOCOL_MAX_ID)
    const result = mintHostIdempotencyKey(
      { clientClass: 'desktop', clientId: oversizedClientId },
      () => FIXED_UUID_A
    )
    expect(result).toEqual({ ok: false, error: 'idempotencyKey exceeds protocol bound' })
  })

  it('rejects non-UUID or unsafe mint factories', () => {
    expect(mintHostCommandId(() => 'not-a-uuid')).toEqual({
      ok: false,
      error: 'commandId mint produced an unsafe or non-UUID value'
    })
    expect(mintHostIdempotencyKey(desktopContext(), () => 'also-not')).toEqual({
      ok: false,
      error: 'idempotencyKey mint produced an unsafe or non-UUID value'
    })
    expect(mintHostIdempotencyKey(desktopContext(), () => ' bad-uuid ')).toEqual({
      ok: false,
      error: 'idempotencyKey mint produced an unsafe or non-UUID value'
    })
  })
})

describe('mintHostCommandIdentity', () => {
  it('returns independent commandId, idempotencyKey, and binding-derived actor', () => {
    const result = mintHostCommandIdentity(iosContext(), {
      commandIdUuid: () => FIXED_UUID_A,
      idempotencyUuid: () => FIXED_UUID_B
    })
    expect(result).toEqual({
      ok: true,
      value: {
        commandId: FIXED_UUID_A,
        idempotencyKey: `ios:ios-pair-client-9:${FIXED_UUID_B}`,
        actor: {
          actorId: 'ios-pair-subject-9',
          clientId: 'ios-pair-client-9',
          clientClass: 'ios'
        }
      }
    })
  })

  it('propagates verified-context failures without inventing identity', () => {
    const result = mintHostCommandIdentity(desktopContext({ actorId: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/actorId/)
    }
  })
})
