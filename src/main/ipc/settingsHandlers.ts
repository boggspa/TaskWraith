import { ipcMain } from 'electron'
import type { SettingsService } from '../services/SettingsService'
import type {
  AppSettings,
  HandoffCard,
  HandoffCardFilter,
  ProviderId,
  RuntimeProfile
} from '../store/types'

export interface SettingsHandlerDeps {
  settingsService: Pick<SettingsService, 'getSettings' | 'updateSettings'>
  setBridgeDaemonEnabled: (enabled: boolean) => Promise<unknown>
  getRuntimeProfiles: (provider?: ProviderId) => RuntimeProfile[]
  saveRuntimeProfile: (
    profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
  ) => RuntimeProfile
  deleteRuntimeProfile: (id: string) => unknown
  getHandoffCards: (filter?: HandoffCardFilter) => HandoffCard[]
  saveHandoffCard: (
    card: Partial<HandoffCard> &
      Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
  ) => HandoffCard
  updateHandoffCard: (id: string, partial: Partial<HandoffCard>) => HandoffCard | null
  deleteHandoffCard: (id: string) => unknown
  assertProviderId: (provider: ProviderId) => ProviderId
  requireNonEmptyString: (value: string, label: string) => string
  sanitizeRuntimeProfileForSave: (
    profile: unknown
  ) => Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
  sanitizeHandoffCardForSave: (
    card: unknown
  ) => Partial<HandoffCard> &
    Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
  sanitizeHandoffCardPatch: (partial: unknown) => Partial<HandoffCard>
  sanitizeHandoffCardFilter: (filter: unknown) => HandoffCardFilter
}

export function registerSettingsHandlers(deps: SettingsHandlerDeps): void {
  ipcMain.handle('get-settings', () => deps.settingsService.getSettings())
  ipcMain.handle('update-settings', (_event, partial: Partial<AppSettings>) =>
    deps.settingsService.updateSettings(partial)
  )
  ipcMain.handle('set-bridge-daemon-enabled', (_event, enabled: boolean) =>
    deps.setBridgeDaemonEnabled(Boolean(enabled))
  )

  ipcMain.handle('get-runtime-profiles', (_event, provider?: ProviderId) => {
    return deps.getRuntimeProfiles(provider ? deps.assertProviderId(provider) : undefined)
  })
  ipcMain.handle(
    'save-runtime-profile',
    (
      _event,
      profile: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
    ) => {
      return deps.saveRuntimeProfile(deps.sanitizeRuntimeProfileForSave(profile))
    }
  )
  ipcMain.handle('delete-runtime-profile', (_event, id: string) =>
    deps.deleteRuntimeProfile(deps.requireNonEmptyString(id, 'Runtime profile id'))
  )

  ipcMain.handle('get-handoff-cards', (_event, filter?: HandoffCardFilter) =>
    deps.getHandoffCards(deps.sanitizeHandoffCardFilter(filter))
  )
  ipcMain.handle(
    'save-handoff-card',
    (
      _event,
      card: Partial<HandoffCard> &
        Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
    ) => {
      return deps.saveHandoffCard(deps.sanitizeHandoffCardForSave(card))
    }
  )
  ipcMain.handle('update-handoff-card', (_event, id: string, partial: Partial<HandoffCard>) => {
    return deps.updateHandoffCard(
      deps.requireNonEmptyString(id, 'Handoff card id'),
      deps.sanitizeHandoffCardPatch(partial)
    )
  })
  ipcMain.handle('delete-handoff-card', (_event, id: string) =>
    deps.deleteHandoffCard(deps.requireNonEmptyString(id, 'Handoff card id'))
  )
}
