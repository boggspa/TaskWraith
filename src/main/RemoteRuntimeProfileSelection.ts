import type { ChatRecord, ProviderId, RuntimeProfile } from './store/types'

export interface RemoteSoloRuntimeProfileSelectionInput {
  chat: Pick<ChatRecord, 'scope' | 'workspacePath' | 'providerMetadata' | 'runs'>
  provider: ProviderId
  runtimeProfiles: readonly RuntimeProfile[]
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * Resolve the runtime profile a phone-origin solo turn will actually use.
 *
 * The desktop's remembered composer selection wins, then the latest run for
 * this provider, then the same first matching workspace profile shown by the desktop
 * picker. Keeping grant, projection, queue, and dispatch on this one resolver
 * prevents a Full Access receipt from being minted for a different profile
 * than the run it is meant to authorize.
 */
export function resolveRemoteSoloRuntimeProfileId(
  input: RemoteSoloRuntimeProfileSelectionInput
): string | undefined {
  if (input.chat.scope === 'global' || !input.chat.workspacePath) return undefined

  const candidates = input.runtimeProfiles.filter(
    (profile) => profile.provider === input.provider && profile.scope === 'workspace'
  )
  const candidateIds = new Set(candidates.map((profile) => profile.id))

  const remembered = nonEmptyString(input.chat.providerMetadata?.runtimeProfileId)
  if (remembered && candidateIds.has(remembered)) return remembered

  const inherited = [...(input.chat.runs ?? [])].reverse().find((run) => {
    const runtimeProfileId = nonEmptyString(run.runtimeProfileId)
    return (
      run.provider === input.provider &&
      runtimeProfileId !== undefined &&
      candidateIds.has(runtimeProfileId)
    )
  })
  const inheritedId = nonEmptyString(inherited?.runtimeProfileId)
  if (inheritedId) return inheritedId

  return candidates[0]?.id
}
