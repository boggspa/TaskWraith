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
  GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V3_ADDED_TOOL_NAMES,
  GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES,
  ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME,
  PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME,
  isCoreMcpAdvertisedTool,
  isGatewayMcpAdvertisedTool,
  taskWraithGatewayHiddenToolNamesForProfile,
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
      GATEWAY_MCP_ADVERTISE_TOOLS,
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES
    ]) {
      expect(Object.isFrozen(profile)).toBe(true)
    }
  })

  it('pins full-v1 to the exact historical 155-tool surface', () => {
    // 2026-07-24: ensemble_continue removed with the Work Session surface
    // (fb88667b1) — 156 → 155.
    expect(FULL_MCP_ADVERTISE_TOOLS).toHaveLength(155)
    expect(nameHash(FULL_MCP_ADVERTISE_TOOLS)).toBe(
      'eec0885ba65addda9da1861a580fbb76795177d604bbd3e6a8bab26a3f5a27e2'
    )
    for (const tool of FULL_MCP_ADVERTISE_TOOLS) expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-full-v1')).toBe(
      FULL_MCP_ADVERTISE_TOOLS
    )
  })

  it('pins core-v1 to the exact historical 59-tool surface', () => {
    // 2026-07-24: ensemble_continue removed with the Work Session surface — 60 → 59.
    expect(CORE_MCP_ADVERTISE_TOOLS).toHaveLength(59)
    expect(nameHash(CORE_MCP_ADVERTISE_TOOLS)).toBe(
      '6d79f189158dcfe01de46bcd127f4fcfc00aaae8dd10ad087b9a44e32bc2951d'
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-core-v1')).toBe(
      CORE_MCP_ADVERTISE_TOOLS
    )
  })
})

describe('GATEWAY_MCP_ADVERTISE_TOOLS', () => {
  it('exposes 38 common tools plus only the two virtual gateway tools', () => {
    // 2026-07-24: ensemble_continue removed with the Work Session surface — 39 → 38.
    expect(GATEWAY_MCP_DIRECT_TOOLS).toHaveLength(38)
    expect(nameHash(GATEWAY_MCP_DIRECT_TOOLS)).toBe(
      'fcef130fd16ef9a7ad8080acae866c9ab8fa2b1b20ce8425f9a6ca534dfbbd2d'
    )
    expect(GATEWAY_MCP_ADVERTISE_TOOLS).toHaveLength(40)
    expect(new Set(GATEWAY_MCP_ADVERTISE_TOOLS).size).toBe(GATEWAY_MCP_ADVERTISE_TOOLS.length)
    for (const tool of GATEWAY_MCP_DIRECT_TOOLS) expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
    expect(GATEWAY_MCP_ADVERTISE_TOOLS.slice(-2)).toEqual(CAPABILITY_GATEWAY_TOOL_NAMES)
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v1')).toBe(
      GATEWAY_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v2')).toBe(
      GATEWAY_MCP_ADVERTISE_TOOLS
    )
  })

  it('keeps gateway-v1 hidden membership exact while v2 adds only the proposal tool', () => {
    expect(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES).toHaveLength(117)
    expect(nameHash(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES)).toBe(
      'bd9d9e82bb1da79b1c1c8ae4613548d92310e294e9fa28d55c628e7f3db01c52'
    )
    expect(new Set(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES).size).toBe(
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES.length
    )
    expect(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES).not.toContain(
      PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME
    )
    expect(GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES,
      PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME,
      ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME
    ])
    expect(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES).not.toContain(
      ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME
    )
    expect(
      createTaskWraithMcpToolDefinitions().filter(
        (definition) => definition.name === PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME
      )
    ).toHaveLength(1)
    expect(
      createTaskWraithMcpToolDefinitions().filter(
        (definition) => definition.name === ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME
      )
    ).toHaveLength(1)
  })

  it('resolves an absent gateway generation conservatively to v1', () => {
    expect(taskWraithGatewayHiddenToolNamesForProfile(undefined)).toBe(
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile(null)).toBe(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES)
    expect(taskWraithGatewayHiddenToolNamesForProfile('unknown-profile' as never)).toBe(
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v1')).toBe(
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v2')).toBe(
      GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES
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
        tools: [...definitions.filter((definition) => names.includes(definition.name)), ...extras]
      }).length
    const fullChars = serializedChars(FULL_MCP_ADVERTISE_TOOLS)
    const gatewayChars = serializedChars(GATEWAY_MCP_DIRECT_TOOLS, gatewayToolDefinitions())

    // Measured 2026-07-19 baseline after correcting delegation's advertised
    // runtime-admission, active-recall queueing, and typed-terminal semantics.
    // Keep the exact values review-sensitive; the 40k gateway limit below is
    // the transport contract.
    // Measured after Path-B Cursor re-entry into live selectable / delegate enums,
    // then the bounded Blackboard poll schema and lifecycle guidance.
    // Re-measured 2026-07-24 after the Work Session removal dropped the
    // ensemble_continue schema from both catalogues.
    expect(fullChars).toBe(131_178)
    expect(gatewayChars).toBe(38_724)
    expect(gatewayChars).toBeLessThan(40_000)
    expect(gatewayChars / fullChars).toBeLessThan(0.301)
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

describe('ensemble_propose_goal_complete reachability (O3 M3)', () => {
  it('is registered, defined, and advertised to gateway + full seats', () => {
    // Captain gate #5 / A3 #2: catalog-only is unreachable (the lived HelperKimi
    // "tool not available in this MCP context" failure). Assert the peer-open tool
    // is in the canonical registry, has a schema definition, and reaches the
    // gateway + full profiles seats actually receive.
    expect(TASKWRAITH_MCP_TOOLS).toContain('ensemble_propose_goal_complete')
    const definitions = createTaskWraithMcpToolDefinitions()
    expect(definitions.some((d) => d.name === 'ensemble_propose_goal_complete')).toBe(true)
    expect(isGatewayMcpAdvertisedTool('ensemble_propose_goal_complete')).toBe(true)
    expect(FULL_MCP_ADVERTISE_TOOLS).toContain('ensemble_propose_goal_complete')
    // KNOWN GAP (escalated to Design/Captain): NOT in the 60-tool CORE budget yet.
    // Constrained (Cursor/Grok) seats on the core profile can't propose until the
    // CORE_MCP_TOOL_BUDGET decision (bump vs evict) lands. See slice-2 disposition.
    expect(isCoreMcpAdvertisedTool('ensemble_propose_goal_complete')).toBe(false)
  })
})

describe('catalogue reachability', () => {
  it('leaves no canonical tool reachable from zero profiles', () => {
    // A tool absent from every profile is implemented, gated, documented, and
    // callable by nobody: Claude sees only its profile's advertised list, and
    // gateway discovery/invocation is bounded by the pinned hidden universe.
    // Eight tools shipped that way (six Outlook, two document) before this
    // test existed — nothing failed, which is exactly the problem.
    const reachable = new Set<string>([
      ...FULL_MCP_ADVERTISE_TOOLS,
      ...CORE_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES
    ])
    const orphans = (TASKWRAITH_MCP_TOOLS as readonly string[]).filter(
      (name) => !reachable.has(name)
    )
    expect(orphans).toEqual([])
  })

  it('grows the newest gateway generation rather than mutating a frozen one', () => {
    expect(GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V3_ADDED_TOOL_NAMES
    ])
    for (const tool of GATEWAY_V3_ADDED_TOOL_NAMES) {
      expect(TASKWRAITH_MCP_TOOLS).toContain(tool)
      // Additions are discoverable capabilities, never new direct surface.
      expect(GATEWAY_MCP_ADVERTISE_TOOLS).not.toContain(tool)
    }
  })

  it('pins each profile id to the hidden universe its sessions were born with', () => {
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v1')).toBe(
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v2')).toBe(
      GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v3')).toBe(
      GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES
    )
    // An unknown or missing id must not inherit a newer surface.
    expect(taskWraithGatewayHiddenToolNamesForProfile(null)).toBe(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES)
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v3')).toBe(
      GATEWAY_MCP_ADVERTISE_TOOLS
    )
  })
})
