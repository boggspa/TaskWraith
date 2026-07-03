import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The catalog transitively pulls in modules that read electron.app on import.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-test'
  }
}))

import { buildOllamaToolDocSection, buildOllamaToolsMarkdown } from './OllamaToolsDoc'
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'

const TOOLS_MD = resolve(__dirname, '../../../resources/Tools.md')
const generated = buildOllamaToolsMarkdown()

// `npm run generate:ollama-tools-md` sets UPDATE_TOOLS_MD=1 to (re)write the
// checked-in file from the catalog. In every other run (incl. CI) the drift
// test below compares the committed file against a fresh generation.
if (process.env.UPDATE_TOOLS_MD === '1') {
  writeFileSync(TOOLS_MD, generated, 'utf8')
}

describe('resources/Tools.md', () => {
  it('is up to date — regenerates byte-identically from the catalog (no drift)', () => {
    const onDisk = readFileSync(TOOLS_MD, 'utf8')
    expect(onDisk).toBe(generated)
  })

  it('documents exactly the TASKWRAITH_MCP_TOOLS set (one section per tool)', () => {
    for (const name of TASKWRAITH_MCP_TOOLS) {
      expect(generated).toContain(`## ${name}\n`)
    }
    const sectionCount = generated.match(/^## /gm)?.length ?? 0
    expect(sectionCount).toBe(TASKWRAITH_MCP_TOOLS.length)
  })

  it('gives every tool a copyable taskwraith_tool call example', () => {
    for (const name of TASKWRAITH_MCP_TOOLS) {
      expect(generated).toContain(`{"taskwraith_tool":{"name":"${name}"`)
    }
  })
})

describe('buildOllamaToolDocSection (tool_help runtime lookup)', () => {
  it('returns just the requested tool section, matching the full doc', () => {
    const section = buildOllamaToolDocSection('write_file')
    expect(section.startsWith('## write_file')).toBe(true)
    expect(section).toContain('- Required args: path, content')
    expect(section).toContain('{"taskwraith_tool":{"name":"write_file"')
    // The single-tool section is a substring of the full generated doc.
    expect(buildOllamaToolsMarkdown()).toContain(section)
    // It is targeted, not the whole 143-tool dump.
    expect(section).not.toContain('## read_file')
  })

  it('lists valid names for an unknown tool', () => {
    const section = buildOllamaToolDocSection('not_a_real_tool')
    expect(section).toContain('Unknown tool "not_a_real_tool"')
    expect(section).toContain('write_file')
  })
})
