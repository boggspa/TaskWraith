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
      cancelGeminiOAuthLogin: vi.fn(() => oauthStatus),
      isMainRendererSender: vi.fn(() => true)
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

  it('omits binary paths, OAuth identity, and live login state from secondary reads', async () => {
    const { deps } = createDeps()
    const profile = {
      id: 'profile-1',
      label: 'Work',
      kind: 'google-oauth',
      configured: true,
      isDefault: true,
      authState: 'google-oauth',
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
      oauthConfigured: true,
      oauthEmail: 'private@example.test',
      oauthLogin: {
        profileId: 'profile-1',
        status: 'running',
        authUrl: 'https://accounts.example.test/private-code'
      }
    } as GeminiAuthProfileSummary
    deps.isMainRendererSender.mockReturnValue(false)
    deps.summarizeGeminiAuthProfile.mockReturnValue(profile)
    deps.getGeminiAuthStatusSnapshot.mockResolvedValue({
      available: true,
      authState: 'google-oauth',
      apiKeyConfigured: false,
      encryptionAvailable: true,
      version: '1.0.0',
      binaryPath: '/Users/private/.local/bin/gemini',
      activeProfileId: 'profile-1',
      activeProfileLabel: 'Work',
      profiles: [profile],
      oauthLogin: profile.oauthLogin
    })
    registerGeminiAuthHandlers(deps)
    const event = { sender: { id: 42 } }

    const status = await handlerFor('get-gemini-auth-status')(event)
    const profiles = await handlerFor('list-gemini-auth-profiles')(event)

    expect(status).toMatchObject({
      available: true,
      authState: 'google-oauth',
      activeProfileId: 'profile-1',
      profiles: [expect.objectContaining({ id: 'profile-1', oauthConfigured: true })]
    })
    expect(profiles).toEqual([expect.objectContaining({ id: 'profile-1', oauthConfigured: true })])
    expect(JSON.stringify({ status, profiles })).not.toContain('/Users/private')
    expect(JSON.stringify({ status, profiles })).not.toContain('private@example.test')
    expect(JSON.stringify({ status, profiles })).not.toContain('private-code')
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
