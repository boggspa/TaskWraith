import type {
  HostPermissionPostureOffer,
  HostProviderModelOffer
} from '../shared/hostSetupProtocol'
import type { TuiHomeTuneProvider } from './state'

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
