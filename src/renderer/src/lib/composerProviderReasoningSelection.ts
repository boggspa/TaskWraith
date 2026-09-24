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
/**
 * Whether one provider's STORED reasoning effort may be judged by the accepted
 * set that is currently in hand.
 *
 * A chat carries a reasoning effort for every provider but selects a model for
 * only one of them, so `acceptedProviderReasoningEfforts` can only ever describe
 * the ACTIVE provider's ladder. Judging the other seven against it asks whether
 * Muse's Max is a rung on Claude's rail; the answer is no, and the read-back
 * replaced a value the user picked with a default belonging to a different
 * provider entirely. A stored effort with no ladder to check it against is left
 * exactly as stored: it is inert until that provider becomes active, and
 * whatever selects it then recomputes it against its own model.
 */
export function acceptsStoredProviderReasoning(
  provider: string,
  activeProvider: string,
  accepted: { has(value: string): boolean },
  value: string
): boolean {
  return provider !== activeProvider || accepted.has(value)
}

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
