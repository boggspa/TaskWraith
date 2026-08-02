export interface TrustedSessionRuntimeProfileRequestInput {
  targetIsParticipant: boolean
  participantRuntimeProfileId?: unknown
  selectedRuntimeProfileId?: unknown
}

export type TrustedSessionRuntimeProfileReconciliation =
  | { ok: true; runtimeProfileId: string | null }
  | { ok: false; runtimeProfileId: string | null }

export function normalizeTrustedSessionRuntimeProfileId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * A participant lane's stored profile identity is authoritative, including
 * null (the provider default). The composer's visual fallback is presentation
 * state and must never be promoted into a different participant identity.
 */
export function trustedSessionRuntimeProfileForRequest(
  input: TrustedSessionRuntimeProfileRequestInput
): string | null {
  return normalizeTrustedSessionRuntimeProfileId(
    input.targetIsParticipant ? input.participantRuntimeProfileId : input.selectedRuntimeProfileId
  )
}

/**
 * Main canonicalizes an omitted request to the lane's authoritative profile,
 * but rejects an explicit identity that names a different runtime profile.
 */
export function reconcileTrustedSessionRuntimeProfile(input: {
  authoritativeRuntimeProfileId?: unknown
  requestedRuntimeProfileId?: unknown
}): TrustedSessionRuntimeProfileReconciliation {
  const runtimeProfileId = normalizeTrustedSessionRuntimeProfileId(
    input.authoritativeRuntimeProfileId
  )
  const requestedRuntimeProfileId = normalizeTrustedSessionRuntimeProfileId(
    input.requestedRuntimeProfileId
  )
  if (requestedRuntimeProfileId && requestedRuntimeProfileId !== runtimeProfileId) {
    return { ok: false, runtimeProfileId }
  }
  return { ok: true, runtimeProfileId }
}
