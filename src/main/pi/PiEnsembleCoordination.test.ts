import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TASKWRAITH_MCP_TOOLS } from '../../shared/taskWraithMcpCatalog'
import {
  MCP_BROKER_LONG_POLL_TIMEOUT_MS,
  MCP_BROKER_REQUEST_TIMEOUT_MS
} from '../mcp/McpBrokerTimeouts'
import {
  PI_ENSEMBLE_COORDINATION_READY_MARKER,
  PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
  PI_EXACT_FILE_TOOL_NAMES,
  PI_MANAGED_SHELL_TOOL_NAMES,
  PI_MESH_TOOL_NAMES,
  PI_ULTRATASK_DELEGATION_TOOL_NAMES,
  isPiEnsembleCoordinationToolName,
  isPiTaskWraithToolName,
  isPiUltraTaskDelegationToolName,
  piEnsembleCoordinationReadyPromptAppendix,
  piEnsembleCoordinationUnavailablePromptAppendix,
  piTaskWraithToolsReadyPromptAppendix,
  piTaskWraithToolsUnavailablePromptAppendix,
  preparePiEnsembleCoordinationExtension,
  preparePiTaskWraithExtension,
  preparePiToolCallRepairExtension
} from './PiEnsembleCoordination'

const temporaryHomes: string[] = []

function createCanonicalHome(): string {
  const created = mkdtempSync(join(tmpdir(), 'taskwraith-pi-coordination-'))
  temporaryHomes.push(created)
  return realpathSync(created)
}

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

/**
 * Run the extension's own repair helper, lifted out of the generated source.
 *
 * The extension is emitted as a string that only Pi's runtime can import, so
 * exercising the shipped text — rather than a copy of it — is the only way this
 * stays pinned to what the seat actually loads.
 */
function extractRepairForkedToolCalls(
  source: string
): (content: unknown) => Record<string, unknown>[] | null {
  const start = source.indexOf('function repairForkedToolCalls(content) {')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  const body = source.slice(start, end + 2)
  return new Function(`${body}; return repairForkedToolCalls`)() as (
    content: unknown
  ) => Record<string, unknown>[] | null
}

describe('Pi managed Ensemble coordination extension', () => {
  it('recognizes only the fixed ensemble coordination broker surface', () => {
    for (const toolName of PI_ENSEMBLE_COORDINATION_TOOL_NAMES) {
      expect(isPiEnsembleCoordinationToolName(toolName)).toBe(true)
    }
    expect(isPiEnsembleCoordinationToolName('run_shell_command')).toBe(false)
    expect(isPiEnsembleCoordinationToolName('capability_invoke')).toBe(false)
    expect(isPiEnsembleCoordinationToolName('write_file')).toBe(false)
    // Delegate tools stay excluded from the ORDINARY coordination surface;
    // signed UltraTask runs opt into their own fixed list below.
    expect(isPiEnsembleCoordinationToolName('delegate_wave')).toBe(false)
    expect(isPiEnsembleCoordinationToolName('delegate_to_subthread')).toBe(false)
  })

  it('admits the Boss/Captain orchestration parity tools without widening to delegates', () => {
    const parityTools = [
      'ensemble_fanout_all',
      'ensemble_await',
      'ensemble_lane_result',
      'ensemble_control',
      'ensemble_bossman_control',
      'list_ensemble_participants',
      'ensemble_propose_goal_complete'
    ] as const
    for (const toolName of parityTools) {
      expect(PI_ENSEMBLE_COORDINATION_TOOL_NAMES).toContain(toolName)
      expect(isPiEnsembleCoordinationToolName(toolName)).toBe(true)
      expect(isPiTaskWraithToolName(toolName)).toBe(true)
    }
    // Every admitted name must exist in the canonical TaskWraith MCP catalog.
    for (const toolName of PI_ENSEMBLE_COORDINATION_TOOL_NAMES) {
      expect(TASKWRAITH_MCP_TOOLS as readonly string[]).toContain(toolName)
    }
  })

  it('keeps the signed UltraTask delegated-review surface fixed and separate', () => {
    expect(PI_ULTRATASK_DELEGATION_TOOL_NAMES).toEqual([
      'ultra_task',
      'delegate_wave',
      'delegate_to_subthread',
      'ensemble_await',
      'list_subthreads',
      'read_subthread_result'
    ])
    for (const toolName of PI_ULTRATASK_DELEGATION_TOOL_NAMES) {
      expect(isPiUltraTaskDelegationToolName(toolName)).toBe(true)
      expect(isPiTaskWraithToolName(toolName)).toBe(true)
      expect(TASKWRAITH_MCP_TOOLS as readonly string[]).toContain(toolName)
    }
    // Join is shared with Ensemble; spawn/inspection remain UltraTask-only.
    expect(PI_ENSEMBLE_COORDINATION_TOOL_NAMES).toContain('ensemble_await')
    for (const toolName of [
      'delegate_wave',
      'delegate_to_subthread',
      'list_subthreads',
      'read_subthread_result'
    ]) {
      expect(PI_ENSEMBLE_COORDINATION_TOOL_NAMES as readonly string[]).not.toContain(toolName)
    }
    // Keep cancellation and claim mutation outside the consent-derived transport.
    for (const outOfScope of ['cancel_subthread', 'claim_fleet_wave']) {
      expect(PI_ULTRATASK_DELEGATION_TOOL_NAMES as readonly string[]).not.toContain(outOfScope)
      expect(isPiUltraTaskDelegationToolName(outOfScope)).toBe(false)
    }
  })

  it('admits the sketch-canvas trio and browser quartet without widening to the full canvas family', () => {
    // Pass-2 Boss ruling (boss-canvas-browser-scope-ruling): minimal-plus —
    // the sketch trio matches Ollama's tier posture and the browser quartet
    // matches the CORE MCP profile exactly. The wider canvas_* render/chart/
    // drive family stays out of scope.
    const parityTools = [
      'canvas_sketch_open',
      'canvas_sketch_get',
      'canvas_sketch_update',
      'browser_open',
      'browser_click',
      'browser_screenshot',
      'browser_console'
    ] as const
    for (const toolName of parityTools) {
      expect(PI_ENSEMBLE_COORDINATION_TOOL_NAMES).toContain(toolName)
      expect(isPiEnsembleCoordinationToolName(toolName)).toBe(true)
      expect(isPiTaskWraithToolName(toolName)).toBe(true)
      expect(TASKWRAITH_MCP_TOOLS as readonly string[]).toContain(toolName)
    }
    for (const outOfScope of [
      'canvas_open',
      'canvas_render',
      'canvas_chart',
      'canvas_snapshot',
      'canvas_drive_report',
      'web_fetch',
      'web_search'
    ]) {
      expect(PI_ENSEMBLE_COORDINATION_TOOL_NAMES as readonly string[]).not.toContain(outOfScope)
      expect(isPiTaskWraithToolName(outOfScope)).toBe(false)
    }
  })

  it('writes a fixed owner-only extension with exactly the narrow coordination tool set', () => {
    const home = createCanonicalHome()

    const prepared = preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })

    expect(prepared.path).toBe(join(home, 'taskwraith-tools.mjs'))
    expect(prepared.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.toolNames).toEqual(PI_ENSEMBLE_COORDINATION_TOOL_NAMES)
    const source = readFileSync(prepared.path, 'utf8')
    expect(source).toContain(PI_ENSEMBLE_COORDINATION_READY_MARKER)
    expect(source).toContain("parentProvider: 'pi'")
    expect(source).toContain('const TOOL_NAMES')
    expect(source).toContain('function parametersFor(name)')
    expect(source).toContain('promptSnippet: descriptionFor(name)')
    expect(source).toContain("case 'ensemble_send'")
    expect(source).toContain('User delivery is durable transcript-only')
    expect(source).toContain('@All remains roster-only')
    expect(source).toContain("case 'blackboard_post'")
    expect(source).toContain('ttlMinutes: Type.Optional(Type.Number())')
    expect(source).toContain("case 'ensemble_control'")
    expect(source).toContain("case 'ensemble_bossman_control'")
    expect(source).toContain("case 'ensemble_await'")
    expect(source).toContain("case 'ensemble_lane_result'")
    expect(source).toContain("case 'ensemble_fanout_all'")
    expect(source).toContain("case 'list_ensemble_participants'")
    expect(source).toContain("case 'ensemble_propose_goal_complete'")
    expect(source).toContain("case 'canvas_sketch_open'")
    expect(source).toContain("case 'canvas_sketch_get'")
    expect(source).toContain("case 'canvas_sketch_update'")
    expect(source).toContain("case 'browser_open'")
    expect(source).toContain("case 'browser_click'")
    expect(source).toContain("case 'browser_screenshot'")
    expect(source).toContain("case 'browser_console'")
    // The generated module contains schema branches for every fixed Pi surface,
    // but this ordinary Ensemble credential registers exactly the coordination
    // list and therefore cannot call either delegated-review tool.
    expect(prepared.toolNames).not.toContain('delegate_wave')
    expect(prepared.toolNames).not.toContain('delegate_to_subthread')
    expect(source).not.toContain("'canvas_render'")
    expect(source).not.toContain("'canvas_drive_report'")
    expect(source).toContain('throw new Error(resultText(result))')
    expect(prepared.toolNames).not.toContain('run_shell_command')
    expect(source).toContain(
      `const TOOL_NAMES = ${JSON.stringify(PI_ENSEMBLE_COORDINATION_TOOL_NAMES)}`
    )
    expect(piTaskWraithToolsReadyPromptAppendix(prepared)).not.toContain(
      'UltraTask delegated-review transport is enabled'
    )
  })

  it('generates exact UltraTask delegation schemas under its fixed credential allowlist', () => {
    const home = createCanonicalHome()
    const prepared = preparePiTaskWraithExtension({
      isolatedHomeDir: home,
      toolNames: PI_ULTRATASK_DELEGATION_TOOL_NAMES
    })
    const source = readFileSync(prepared.path, 'utf8')

    expect(prepared.toolNames).toEqual(PI_ULTRATASK_DELEGATION_TOOL_NAMES)
    expect(source).toContain(
      `const TOOL_NAMES = ${JSON.stringify(PI_ULTRATASK_DELEGATION_TOOL_NAMES)}`
    )
    expect(source).toContain("case 'ultra_task'")
    expect(source).toContain('enableFanout: Type.Optional(Type.Boolean())')
    expect(source).toContain('enableReview: Type.Optional(Type.Boolean())')
    expect(source).toContain('maxWorkers: Type.Optional(Type.Number())')
    expect(source).toContain("case 'delegate_wave'")
    expect(source).toContain('workers: Type.Array(')
    expect(source).toContain('{ minItems: 1, maxItems: 64 }')
    expect(source).toContain('allowMultiProvider: Type.Optional(Type.Boolean())')
    expect(source).toContain('deadlineMs: Type.Optional(Type.Number())')
    expect(source).toContain("case 'delegate_to_subthread'")
    expect(source).toContain('provider: Type.String()')
    expect(source).toContain('prompt: Type.String()')
    expect(source).toContain('returnResult: Type.Optional(Type.Boolean())')
    expect(source).toContain('subThreadId: optionalText()')
    expect(source).toContain("case 'ensemble_await'")
    expect(source).toContain('subThreadIds: optionalTextArray()')
    expect(source).toContain('waveIds: optionalTextArray()')
    expect(source).toContain('timeoutSeconds: Type.Optional(Type.Number())')
    expect(source).not.toContain('timeoutMs: Type.Optional(Type.Number())')
    expect(source).toContain(`const DEFAULT_BROKER_TIMEOUT_MS = ${MCP_BROKER_REQUEST_TIMEOUT_MS}`)
    expect(source).toContain(
      `const LONG_POLL_BROKER_TIMEOUT_MS = ${MCP_BROKER_LONG_POLL_TIMEOUT_MS}`
    )
    expect(source).toContain(
      "tool === 'ensemble_await' ? LONG_POLL_BROKER_TIMEOUT_MS : DEFAULT_BROKER_TIMEOUT_MS"
    )
    expect(source).not.toContain('\n      130000\n')
    expect(source).toContain("case 'list_subthreads'")
    expect(source).toContain('includeArchived: Type.Optional(Type.Boolean())')
    expect(source).toContain("case 'read_subthread_result'")
    expect(source).toContain('includeEvents: Type.Optional(Type.Boolean())')

    const prompt = piTaskWraithToolsReadyPromptAppendix(prepared)
    expect(prompt).toContain('main-signed reasoning-picker consent')
    expect(prompt).toContain('call `ultra_task` once')
    expect(prompt).toContain('TaskWraith owns every staged worker and join')
    expect(prompt).toContain('only when `ultra_task` is unavailable')
    expect(prompt).toContain('returned `waveIds` or `subThreadIds`')
    expect(prompt).toContain('does not widen native Pi file, shell, network, or generic MCP access')
  })

  it('repairs Pi forked tool-call blocks before the message is dispatched', () => {
    // Pi's mistral-conversations accumulator keys on `${callId}:${index}`, and
    // Mistral's continuation deltas arrive with `id: "null"` / `name: ""` — a
    // different key, so a SECOND, nameless block is forked and the arguments
    // land in whichever of the two the packet boundaries filled. The extension
    // repairs the message on message_end, which is the object Pi dispatches
    // from, so the fix reaches execution rather than only the transcript.
    const home = createCanonicalHome()
    const prepared = preparePiTaskWraithExtension({
      isolatedHomeDir: home,
      toolNames: [...PI_MANAGED_SHELL_TOOL_NAMES]
    })
    const source = readFileSync(prepared.path, 'utf8')
    expect(source).toContain("pi.on('message_end'")

    const repair = extractRepairForkedToolCalls(source)

    // Arguments forked onto the nameless block: hand them back.
    expect(
      repair([
        {
          type: 'toolCall',
          id: 'chatcmpl-tool-8c5da23850ab7ca1',
          name: 'run_shell_command',
          arguments: {}
        },
        { type: 'toolCall', id: 'toolcall0', name: '', arguments: { command: 'echo hello world' } }
      ])
    ).toEqual([
      {
        type: 'toolCall',
        id: 'chatcmpl-tool-8c5da23850ab7ca1',
        name: 'run_shell_command',
        arguments: { command: 'echo hello world' }
      }
    ])

    // Arguments stayed on the named block: keep them, drop the empty fork.
    expect(
      repair([
        {
          type: 'toolCall',
          id: 'call-ok',
          name: 'run_shell_command',
          arguments: { command: 'swift' }
        },
        { type: 'toolCall', id: 'toolcall0', name: '', arguments: {} }
      ])
    ).toEqual([
      {
        type: 'toolCall',
        id: 'call-ok',
        name: 'run_shell_command',
        arguments: { command: 'swift' }
      }
    ])

    // Several calls in one turn: each fork walks back to its own call.
    expect(
      repair([
        { type: 'toolCall', id: 'call-a', name: 'read', arguments: {} },
        { type: 'toolCall', id: 'call-b', name: 'grep', arguments: {} },
        { type: 'toolCall', id: 'toolcall0', name: '', arguments: { path: 'a.ts' } },
        { type: 'toolCall', id: 'toolcall1', name: '', arguments: { pattern: 'x' } }
      ])
    ).toEqual([
      { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'toolCall', id: 'call-b', name: 'grep', arguments: { pattern: 'x' } }
    ])

    // Nothing forked: leave the message alone rather than rewriting it.
    expect(
      repair([
        { type: 'text', text: 'hello' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }
      ])
    ).toBeNull()
    expect(repair(undefined)).toBeNull()
  })

  it('carries the same repair in a tools-free extension for unprivileged runs', () => {
    // A run with no managed tools still drives Pi's own read/grep/find/ls (and
    // bash/edit/write when write-capable), and the fork is a property of the
    // upstream stream rather than of the tool. Without this the seats with the
    // fewest privileges would be the only ones left dispatching `{}`.
    const home = createCanonicalHome()

    const repairOnly = preparePiToolCallRepairExtension({ isolatedHomeDir: home })

    expect(repairOnly.path).toBe(join(home, 'taskwraith-toolcall-repair.mjs'))
    expect(repairOnly.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    const repairSource = readFileSync(repairOnly.path, 'utf8')
    expect(repairSource).toContain("pi.on('message_end'")
    // Registers nothing and opens no broker connection, so it widens no
    // capability and is attachable where the managed extension is not.
    expect(repairSource).not.toContain('registerTool')
    expect(repairSource).not.toContain('node:net')
    expect(repairSource).not.toContain('TASKWRAITH_PI_COORDINATION_TOKEN')
    // No tools means nothing to be ready: Main's readiness gate must not be
    // told the managed surface arrived.
    expect(repairSource).not.toContain(PI_ENSEMBLE_COORDINATION_READY_MARKER)

    // Its own filename, so it never collides with a managed extension already
    // written into the same per-run home.
    const managed = preparePiTaskWraithExtension({
      isolatedHomeDir: home,
      toolNames: [...PI_MANAGED_SHELL_TOOL_NAMES]
    })
    expect(managed.path).not.toBe(repairOnly.path)

    // Both extensions must repair identically, or attaching the tools-free one
    // would quietly be a weaker fix than the managed one.
    const managedSource = readFileSync(managed.path, 'utf8')
    const cases = [
      [
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
        { type: 'toolCall', id: 'toolcall0', name: '', arguments: { path: 'a.ts' } }
      ],
      [
        { type: 'toolCall', id: 'call-a', name: 'grep', arguments: {} },
        { type: 'toolCall', id: 'call-b', name: 'ls', arguments: {} },
        { type: 'toolCall', id: 'toolcall0', name: '', arguments: { pattern: 'x' } },
        { type: 'toolCall', id: 'toolcall1', name: '', arguments: { path: '.' } }
      ],
      [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }]
    ]
    const repairFromRepairOnly = extractRepairForkedToolCalls(repairSource)
    const repairFromManaged = extractRepairForkedToolCalls(managedSource)
    for (const content of cases) {
      expect(repairFromRepairOnly(content)).toEqual(repairFromManaged(content))
    }
    expect(repairFromRepairOnly(cases[0])).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }
    ])
  })

  it('builds one fixed extension for file, shell, coordination, and Mesh tools', () => {
    const home = createCanonicalHome()
    const toolNames = [
      ...PI_EXACT_FILE_TOOL_NAMES,
      ...PI_MANAGED_SHELL_TOOL_NAMES,
      ...PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
      ...PI_MESH_TOOL_NAMES
    ]

    const prepared = preparePiTaskWraithExtension({ isolatedHomeDir: home, toolNames })
    const source = readFileSync(prepared.path, 'utf8')

    expect(prepared.toolNames).toEqual(toolNames)
    for (const toolName of toolNames) expect(isPiTaskWraithToolName(toolName)).toBe(true)
    expect(isPiTaskWraithToolName('run_shell_command')).toBe(true)
    expect(isPiTaskWraithToolName('request_tool_permission')).toBe(true)
    expect(isPiTaskWraithToolName('mesh_topology_edit')).toBe(true)
    expect(isPiTaskWraithToolName('git_commit')).toBe(false)
    expect(source).toContain("case 'write_file'")
    expect(source).toContain("case 'replace'")
    expect(source).toContain("case 'apply_patch'")
    expect(source).toContain("case 'run_shell_command'")
    expect(source).toContain("case 'request_tool_permission'")
    expect(source).toContain("case 'mesh_scene_import'")
    expect(source).toContain('sourcePath: Type.String()')
    expect(source).toContain("case 'mesh_topology_edit'")
    expect(source).toContain('expectedRevision: Type.Number()')
    const prompt = piTaskWraithToolsReadyPromptAppendix(prepared)
    expect(prompt).toContain('Native Pi bash/edit/write remain disabled')
    expect(prompt).toContain('acquire only their proposed file/hunk targets')
    expect(prompt).toContain('never treated as contained by caller-declared paths')
    expect(prompt).toContain('one-shot TaskWraith host execution')
    expect(prompt).toContain('finish the turn')
    expect(prompt).toContain('same meshCanvas permission gate')
  })

  it('generates extension sources compatible with Pi-bundled typebox 1.x', () => {
    // Pi resolves `typebox` (not `@sinclair/typebox`) from its own runtime.
    // typebox 1.x removed `Type.OneOf` in favor of `Type.Union`, and any use
    // of the removed builder throws during module evaluation, which fails the
    // ENTIRE extension load for the seat. Pin the generated source against
    // removed builders so this cannot silently regress.
    const homes = [
      preparePiEnsembleCoordinationExtension({ isolatedHomeDir: createCanonicalHome() }),
      preparePiTaskWraithExtension({
        isolatedHomeDir: createCanonicalHome(),
        toolNames: [
          ...PI_EXACT_FILE_TOOL_NAMES,
          ...PI_MANAGED_SHELL_TOOL_NAMES,
          ...PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
          ...PI_MESH_TOOL_NAMES
        ]
      }),
      preparePiTaskWraithExtension({
        isolatedHomeDir: createCanonicalHome(),
        toolNames: PI_ULTRATASK_DELEGATION_TOOL_NAMES
      })
    ]
    for (const prepared of homes) {
      const source = readFileSync(prepared.path, 'utf8')
      expect(source).toContain("import { Type } from 'typebox'")
      expect(source).not.toContain('Type.OneOf')
      expect(source).toContain('Type.Union([Type.String(), Type.Array(Type.String())])')
    }
  })

  it('does not overwrite an unexpected pre-existing extension file', () => {
    const home = createCanonicalHome()
    preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })

    expect(() => preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })).toThrow(
      /EEXIST/
    )
  })

  it('makes the ready and fallback prompt receipts mutually exclusive and actionable', () => {
    const home = createCanonicalHome()
    const prepared = preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })

    const ready = piEnsembleCoordinationReadyPromptAppendix(prepared)
    const unavailable = piEnsembleCoordinationUnavailablePromptAppendix(
      'extension readiness timed out'
    )

    expect(ready).toContain('verified for this run')
    for (const tool of PI_ENSEMBLE_COORDINATION_TOOL_NAMES) expect(ready).toContain(`\`${tool}\``)
    expect(unavailable).toContain('unavailable for this run')
    expect(unavailable).toContain('@Role')
    expect(unavailable).not.toContain('verified for this run')
  })

  it('keeps a managed-tools readiness failure actionable without cancelling the lane', () => {
    const unavailable = piTaskWraithToolsUnavailablePromptAppendix({
      exactFileToolsExpected: true,
      shellToolsExpected: true,
      coordinationExpected: false,
      ultraTaskDelegationExpected: true,
      meshToolsExpected: true,
      reason: 'extension readiness timed out'
    })

    expect(unavailable).toContain('Continue all work that remains possible')
    expect(unavailable).toContain('exact command and cwd')
    expect(unavailable).toContain('extension readiness timed out')
    expect(unavailable).toContain('Mesh Canvas tools were expected')
    expect(unavailable).toContain('UltraTask delegation tools were expected')
    expect(unavailable).toContain('`ultra_task` is unavailable')
    expect(unavailable).not.toContain('continuing read-only')
  })
})
