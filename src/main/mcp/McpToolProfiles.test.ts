import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { AUDIT_MCP_TOOL_NAMES } from './AuditToolExecutors'
import { gatewayToolDefinitions } from './McpToolGateway'
import {
  CAPABILITY_GATEWAY_TOOL_NAMES,
  CORE_MCP_ADVERTISE_TOOLS,
  CORE_V2_MCP_ADVERTISE_TOOLS,
  CORE_MCP_TOOL_BUDGET,
  FULL_MCP_ADVERTISE_TOOLS,
  FULL_V2_MCP_ADVERTISE_TOOLS,
  GATEWAY_MCP_ADVERTISE_TOOLS,
  GATEWAY_MCP_DIRECT_TOOLS,
  GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V3_ADDED_TOOL_NAMES,
  GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V4_ADDED_TOOL_NAMES,
  GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V5_ADDED_TOOL_NAMES,
  GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V6_MCP_ADVERTISE_TOOLS,
  GATEWAY_V6_MCP_DIRECT_TOOLS,
  GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V7_ADDED_TOOL_NAMES,
  GATEWAY_V7_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MCP_DIRECT_TOOLS,
  GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MESH_MCP_DIRECT_TOOLS,
  GATEWAY_V8_ADDED_TOOL_NAMES,
  GATEWAY_V8_MCP_ADVERTISE_TOOLS,
  GATEWAY_V8_MCP_DIRECT_TOOLS,
  GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V8_MESH_MCP_DIRECT_TOOLS,
  GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V9_ADDED_TOOL_NAMES,
  GATEWAY_V9_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MCP_DIRECT_TOOLS,
  GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MESH_MCP_DIRECT_TOOLS,
  GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V10_ADDED_TOOL_NAMES,
  GATEWAY_V10_MCP_ADVERTISE_TOOLS,
  GATEWAY_V10_MCP_DIRECT_TOOLS,
  GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES,
  GATEWAY_V10_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V10_MESH_MCP_DIRECT_TOOLS,
  GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES,
  ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME,
  PROJECT_REFERENCE_PROPOSE_GATEWAY_TOOL_NAME,
  compactGatewayV8MeshToolDefinitionsForTransport,
  filterTaskWraithMcpToolDefinitionsForProfile,
  isCoreMcpAdvertisedTool,
  isGatewayMcpAdvertisedTool,
  taskWraithGatewayDirectToolNamesForProfile,
  taskWraithGatewayHiddenToolNamesForProfile,
  taskWraithMcpAdvertisedToolNamesForProfile,
  shouldUseCoreMcpProfile
} from './McpToolProfiles'

function nameHash(names: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(names)).digest('hex')
}

function withoutDescriptionFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptionFields)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, nested]) => [key, withoutDescriptionFields(nested)])
  )
}

describe('immutable v1 MCP profile snapshots', () => {
  it('freezes every exported membership array at runtime', () => {
    for (const profile of [
      FULL_MCP_ADVERTISE_TOOLS,
      FULL_V2_MCP_ADVERTISE_TOOLS,
      CORE_MCP_ADVERTISE_TOOLS,
      CORE_V2_MCP_ADVERTISE_TOOLS,
      GATEWAY_MCP_DIRECT_TOOLS,
      GATEWAY_MCP_ADVERTISE_TOOLS,
      GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V2_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V6_MCP_DIRECT_TOOLS,
      GATEWAY_V6_MCP_ADVERTISE_TOOLS,
      GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V7_ADDED_TOOL_NAMES,
      GATEWAY_V7_MCP_DIRECT_TOOLS,
      GATEWAY_V7_MCP_ADVERTISE_TOOLS,
      GATEWAY_V7_MESH_MCP_DIRECT_TOOLS,
      GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS,
      GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V8_ADDED_TOOL_NAMES,
      GATEWAY_V8_MCP_DIRECT_TOOLS,
      GATEWAY_V8_MCP_ADVERTISE_TOOLS,
      GATEWAY_V8_MESH_MCP_DIRECT_TOOLS,
      GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
      GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V9_ADDED_TOOL_NAMES,
      GATEWAY_V9_MCP_DIRECT_TOOLS,
      GATEWAY_V9_MCP_ADVERTISE_TOOLS,
      GATEWAY_V9_MESH_MCP_DIRECT_TOOLS,
      GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS,
      GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES,
      GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES
    ]) {
      expect(Object.isFrozen(profile)).toBe(true)
    }
  })

  it('pins full-v1 to the exact historical 155-tool surface', () => {
    // 2026-07-24: ensemble_continue removed with the Work Session surface
    // (fb88667b1) — 156 → 155.
    // 2026-07-26: theme_tokens_get/_set — 155 → 157. FULL-only placement (the
    // canvas_eval pattern): full seats get them directly, and gateway seats
    // reach them through discovery because V1_HIDDEN is a filter() off FULL,
    // so no gateway DIRECT budget is spent.
    expect(FULL_MCP_ADVERTISE_TOOLS).toHaveLength(157)
    expect(nameHash(FULL_MCP_ADVERTISE_TOOLS)).toBe(
      'f3c9578f76c4be878fe114a98b3a2884ee9f17cb41ae8f543e4c080228e5f1aa'
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
    expect(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES).toHaveLength(119)
    expect(nameHash(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES)).toBe(
      '3e05150155cf73b0489b0ce9c579f0271cbc0fe6cab09b3deb7f61c42507277f'
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
    expect(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES).not.toContain(ENSEMBLE_FANOUT_ALL_GATEWAY_TOOL_NAME)
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

  it('replaces the wide Ensemble control only on the fresh gateway-v6 surface', () => {
    expect(GATEWAY_MCP_DIRECT_TOOLS).not.toContain('ensemble_control')
    expect(GATEWAY_MCP_DIRECT_TOOLS).toContain('ensemble_bossman_control')
    expect(GATEWAY_V6_MCP_DIRECT_TOOLS).toContain('ensemble_control')
    expect(GATEWAY_V6_MCP_DIRECT_TOOLS).not.toContain('ensemble_bossman_control')
    expect(GATEWAY_V6_MCP_ADVERTISE_TOOLS).toContain('ensemble_control')
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v6')).toBe(
      GATEWAY_V6_MCP_ADVERTISE_TOOLS
    )
    expect(GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES).toEqual(GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES)
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
    const serializedChars = (
      names: readonly string[],
      extras: unknown[] = [],
      transform: (
        definitions: ReturnType<typeof createTaskWraithMcpToolDefinitions>
      ) => ReturnType<typeof createTaskWraithMcpToolDefinitions> = (selected) => selected
    ) =>
      JSON.stringify({
        tools: [
          ...transform(definitions.filter((definition) => names.includes(definition.name))),
          ...extras
        ]
      }).length
    const fullChars = serializedChars(FULL_MCP_ADVERTISE_TOOLS)
    const gatewayChars = serializedChars(GATEWAY_MCP_DIRECT_TOOLS, gatewayToolDefinitions())
    const freshGatewayChars = serializedChars(
      GATEWAY_V10_MCP_DIRECT_TOOLS,
      gatewayToolDefinitions()
    )
    const freshMeshGatewayChars = serializedChars(
      GATEWAY_V10_MESH_MCP_DIRECT_TOOLS,
      gatewayToolDefinitions(),
      compactGatewayV8MeshToolDefinitionsForTransport
    )

    // Measured 2026-07-19 baseline after correcting delegation's advertised
    // runtime-admission, active-recall queueing, and typed-terminal semantics.
    // Keep the exact values review-sensitive; the 40k gateway limit below is
    // the transport contract.
    // Measured after Path-B Cursor re-entry into live selectable / delegate enums,
    // then the bounded Blackboard poll schema and lifecycle guidance.
    // Re-measured 2026-07-24 after the Work Session removal dropped the
    // ensemble_continue schema from both catalogues.
    // Re-measured 2026-07-25: gateway-v4 graph primitives (ensemble_await +
    // ensemble_lane_result) grew the full catalogue, and the fan-out
    // isolation parameter grew ensemble_fanout on the DIRECT surface; both
    // stay inside the 40k transport contract and the 0.301 ratio.
    // Re-measured 2026-07-25 after the Pi seat joined LIVE_SELECTABLE_PROVIDER_IDS:
    // the provider enum is inlined into tool schemas on BOTH surfaces, so each
    // grew by one enum member's worth of characters.
    // Re-measured 2026-07-26: +52 full / +26 gateway for two `items` declarations
    // that are NOT optional. Gemini rejects the WHOLE request when any array
    // schema omits `items`, so a bare array anywhere 400'd every tool-advertising
    // AntiGravity gemini-api run (confirmed live). `{"items":{"type":"object"}}`
    // is the minimum valid form — the bytes cannot be spent more cheaply, and
    // clawing them back by trimming a tool description would degrade real model
    // guidance to satisfy a tripwire. Split: creative_timeline_import.ir.projects
    // is discovery-only (full surface), ensemble_roster_edit's
    // permissionOverrides.externalPathGrants is gateway-advertised (both).
    // Transport contract unaffected: gateway keeps 644 chars of headroom under
    // the 40k limit and the ratio moves 0.29831 -> 0.29843.
    // Re-measured 2026-07-26: theme_tokens_get/_set on the FULL surface only.
    // full +1,934 chars; gateway +50 despite the tools NOT being gateway-direct,
    // because the capability-gateway definitions enumerate the discoverable set.
    // Headroom 594 chars under the 40k transport cap, ratio 0.29843 -> 0.29449
    // (the ratio IMPROVES: the hidden surface grew while direct barely moved).
    // Re-measured 2026-07-26: +2,496 full, gateway UNCHANGED at 39_406 — the
    // canvas actuation tools are not gateway-direct, so the 594-char headroom
    // above is untouched and the ratio improves again to 0.28911.
    // The spend is agent guidance for canvas_click/canvas_fill/canvas_sketch_update
    // /canvas_snapshot/canvas_screenshot: the new `executed` / `verified` /
    // `refusalReason` contract, the credential refusal, and the optimistic-
    // concurrency args. It is deliberately not trimmable — a model that receives
    // `{executed: false, refusalReason: 'stale_target'}` with no description
    // retries the same action, which is the exact destructive loop the underlying
    // change exists to stop, so buying the bytes back here would re-open it.
    // Re-measured 2026-07-27: +13 full from the `meshCanvas` approval-status
    // enum member. Mesh definitions remain behind v7 discovery on the normal
    // gateway profile, so no direct gateway transport bytes are spent.
    // Re-measured 2026-07-28 after first-class Sketch policy/catalogue routing:
    // full is 137,005; the immutable v1 gateway is 39,869; v8 is 36,985.
    // The v8-mesh specialist profile compacts long-form Mesh/Sketch wire prose
    // while preserving every direct tool, typed schema, enum, required field,
    // and annotation. Both variants stay below the transport ceiling.
    // Re-measured after rebasing over the Captain fan-out guidance: each
    // catalogue grows by the same 66 characters; membership is unchanged.
    // Re-measured after the native AppDrive contract expanded the full-only
    // canvas_open_launch guidance. Direct gateway membership and bytes are
    // unchanged, so all three transport catalogues retain their prior budgets.
    // Gateway-v9 adds permission retry only to capability discovery, so its
    // direct transport catalogues remain byte-identical to v8.
    // Re-measured after replace_participant stopped accepting a permission
    // change. ensemble_bossman_control IS in the gateway catalogue, which sits
    // ~65 characters under a hard 40,000 transport ceiling, so the replacement
    // description was written to be SHORTER than the ceiling text it replaced
    // rather than clearer at any price: full and gateway each drop 5 characters
    // and the two fresh-session catalogues are untouched. The rule itself, and
    // the pointer to edit_participant, live in the refusal message where they
    // cost nothing until someone gets it wrong.
    // Re-measured 2026-08-04. Three independent contributions since the last
    // calibration (ccebb41d7):
    //   +381 ensemble_yield and +237 blackboard_post guidance prose (landed by
    //        the fan-out-seal / blackboard-timer sessions WITHOUT recalibrating
    //        here). Both tools are gateway-DIRECT, so this +618 pushed the
    //        immutable v1 gateway transport (40,548) and the fresh v10-mesh
    //        transport (40,464) OVER the hard 40,000 ceiling below. The exact
    //        pins are updated to the measured truth; the ceiling assertions are
    //        deliberately NOT relaxed — they are the transport contract, and
    //        the overage belongs to those two descriptions, not to this
    //        measurement. Trimming them back under budget is the owning
    //        features' call.
    //   +14  full-only: the approval_status service filter gains 'webBrowsing'.
    //   +0   to every pinned transport from canvas_navigate (Canvas Browser):
    //        gateway-v10 keeps it hidden — discoverable via capability_search,
    //        never direct — and it is not in the immutable v1 full list.
    // Re-measured 2026-08-05. Every pinned transport grew by roughly the same
    // ~830 characters — full +826, immutable v1 gateway +839, fresh v10 +830,
    // fresh v10-mesh +839 — so the spend is gateway-DIRECT prose, not full-only
    // surface. Five catalogue commits landed since the 08-04 calibration, ranked
    // here by source delta (the serialized spend is not separable per commit
    // without re-measuring each):
    //   +628 bc81364e5 Isolate enforcement — Shared/Worktrees pin, Any delegation
    //   +348 7ac885f7d Agent Pool participant registration
    //   +272 0d8ba7073 permission-agnostic stage roles
    //   +26  107adb9ab the ensemble_await 10-minute ceiling
    //   -58  75075fecc tier display-label rename — the one that bought bytes back
    // The breach the 08-04 note opened is WIDER, not closed: the immutable v1
    // gateway now runs 1,387 over the hard 40,000 transport ceiling and fresh
    // v10-mesh 1,303 over. Only the fresh v10 transport (38,499) is inside it.
    //
    // Those two overages used to sit here as bare `toBeLessThan(40_000)` calls
    // left deliberately red. That cost more than it bought: vitest aborts a test
    // body at the first failed expect, so the ratio check and BOTH fresh-session
    // pins below never executed — the guard was two-thirds disabled by the very
    // assertion meant to protect it, and a permanently-red suite teaches
    // everyone to stop reading the result. The ceiling is NOT relaxed; it moved
    // into the inventory below, where a breach still has to be declared in code.
    // Re-measured 2026-08-06 after the concurrent fan-out cap documented itself
    // in `ensemble_fanout` (a tool that can refuse for a reason absent from its
    // own description is a worse tool than one that costs 193 characters).
    // Every transport moved by exactly +193 — the sentence lands once, on the
    // one fan-out tool that is in these profiles. No transport crossed the
    // ceiling: fresh v10 went 38,499 -> 38,692, still inside, and the inventory
    // below is unchanged.
    expect(fullChars).toBe(139_746)
    expect(gatewayChars).toBe(41_580)
    expect(freshGatewayChars).toBe(38_692)
    expect(freshMeshGatewayChars).toBe(41_496)
    expect(gatewayChars / fullChars).toBeLessThan(0.301)

    // Transports currently over the hard 40,000-char transport ceiling. This
    // list may SHRINK, never grow — same ratchet the control-byte and
    // platform-portability guards use. A newly-breached transport fails here,
    // and so does a repaired one: that failure is the signal to strike the name
    // and take the win. Trimming `ensemble_yield` / `blackboard_post` prose back
    // under budget remains the owning features' call, not this test's.
    expect(
      Object.entries({ gatewayChars, freshGatewayChars, freshMeshGatewayChars })
        .filter(([, chars]) => chars >= 40_000)
        .map(([name]) => name)
    ).toEqual(['gatewayChars', 'freshMeshGatewayChars'])
  })

  it('compacts only Mesh and Sketch prose for the combined v8 transport', () => {
    const compactNames = [...GATEWAY_V7_ADDED_TOOL_NAMES, ...GATEWAY_V8_ADDED_TOOL_NAMES]
    const originals = createTaskWraithMcpToolDefinitions().filter((definition) =>
      compactNames.includes(definition.name as (typeof compactNames)[number])
    )
    const originalJson = JSON.stringify(originals)
    const compacted = compactGatewayV8MeshToolDefinitionsForTransport(originals)

    expect(compacted.map((definition) => definition.name)).toEqual(
      originals.map((definition) => definition.name)
    )
    for (const [index, compact] of compacted.entries()) {
      const original = originals[index]
      expect(compact).not.toBe(original)
      expect(compact.annotations).toEqual(original.annotations)
      expect(withoutDescriptionFields(compact.inputSchema)).toEqual(
        withoutDescriptionFields(original.inputSchema)
      )
      expect(compact.description?.length).toBeLessThan(original.description?.length ?? 0)
    }
    expect(JSON.stringify(originals)).toBe(originalJson)
  })

  it('never strips a schema property literally named description', () => {
    const definition = {
      name: 'canvas_sketch_update',
      description: 'long-form prose the transport compaction replaces',
      inputSchema: {
        type: 'object',
        description: 'annotation that should be stripped',
        properties: {
          description: {
            type: 'string',
            description: 'annotation on the description argument'
          },
          nested: {
            type: 'object',
            properties: { description: { type: 'number' } }
          }
        },
        required: ['description']
      }
    }
    const [compacted] = compactGatewayV8MeshToolDefinitionsForTransport([definition])
    expect(compacted.inputSchema).toEqual({
      type: 'object',
      properties: {
        description: { type: 'string' },
        nested: { type: 'object', properties: { description: { type: 'number' } } }
      },
      required: ['description']
    })
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
      ...FULL_V2_MCP_ADVERTISE_TOOLS,
      ...CORE_MCP_ADVERTISE_TOOLS,
      ...CORE_V2_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V6_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V7_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V8_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V9_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V10_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V10_MESH_MCP_ADVERTISE_TOOLS,
      ...GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES
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
    expect(GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V3_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V4_ADDED_TOOL_NAMES
    ])
    expect(GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V5_ADDED_TOOL_NAMES
    ])
    expect(GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES).toEqual(GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES)
    expect(GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V7_ADDED_TOOL_NAMES
    ])
    expect(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES).toEqual(GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES)
    expect(GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES).toEqual(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES)
    expect(GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V9_ADDED_TOOL_NAMES
    ])
    expect(GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V9_ADDED_TOOL_NAMES
    ])
    expect(GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V10_ADDED_TOOL_NAMES
    ])
    expect(GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES).toEqual([
      ...GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES,
      ...GATEWAY_V10_ADDED_TOOL_NAMES
    ])
    for (const tool of [
      ...GATEWAY_V3_ADDED_TOOL_NAMES,
      ...GATEWAY_V4_ADDED_TOOL_NAMES,
      ...GATEWAY_V5_ADDED_TOOL_NAMES,
      ...GATEWAY_V10_ADDED_TOOL_NAMES
    ]) {
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
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v4')).toBe(
      GATEWAY_V4_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v5')).toBe(
      GATEWAY_V5_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v6')).toBe(
      GATEWAY_V6_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v7')).toBe(
      GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v7-mesh')).toBe(
      GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v8')).toBe(
      GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v8-mesh')).toBe(
      GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v9')).toBe(
      GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v9-mesh')).toBe(
      GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v10')).toBe(
      GATEWAY_V10_MCP_HIDDEN_TOOL_NAMES
    )
    expect(taskWraithGatewayHiddenToolNamesForProfile('taskwraith-gateway-v10-mesh')).toBe(
      GATEWAY_V10_MESH_MCP_HIDDEN_TOOL_NAMES
    )
    // An unknown or missing id must not inherit a newer surface.
    expect(taskWraithGatewayHiddenToolNamesForProfile(null)).toBe(GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES)
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v5')).toBe(
      GATEWAY_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v6')).toBe(
      GATEWAY_V6_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v7')).toBe(
      GATEWAY_V7_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v7-mesh')).toBe(
      GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v8')).toBe(
      GATEWAY_V8_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v8-mesh')).toBe(
      GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v9')).toBe(
      GATEWAY_V9_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v9-mesh')).toBe(
      GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v10')).toBe(
      GATEWAY_V10_MCP_ADVERTISE_TOOLS
    )
    expect(taskWraithMcpAdvertisedToolNamesForProfile('taskwraith-gateway-v10-mesh')).toBe(
      GATEWAY_V10_MESH_MCP_ADVERTISE_TOOLS
    )
  })

  it('keeps Mesh Canvas discoverable normally and direct for the non-denied run variant', () => {
    for (const tool of GATEWAY_V7_ADDED_TOOL_NAMES) {
      expect(GATEWAY_V7_MCP_DIRECT_TOOLS).not.toContain(tool)
      expect(GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES).toContain(tool)
      expect(GATEWAY_V7_MESH_MCP_DIRECT_TOOLS).toContain(tool)
    }
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v7')).toBe(
      GATEWAY_V7_MCP_DIRECT_TOOLS
    )
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v7-mesh')).toBe(
      GATEWAY_V7_MESH_MCP_DIRECT_TOOLS
    )
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v8')).toBe(
      GATEWAY_V8_MCP_DIRECT_TOOLS
    )
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v8-mesh')).toBe(
      GATEWAY_V8_MESH_MCP_DIRECT_TOOLS
    )
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v9')).toBe(
      GATEWAY_V9_MCP_DIRECT_TOOLS
    )
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v9-mesh')).toBe(
      GATEWAY_V9_MESH_MCP_DIRECT_TOOLS
    )
    expect(GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES).toContain('request_tool_permission')
    expect(GATEWAY_V9_MCP_DIRECT_TOOLS).not.toContain('request_tool_permission')
  })

  it('keeps the v8 Sketch Canvas promotion direct in v8 and later birth catalogues', () => {
    expect(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES).toEqual(GATEWAY_V7_MCP_HIDDEN_TOOL_NAMES)
    for (const profile of [
      GATEWAY_V8_MCP_DIRECT_TOOLS,
      GATEWAY_V8_MCP_ADVERTISE_TOOLS,
      GATEWAY_V8_MESH_MCP_DIRECT_TOOLS,
      GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
      GATEWAY_V9_MCP_DIRECT_TOOLS,
      GATEWAY_V9_MCP_ADVERTISE_TOOLS,
      GATEWAY_V9_MESH_MCP_DIRECT_TOOLS,
      GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS
    ]) {
      expect(new Set(profile).size).toBe(profile.length)
    }
    for (const tool of GATEWAY_V8_ADDED_TOOL_NAMES) {
      expect(GATEWAY_V7_MCP_DIRECT_TOOLS).not.toContain(tool)
      expect(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES).toContain(tool)
      expect(GATEWAY_V8_MCP_DIRECT_TOOLS).toContain(tool)
      expect(GATEWAY_V8_MESH_MCP_DIRECT_TOOLS).toContain(tool)
      expect(GATEWAY_V9_MCP_DIRECT_TOOLS).toContain(tool)
      expect(GATEWAY_V9_MESH_MCP_DIRECT_TOOLS).toContain(tool)
    }
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v8')).toBe(
      GATEWAY_V8_MCP_DIRECT_TOOLS
    )
    expect(taskWraithGatewayDirectToolNamesForProfile('taskwraith-gateway-v8-mesh')).toBe(
      GATEWAY_V8_MESH_MCP_DIRECT_TOOLS
    )
    expect(GATEWAY_V8_MESH_MCP_DIRECT_TOOLS).toContain('ensemble_roster_edit')
    expect(GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES).toEqual(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES)
  })

  it('pins the exact immutable v8 and v8-mesh membership snapshots', () => {
    expect(GATEWAY_V8_MCP_DIRECT_TOOLS).toHaveLength(41)
    expect(nameHash(GATEWAY_V8_MCP_DIRECT_TOOLS)).toBe(
      'c6cfb8832f7b4e231b5b51e7ad72ea77cd8814a42bca89312c62a1b5299792f6'
    )
    expect(GATEWAY_V8_MESH_MCP_DIRECT_TOOLS).toHaveLength(50)
    expect(nameHash(GATEWAY_V8_MESH_MCP_DIRECT_TOOLS)).toBe(
      'afff045b39034e6df9ded9f5a1407c2298e0d22ce8f1b8507cdd24aa117f7c20'
    )
    expect(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES).toHaveLength(141)
    expect(nameHash(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES)).toBe(
      'f1ece0dc0169aa910c08347c675128143ecb101a3a486a4713b714edad9a4992'
    )
    expect(nameHash(GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES)).toBe(
      'f1ece0dc0169aa910c08347c675128143ecb101a3a486a4713b714edad9a4992'
    )
  })

  it('adds one-shot permission retry only to immutable v9 hidden catalogues', () => {
    expect(GATEWAY_V9_ADDED_TOOL_NAMES).toEqual(['request_tool_permission'])
    expect(GATEWAY_V9_MCP_DIRECT_TOOLS).toEqual(GATEWAY_V8_MCP_DIRECT_TOOLS)
    expect(GATEWAY_V9_MESH_MCP_DIRECT_TOOLS).toEqual(GATEWAY_V8_MESH_MCP_DIRECT_TOOLS)
    expect(GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES).not.toContain('request_tool_permission')
    expect(GATEWAY_V8_MESH_MCP_HIDDEN_TOOL_NAMES).not.toContain('request_tool_permission')
    expect(GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES).toContain('request_tool_permission')
    expect(GATEWAY_V9_MESH_MCP_HIDDEN_TOOL_NAMES).toContain('request_tool_permission')
  })

  it('fences retry targets to the immutable direct and hidden v9 union', () => {
    const names = filterTaskWraithMcpToolDefinitionsForProfile(
      'taskwraith-gateway-v9',
      createTaskWraithMcpToolDefinitions()
    ).map((definition) => definition.name)
    expect(names).toContain('write_file')
    expect(names).toContain('run_shell_command')
    expect(names).toContain('request_tool_permission')
    expect(names).not.toContain('ensemble_bossman_control')
    expect(names).toHaveLength(new Set(names).size)
  })
})
