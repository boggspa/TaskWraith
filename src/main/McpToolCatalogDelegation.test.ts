import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

describe('delegate_to_subthread MCP schema', () => {
  it('advertises fresh-seat model controls and marks them spawn-only', () => {
    const definition = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'delegate_to_subthread'
    )
    const schema = definition?.inputSchema as
      | { properties?: Record<string, { description?: string; enum?: string[] }> }
      | undefined
    const properties = schema?.properties

    expect(properties?.model?.description).toMatch(/spawn-only/i)
    expect(properties?.model?.description).toMatch(/omit.*recall/i)
    expect(properties?.reasoningEffort?.enum).toEqual(
      expect.arrayContaining(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    )
    expect(properties?.reasoningEffort?.description).toMatch(/codex.*claude.*grok.*cursor/i)
    expect(properties?.kimiThinking?.description).toMatch(/kimi/i)
    expect(properties?.subThreadId?.description).toMatch(/inherits.*model.*controls/i)
  })
})
