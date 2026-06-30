import { ipcMain } from 'electron'
import type {
  GeminiAuthProfile,
  GeminiAuthProfileSummary,
  GeminiAuthStatus,
  GeminiOAuthLoginStatus
} from '../store/types'

export interface GeminiAuthHandlersDeps {
  getGeminiAuthStatusSnapshot: () => Promise<GeminiAuthStatus>
  getDefaultGeminiAuthProfileId: () => string | null
  getGeminiAuthProfiles: () => GeminiAuthProfile[]
  summarizeGeminiAuthProfile: (
    profile: GeminiAuthProfile,
    defaultProfileId: string | null
  ) => GeminiAuthProfileSummary
  saveGeminiAuthProfile: (profile: unknown) => GeminiAuthProfileSummary
  deleteGeminiAuthProfile: (profileId: unknown) => Promise<boolean>
  setDefaultGeminiAuthProfile: (profileId: unknown) => GeminiAuthProfileSummary | null
  startGeminiOAuthLogin: (input: unknown) => Promise<GeminiOAuthLoginStatus>
  getGeminiOAuthLoginStatus: (profileId: unknown) => GeminiOAuthLoginStatus | null
  cancelGeminiOAuthLogin: (profileId: unknown) => GeminiOAuthLoginStatus | null
}

export function registerGeminiAuthHandlers(deps: GeminiAuthHandlersDeps): void {
  ipcMain.handle('get-gemini-auth-status', async () => {
    return deps.getGeminiAuthStatusSnapshot()
  })

  ipcMain.handle('list-gemini-auth-profiles', async () => {
    const defaultProfileId = deps.getDefaultGeminiAuthProfileId()
    return deps
      .getGeminiAuthProfiles()
      .map((profile) => deps.summarizeGeminiAuthProfile(profile, defaultProfileId))
  })

  ipcMain.handle('save-gemini-auth-profile', async (_, profile: unknown) => {
    return deps.saveGeminiAuthProfile(profile)
  })

  ipcMain.handle('delete-gemini-auth-profile', async (_, profileId: unknown) => {
    return deps.deleteGeminiAuthProfile(profileId)
  })

  ipcMain.handle('set-default-gemini-auth-profile', async (_, profileId: unknown) => {
    return deps.setDefaultGeminiAuthProfile(profileId)
  })

  ipcMain.handle('start-gemini-oauth-login', async (_, input: unknown) => {
    return deps.startGeminiOAuthLogin(input)
  })

  ipcMain.handle('get-gemini-oauth-login-status', async (_, profileId: unknown) => {
    return deps.getGeminiOAuthLoginStatus(profileId)
  })

  ipcMain.handle('cancel-gemini-oauth-login', async (_, profileId: unknown) => {
    return deps.cancelGeminiOAuthLogin(profileId)
  })
}
