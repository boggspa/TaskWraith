import { describe, expect, it } from 'vitest'
import {
  OLLAMA_MODEL_COMMANDS,
  PROVIDER_INSTALL_COMMANDS,
  findCatalogInstallCommand
} from './providerSetupCatalog'

describe('findCatalogInstallCommand', () => {
  it('resolves live provider installs and ollama model pulls by row id', () => {
    expect(findCatalogInstallCommand('codex')).toMatchObject({
      kind: 'provider',
      label: 'Codex',
      command: 'npm i -g @openai/codex'
    })
    expect(findCatalogInstallCommand('qwen3:4b-instruct')).toMatchObject({
      kind: 'ollama-model',
      command: 'ollama run qwen3:4b-instruct'
    })
  })

  it('carries the platform restriction for platform-bound installers', () => {
    expect(findCatalogInstallCommand('mistral')?.platforms).toEqual(['darwin', 'linux'])
    expect(findCatalogInstallCommand('ollama')?.platforms).toEqual(['darwin', 'linux'])
  })

  it('refuses unknown ids and providers outside the live-selectable set', () => {
    expect(findCatalogInstallCommand('nope')).toBeNull()
    expect(findCatalogInstallCommand(undefined)).toBeNull()
    // The renderer never offers non-live providers; the executable lane must
    // match it fail-closed. 'ollama-windows' is a row id, not a ProviderId, so
    // it is unreachable through this resolver too.
    expect(findCatalogInstallCommand('antigravity')).toBeNull()
    expect(findCatalogInstallCommand('ollama-windows')).toBeNull()
  })

  it('keeps provider and model row ids globally unique', () => {
    const ids = [
      ...PROVIDER_INSTALL_COMMANDS.map((entry) => entry.id),
      ...OLLAMA_MODEL_COMMANDS.map((entry) => entry.id)
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
