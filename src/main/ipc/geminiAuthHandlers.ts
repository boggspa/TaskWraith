import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  GeminiAuthProfile,
  GeminiAuthProfileSummary,
  GeminiAuthStatus,
  GeminiOAuthLoginStatus
} from '../store/types'
import { createGeminiAuthHandlers } from './providerSecretHandlerFactory'

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
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerGeminiAuthHandlers(deps: GeminiAuthHandlersDeps): void {
  const handlers = createGeminiAuthHandlers({
    getGeminiAuthStatusSnapshot: deps.getGeminiAuthStatusSnapshot,
    getDefaultGeminiAuthProfileId: deps.getDefaultGeminiAuthProfileId,
    getGeminiAuthProfiles: deps.getGeminiAuthProfiles,
    summarizeGeminiAuthProfile: deps.summarizeGeminiAuthProfile,
    saveGeminiAuthProfile: deps.saveGeminiAuthProfile,
    deleteGeminiAuthProfile: deps.deleteGeminiAuthProfile,
    setDefaultGeminiAuthProfile: deps.setDefaultGeminiAuthProfile,
    startGeminiOAuthLogin: deps.startGeminiOAuthLogin,
    getGeminiOAuthLoginStatus: deps.getGeminiOAuthLoginStatus,
    cancelGeminiOAuthLogin: deps.cancelGeminiOAuthLogin,
    isMainRendererSender: deps.isMainRendererSender
  })

  ipcMain.handle('get-gemini-auth-status', handlers.getStatus)
  ipcMain.handle('list-gemini-auth-profiles', handlers.listProfiles)
  ipcMain.handle('save-gemini-auth-profile', handlers.saveProfile)
  ipcMain.handle('delete-gemini-auth-profile', handlers.deleteProfile)
  ipcMain.handle('set-default-gemini-auth-profile', handlers.setDefaultProfile)
  ipcMain.handle('start-gemini-oauth-login', handlers.startOAuthLogin)
  ipcMain.handle('get-gemini-oauth-login-status', handlers.getOAuthLoginStatus)
  ipcMain.handle('cancel-gemini-oauth-login', handlers.cancelOAuthLogin)
}
