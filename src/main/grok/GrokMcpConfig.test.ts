import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  grokProjectMcpDirForWorkspace,
  grokProjectNameForWorkspace,
  isReservedGrokTaskWraithMcpServerName,
  sweepGrokProjectTaskWraithMcpRegistrations
} from './GrokMcpConfig'

describe('Grok MCP config hygiene', () => {
  it('matches Grok project directory names for workspace paths', () => {
    expect(grokProjectNameForWorkspace('/Users/chrisizatt/Documents/AGBench')).toBe(
      'Users-chrisizatt-Documents-AGBench'
    )
    expect(grokProjectMcpDirForWorkspace('/home/me', '/Users/chrisizatt/Documents/Test 3')).toBe(
      '/home/me/.grok/projects/Users-chrisizatt-Documents-Test 3/mcps'
    )
  })

  it('recognizes only TaskWraith-owned reserved names', () => {
    expect(isReservedGrokTaskWraithMcpServerName('TaskWraith')).toBe(true)
    expect(isReservedGrokTaskWraithMcpServerName('taskwraith-broker')).toBe(true)
    expect(isReservedGrokTaskWraithMcpServerName('taskwraith-cursor')).toBe(true)
    expect(isReservedGrokTaskWraithMcpServerName('agbench')).toBe(true)
    expect(isReservedGrokTaskWraithMcpServerName('filesystem')).toBe(false)
    expect(isReservedGrokTaskWraithMcpServerName('my-taskwraith-tools')).toBe(false)
  })

  it('sweeps stale TaskWraith and agbench entries from the current project MCP store', () => {
    const home = mkdtempSync(join(tmpdir(), 'taskwraith-grok-mcp-'))
    const mcpDir = grokProjectMcpDirForWorkspace(home, '/Users/chrisizatt/Documents/AGBench')!
    for (const name of ['agbench', 'TaskWraith', 'taskwraith-cursor', 'taskwraith-broker']) {
      mkdirSync(join(mcpDir, name, 'tools'), { recursive: true })
      writeFileSync(join(mcpDir, name, 'tools', 'write_file.json'), '{}')
    }
    mkdirSync(join(mcpDir, 'filesystem', 'tools'), { recursive: true })

    const result = sweepGrokProjectTaskWraithMcpRegistrations(
      home,
      '/Users/chrisizatt/Documents/AGBench'
    )

    expect(result.removed.sort()).toEqual([
      'TaskWraith',
      'agbench',
      'taskwraith-broker',
      'taskwraith-cursor'
    ])
    expect(existsSync(join(mcpDir, 'filesystem'))).toBe(true)
    expect(existsSync(join(mcpDir, 'TaskWraith'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})
