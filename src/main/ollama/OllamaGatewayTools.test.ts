import { describe, expect, it } from 'vitest'
import { CAPABILITY_GATEWAY_TOOL_NAMES } from '../mcp/McpToolGateway'
import {
  OLLAMA_TOOL_HELP_NAME,
  buildOllamaOpeningMessages,
  normalizeOllamaNativeToolCall,
  ollamaNativeToolDefinitions,
  ollamaToolCallFormatSchema,
  parseOllamaToolRequest,
  validateOllamaToolArguments
} from './OllamaProvider'
import { ollamaAdvertisedToolNames } from './OllamaToolTiers'

describe('Ollama capability gateway exposure', () => {
  it('advertises both gateway functions with exact bounded schemas', () => {
    const definitions = ollamaNativeToolDefinitions('provider_parity')
    const names = definitions.map((definition) => definition.function.name)
    const direct = ollamaAdvertisedToolNames()
    expect(names.slice(0, direct.length)).toEqual([...direct])
    expect(names).toHaveLength(direct.length + 3)
    expect(names).toEqual(expect.arrayContaining([...CAPABILITY_GATEWAY_TOOL_NAMES]))

    const search = definitions.find(
      (definition) => definition.function.name === 'capability_search'
    )
    expect(search?.function.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 240 },
        limit: { type: 'integer', minimum: 1, maximum: 6 }
      }
    })

    const invoke = definitions.find(
      (definition) => definition.function.name === 'capability_invoke'
    )
    expect(invoke?.function.parameters).toMatchObject({
      type: 'object',
      required: ['name', 'arguments'],
      properties: {
        name: { type: 'string' },
        arguments: { type: 'object' }
      }
    })
  })

  it('keeps the legacy tool_help definition available after the gateway tools', () => {
    const definitions = ollamaNativeToolDefinitions('provider_parity')
    const names = definitions.map((definition) => definition.function.name)
    expect(names).toContain(OLLAMA_TOOL_HELP_NAME)
    expect(names.indexOf(OLLAMA_TOOL_HELP_NAME)).toBeGreaterThan(names.indexOf('capability_invoke'))
    expect(
      definitions.find((definition) => definition.function.name === OLLAMA_TOOL_HELP_NAME)
    ).toMatchObject({
      function: {
        parameters: { properties: { name: { type: 'string' } } }
      }
    })
  })

  it('keeps gateway discovery available to a read-only local seat', () => {
    const names = ollamaNativeToolDefinitions('read_only', { readOnly: true }).map(
      (definition) => definition.function.name
    )
    expect(names).toEqual([
      ...ollamaAdvertisedToolNames({ readOnly: true }),
      ...CAPABILITY_GATEWAY_TOOL_NAMES,
      OLLAMA_TOOL_HELP_NAME
    ])
  })

  it('advertises Sketch mutation to Plan while keeping general writes out', () => {
    const definitions = ollamaNativeToolDefinitions('read_only', {
      readOnly: true,
      plan: true
    })
    const names = definitions.map((definition) => definition.function.name)
    expect(names).toContain('canvas_sketch_open')
    expect(names).toContain('canvas_sketch_get')
    expect(names).toContain('canvas_sketch_update')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('run_shell_command')
    expect(
      definitions.find((definition) => definition.function.name === 'canvas_sketch_update')
        ?.function.parameters
    ).toMatchObject({
      required: ['canvasId'],
      properties: {
        canvasId: { type: 'string' },
        mode: { enum: ['append', 'replace', 'clear', 'delete'] },
        elements: {
          type: 'array',
          items: {
            properties: {
              kind: { enum: ['rect', 'ellipse', 'line', 'arrow', 'text', 'path'] }
            },
            required: ['kind']
          }
        }
      }
    })
  })

  it('keeps Sketch behind discovery for a pinned v7 native-tool receipt', () => {
    const names = ollamaNativeToolDefinitions('provider_parity', {
      taskWraithMcpProfileId: 'taskwraith-gateway-v7'
    }).map((definition) => definition.function.name)
    expect(names).not.toContain('canvas_sketch_open')
    expect(names).not.toContain('canvas_sketch_get')
    expect(names).not.toContain('canvas_sketch_update')
    expect(names).toEqual(expect.arrayContaining([...CAPABILITY_GATEWAY_TOOL_NAMES]))
  })

  it.each([
    ['capability_search', { query: 'trim video', limit: 2 }],
    ['capability_invoke', { name: 'video_thumbnail', arguments: { inputPath: 'clip.mov' } }],
    [OLLAMA_TOOL_HELP_NAME, { name: 'video_thumbnail' }]
  ] as const)('accepts %s through the JSON fallback protocol', (name, args) => {
    expect(
      parseOllamaToolRequest(JSON.stringify({ taskwraith_tool: { name, arguments: args } }))
    ).toEqual({ toolName: name, arguments: args })
  })

  it.each([
    ['capability_search', { query: 'inspect media' }],
    ['capability_invoke', { name: 'inspect_chat_attachment', arguments: { ref: 'attachment-1' } }],
    [OLLAMA_TOOL_HELP_NAME, { name: 'inspect_chat_attachment' }]
  ] as const)('accepts %s through native Ollama tool calls', (name, args) => {
    expect(normalizeOllamaNativeToolCall({ function: { name, arguments: args } })).toEqual({
      toolName: name,
      arguments: args
    })
  })

  it('includes gateway names without removing tool_help from constrained decoding', () => {
    const names = ['read_file', ...CAPABILITY_GATEWAY_TOOL_NAMES, OLLAMA_TOOL_HELP_NAME]
    const schema = ollamaToolCallFormatSchema(names) as {
      properties: {
        taskwraith_tool: { properties: { name: { enum: string[] } } }
      }
    }
    expect(schema.properties.taskwraith_tool.properties.name.enum).toEqual(names)
  })

  it('teaches JSON-only local models both gateway call shapes while retaining tool_help', () => {
    const messages = buildOllamaOpeningMessages({
      toolProtocolEnabled: true,
      harnessEnabled: false,
      promptIntent: 'workspace',
      toolControlTier: 'provider_parity',
      model: 'qwen3:latest',
      workspaceIndexBlock: '',
      userPrompt: 'Inspect the clip.'
    })
    const system = messages.find((message) => message.role === 'system')?.content || ''
    expect(system).toContain('capability_search')
    expect(system).toContain('capability_invoke')
    expect(system).toContain(OLLAMA_TOOL_HELP_NAME)
    expect(system).toContain('"name":"exact_tool_name"')
  })

  it('leaves pre-execution compatibility validation open for virtual tools', () => {
    expect(validateOllamaToolArguments('capability_search', { query: 'video' })).toEqual({
      ok: true
    })
    expect(
      validateOllamaToolArguments('capability_invoke', {
        name: 'video_thumbnail',
        arguments: {}
      })
    ).toEqual({ ok: true })
    expect(validateOllamaToolArguments(OLLAMA_TOOL_HELP_NAME, { name: '' })).toEqual({ ok: true })
  })
})
