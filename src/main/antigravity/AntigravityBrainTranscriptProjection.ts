/**
 * Thin integration shim: project read-side agy tools from the brain transcript
 * after a provider turn completes. Called from runAntigravityAgyProvider in
 * index.ts (the caller wires sendAgentCompatLine, sender, and route).
 *
 * This is a separate module because index.ts exceeds TaskWraith's file-size
 * limit for direct mutation tools, so the integration is a single import +
 * one-line call that can be applied as a small patch.
 *
 * @internal Called only from runAntigravityAgyProvider.
 */

import { readAgyConversationReceipt, formatAgyProjectBoundSessionId } from './AntigravityConversationReceipt'
import { projectAgyBrainTranscriptTools } from './AntigravityToolProjection'

type SendAgentCompatLine<TRoute> = (
  sender: Electron.WebContents,
  provider: 'antigravity',
  payload: Record<string, unknown>,
  route?: TRoute
) => void

/**
 * Read the agy brain transcript for the conversation that just completed and
 * project any read-side tool calls (VIEW_FILE, GREP_SEARCH, LIST_DIRECTORY,
 * GENERIC, ERROR_MESSAGE) into the transcript. Shell/write tools are already
 * projected in real-time by the PreToolUse bridge.
 *
 * Best-effort: failures are silent. Tool projection is display-only.
 */
export async function projectAgyBrainTranscriptAfterTurn<TRoute>(
  sendAgentCompatLine: SendAgentCompatLine<TRoute>,
  sender: Electron.WebContents,
  route: TRoute,
  workspace: string | null | undefined
): Promise<void> {
  // Re-read the receipt to learn the conversation id agy actually used.
  const learned = await readAgyConversationReceipt(workspace)
  const sessionId = formatAgyProjectBoundSessionId(learned)

  await projectAgyBrainTranscriptTools(
    sessionId,
    sendAgentCompatLine,
    sender,
    route
  )
}
