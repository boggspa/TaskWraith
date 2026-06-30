import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type {
  GeminiAuthProfile,
  GeminiAuthProfileSummary,
  GeminiAuthStatus,
  GeminiOAuthLoginStatus
} from '../store/types'
import { registerGeminiAuthHandlers } from './geminiAuthHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  const profile = { id: 'profile-1', provider: 'gemini' } as unknown as GeminiAuthProfile
  const summary = { id: 'profile-1', isDefault: true } as unknown as GeminiAuthProfileSummary
  const status = { authState: 'authenticated' } as unknown as GeminiAuthStatus
  const oauthStatus = { status: 'running' } as unknown as GeminiOAuthLoginStatus

  return {
    deps: {
      getGeminiAuthStatusSnapshot: vi.fn(async () => status),
      getDefaultGeminiAuthProfileId: vi.fn(() => 'profile-1'),
      getGeminiAuthProfiles: vi.fn(() => [profile]),
      summarizeGeminiAuthProfile: vi.fn(() => summary),
      saveGeminiAuthProfile: vi.fn(() => summary),
      deleteGeminiAuthProfile: vi.fn(async () => true),
      setDefaultGeminiAuthProfile: vi.fn(() => summary),
      startGeminiOAuthLogin: vi.fn(async () => oauthStatus),
      getGeminiOAuthLoginStatus: vi.fn(() => oauthStatus),
      cancelGeminiOAuthLogin: vi.fn(() => oauthStatus)
    },
    profile,
    summary,
    status,
    oauthStatus
  }
}

describe('registerGeminiAuthHandlers', () => {
  it('registers gemini auth/profile/oauth IPC channels', () => {
    registerGeminiAuthHandlers(createDeps().deps)

    expect(handlerFor('get-gemini-auth-status')).toBeTypeOf('function')
    expect(handlerFor('list-gemini-auth-profiles')).toBeTypeOf('function')
    expect(handlerFor('save-gemini-auth-profile')).toBeTypeOf('function')
    expect(handlerFor('delete-gemini-auth-profile')).toBeTypeOf('function')
    expect(handlerFor('set-default-gemini-auth-profile')).toBeTypeOf('function')
    expect(handlerFor('start-gemini-oauth-login')).toBeTypeOf('function')
    expect(handlerFor('get-gemini-oauth-login-status')).toBeTypeOf('function')
    expect(handlerFor('cancel-gemini-oauth-login')).toBeTypeOf('function')
  })

  it('delegates get-gemini-auth-status directly', async () => {
    const { deps, status } = createDeps()
    registerGeminiAuthHandlers(deps)

    await expect(handlerFor('get-gemini-auth-status')({})).resolves.toBe(status)
    expect(deps.getGeminiAuthStatusSnapshot).toHaveBeenCalledOnce()
  })

  it('captures defaultProfileId once and summarizes each profile with it', async () => {
    const { deps, profile, summary } = createDeps()
    registerGeminiAuthHandlers(deps)

    await expect(handlerFor('list-gemini-auth-profiles')({})).resolves.toEqual([summary])
    expect(deps.getDefaultGeminiAuthProfileId).toHaveBeenCalledTimes(1)
    expect(deps.getGeminiAuthProfiles).toHaveBeenCalledTimes(1)
    expect(deps.summarizeGeminiAuthProfile).toHaveBeenCalledWith(profile, 'profile-1')
  })

  it('passes save/delete/set-default/profileId and oauth args through unchanged', async () => {
    const { deps, summary, oauthStatus } = createDeps()
    registerGeminiAuthHandlers(deps)

    const profileInput = { id: 'profile-2', label: 'Work' }
    await expect(handlerFor('save-gemini-auth-profile')({}, profileInput)).resolves.toBe(summary)
    expect(deps.saveGeminiAuthProfile).toHaveBeenCalledWith(profileInput)

    await expect(handlerFor('delete-gemini-auth-profile')({}, 'profile-2')).resolves.toBe(true)
    expect(deps.deleteGeminiAuthProfile).toHaveBeenCalledWith('profile-2')

    await expect(handlerFor('set-default-gemini-auth-profile')({}, 'profile-2')).resolves.toBe(
      summary
    )
    expect(deps.setDefaultGeminiAuthProfile).toHaveBeenCalledWith('profile-2')

    const oauthInput = { profileId: 'profile-2', reauth: true }
    await expect(handlerFor('start-gemini-oauth-login')({}, oauthInput)).resolves.toBe(oauthStatus)
    expect(deps.startGeminiOAuthLogin).toHaveBeenCalledWith(oauthInput)

    await expect(handlerFor('get-gemini-oauth-login-status')({}, 'profile-2')).resolves.toBe(
      oauthStatus
    )
    expect(deps.getGeminiOAuthLoginStatus).toHaveBeenCalledWith('profile-2')

    await expect(handlerFor('cancel-gemini-oauth-login')({}, 'profile-2')).resolves.toBe(
      oauthStatus
    )
    expect(deps.cancelGeminiOAuthLogin).toHaveBeenCalledWith('profile-2')
  })
})
