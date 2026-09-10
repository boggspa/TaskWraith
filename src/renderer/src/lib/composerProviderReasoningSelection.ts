import { defaultPiReasoningEffort } from '../../../shared/piReasoning'

/**
 * The reasoning efforts a persisted selection may legitimately carry for one
 * provider + model.
 *
 * This MUST stay the mirror image of the ladder the pickers OFFER: the
 * per-provider branch in Composer.tsx, plus the UltraTask/Off injection that
 * `withUltraTaskLadderBottom` performs there and in ParticipantPickerCluster.
 * Every rung the user can reach on the rail has to be accepted here.
 * Otherwise the read-back replaces their pick with a provider default and the
 * slider visibly snaps -- silently narrowing a capability the UI itself just
 * advertised, which CAPABILITY_GOVERNANCE treats as a user-facing narrowing
 * rather than a cosmetic bug.
 */
export function acceptedProviderReasoningEfforts(options: {
  reasoningOptions: readonly { value: string; disabled?: boolean }[]
  supportedReasoningEfforts?: readonly { reasoningEffort: string; disabled?: boolean }[] | null
  ultraTaskSupported?: boolean
}): Set<string> {
  const accepted = new Set(
    options.supportedReasoningEfforts
      ? options.supportedReasoningEfforts
          .filter((option) => !option.disabled)
          .map((option) => option.reasoningEffort)
      : options.reasoningOptions.filter((option) => !option.disabled).map((option) => option.value)
  )
  // UltraTask rides the top of every ladder as a synthetic token; outbound
  // normalizers clamp it to each provider's real ceiling.
  accepted.add('ultraTask')
  // ...and when the base ladder is empty the pickers seed an explicit Off
  // bottom stop beside it, so Off is a real, pickable rung too.
  if (options.reasoningOptions.length === 0 && options.ultraTaskSupported === true) {
    accepted.add('off')
  }
  return accepted
}

export function resolveComposerModelReasoningDefault(options: {
  provider: string
  modelId: string
  modelDefaultReasoningEffort?: string | null
  reasoningOptions: readonly { value: string }[]
}): string {
  const enabled = new Set(options.reasoningOptions.map((option) => option.value))
  const modelDefault = String(options.modelDefaultReasoningEffort || '')
  if (modelDefault && enabled.has(modelDefault)) return modelDefault

  if (options.provider === 'pi') {
    const piDefault = defaultPiReasoningEffort(options.modelId)
    if (piDefault && enabled.has(piDefault)) return piDefault
  }

  return options.reasoningOptions[0]?.value || ''
}
