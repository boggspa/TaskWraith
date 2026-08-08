import { describe, expect, it } from 'vitest'
import {
  SIMULATOR_TOOL_IDS,
  SIMULATOR_TOOLS,
  isSimulatorToolId,
  simulatorIdbMissingHint,
  simulatorTool,
  simulatorToolInstallCommands
} from './simulatorToolCatalog'
import { HOST_CLI_TOOL_IDS } from './hostCliToolCatalog'

describe('simulatorToolCatalog', () => {
  it('registers idb with companion + client install guidance', () => {
    const idb = simulatorTool('idb')
    expect(idb?.binaryName).toBe('idb')
    expect(idb?.companionBinaryName).toBe('idb_companion')
    expect(idb?.docsUrl).toContain('fbidb')
    expect(SIMULATOR_TOOL_IDS).toEqual(['idb'])
    expect(idb?.clientInstallNote).toContain('pip3 install fb-idb')
  })

  it('stays disjoint from the gh-only host CLI catalog', () => {
    for (const id of SIMULATOR_TOOL_IDS) {
      expect(HOST_CLI_TOOL_IDS).not.toContain(id)
    }
  })

  it('resolves the macOS companion brew command and skips other platforms', () => {
    expect(simulatorToolInstallCommands('idb', 'darwin')[0]?.command).toBe(
      'brew tap facebook/fb && brew install idb-companion'
    )
    expect(simulatorToolInstallCommands('idb', 'linux')).toEqual([])
    expect(simulatorToolInstallCommands('idb', 'win32')).toEqual([])
  })

  it('bounds the id set against untrusted input', () => {
    expect(isSimulatorToolId('idb')).toBe(true)
    expect(isSimulatorToolId('gh')).toBe(false)
    expect(isSimulatorToolId(null)).toBe(false)
    expect(simulatorTool({ id: 'idb' })).toBeNull()
  })

  it('gives every entry purpose, consequence, and install commands', () => {
    for (const entry of SIMULATOR_TOOLS) {
      expect(entry.purpose.length).toBeGreaterThan(0)
      expect(entry.missingConsequence.length).toBeGreaterThan(0)
      expect(entry.installCommands.length).toBeGreaterThan(0)
    }
    expect(simulatorIdbMissingHint()).toContain('brew tap facebook/fb')
    expect(simulatorIdbMissingHint()).toContain('pip3 install fb-idb')
  })
})
