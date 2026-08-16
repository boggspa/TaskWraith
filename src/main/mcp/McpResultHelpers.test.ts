import { describe, expect, it } from 'vitest'
import { mcpJson } from './McpResultHelpers'

describe('mcpJson', () => {
  it('serializes successful Blackboard deletes as count-only receipts', () => {
    const deletedBody = 'large deleted post '.repeat(8_000)
    const result = JSON.parse(
      mcpJson({
        ok: true,
        tool: 'blackboard_delete',
        removed: [{ id: 'entry-1', value: deletedBody }],
        removedCount: 1,
        remainingCount: 2
      })
    )

    expect(result).toEqual({
      ok: true,
      tool: 'blackboard_delete',
      removedCount: 1,
      remainingCount: 2,
      deletedContentOmitted: true
    })
    expect(JSON.stringify(result)).not.toContain(deletedBody)
  })

  it('does not alter other MCP tool results', () => {
    const result = { ok: true, tool: 'another_tool', removed: ['meaningful-result'] }

    expect(JSON.parse(mcpJson(result))).toEqual(result)
  })
})
