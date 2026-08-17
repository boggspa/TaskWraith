import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

function tool(name: 'blackboard_post' | 'ensemble_poll_response') {
  const definition = createTaskWraithMcpToolDefinitions().find(
    (candidate) => candidate.name === name
  )
  if (!definition) throw new Error(`${name} missing from the catalogue`)
  return definition
}

describe('Blackboard quota and poll MCP schema', () => {
  it('advertises the 8,000-character value cap and bounded plain-text poll options', () => {
    const schema = tool('blackboard_post').inputSchema as {
      properties?: {
        key?: { maxLength?: number }
        value?: { maxLength?: number }
        pollOptions?: {
          type?: string
          minItems?: number
          maxItems?: number
          items?: { type?: string; minLength?: number; maxLength?: number }
        }
        ttlMinutes?: { type?: string; minimum?: number; maximum?: number }
        attachmentIds?: { type?: string; maxItems?: number }
        workspaceImagePaths?: { type?: string; maxItems?: number }
      }
    }

    expect(schema.properties?.key?.maxLength).toBe(80)
    expect(schema.properties?.value?.maxLength).toBe(8_000)
    expect(schema.properties?.pollOptions).toMatchObject({
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: { type: 'string', minLength: 1, maxLength: 160 }
    })
    expect(schema.properties?.ttlMinutes).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10_080,
      description:
        'Optional self-delete delay in whole minutes. Defaults to 1440 (24 hours) if omitted. Pass null for no time expiry.'
    })
    expect(tool('blackboard_post').description).toMatch(/ensemble_poll_response/i)
    expect(tool('blackboard_post').description).toMatch(/replaced, retired, or expired/i)
    expect(schema.properties?.attachmentIds).toMatchObject({ type: 'array', maxItems: 4 })
    expect(schema.properties?.workspaceImagePaths).toMatchObject({ type: 'array', maxItems: 4 })
  })

  it('reuses the existing ensemble response tool with the Blackboard entry id', () => {
    expect(tool('ensemble_poll_response').description).toMatch(/Blackboard/i)
    expect(tool('ensemble_poll_response').description).toMatch(/entry id as pollId/i)
  })
})
