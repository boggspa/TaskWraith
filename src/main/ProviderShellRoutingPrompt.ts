import type { EffectiveRunPermissions, ProviderId } from './store/types'
import { taskWraithToolNameForProvider } from './TaskWraithMcpPromptNames'

/**
 * A generated, leading prompt envelope. Keeping the envelope at the beginning
 * lets the final launch path remove it exactly if its broker fails to attach;
 * later user/transcript text that happens to quote the wording is untouched.
 */
export const TASKWRAITH_SHELL_ROUTING_PROMPT_OPEN = '<taskwraith-shell-routing-v1>'
export const TASKWRAITH_SHELL_ROUTING_PROMPT_CLOSE = '</taskwraith-shell-routing-v1>'

export function stripProviderShellRoutingPromptPrefix(prompt: string): string {
  if (!prompt.startsWith(TASKWRAITH_SHELL_ROUTING_PROMPT_OPEN)) return prompt
  const suffix = `${TASKWRAITH_SHELL_ROUTING_PROMPT_CLOSE}\n\n`
  const end = prompt.indexOf(suffix)
  return end >= 0 ? prompt.slice(end + suffix.length) : prompt
}

/**
 * Providers that can receive TaskWraith's workspace MCP surface. The prompt
 * still says "if it is listed" because broker setup is fallible and a degraded
 * run must never be told that an unavailable tool exists.
 */
const TASKWRAITH_MCP_SHELL_PROVIDERS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'mistral',
  'pi'
])

type ShellRoutingPermissions = Pick<EffectiveRunPermissions, 'agenticServices'>

function shellGrantSentence(
  policy: ShellRoutingPermissions['agenticServices']['shellCommands']
): string {
  if (policy === 'allow') {
    return 'The user has already allowed shell commands for this participant.'
  }
  if (policy === 'workspace') {
    return 'A user-approved workspace shell grant covers this participant.'
  }
  return 'This call uses the normal user approval request when the current policy requires it.'
}

/**
 * Make the containment-vs-permission distinction explicit in ensemble prompts.
 * A native terminal tool may be intentionally unavailable even while the
 * corresponding host-mediated TaskWraith MCP tool is granted by the user.
 */
export function buildProviderShellRoutingPrompt(input: {
  provider: ProviderId
  effectivePermissions: ShellRoutingPermissions | null | undefined
}): string {
  const permissions = input.effectivePermissions
  const shellPolicy = permissions?.agenticServices.shellCommands
  const mcpPolicy = permissions?.agenticServices.mcpTools
  if (
    !permissions ||
    !shellPolicy ||
    !TASKWRAITH_MCP_SHELL_PROVIDERS.has(input.provider) ||
    shellPolicy === 'deny'
  ) {
    return ''
  }

  const managedRouteAvailable = input.provider === 'pi' || mcpPolicy !== 'deny'
  if (!managedRouteAvailable && input.provider !== 'cursor') return ''
  const shellTool =
    input.provider === 'pi'
      ? 'run_shell_command'
      : taskWraithToolNameForProvider(input.provider, 'run_shell_command')
  const permissionRoute =
    'follow the returned `permissionOpportunity` or legacy `permissionRetry` instruction exactly once. A fresh profile redeems only TaskWraith\'s opaque id; an older profile uses the listed compatibility capability gateway to `request_tool_permission`. Never reconstruct or alter the failed target, arguments, or failure text'
  return [
    TASKWRAITH_SHELL_ROUTING_PROMPT_OPEN,
    'TaskWraith shell-routing (effective grant):',
    ...(managedRouteAvailable
      ? [
          `- For tests, builds, Git, npm, and other shell work, call \`${shellTool}\` if it is listed in your tool surface. ${shellGrantSentence(shellPolicy)}`,
          '- The normal managed route executes only commands TaskWraith can prove read-only. Opaque process side effects cannot be contained by caller-declared paths.',
          `- If TaskWraith reports that boundary, ${permissionRoute}. That opens an auditable one-shot approval showing the exact command and cwd; approval runs only that invocation in the TaskWraith host process outside the workspace sandbox.`,
          `- A refusal from a native Bash/Shell/terminal tool can be a containment route, not a denial of the effective shell permission. Do not repeat the native call; route once through \`${shellTool}\`. If the user declines either approval, respect it, continue from available evidence, and finish the turn instead of cancelling.`
        ]
      : []),
    ...(input.provider === 'cursor'
      ? [
          '- Cursor continuity: when the managed TaskWraith shell tool is absent on a user-approved write seat, native Shell/Write remain available inside Cursor’s enabled workspace sandbox. Shell is not a substitute for TaskWraith sub-thread or cross-provider spawn. Stay inside the assigned lane scope, expose the exact command/path, and continue the turn if the sandbox refuses it.'
        ]
      : []),
    TASKWRAITH_SHELL_ROUTING_PROMPT_CLOSE,
    '',
    ''
  ].join('\n')
}
