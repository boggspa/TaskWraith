/**
 * Cold-start liveness feedback for the official `agy --print` CLI.
 *
 * When agy launches with `--new-project` (first turn in a chat), project
 * bootstrap can take several seconds before the first stdout line arrives.
 * agy --print is batch-only — no incremental assistant deltas — so the
 * orchestrator receives nothing to project, and the UI shows an empty
 * "Working..." spinner.
 *
 * Emit a synthetic `antigravity_init` tool activity as soon as we know the
 * launch is a fresh project, so the transcript shows meaningful progress
 * immediately.
 *
 * @internal Called only from runAntigravityAgyProvider.
 */

type SendAgentCompatLine = (
  sender: Electron.WebContents,
  provider: 'antigravity',
  payload: Record<string, unknown>,
  route?: unknown
) => void

export function emitAntigravityColdStartInit(
  sendAgentCompatLine: SendAgentCompatLine,
  sender: Electron.WebContents,
  route: unknown
): void {
  const initToolId = `agy-init-${Date.now()}`
  sendAgentCompatLine(
    sender,
    'antigravity',
    {
      type: 'tool_use',
      tool_id: initToolId,
      tool_name: 'antigravity_init',
      parameters: {}
    },
    route
  )
  sendAgentCompatLine(
    sender,
    'antigravity',
    {
      type: 'tool_result',
      tool_id: initToolId,
      tool_name: 'antigravity_init',
      status: 'success',
      output:
        'Initializing AntiGravity project — this may take a few seconds for the first turn in a new chat.'
    },
    route
  )
}
