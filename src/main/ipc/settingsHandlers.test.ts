import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerSettingsHandlers } from './settingsHandlers'
import type { ExtensionSecretRef } from '../ExtensionSecretStore'
import type { AppSettings, HandoffCard, ProviderId, RuntimeProfile } from '../store/types'

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

function runtimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'runtime-1',
    name: 'Runtime',
    provider: 'codex',
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-06-27T16:00:00.000Z',
    updatedAt: '2026-06-27T16:00:00.000Z',
    ...overrides
  }
}

function handoffCard(overrides: Partial<HandoffCard> = {}): HandoffCard {
  return {
    id: 'handoff-1',
    status: 'draft',
    sourceChatId: 'chat-1',
    sourceProvider: 'codex',
    summary: 'Summary',
    selectedFiles: [],
    workspaceChangeSetIds: [],
    rawEventRunIds: [],
    finalPrompt: 'Continue',
    createdAt: '2026-06-27T16:00:00.000Z',
    updatedAt: '2026-06-27T16:00:00.000Z',
    ...overrides
  }
}

function createDeps(overrides: Partial<Parameters<typeof registerSettingsHandlers>[0]> = {}) {
  const settings = { bridgeDaemonEnabled: false } as AppSettings
  return {
    settingsService: {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn()
    },
    setBridgeDaemonEnabled: vi.fn(async () => ({
      lan: { enabled: true },
      tailscale: { available: true }
    })),
    getRuntimeProfiles: vi.fn(() => [runtimeProfile()]),
    saveRuntimeProfile: vi.fn((profile) => runtimeProfile(profile)),
    deleteRuntimeProfile: vi.fn(() => true),
    getExtensionSecretStatusSnapshot: vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: '2026-07-03T00:00:00.000Z',
      encryptionAvailable: true,
      secrets: []
    })),
    setExtensionSecret: vi.fn((ref: ExtensionSecretRef, _value: string) => ({
      ok: true,
      snapshot: {
        schemaVersion: 1 as const,
        generatedAt: '2026-07-03T00:00:00.000Z',
        encryptionAvailable: true,
        secrets: [{ ...ref, configured: true, updatedAt: '2026-07-03T00:00:00.000Z' }]
      }
    })),
    clearExtensionSecret: vi.fn((ref: ExtensionSecretRef) => ({
      ok: true,
      snapshot: {
        schemaVersion: 1 as const,
        generatedAt: '2026-07-03T00:00:00.000Z',
        encryptionAvailable: true,
        secrets: [{ ...ref, configured: false }]
      }
    })),
    getHandoffCards: vi.fn(() => [handoffCard()]),
    saveHandoffCard: vi.fn((card) => handoffCard(card)),
    updateHandoffCard: vi.fn((id, partial) => handoffCard({ id, ...partial })),
    deleteHandoffCard: vi.fn(() => true),
    assertProviderId: vi.fn((provider: ProviderId) => provider),
    requireNonEmptyString: vi.fn((value: string) => value),
    sanitizeRuntimeProfileForSave: vi.fn((profile) => profile as any),
    sanitizeHandoffCardForSave: vi.fn((card) => card as any),
    sanitizeHandoffCardPatch: vi.fn((partial) => partial as any),
    sanitizeHandoffCardFilter: vi.fn((filter) => filter as any),
    ...overrides
  }
}

describe('registerSettingsHandlers', () => {
  it('registers settings read and update handlers against the settings service', () => {
    const deps = createDeps()
    registerSettingsHandlers(deps)

    expect(handlerFor('get-settings')({} as any)).toBe(deps.settingsService.getSettings())
    expect(handlerFor('update-settings')({} as any, { compactDensity: true })).toBeUndefined()
    expect(deps.settingsService.updateSettings).toHaveBeenCalledWith({ compactDensity: true })
  })

  it('delegates bridge daemon toggles through the injected bridge callback', async () => {
    const deps = createDeps()
    registerSettingsHandlers(deps)

    await expect(handlerFor('set-bridge-daemon-enabled')({} as any, 1)).resolves.toEqual({
      lan: { enabled: true },
      tailscale: { available: true }
    })
    expect(deps.setBridgeDaemonEnabled).toHaveBeenCalledWith(true)
  })

  it('sanitizes provider filters and runtime profile mutations', () => {
    const deps = createDeps()
    const profileInput = { name: 'Runtime', provider: 'codex' as ProviderId }
    registerSettingsHandlers(deps)

    expect(handlerFor('get-runtime-profiles')({} as any, 'codex')).toEqual([runtimeProfile()])
    expect(deps.assertProviderId).toHaveBeenCalledWith('codex')
    expect(deps.getRuntimeProfiles).toHaveBeenCalledWith('codex')

    expect(handlerFor('save-runtime-profile')({} as any, profileInput)).toEqual(
      runtimeProfile(profileInput)
    )
    expect(deps.sanitizeRuntimeProfileForSave).toHaveBeenCalledWith(profileInput)
    expect(deps.saveRuntimeProfile).toHaveBeenCalledWith(profileInput)

    expect(handlerFor('delete-runtime-profile')({} as any, 'runtime-1')).toBe(true)
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('runtime-1', 'Runtime profile id')
    expect(deps.deleteRuntimeProfile).toHaveBeenCalledWith('runtime-1')
  })

  it('exposes extension secret status and mutation handlers without plaintext reads', () => {
    const deps = createDeps()
    const ref: ExtensionSecretRef = {
      ownerKind: 'runtimeProfile',
      ownerId: 'runtime-1',
      fieldKind: 'env',
      fieldName: 'SERVICE_TOKEN'
    }
    registerSettingsHandlers(deps)

    expect(handlerFor('get-extension-secret-status')({} as any)).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-07-03T00:00:00.000Z',
      encryptionAvailable: true,
      secrets: []
    })
    expect(handlerFor('set-extension-secret')({} as any, ref, 'token-value')).toMatchObject({
      ok: true,
      snapshot: {
        secrets: [{ ...ref, configured: true }]
      }
    })
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('token-value', 'Secret value')
    expect(deps.setExtensionSecret).toHaveBeenCalledWith(ref, 'token-value')

    expect(handlerFor('clear-extension-secret')({} as any, ref)).toMatchObject({
      ok: true,
      snapshot: {
        secrets: [{ ...ref, configured: false }]
      }
    })
    expect(deps.clearExtensionSecret).toHaveBeenCalledWith(ref)
  })

  it('sanitizes handoff card reads and mutations', () => {
    const deps = createDeps()
    const cardInput = {
      sourceChatId: 'chat-1',
      sourceProvider: 'codex' as ProviderId,
      summary: 'Summary',
      finalPrompt: 'Continue'
    }
    registerSettingsHandlers(deps)

    expect(handlerFor('get-handoff-cards')({} as any, { status: 'draft' })).toEqual([handoffCard()])
    expect(deps.sanitizeHandoffCardFilter).toHaveBeenCalledWith({ status: 'draft' })
    expect(deps.getHandoffCards).toHaveBeenCalledWith({ status: 'draft' })

    expect(handlerFor('save-handoff-card')({} as any, cardInput)).toEqual(handoffCard(cardInput))
    expect(deps.sanitizeHandoffCardForSave).toHaveBeenCalledWith(cardInput)
    expect(deps.saveHandoffCard).toHaveBeenCalledWith(cardInput)

    expect(handlerFor('update-handoff-card')({} as any, 'handoff-1', { summary: 'Updated' })).toEqual(
      handoffCard({ id: 'handoff-1', summary: 'Updated' })
    )
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('handoff-1', 'Handoff card id')
    expect(deps.sanitizeHandoffCardPatch).toHaveBeenCalledWith({ summary: 'Updated' })
    expect(deps.updateHandoffCard).toHaveBeenCalledWith('handoff-1', { summary: 'Updated' })

    expect(handlerFor('delete-handoff-card')({} as any, 'handoff-1')).toBe(true)
    expect(deps.deleteHandoffCard).toHaveBeenCalledWith('handoff-1')
  })
})
