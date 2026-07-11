// Phase I4 (Kimi initiator): wire the taskwraith MCP bridge into the
// Kimi CLI run paths so a Kimi agent can call delegate_to_subthread on
// other providers. Gemini, Codex, and Claude already register the bridge
// — this module mirrors that wiring for Kimi.
//
// Kimi CLI 1.43.0 ships native MCP support via:
//
//   kimi mcp add <name> --transport stdio --env KEY=VALUE -- <command> <args>
//
// The `--env` flag accepts multiple `-e KEY=VALUE` pairs and the `--`
// separator terminates Kimi's flag-parsing so any flags meant for the
// bridge subprocess (e.g. `--socket`, `--token`) reach the subprocess
// rather than being eaten by Kimi.
//
// Config file: `~/.kimi/mcp.json`. This is provider-global rather than bound to
// one native Kimi session, so registration repair cannot honestly guarantee
// birth-pinned catalogue membership to an already-running session. TaskWraith
// refreshes only its named registration; user MCP servers remain untouched.
// The broker subprocess inherits the
// `TASKWRAITH_PARENT_PROVIDER=kimi` stamp from the per-server env block
// and the bridge subprocess uses it to route broker requests with the
// right provider key.
//
// Kept free of Electron / fs / IPC imports so it can be unit-tested
// directly against fixed inputs.

import { GATEWAY_MCP_ADVERTISE_TOOLS } from './mcp/McpToolProfiles'

/**
 * Compact first-party surface advertised by TaskWraith's Kimi registration.
 * Hidden canonical tools remain available through capability_search/invoke;
 * user-installed Kimi MCP servers are outside this list and remain untouched.
 */
export const KIMI_TASKWRAITH_TOOL_NAMES = GATEWAY_MCP_ADVERTISE_TOOLS

/**
 * Server name used as the registration key in `~/.kimi/mcp.json`.
 * Matches the Gemini / Codex / Claude bridge name so the broker's
 * server-side identity is consistent across providers. Mixed-case
 * `TaskWraith` matches the product display name and is what Kimi shows
 * in its tool list as the namespace prefix (`TaskWraith__<tool>`).
 */
export const KIMI_TASKWRAITH_SERVER_NAME = 'TaskWraith'
export const KIMI_LEGACY_TASKWRAITH_SERVER_NAMES = ['agentbench', 'AGBench'] as const

export interface KimiMcpBridgeAddArgsInput {
  /** Absolute path of the TaskWraith binary that hosts the MCP bridge. */
  bridgeBinaryPath: string
  /** argv passed to the bridge subprocess (already includes flag literals). */
  bridgeArgs: string[]
}

export interface KimiWirePromptRequestInput {
  id: string
  prompt: string
  imagePaths?: ReadonlyArray<string>
}

/**
 * Build the argv passed to `kimi mcp add` for registering the
 * taskwraith bridge as a stdio MCP server. The exact shape is:
 *
 *   mcp add taskwraith
 *     --transport stdio
 *     --env TASKWRAITH_PARENT_PROVIDER=kimi
 *     --
 *     <bridgeBinaryPath>
 *     <...bridgeArgs>
 *
 * The `--` separator is essential: it tells Kimi's CLI argparser to
 * stop interpreting flags so the bridge's `--socket` / `--token`
 * arguments survive intact to the spawned subprocess.
 *
 * Pure function — no side effects, no IO. The caller passes the
 * resulting array to `captureProcessOutput(kimiBinaryPath, args)`.
 */
export function buildKimiMcpBridgeAddArgs(input: KimiMcpBridgeAddArgsInput): string[] {
  return [
    'mcp',
    'add',
    KIMI_TASKWRAITH_SERVER_NAME,
    '--transport',
    'stdio',
    '--env',
    'TASKWRAITH_PARENT_PROVIDER=kimi',
    '--',
    input.bridgeBinaryPath,
    ...input.bridgeArgs
  ]
}

export function buildKimiMcpBridgeRemoveArgs(serverName: string): string[] {
  return ['mcp', 'remove', serverName]
}

/**
 * Redact the broker token (the arg immediately following `--token`) so
 * the registration command can be safely logged in user-facing errors.
 * Mirrors `redactGeminiMcpBridgeArgs` in `index.ts`. The flag literal
 * is duplicated here to avoid cross-module coupling — the token arg is
 * a stable shape (`--token <hex>`), not a Kimi-specific concept.
 */
export function redactKimiMcpBridgeAddArgs(args: string[]): string[] {
  return args.map((arg, index) => (args[index - 1] === '--token' ? '[redacted-token]' : arg))
}

export function buildKimiWirePromptRequest(input: KimiWirePromptRequestInput): Record<string, unknown> {
  const imagePaths = input.imagePaths || []
  const userInput =
    imagePaths.length > 0
      ? [
          { type: 'text', text: input.prompt },
          ...imagePaths.map((imagePath) => ({
            type: 'image_url',
            image_url: { url: imagePath }
          }))
        ]
      : input.prompt

  return {
    jsonrpc: '2.0',
    id: input.id,
    method: 'prompt',
    params: { user_input: userInput }
  }
}
