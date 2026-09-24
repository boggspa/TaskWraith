import type {
  HostPermissionPostureOffer,
  HostProviderModelOffer
} from '../shared/hostSetupProtocol'
import type { TuiHomePermissionSelection, TuiHomeTuneProvider } from './state'
import { modelRequiresApiKey } from '../shared/apiKeyModelIndicator'
import type { TuiGlyphSet } from './theme'

export { modelRequiresApiKey }

export function tuiModelBillingLabel(
  providerId: string,
  modelId: string,
  label: string,
  glyphs: TuiGlyphSet
): string {
  return modelRequiresApiKey(providerId, modelId) ? `${glyphs.apiKey} ${label}` : label
}

export function tuiModelBillingLegend(glyphs: TuiGlyphSet): string {
  return `${glyphs.apiKey} API key · billed separately`
}

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

/** What the offered postures prove about a provider's authority, for disclosure. */
export interface TuiProviderWriteDisclosure {
  /** True when at least one offered posture actually grants more than read. */
  readonly canModifyFiles: boolean
  /** Present only when the provider cannot modify files; safe to render verbatim. */
  readonly notice?: string
}

/**
 * Disclose, at the point of selection, that a provider cannot modify files.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some providers compose in the standalone Host but can never mutate a
 * workspace: AntiGravity runs plan-only, Cursor's run path is a hard stop, Pi
 * is read-only by construction. The picker still lists them, so a user can
 * choose one, ask for an edit, and receive only a failure. Capability doctrine
 * is to DISCLOSE, never to hide — a hidden provider is a bug report about a
 * missing feature, while a labelled one is an informed choice.
 *
 * DERIVED, NEVER HARDCODED
 * ------------------------
 * This reads the postures the Host actually advertised rather than carrying a
 * list of provider ids. A hardcoded list is wrong the moment a provider gains
 * write support, and it would duplicate an authority that belongs to the Host.
 * The rule is exactly what the wire already proves: a provider can modify files
 * only if some AVAILABLE posture has a ceiling above `read`.
 *
 * The reason is quoted from the Host's own `detail` when it supplied one, so
 * the TUI explains the refusal in the Host's words instead of inventing a
 * cause it cannot know.
 */
export function tuiProviderWriteDisclosure(
  provider: TuiHomeTuneProvider
): TuiProviderWriteDisclosure {
  const postures = provider.offers.postures
  // No posture data proves nothing. Offers can be empty while they are still
  // loading, and branding a provider read-only on absent evidence is a false
  // restriction — the opposite failure to the one this exists to fix. Silence
  // is the only honest answer when the Host has not told us anything yet.
  if (postures.length === 0) return { canModifyFiles: true }
  const writeCapable = postures.some((posture) => posture.available && posture.ceiling !== 'read')
  if (writeCapable) return { canModifyFiles: true }
  const label = provider.status.label || provider.status.providerId
  // Prefer the Host's stated reason for a withheld editing tier over any
  // sentence of our own; it is the only party that knows why.
  const withheld = postures.find(
    (posture) => !posture.available && posture.ceiling !== 'read' && Boolean(posture.detail)
  )
  const because = withheld?.detail ? ` ${withheld.detail}` : ''
  return {
    canModifyFiles: false,
    notice: `${label} cannot modify files in this Host — it offers no editing permission tier.${because}`
  }
}

/**
 * Note when the tier the user is on shares its authority ceiling with another
 * offered tier, so cycling between them is not the change it appears to be.
 *
 * The user reported that permissions are "switchable but I worry it doesn't
 * work properly". For Claude they are right that nothing changes: `default`
 * (Accept Edits) and `workspace_write` (Full WS Access) both reach the CLI as
 * `acceptEdits`. That mapping is DELIBERATE and documented — two TaskWraith
 * postures legitimately land on the one editing mode the CLI exposes — so the
 * honest fix is to say so, never to re-map it.
 *
 * Deliberately phrased as a shared CEILING rather than "identical". Codex also
 * shares this ceiling across both tiers yet genuinely differs in approval
 * friction, so claiming equivalence would be false there. The ceiling is what
 * the wire actually proves, so the ceiling is what this reports.
 */
export function tuiPostureCeilingNote(
  postures: readonly HostPermissionPostureOffer[],
  currentPostureId: string | undefined
): string | undefined {
  const current = postures.find(
    (posture) => posture.postureId === currentPostureId && posture.available
  )
  if (!current) return undefined
  const sharing = postures.filter(
    (posture) =>
      posture.available &&
      posture.ceiling === current.ceiling &&
      posture.postureId !== current.postureId
  )
  if (sharing.length === 0) return undefined
  const names = [current.label, ...sharing.map((posture) => posture.label)].join(' and ')
  return `${names} share one authority ceiling (${current.ceiling.replace(/_/g, ' ')}).`
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
