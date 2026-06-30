import { ipcMain } from 'electron'
import type { AppSettings } from '../store/types'

interface ImageGenerationStatus {
  enabled: boolean
  defaultProvider: 'openai' | 'xai'
  encryptionAvailable: boolean
  configured: {
    openai: boolean
    xai: boolean
  }
}

export interface ImageGenerationHandlersDeps {
  getSettings: () => AppSettings
  updateSettings: (patch: Partial<AppSettings>) => void
  isRecord: (value: unknown) => value is Record<string, unknown>
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
}

export function registerImageGenerationHandlers(deps: ImageGenerationHandlersDeps): void {
  ipcMain.handle('image-generation:get-status', (): ImageGenerationStatus => {
    const imageGeneration = deps.getSettings().imageGeneration
    return {
      enabled: Boolean(imageGeneration?.enabled),
      defaultProvider: imageGeneration?.provider === 'xai' ? 'xai' : 'openai',
      encryptionAvailable: deps.isEncryptionAvailable(),
      configured: {
        openai: Boolean(imageGeneration?.encryptedKeys?.openai),
        xai: Boolean(imageGeneration?.encryptedKeys?.xai)
      }
    }
  })

  ipcMain.handle('image-generation:set-enabled', (_event, input: unknown) => {
    if (!deps.isRecord(input)) return { ok: false, error: 'invalid input' }
    const provider =
      input.provider === 'xai' ? 'xai' : input.provider === 'openai' ? 'openai' : undefined
    const current = deps.getSettings().imageGeneration || {}
    deps.updateSettings({
      imageGeneration: {
        ...current,
        enabled: Boolean(input.enabled),
        ...(provider ? { provider } : {})
      }
    })
    return { ok: true }
  })

  ipcMain.handle('image-generation:set-key', (_event, input: unknown) => {
    if (!deps.isRecord(input)) return { ok: false, error: 'invalid input' }
    const provider =
      input.provider === 'xai' ? 'xai' : input.provider === 'openai' ? 'openai' : null
    const key = typeof input.key === 'string' ? input.key.trim() : ''
    if (!provider) return { ok: false, error: 'provider must be openai or xai' }
    if (!key) return { ok: false, error: 'key is required' }
    if (!deps.isEncryptionAvailable()) {
      return { ok: false, error: 'OS keychain encryption is unavailable; cannot store the key.' }
    }
    const current = deps.getSettings().imageGeneration || {}
    deps.updateSettings({
      imageGeneration: {
        ...current,
        encryptedKeys: {
          ...(current.encryptedKeys || {}),
          [provider]: deps.encryptString(key).toString('base64')
        }
      }
    })
    return { ok: true }
  })

  ipcMain.handle('image-generation:clear-key', (_event, input: unknown) => {
    if (!deps.isRecord(input)) return { ok: false, error: 'invalid input' }
    const provider =
      input.provider === 'xai' ? 'xai' : input.provider === 'openai' ? 'openai' : null
    if (!provider) return { ok: false, error: 'provider must be openai or xai' }
    const current = deps.getSettings().imageGeneration || {}
    const encryptedKeys = { ...(current.encryptedKeys || {}) }
    delete encryptedKeys[provider]
    deps.updateSettings({ imageGeneration: { ...current, encryptedKeys } })
    return { ok: true }
  })
}
