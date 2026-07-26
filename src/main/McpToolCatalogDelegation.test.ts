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
    // Path-B Cursor is a live selectable seat; parents may spawn/recall a Cursor
    // child, and a broker-active Cursor parent can use this same governed tool.
    expect(properties?.provider?.enum).toContain('cursor')
    expect(properties?.reasoningEffort?.description).toMatch(/codex.*claude.*kimi.*grok/i)
    expect(properties?.kimiThinking?.description).toMatch(/kimi/i)
    expect(properties?.subThreadId?.description).toMatch(/inherits.*model.*controls/i)
    expect(properties?.subThreadId?.description).toMatch(/active child.*durably queued/i)
    expect(properties?.subThreadId?.description).not.toMatch(/unarchived and idle/i)
    expect(properties?.returnResult?.description).toMatch(/typed terminal result/i)
    expect(definition?.description).toMatch(/subject to current runtime admission/i)
    expect(definition?.description).toMatch(/done\/requires_action\/failed\/cancelled/i)
  })

  it('documents cancellation of queued recalls as well as a live child run', () => {
    const definition = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'cancel_subthread'
    )

    expect(definition?.description).toMatch(/queued recalled follow-ups/i)
    expect(definition?.description).toMatch(/active run/i)
  })
})
