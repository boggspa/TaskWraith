import { describe, expect, it } from 'vitest'
import {
  HOST_CLI_TOOLS,
  HOST_CLI_TOOL_IDS,
  hostCliTool,
  hostCliToolInstallCommand,
  hostCliToolManualInstallMessage,
  isHostCliToolId
} from './hostCliToolCatalog'
import { PROVIDER_INSTALL_COMMANDS } from './providerSetupCatalog'

describe('hostCliToolCatalog', () => {
  it('registers gh with a probeable binary name and official docs link', () => {
    const gh = hostCliTool('gh')
    expect(gh?.binaryName).toBe('gh')
    expect(gh?.label).toBe('GitHub CLI')
    expect(gh?.docsUrl).toBe('https://cli.github.com')
    expect(HOST_CLI_TOOL_IDS).toContain('gh')
  })

  it('stays disjoint from the provider install catalog', () => {
    // The provider list is projected to the iOS/remote first-launch surface and
    // is filtered by isLiveSelectableProvider. A host tool leaking into it would
    // ship a desktop-only install command to a phone.
    const providerIds = new Set(PROVIDER_INSTALL_COMMANDS.map((entry) => entry.id))
    for (const id of HOST_CLI_TOOL_IDS) expect(providerIds.has(id)).toBe(false)
  })

  it('resolves the platform-correct install command', () => {
    expect(hostCliToolInstallCommand('gh', 'darwin')?.command).toBe('brew install gh')
    expect(hostCliToolInstallCommand('gh', 'win32')?.command).toBe('winget install --id GitHub.cli')
  })

  it('returns null rather than guessing on an uncovered platform', () => {
    expect(hostCliToolInstallCommand('gh', 'linux')).toBeNull()
    expect(hostCliToolManualInstallMessage('gh')).toContain('https://cli.github.com')
  })

  it('bounds the id set against untrusted input', () => {
    expect(isHostCliToolId('gh')).toBe(true)
    expect(isHostCliToolId('codex')).toBe(false)
    expect(isHostCliToolId('')).toBe(false)
    expect(isHostCliToolId(null)).toBe(false)
    expect(hostCliTool({ id: 'gh' })).toBeNull()
  })

  it('gives every entry a purpose and consequence for the user-facing card', () => {
    for (const entry of HOST_CLI_TOOLS) {
      expect(entry.purpose.length).toBeGreaterThan(0)
      expect(entry.missingConsequence.length).toBeGreaterThan(0)
      expect(entry.installCommands.length).toBeGreaterThan(0)
    }
  })
})
