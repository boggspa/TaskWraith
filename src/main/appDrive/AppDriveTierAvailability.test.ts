import { describe, expect, it, vi } from 'vitest'

// The catalog transitively pulls in modules that read electron.app on import.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/taskwraith-test' } }))

import { DEFAULT_PERMISSION_PRESETS } from '../EffectiveRunPermissions'
import { FULL_MCP_ADVERTISE_TOOLS } from '../mcp/McpToolProfiles'
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'
import { classifyTool } from '../ToolClassTaxonomy'

/**
 * The agent-facing surface for driving a process the run started. These must
 * be reachable on their own merits — no build flag, no opt-in setting, no
 * separate rollout gate. The only things standing between an agent and this
 * feature are the posture tier, the Ensemble authority check, the host
 * capability (macOS 15.2 + daemon), and the human's own approval.
 */
const APP_DRIVE_TOOLS = ['launch_adopt', 'canvas_open_launch'] as const

describe('App Drive tier availability', () => {
  it('ships every App Drive tool in the catalogue and the FULL advertise surface', () => {
    for (const tool of APP_DRIVE_TOOLS) {
      expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
      expect(FULL_MCP_ADVERTISE_TOOLS).toContain(tool)
    }
  })

  it('is available under Accept Edits, Full WS Access, and Full Access', () => {
    // Label-checked as well as id-checked: these are the tiers the user names,
    // and the ids have been renamed underneath the labels before.
    expect(DEFAULT_PERMISSION_PRESETS.default.label).toBe('Accept Edits')
    expect(DEFAULT_PERMISSION_PRESETS.workspace_write.label).toBe('Full WS Access')
    expect(DEFAULT_PERMISSION_PRESETS.full_access.label).toBe('Full Access')

    for (const presetId of ['default', 'workspace_write', 'full_access'] as const) {
      const services = DEFAULT_PERMISSION_PRESETS[presetId].agenticServices ?? {}
      // Never a hard deny at the tier. Accept Edits deliberately leaves
      // shellCommands unset so it resolves from the user's own globals/grants
      // (prompting), which is availability — not a feature gate.
      expect(services.shellCommands ?? 'ask').not.toBe('deny')
      expect(services.canvasInteraction ?? 'ask').not.toBe('deny')
    }

    // The two tiers that mean "I have authorized in-workspace work" auto-allow
    // the shell service the adoption tool is classified under.
    expect(DEFAULT_PERMISSION_PRESETS.workspace_write.agenticServices?.shellCommands).toBe('allow')
    expect(DEFAULT_PERMISSION_PRESETS.full_access.agenticServices?.shellCommands).toBe('allow')
  })

  it('stays denied under Plan, and refused for a read-only seat', () => {
    expect(DEFAULT_PERMISSION_PRESETS.plan.agenticServices?.shellCommands).toBe('deny')
    expect(DEFAULT_PERMISSION_PRESETS.plan.agenticServices?.canvasInteraction).toBe('deny')

    // A read-only seat is blocked by the class axis rather than the tier map:
    // adoption mutates run state and is classified accordingly.
    expect(classifyTool('launch_adopt')).toBe('workspace_write')
    expect(classifyTool('launch_start')).toBe(classifyTool('launch_adopt'))
  })
})
