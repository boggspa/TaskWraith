import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../shared/ensembleLimits'

describe('agent-authored Ensemble roster MCP schema', () => {
  it('advertises the canonical preset import on the existing roster tool', () => {
    const definitions = createTaskWraithMcpToolDefinitions()
    const rosterEdit = definitions.find((tool) => tool.name === 'ensemble_roster_edit')
    const rosterSchema = rosterEdit?.inputSchema as
      | {
          properties?: Record<
            string,
            { type?: string; enum?: string[]; maxLength?: number; description?: string }
          >
        }
      | undefined
    const properties = rosterSchema?.properties

    expect(properties?.action?.enum).toContain('import_preset')
    expect(properties?.action?.enum).toContain('register_in_agent_pool')
    expect(properties?.path?.type).toBe('string')
    expect(properties?.json).toMatchObject({ type: 'string', maxLength: 1_000_000 })
    expect(properties?.preset?.type).toBe('object')
    const presetSchema = properties?.preset as
      | {
          description?: string
          properties?: {
            participants?: { maxItems?: number }
          }
        }
      | undefined
    expect(presetSchema?.description).toContain(
      `maxParticipants defaults to ${MAX_ENSEMBLE_PARTICIPANTS}`
    )
    expect(presetSchema?.properties?.participants?.maxItems).toBe(MAX_ENSEMBLE_PARTICIPANTS)
    expect(properties?.apply?.type).toBe('boolean')
    expect(rosterEdit?.description).toMatch(/single-provider chat/i)
    expect(rosterEdit?.description).toMatch(/do not call shell, file, or time tools/i)
    expect(rosterEdit?.description).toMatch(/role max 50 chars/i)
  })

  it('makes the discovery tool usable as the setup and quota-selection preflight', () => {
    const list = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'list_ensemble_participants'
    )

    expect(list?.description).toMatch(/single-provider or Ensemble/i)
    expect(list?.description).toMatch(/provider\/model\/reasoning catalog/i)
    expect(list?.description).toMatch(/canonical TaskWraith roster-export JSON contract/i)
  })
})
