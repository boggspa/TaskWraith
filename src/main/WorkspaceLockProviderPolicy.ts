import { isAntigravityGeminiApiModelCandidate } from './antigravity/AntigravityCombinedModeDispatch'
import { codexSandboxForMode } from './codex/CodexRunPolicy'
import { cursorWriteCapable } from './cursor/CursorCliArgs'
import { isFullShellAccessGranted } from './EffectiveRunPermissions'
import { mistralWriteCapable } from './mistral/MistralCliArgs'
import { resolvePiNativeToolPosture } from './pi/PiNativeToolPosture'
import type { AgentRunPayload } from './run/AgentRunTypes'

export type WorkspaceLockProviderRunInput = Pick<
  AgentRunPayload,
  'provider' | 'scope' | 'workspace' | 'approvalMode' | 'effectivePermissions' | 'model'
>

/**
 * Whether a provider run has a native or descendant write surface that cannot
 * be placed inside TaskWraith's exact per-operation mutation transaction.
 */
export function providerRunRequiresCoarseWorkspaceLock(
  payload: WorkspaceLockProviderRunInput
): boolean {
  if (payload.scope !== 'workspace' || !payload.workspace) return false
  // Claude Code auto-loads workspace/user hooks, plugins, and MCP servers even
  // when TaskWraith requests a read-only posture. Preserve those live surfaces
  // while serializing every native Claude workspace transport.
  if (payload.provider === 'claude') return true
  // Kimi's production ACP runtime statically denies native filesystem, shell,
  // egress, fan-out, hooks, and plugins. Every workspace mutation crosses the
  // TaskWraith HTTP-MCP broker and already receives an exact operation claim.
  if (payload.provider === 'kimi') return false
  if (payload.provider === 'grok') return payload.approvalMode !== 'plan'
  if (payload.provider === 'mistral') return mistralWriteCapable(payload.approvalMode)
  if (payload.provider === 'cursor') return cursorWriteCapable(payload.approvalMode)
  if (payload.provider === 'pi') {
    return resolvePiNativeToolPosture({
      approvalMode: payload.approvalMode,
      effectivePermissions: payload.effectivePermissions
    }).writeCapable
  }
  if (payload.provider === 'codex') {
    return (
      codexSandboxForMode(
        payload.approvalMode,
        isFullShellAccessGranted(payload.effectivePermissions)
      ) === 'workspace-write'
    )
  }
  if (payload.provider === 'antigravity') {
    // gemini-api:* is an in-process host lane. It has no child to receive a
    // launching-child acquisition; its MCP mutations use ordinary exact
    // main-owned per-operation claims instead.
    if (isAntigravityGeminiApiModelCandidate(payload.model)) return false
    // The official agy transport auto-loads user hooks/plugins, whose
    // subprocesses can mutate the workspace even in plan mode. Preserve that
    // live customization surface but serialize the entire native transport.
    return true
  }
  return false
}
