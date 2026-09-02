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
import { GATEWAY_V9_MCP_DIRECT_TOOLS } from '../mcp/McpToolProfiles'
import { validateEmulatorStepToolInput } from '../../shared/emulatorCanvas'

const TOOLS_MD = resolve(__dirname, '../../../resources/Tools.md')
const generated = buildOllamaToolsMarkdown()

function onDiskToolSection(name: string): string {
  const onDisk = readFileSync(TOOLS_MD, 'utf8')
  const start = onDisk.indexOf(`## ${name}\n`)
  if (start < 0) return ''
  const next = onDisk.indexOf('\n## ', start + 1)
  return onDisk.slice(start, next < 0 ? undefined : next).trimEnd()
}

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
    const directNames = new Set<string>(GATEWAY_V9_MCP_DIRECT_TOOLS)
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
    expect(section).toContain('"arguments":{"action":"set_round_plan","planSummary":"Review."}')
    expect(section).not.toContain('"action":"text"')
  })

  it('describes the exact-live-surface canvas_eval window without a per-call promise', () => {
    const section = buildOllamaToolDocSection('canvas_eval')
    expect(section).toContain(
      '- Access: surface-window gated — denied under Plan; first permitted eval on each live Canvas surface requires exact desktop review, then same-surface evals auto-approve for 12 hours across navigation and later turns'
    )
    expect(section).toContain('Other Canvas surfaces are not covered')
    expect(section).not.toContain('PROMPTS EVERY CALL')
    expect(section).not.toContain('prompts every permitted call')
    expect(section).not.toContain('unless granted')
  })

  it('describes permission retry as elicitation rather than a pre-existing grant', () => {
    const section = buildOllamaToolDocSection('request_tool_permission')
    expect(section).toContain(
      '- Access: permission elicitation — callable under Ask/Plan; the exact target runs only after one-shot user approval and all non-grantable guards still apply'
    )
    expect(section).not.toContain('denied under Plan, prompts under Ask')
  })

  it.each(['canvas_screenshot', 'emulator_observe'])(
    'keeps %s pixel egress governed rather than auto-allowed',
    (name) => {
      const section = buildOllamaToolDocSection(name)
      expect(section).toContain(
        '- Access: pixel egress — governed by your run permission role; capture is not auto-allowed merely because it is read-only'
      )
      expect(section).not.toContain('- Access: read-only (no approval needed)')
    }
  )

  it('uses a shared-valid example for the bounded emulator step macro', () => {
    const section = buildOllamaToolDocSection('emulator_step')
    const match = section.match(/- Example: `(\{.+\})`/)
    expect(match?.[1]).toBeDefined()
    const example = JSON.parse(match?.[1] ?? '{}') as {
      taskwraith_tool?: { arguments?: { name?: string; arguments?: unknown } }
    }
    const arguments_ = example.taskwraith_tool?.arguments
    expect(arguments_?.name).toBe('emulator_step')
    expect(arguments_?.arguments).toEqual({
      canvasId: 'canvas-demo-1',
      expectedObservationId: 'observation-1',
      segments: [{ buttons: ['right'], frames: 1 }]
    })
    expect(validateEmulatorStepToolInput(arguments_?.arguments).ok).toBe(true)
  })

  it.each(['mesh_scene_create', 'mesh_scene_list', 'mesh_topology_inspect', 'mesh_topology_edit'])(
    'documents the five-tier Mesh Canvas approval ladder for %s',
    (name) => {
      const section = buildOllamaToolDocSection(name)
      expect(section).toContain(
        '- Access: Mesh Canvas — per-call approval under Ask and Plan; automatic under Accept Edits, Full WS Access, and Full Access unless Mesh Canvas is globally denied'
      )
      expect(section).not.toContain('denied under Plan')
      expect(section).not.toContain('prompts under Accept Edits')
    }
  )

  it.each([
    'canvas_screenshot',
    'canvas_eval',
    'emulator_open',
    'emulator_observe',
    'emulator_step'
  ])('keeps the focused %s resource section in sync with the catalog', (name) => {
    expect(onDiskToolSection(name)).toBe(buildOllamaToolDocSection(name))
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

  it('keeps the retry schema hidden from gateway-v8 help and visible to gateway-v9', () => {
    const v8List = buildOllamaToolDocSection('', 'taskwraith-gateway-v8')
    const v8Lookup = buildOllamaToolDocSection('request_tool_permission', 'taskwraith-gateway-v8')
    const v9List = buildOllamaToolDocSection('', 'taskwraith-gateway-v9')
    const v9Lookup = buildOllamaToolDocSection('request_tool_permission', 'taskwraith-gateway-v9')

    expect(v8List).not.toContain('request_tool_permission')
    expect(v8Lookup).toContain('Unknown tool "request_tool_permission"')
    expect(v8Lookup).not.toContain('## request_tool_permission')
    expect(v9List).toContain('request_tool_permission')
    expect(v9Lookup).toContain('## request_tool_permission')
  })

  it('keeps emulator help absent from v18 and discoverable from v19 successors', () => {
    const v18 = buildOllamaToolDocSection('', 'taskwraith-gateway-v18')
    const v19 = buildOllamaToolDocSection('', 'taskwraith-gateway-v19')
    const soloV3 = buildOllamaToolDocSection('', 'taskwraith-gateway-solo-v3')
    const fullV3 = buildOllamaToolDocSection('', 'taskwraith-full-v3')
    for (const toolName of ['emulator_open', 'emulator_observe', 'emulator_step']) {
      expect(v18).not.toContain(toolName)
      expect(v19).toContain(toolName)
      expect(soloV3).toContain(toolName)
      expect(fullV3).toContain(toolName)
      expect(buildOllamaToolDocSection(toolName, 'taskwraith-gateway-v18')).toContain(
        `Unknown tool "${toolName}"`
      )
      expect(buildOllamaToolDocSection(toolName, 'taskwraith-gateway-v19')).toContain(
        `## ${toolName}`
      )
      expect(buildOllamaToolDocSection(toolName, 'taskwraith-full-v3')).toContain(`## ${toolName}`)
    }
  })
})
