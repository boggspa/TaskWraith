import { describe, expect, it } from 'vitest'

import {
  reconcileTrustedSessionRuntimeProfile,
  trustedSessionRuntimeProfileForRequest
} from './trustedSessionRuntimeProfile'

describe('trustedSessionRuntimeProfileForRequest', () => {
  it('preserves an implicit participant profile instead of borrowing the visual default', () => {
    expect(
      trustedSessionRuntimeProfileForRequest({
        targetIsParticipant: true,
        participantRuntimeProfileId: null,
        selectedRuntimeProfileId: 'builtin:codex:local'
      })
    ).toBeNull()
  })

  it('uses the explicit participant profile and keeps solo selection behavior', () => {
    expect(
      trustedSessionRuntimeProfileForRequest({
        targetIsParticipant: true,
        participantRuntimeProfileId: ' profile:participant ',
        selectedRuntimeProfileId: 'profile:visual-default'
      })
    ).toBe('profile:participant')
    expect(
      trustedSessionRuntimeProfileForRequest({
        targetIsParticipant: false,
        selectedRuntimeProfileId: ' profile:solo '
      })
    ).toBe('profile:solo')
  })
})

describe('reconcileTrustedSessionRuntimeProfile', () => {
  it('canonicalizes an omitted request to the authoritative lane identity', () => {
    expect(
      reconcileTrustedSessionRuntimeProfile({
        authoritativeRuntimeProfileId: 'profile:participant',
        requestedRuntimeProfileId: null
      })
    ).toEqual({ ok: true, runtimeProfileId: 'profile:participant' })
  })

  it('accepts an exact identity and rejects a true mismatch', () => {
    expect(
      reconcileTrustedSessionRuntimeProfile({
        authoritativeRuntimeProfileId: 'profile:participant',
        requestedRuntimeProfileId: 'profile:participant'
      })
    ).toEqual({ ok: true, runtimeProfileId: 'profile:participant' })
    expect(
      reconcileTrustedSessionRuntimeProfile({
        authoritativeRuntimeProfileId: null,
        requestedRuntimeProfileId: 'builtin:codex:local'
      })
    ).toEqual({ ok: false, runtimeProfileId: null })
  })
})
