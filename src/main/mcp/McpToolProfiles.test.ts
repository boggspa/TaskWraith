import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { AUDIT_MCP_TOOL_NAMES } from './AuditToolExecutors'
import { gatewayToolDefinitions } from './McpToolGateway'
import {
  CAPABILITY_GATEWAY_TOOL_NAMES,
  CORE_MCP_ADVERTISE_TOOLS,
  CORE_MCP_TOOL_BUDGET,
  FULL_MCP_ADVERTISE_TOOLS,
  GATEWAY_MCP_ADVERTISE_TOOLS,
  GATEWAY_MCP_DIRECT_TOOLS,
  isCoreMcpAdvertisedTool,
  isGatewayMcpAdvertisedTool,
  taskWraithMcpAdvertisedToolNamesForProfile,
  shouldUseCoreMcpProfile
} from './McpToolProfiles'

function nameHash(names: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(names)).digest('hex')
}

describe('immutable v1 MCP profile snapshots', () => {
  it('freezes every exported membership array at runtime', () => {
    for (const profile of [
      FULL_MCP_ADVERTISE_TOOLS,
      CORE_MCP_ADVERTISE_TOOLS,
      GATEWAY_MCP_DIRECT_TOOLS,
      GATEWAY_MCP_ADVERTISE_TOOLS
    ]) {
      expect(Object.isFrozen(profile)).toBe(true)
    }
  })

  it('pins full-v1 to the exact historical 155-tool surface', () => {
    expect(FULL_MCP_ADVERTISE_TOOLS).toHaveLength(155)
    expect(nameHash(FULL_MCP_ADVERTISE_TOOLS)).toBe(
      '61493913c017c0d37a2f1bd212f971e8c11b4edf747ef03acf58c1d538f5bc73'
    )
    for (const tool of FULL_MCP_ADVERTISE_TOOLS) expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-full-v1')).toBe(
      FULL_MCP_ADVERTISE_TOOLS
    )
  })

  it('pins core-v1 to the exact historical 60-tool surface', () => {
    expect(CORE_MCP_ADVERTISE_TOOLS).toHaveLength(60)
    expect(nameHash(CORE_MCP_ADVERTISE_TOOLS)).toBe(
      'ba91357b3c1c8097a94527777c5f6e8a71de953da828486c2acd15484d15acac'
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-core-v1')).toBe(
      CORE_MCP_ADVERTISE_TOOLS
    )
  })
})

describe('GATEWAY_MCP_ADVERTISE_TOOLS', () => {
  it('exposes 38 common tools plus only the two virtual gateway tools', () => {
    expect(GATEWAY_MCP_DIRECT_TOOLS).toHaveLength(38)
    expect(GATEWAY_MCP_ADVERTISE_TOOLS).toHaveLength(40)
    expect(new Set(GATEWAY_MCP_ADVERTISE_TOOLS).size).toBe(GATEWAY_MCP_ADVERTISE_TOOLS.length)
    for (const tool of GATEWAY_MCP_DIRECT_TOOLS) expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
    expect(GATEWAY_MCP_ADVERTISE_TOOLS.slice(-2)).toEqual(CAPABILITY_GATEWAY_TOOL_NAMES)
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v1')).toBe(
      GATEWAY_MCP_ADVERTISE_TOOLS
    )
  })

  it('keeps coding, user-decision, goal, delegation, and ensemble controls direct', () => {
    for (const tool of [
      'run_shell_command',
      'read_file',
      'write_file',
      'workspace_search',
      'apply_patch',
      'git_status',
      'git_commit',
      'ask_user_question',
      'update_goal',
      'goal_complete',
      'goal_blocked',
      'todo_write',
      'delegate_to_subthread',
      'ensemble_yield',
      'ensemble_fanout',
      'ensemble_bossman_control',
      'ensemble_roster_edit',
      'schedule_wakeup',
      'cancel_wakeup',
      'blackboard_read',
      'capability_search',
      'capability_invoke'
    ]) {
      expect(isGatewayMcpAdvertisedTool(tool)).toBe(true)
    }
  })

  it('moves specialized and less frequent families behind discovery', () => {
    for (const tool of [
      'git_push',
      'browser_open',
      'canvas_eval',
      'appwatch_start',
      'open_in_ide',
      'tw_recall_find',
      'tw_introspection_run',
      'creative_blender_python',
      'image_generate',
      'video_encode_clip'
    ]) {
      expect(isGatewayMcpAdvertisedTool(tool)).toBe(false)
      expect(FULL_MCP_ADVERTISE_TOOLS).toContain(tool)
    }
  })

  it('keeps the serialized fresh-session catalogue below the agreed size budget', () => {
    const definitions = createTaskWraithMcpToolDefinitions()
    const serializedChars = (names: readonly string[], extras: unknown[] = []) =>
      JSON.stringify({
        tools: [
          ...definitions.filter((definition) => names.includes(definition.name)),
          ...extras
        ]
      }).length
    const fullChars = serializedChars(FULL_MCP_ADVERTISE_TOOLS)
    const gatewayChars = serializedChars(GATEWAY_MCP_DIRECT_TOOLS, gatewayToolDefinitions())

    expect(fullChars).toBe(128_000)
    expect(gatewayChars).toBe(36_378)
    expect(gatewayChars).toBeLessThan(40_000)
    expect(gatewayChars / fullChars).toBeLessThan(0.3)
  })
})

describe('CORE_MCP_ADVERTISE_TOOLS', () => {
  it('stays inside the constrained-model budget with no duplicates or unknown tools', () => {
    expect(CORE_MCP_ADVERTISE_TOOLS.length).toBeLessThanOrEqual(CORE_MCP_TOOL_BUDGET)
    expect(new Set(CORE_MCP_ADVERTISE_TOOLS).size).toBe(CORE_MCP_ADVERTISE_TOOLS.length)
    for (const tool of CORE_MCP_ADVERTISE_TOOLS) {
      expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
    }
    // Run-scoped audit tools are appended after profile filtering. Keep the
    // TaskWraith-owned total at 64 or below so external servers retain headroom.
    expect(CORE_MCP_ADVERTISE_TOOLS.length + AUDIT_MCP_TOOL_NAMES.length).toBeLessThanOrEqual(64)
  })

  it('keeps the general coding, approval, and orchestration floor', () => {
    for (const tool of [
      'run_shell_command',
      'write_file',
      'read_file',
      'workspace_search',
      'apply_patch',
      'git_status',
      'git_commit',
      'run_task',
      'ask_user_question',
      'update_goal',
      'goal_complete',
      'goal_blocked',
      'todo_write',
      'delegate_to_subthread',
      'ensemble_yield',
      'ensemble_bossman_control',
      'ensemble_roster_edit',
      'ensemble_brief_update',
      'blackboard_delete'
    ]) {
      expect(isCoreMcpAdvertisedTool(tool)).toBe(true)
    }
  })

  it('keeps long-horizon coordination and every Boss/Captain control tool', () => {
    for (const tool of ['ensemble_poll_response', 'schedule_wakeup', 'cancel_wakeup']) {
      expect(isCoreMcpAdvertisedTool(tool)).toBe(true)
    }

    for (const tool of [
      'ensemble_fanout',
      'ensemble_bossman_control',
      'ensemble_roster_edit',
      'ensemble_brief_update',
      'list_ensemble_participants'
    ]) {
      expect(isCoreMcpAdvertisedTool(tool)).toBe(true)
    }
  })

  it('leaves specialized families on the full profile', () => {
    for (const tool of [
      'canvas_eval',
      'canvas_screenshot',
      'creative_blender_python',
      'tw_introspection_run',
      'image_generate',
      'transcode_video'
    ]) {
      expect(isCoreMcpAdvertisedTool(tool)).toBe(false)
    }
  })
})

describe('shouldUseCoreMcpProfile', () => {
  it('constrains Cursor Grok 4.5 while leaving Composer 2.5 on the full profile', () => {
    expect(shouldUseCoreMcpProfile('cursor', 'grok-4.5')).toBe(true)
    expect(shouldUseCoreMcpProfile('cursor', 'grok-4.5-fast-xhigh')).toBe(true)
    expect(shouldUseCoreMcpProfile('cursor', 'composer-2.5-fast')).toBe(false)
  })

  it('constrains standalone Grok 4.5 aliases while leaving Grok Composer full', () => {
    expect(shouldUseCoreMcpProfile('grok', undefined)).toBe(true)
    expect(shouldUseCoreMcpProfile('grok', 'grok-4.5')).toBe(true)
    expect(shouldUseCoreMcpProfile('grok', 'grok-4.5-latest')).toBe(true)
    expect(shouldUseCoreMcpProfile('grok', 'grok-4.5-fast-xhigh')).toBe(true)
    expect(shouldUseCoreMcpProfile('grok', 'grok-composer-2.5-fast')).toBe(false)
  })

  it('never constrains unrelated providers', () => {
    expect(shouldUseCoreMcpProfile('codex', 'grok-4.5')).toBe(false)
    expect(shouldUseCoreMcpProfile('claude', 'grok-4.5')).toBe(false)
  })
})
