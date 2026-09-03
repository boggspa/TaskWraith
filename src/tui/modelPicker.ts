import type {
  HostPermissionPostureOffer,
  HostProviderModelOffer
} from '../shared/hostSetupProtocol'
import type { TuiHomePermissionSelection, TuiHomeTuneProvider } from './state'

export interface TuiModelChoice {
  readonly providerIndex: number
  readonly provider: TuiHomeTuneProvider
  readonly model: HostProviderModelOffer
}

export const TUI_PERMISSION_ORDER = [
  'plan',
  'read_only',
  'default',
  'workspace_write',
  'full_access'
] as const

export function tuiModelChoices(providers: readonly TuiHomeTuneProvider[]): TuiModelChoice[] {
  return providers.flatMap((provider, providerIndex) =>
    provider.offers.models
      .filter((model) => model.available)
      .map((model) => ({ providerIndex, provider, model }))
  )
}

export function findTuiModelChoiceIndex(
  choices: readonly TuiModelChoice[],
  providerId: string | undefined,
  modelId: string | undefined
): number {
  if (!providerId && !modelId) return -1
  const exact = choices.findIndex(
    (choice) => choice.provider.status.providerId === providerId && choice.model.modelId === modelId
  )
  if (exact >= 0) return exact
  if (providerId) {
    const providerDefault = choices.findIndex(
      (choice) => choice.provider.status.providerId === providerId && choice.model.default === true
    )
    if (providerDefault >= 0) return providerDefault
    return choices.findIndex((choice) => choice.provider.status.providerId === providerId)
  }
  return choices.findIndex((choice) => choice.model.modelId === modelId)
}

/** Home's resolved permission tier, plus the explicit choice it could not honour. */
export interface TuiHomePostureResolution {
  readonly posture: HostPermissionPostureOffer | undefined
  /** The Shift+Tab posture the user picked for this provider that is no longer offered. */
  readonly downgradedFrom?: string
}

/**
 * Resolve Home's permission chip against the currently selected provider.
 *
 * An explicit Shift+Tab choice wins while that exact posture is still offered.
 * When it has since lapsed, this reports the discard rather than quietly
 * swapping in the standard edit posture, because Home does not actually run
 * that substitution: prepareDefaultThreadForPrompt looks for the explicit
 * posture alone and refuses the send with "no longer available · choose
 * another tier". Answering the chip with `default` therefore advertised a tier
 * the very next Enter would decline — the display and the behaviour disagreed,
 * and only the display looked fine.
 *
 * A provider the user never picked a tier for is a different case and still
 * falls back to the standard edit posture; that is a genuine resting state,
 * not a discarded choice.
 */
export function resolveTuiHomePostureDetail(
  providers: readonly TuiHomeTuneProvider[],
  modelIndex: number,
  selection?: TuiHomePermissionSelection
): TuiHomePostureResolution {
  const choice = tuiModelChoices(providers)[modelIndex]
  if (!choice) return { posture: undefined }
  const postures = choice.provider.offers.postures
  const requested =
    selection?.providerId === choice.provider.status.providerId ? selection.postureId : undefined
  if (requested) {
    const explicit = postures.find(
      (posture) => posture.postureId === requested && posture.available
    )
    return explicit ? { posture: explicit } : { posture: undefined, downgradedFrom: requested }
  }
  return {
    posture: postures.find((posture) => posture.postureId === 'default' && posture.available)
  }
}

export function resolveTuiHomePosture(
  providers: readonly TuiHomeTuneProvider[],
  modelIndex: number,
  selection?: TuiHomePermissionSelection
): HostPermissionPostureOffer | undefined {
  return resolveTuiHomePostureDetail(providers, modelIndex, selection).posture
}

export function nextAvailableTuiPosture(
  postures: readonly HostPermissionPostureOffer[],
  currentPostureId: string | undefined
): HostPermissionPostureOffer | undefined {
  const currentIndex = Math.max(
    -1,
    TUI_PERMISSION_ORDER.findIndex((postureId) => postureId === currentPostureId)
  )
  for (let offset = 1; offset <= TUI_PERMISSION_ORDER.length; offset += 1) {
    const postureId = TUI_PERMISSION_ORDER[(currentIndex + offset) % TUI_PERMISSION_ORDER.length]
    const offered = postures.find((posture) => posture.postureId === postureId)
    if (offered?.available) return offered
  }
  return undefined
}
