import { describe, expect, it } from 'vitest'
import { createMainSanitizers } from './MainSanitizers'
import type { MainSanitizerDeps } from './MainSanitizers'
import type { AppSettings } from '../store/types'
import { rendererSettingsForSender } from '../ipc/settingsHandlers'

/**
 * `customProviderModels` reaches the store through the generic settings patch,
 * which drops every key that is not on `SETTINGS_PATCH_KEYS` — silently. An
 * omission there does not fail a build or a type check: the composer's saved
 * model list simply appears to work and is gone on the next reload. These tests
 * pin the write path (survives sanitisation, normalised on the way in).
 */

function makeSanitizers(settings: AppSettings = {} as AppSettings) {
  return createMainSanitizers({
    getSettings: () => settings,
    getScheduledTasks: () => [],
    getWorkflowDefinitions: () => [],
    getChat: () => null,
    findRegisteredWorkspace: () => undefined,
    requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
    canonicalPath: (value: string) => value,
    normalizeExternalPathGrants: (grants) => grants,
    stageScheduledAttachments: ({ attachments }) => ({ ok: true, attachments })
  } as unknown as MainSanitizerDeps)
}

describe('customProviderModels settings patch', () => {
  it('survives the settings-patch allowlist', () => {
    const { sanitizeSettingsPatch } = makeSanitizers()
    const patched = sanitizeSettingsPatch({
      customProviderModels: { ollama: ['qwen3-coder:30b'] }
    })
    expect(patched.customProviderModels).toEqual({ ollama: ['qwen3-coder:30b'] })
  })

  it('normalises the list on write so an unusable id never reaches the picker', () => {
    const { sanitizeSettingsPatch } = makeSanitizers()
    const patched = sanitizeSettingsPatch({
      customProviderModels: {
        ollama: ['qwen3-coder:30b', 'qwen3-coder:30b', '  ', 'two words', 'custom'],
        codex: []
      }
    })
    expect(patched.customProviderModels).toEqual({ ollama: ['qwen3-coder:30b'] })
  })

  it('coerces a malformed value to an empty map instead of persisting it', () => {
    const { sanitizeSettingsPatch } = makeSanitizers()
    expect(sanitizeSettingsPatch({ customProviderModels: 'nope' }).customProviderModels).toEqual({})
    expect(sanitizeSettingsPatch({ customProviderModels: null }).customProviderModels).toEqual({})
  })

  it('leaves the key absent when the patch does not carry it', () => {
    const { sanitizeSettingsPatch } = makeSanitizers()
    expect('customProviderModels' in sanitizeSettingsPatch({ currency: 'GBP' })).toBe(false)
  })
})

describe('customProviderModels renderer projection', () => {
  const pathsEqual = (left: string, right: string): boolean => left === right
  // The chat projection dereferences agenticServices unconditionally, so every
  // fixture here carries one; it is not part of what these tests assert.
  const baseSettings = { agenticServices: {} } as unknown as AppSettings

  it('reaches a chat renderer, whose projection is an allowlist', () => {
    const projected = rendererSettingsForSender(
      { ...baseSettings, customProviderModels: { ollama: ['qwen3-coder:30b'] } },
      { kind: 'chat', workspacePath: '/tmp/ws' },
      pathsEqual
    )
    expect(projected.customProviderModels).toEqual({ ollama: ['qwen3-coder:30b'] })
  })

  it('reaches the main renderer too', () => {
    const projected = rendererSettingsForSender(
      { ...baseSettings, customProviderModels: { ollama: ['qwen3-coder:30b'] } },
      { kind: 'main' },
      pathsEqual
    )
    expect(projected.customProviderModels).toEqual({ ollama: ['qwen3-coder:30b'] })
  })

  it('omits the key entirely when nothing is saved', () => {
    const projected = rendererSettingsForSender(
      baseSettings,
      { kind: 'chat', workspacePath: '/tmp/ws' },
      pathsEqual
    )
    expect('customProviderModels' in projected).toBe(false)
  })
})
