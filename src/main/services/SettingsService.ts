import type { AppSettings } from '../store/types'

export interface SettingsUpdateContext {
  rawPatch: unknown
  sanitizedPatch: Partial<AppSettings>
  previousSettings: AppSettings
  nextSettings: AppSettings
}

export type SettingsUpdateSideEffect = (context: SettingsUpdateContext) => void

export interface SettingsManagedPolicy {
  effectiveSettings: (settings: AppSettings) => AppSettings
  enforcedSettingsPatch: (settings: AppSettings) => Partial<AppSettings>
  filterSettingsPatch: (patch: Partial<AppSettings>) => Partial<AppSettings>
}

export interface SettingsServiceDeps {
  getSettings: () => AppSettings
  updateSettings: (partial: Partial<AppSettings>) => void
  sanitizeSettingsPatch: (partial: unknown) => Partial<AppSettings>
  managedPolicy?: SettingsManagedPolicy
  sideEffects?: SettingsUpdateSideEffect[]
}

/**
 * SettingsService — Phase B7 extraction.
 *
 * Keeps the IPC surface behaviour-preserving while moving settings
 * write policy out of `index.ts`. The service owns the order of
 * operations:
 *   1. sanitize the incoming patch
 *   2. persist it through the injected store
 *   3. run explicit side effects such as update-service reconfiguration
 *
 * Side effects are injected so tests can pin behaviour and future
 * settings-triggered systems can register without growing another IPC
 * closure.
 */
export class SettingsService {
  private readonly sideEffects: SettingsUpdateSideEffect[]

  constructor(private deps: SettingsServiceDeps) {
    this.sideEffects = deps.sideEffects ?? []
  }

  getSettings(): AppSettings {
    const settings = this.deps.getSettings()
    return this.deps.managedPolicy?.effectiveSettings(settings) ?? settings
  }

  updateSettings(rawPatch: unknown): void {
    const previousSettings = this.deps.getSettings()
    const sanitizedPatch =
      this.deps.managedPolicy?.filterSettingsPatch(this.deps.sanitizeSettingsPatch(rawPatch)) ??
      this.deps.sanitizeSettingsPatch(rawPatch)

    // Chat renderers only receive elevation acknowledgements for their own
    // workspace (path privacy). Merge their patch into the persisted record
    // so acknowledging Accept Edits in one workspace never drops acknowledgements
    // that other workspaces already recorded.
    const mergedPatch: Partial<AppSettings> = { ...sanitizedPatch }
    if (
      Object.prototype.hasOwnProperty.call(sanitizedPatch, 'approvalModeElevationAcknowledgements')
    ) {
      mergedPatch.approvalModeElevationAcknowledgements = {
        ...previousSettings.approvalModeElevationAcknowledgements,
        ...sanitizedPatch.approvalModeElevationAcknowledgements
      }
    }

    const enforcedPatch =
      this.deps.managedPolicy?.enforcedSettingsPatch({
        ...previousSettings,
        ...mergedPatch
      } as AppSettings) ?? {}
    const finalPatch = { ...mergedPatch, ...enforcedPatch }
    this.deps.updateSettings(finalPatch)
    const nextSettings = this.deps.getSettings()
    const context: SettingsUpdateContext = {
      rawPatch,
      sanitizedPatch: finalPatch,
      previousSettings,
      nextSettings
    }
    for (const sideEffect of this.sideEffects) {
      sideEffect(context)
    }
  }
}
