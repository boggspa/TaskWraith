import { describe, expect, it } from 'vitest'
import { EMULATOR_BUTTONS } from '../shared/emulatorCanvas'
import { EMULATOR_MCP_TOOL_NAMES, TASKWRAITH_MCP_TOOLS } from '../shared/taskWraithMcpCatalog'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

describe('packaged emulator MCP catalog definitions', () => {
  it('registers exactly the fixed open, safe observe, and bounded step surface', () => {
    expect(EMULATOR_MCP_TOOL_NAMES).toEqual(['emulator_open', 'emulator_observe', 'emulator_step'])
    for (const toolName of EMULATOR_MCP_TOOL_NAMES) {
      expect(TASKWRAITH_MCP_TOOLS).toContain(toolName)
    }

    const definitions = createTaskWraithMcpToolDefinitions()
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    const open = byName.get('emulator_open')
    const observe = byName.get('emulator_observe')
    const step = byName.get('emulator_step')
    expect(open?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false
    })
    expect(open?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false })
    expect(observe?.inputSchema).toMatchObject({
      type: 'object',
      required: ['canvasId'],
      additionalProperties: false,
      properties: { canvasId: { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } }
    })
    expect(observe?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
    expect(step?.inputSchema).toMatchObject({
      type: 'object',
      required: ['canvasId', 'expectedObservationId', 'segments'],
      additionalProperties: false,
      properties: {
        canvasId: { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
        expectedObservationId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
        },
        segments: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            properties: {
              buttons: { uniqueItems: true, items: { enum: EMULATOR_BUTTONS } },
              frames: { type: 'integer', minimum: 1, maximum: 120 }
            },
            required: ['buttons', 'frames'],
            additionalProperties: false
          }
        }
      }
    })
    expect(step?.description).toContain('outcome, executed, partial, and framesCompleted')
  })
})
