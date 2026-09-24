/**
 * TaskWraith tool-name allowlists for the contained Pi route.
 *
 * Extracted verbatim from src/main/pi/PiEnsembleCoordination.ts:18-143 so the
 * Node Host and Electron main share ONE definition. PiEnsembleCoordination now
 * re-exports these symbols, so its public API is unchanged.
 *
 * Only the allowlists moved. The Pi broker/extension machinery stays in main:
 * it pulls `typebox` and `node:net`, and the Host boundary test forbids any
 * non-relative runtime import.
 */

import { MESH_MCP_TOOL_NAMES, type MeshMcpToolName } from '../../shared/taskWraithMcpCatalog'

export const PI_ENSEMBLE_COORDINATION_TOOL_NAMES = Object.freeze([
  'ensemble_yield',
  'ensemble_send',
  'ensemble_fanout',
  'ensemble_poll_response',
  'scout_brief',
  'blackboard_post',
  'blackboard_read',
  'blackboard_delete',
  // Parity additions (all read/control-only, still server-side policy-gated):
  // Pi seats hold Boss/Captain roles on real panels, so they need the same
  // orchestration primitives every full-MCP provider already gets. Delegate
  // tools (`delegate_wave`, `delegate_to_subthread`) stay deliberately
  // excluded, matching the Ollama posture.
  'ensemble_fanout_all',
  'ensemble_await',
  'ensemble_lane_result',
  'ensemble_control',
  'ensemble_bossman_control',
  'list_ensemble_participants',
  'ensemble_propose_goal_complete',
  // Sketch-canvas + browser parity additions (pass 2, Boss ruling
  // `boss-canvas-browser-scope-ruling`): the sketch trio matches Ollama's
  // proven tier posture, and the browser quartet is exactly the set the CORE
  // MCP profile already advertises to constrained gateway providers. The full
  // canvas_* render/chart/drive family stays out of scope. Interaction tools
  // (canvas_sketch_update writes, browser_click) remain server-side
  // posture-gated as for every other provider.
  'canvas_sketch_open',
  'canvas_sketch_get',
  'canvas_sketch_update',
  'browser_open',
  'browser_click',
  'browser_screenshot',
  'browser_console'
] as const)

/**
 * Exact delegated-review surface for a Pi run whose main-signed permission
 * posture records `subThreadDelegationAutoAllowSource: 'ultratask'`.
 *
 * This list is deliberately separate from the ordinary Ensemble coordination
 * surface above: a normal solo Pi run, and an Ensemble seat that did not select
 * UltraTask, must not receive sub-thread spawn authority. Main opts this fixed
 * list in only for the signed UltraTask run. `ultra_task` launches the
 * main-owned durable graph for solo workspace runs. `ensemble_await` remains
 * available for panel coordination and the legacy wave fallback; the two read
 * tools are the bounded inspection fallback when a join times out or lifecycle
 * is unclear.
 */
export const PI_ULTRATASK_DELEGATION_TOOL_NAMES = Object.freeze([
  'ultra_task',
  'delegate_wave',
  'delegate_to_subthread',
  'ensemble_await',
  'list_subthreads',
  'read_subthread_result'
] as const)

/** Exact workspace mutation tools whose arguments can be locked and committed
 * inside TaskWraith's broker transaction. */
export const PI_EXACT_FILE_TOOL_NAMES = Object.freeze([
  'write_file',
  'replace',
  'apply_patch'
] as const)

/** Managed shell and elevation tools. Native Pi bash remains disabled: proven
 * reads use the normal route and opaque process effects require one visible,
 * audited host approval. */
export const PI_MANAGED_SHELL_TOOL_NAMES = Object.freeze([
  'run_shell_command',
  'request_tool_permission'
] as const)

/** Chat-local Mesh scene/topology tools admitted through the normal main gate. */
export const PI_MESH_TOOL_NAMES = Object.freeze([...MESH_MCP_TOOL_NAMES])

export type PiEnsembleCoordinationToolName = (typeof PI_ENSEMBLE_COORDINATION_TOOL_NAMES)[number]
export type PiUltraTaskDelegationToolName = (typeof PI_ULTRATASK_DELEGATION_TOOL_NAMES)[number]
export type PiExactFileToolName = (typeof PI_EXACT_FILE_TOOL_NAMES)[number]
export type PiManagedShellToolName = (typeof PI_MANAGED_SHELL_TOOL_NAMES)[number]
export type PiTaskWraithToolName =
  | PiEnsembleCoordinationToolName
  | PiUltraTaskDelegationToolName
  | PiExactFileToolName
  | PiManagedShellToolName
  | MeshMcpToolName

/**
 * The broker enforces this independently of Pi's extension registration.
 *
 * A write-capable Pi seat can inspect its own process environment, so the
 * run-bound local-broker token is authentication, not a capability boundary.
 * Keep the authorization boundary server-side: even a caller that obtained
 * that token cannot turn the contained Pi route into the generic TaskWraith
 * MCP surface.
 */
export function isPiEnsembleCoordinationToolName(
  value: unknown
): value is PiEnsembleCoordinationToolName {
  return (
    typeof value === 'string' &&
    (PI_ENSEMBLE_COORDINATION_TOOL_NAMES as readonly string[]).includes(value)
  )
}

export function isPiUltraTaskDelegationToolName(
  value: unknown
): value is PiUltraTaskDelegationToolName {
  return (
    typeof value === 'string' &&
    (PI_ULTRATASK_DELEGATION_TOOL_NAMES as readonly string[]).includes(value)
  )
}

export function isPiTaskWraithToolName(value: unknown): value is PiTaskWraithToolName {
  return (
    isPiEnsembleCoordinationToolName(value) ||
    isPiUltraTaskDelegationToolName(value) ||
    (typeof value === 'string' &&
      ((PI_EXACT_FILE_TOOL_NAMES as readonly string[]).includes(value) ||
        (PI_MANAGED_SHELL_TOOL_NAMES as readonly string[]).includes(value) ||
        (PI_MESH_TOOL_NAMES as readonly string[]).includes(value)))
  )
}
