import { describe, expect, it } from 'vitest'
import {
  canonicalTaskWraithToolName,
  normalizePortableEnsembleControlArguments,
  TASKWRAITH_MCP_TOOLS
} from './TaskWraithMcpTools'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

describe('TaskWraith MCP tool registry', () => {
  it('keeps the advertised tool catalog in lockstep with the canonical name registry', () => {
    const catalogNames = createTaskWraithMcpToolDefinitions().map((tool) => tool.name)
    expect(catalogNames).toEqual([...TASKWRAITH_MCP_TOOLS])
    expect(new Set(catalogNames).size).toBe(catalogNames.length)
  })

  it('advertises the full Boss/Captain control action surface', () => {
    const bossmanControl = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'ensemble_bossman_control'
    )
    expect(bossmanControl).toBeDefined()
    const inputSchema = bossmanControl!.inputSchema as {
      properties?: { action?: { enum?: string[] } }
    }
    const actionEnum = inputSchema.properties?.action?.enum

    expect(actionEnum).toEqual(
      expect.arrayContaining([
        'select_participants',
        'skip_intervention',
        'summon_participant',
        'assign_work',
        'set_round_plan',
        'request_status',
        'declare_decision',
        'set_review_gate',
        'quarantine_participant',
        'allocate_budget',
        'create_poll',
        'set_goal',
        'update_goal',
        'clear_goal',
        'adjust_hops',
        'ensemble_scheduled_wakeup',
        'check_quota_resets'
      ])
    )
    expect(TASKWRAITH_MCP_TOOLS).toContain('ensemble_poll_response')
  })

  it('offers a compact portable control front door without duplicating authority logic', () => {
    const portable = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'ensemble_control'
    )
    expect(portable?.inputSchema).toMatchObject({
      type: 'object',
      required: ['action'],
      additionalProperties: true,
      properties: { action: { type: 'string' }, params: { type: 'object' } }
    })
    expect(Object.keys((portable?.inputSchema?.properties || {}) as object)).toEqual([
      'action',
      'params'
    ])
    expect(canonicalTaskWraithToolName('mcp__TaskWraith__ensemble_control')).toBe(
      'ensemble_bossman_control'
    )
    expect(
      normalizePortableEnsembleControlArguments('ensemble_control', {
        action: 'set_round_plan',
        params: { goal: 'Review.' }
      })
    ).toEqual({ action: 'set_round_plan', goal: 'Review.' })
    expect(
      normalizePortableEnsembleControlArguments('ensemble_control', {
        action: 'select_participants',
        params: { participantRoles: ['Reviewer'] }
      })
    ).toEqual({ action: 'select_participants', participantRoles: ['Reviewer'] })
  })

  it('does not expose a Session Activity Ledger write path to agents', () => {
    expect(TASKWRAITH_MCP_TOOLS).not.toContain('session_activity_append' as never)
    expect(TASKWRAITH_MCP_TOOLS).not.toContain('session_activity_write' as never)
    expect(
      TASKWRAITH_MCP_TOOLS.some((name) => /session.*activity|activity.*ledger/i.test(name))
    ).toBe(false)
  })
})
