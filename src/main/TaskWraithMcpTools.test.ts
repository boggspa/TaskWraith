import { describe, expect, it } from 'vitest'
import { TASKWRAITH_MCP_TOOLS } from './TaskWraithMcpTools'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

describe('TaskWraith MCP tool registry', () => {
  it('keeps the advertised tool catalog in lockstep with the canonical name registry', () => {
    const catalogNames = createTaskWraithMcpToolDefinitions().map((tool) => tool.name)
    expect(catalogNames).toEqual([...TASKWRAITH_MCP_TOOLS])
    expect(new Set(catalogNames).size).toBe(catalogNames.length)
  })

  it('gives ensemble_continue DONE/BLOCK guidance with anti-examples', () => {
    const ensembleContinue = createTaskWraithMcpToolDefinitions().find(
      (tool) => tool.name === 'ensemble_continue'
    )
    expect(ensembleContinue).toBeDefined()
    const description = ensembleContinue?.description ?? ''
    expect(description).toContain('`complete` only when the task is fully done and verified')
    expect(description).toContain('`blocked` only when you are genuinely stuck')
    expect(description).toContain('a test you can fix is not a block')
    expect(description).toContain('a recoverable error')
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

  it('does not expose a Session Activity Ledger write path to agents', () => {
    expect(TASKWRAITH_MCP_TOOLS).not.toContain('session_activity_append' as never)
    expect(TASKWRAITH_MCP_TOOLS).not.toContain('session_activity_write' as never)
    expect(
      TASKWRAITH_MCP_TOOLS.some((name) => /session.*activity|activity.*ledger/i.test(name))
    ).toBe(false)
  })
})
