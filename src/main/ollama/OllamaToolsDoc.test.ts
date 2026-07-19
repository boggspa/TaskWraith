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
import { GATEWAY_MCP_DIRECT_TOOLS } from '../mcp/McpToolProfiles'

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

  it('uses direct examples only for the compact profile and gateway examples for the tail', () => {
    const directNames = new Set<string>(GATEWAY_MCP_DIRECT_TOOLS)
    for (const name of TASKWRAITH_MCP_TOOLS) {
      expect(generated).toContain(
        directNames.has(name)
          ? `{"taskwraith_tool":{"name":"${name}"`
          : `{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"${name}"`
      )
    }
  })

  it('uses a valid catalog example for enum-discriminated Boss control calls', () => {
    const section = buildOllamaToolDocSection('ensemble_bossman_control')
    expect(section).toContain(
      '"arguments":{"action":"set_round_plan","goal":"Review."}'
    )
    expect(section).not.toContain('"action":"text"')
  })

  it('does not describe non-grantable canvas_eval as grantable', () => {
    const section = buildOllamaToolDocSection('canvas_eval')
    expect(section).toContain(
      '- Access: signed-elevated — denied under Read-Only/Plan; prompts every call and requires exact desktop review'
    )
    expect(section).not.toContain('unless granted')
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
    // It is targeted, not the whole catalogue dump.
    expect(section).not.toContain('## read_file')
  })

  it('serves a real section for a NON-advertised tail tool (the tool_help promise)', () => {
    // git_blame is deliberately NOT in the gateway direct set — the whole
    // point of tool_help is that the tail is still discoverable on demand.
    const section = buildOllamaToolDocSection('git_blame')
    expect(section.startsWith('## git_blame')).toBe(true)
    expect(section).toContain(
      '{"taskwraith_tool":{"name":"capability_invoke","arguments":{"name":"git_blame"'
    )
    expect(buildOllamaToolsMarkdown()).toContain(section)
  })

  it('lists valid names for an unknown tool', () => {
    const section = buildOllamaToolDocSection('not_a_real_tool')
    expect(section).toContain('Unknown tool "not_a_real_tool"')
    expect(section).toContain('write_file')
  })
})
