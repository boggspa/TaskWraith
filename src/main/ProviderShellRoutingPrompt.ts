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
  'mistral'
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
    !mcpPolicy ||
    !TASKWRAITH_MCP_SHELL_PROVIDERS.has(input.provider) ||
    shellPolicy === 'deny' ||
    mcpPolicy === 'deny'
  ) {
    return ''
  }

  const shellTool = taskWraithToolNameForProvider(input.provider, 'run_shell_command')
  return [
    TASKWRAITH_SHELL_ROUTING_PROMPT_OPEN,
    'TaskWraith shell-routing (effective grant):',
    `- For tests, builds, Git, npm, and other shell work, call \`${shellTool}\` if it is listed in your tool surface. ${shellGrantSentence(shellPolicy)}`,
    `- A refusal from a native Bash/Shell/terminal tool can be a containment route, not a denial of the effective shell permission. This is the one permitted route change: do not retry the native tool; call \`${shellTool}\` once. This supersedes generic “do not retry through another tool” wording only for this contained-native-to-TaskWraith-shell route. If the TaskWraith shell call itself is unavailable or denied, report that exact blocker and do not substitute unrelated side effects.`,
    TASKWRAITH_SHELL_ROUTING_PROMPT_CLOSE,
    '',
    ''
  ].join('\n')
}
