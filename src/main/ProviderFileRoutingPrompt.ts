import type { EffectiveRunPermissions, ProviderId } from './store/types'
import { taskWraithToolNameForProvider } from './TaskWraithMcpPromptNames'

export const TASKWRAITH_FILE_ROUTING_PROMPT_OPEN = '<taskwraith-file-routing-v1>'
export const TASKWRAITH_FILE_ROUTING_PROMPT_CLOSE = '</taskwraith-file-routing-v1>'

export function stripProviderFileRoutingPromptPrefix(prompt: string): string {
  if (!prompt.startsWith(TASKWRAITH_FILE_ROUTING_PROMPT_OPEN)) return prompt
  const suffix = `${TASKWRAITH_FILE_ROUTING_PROMPT_CLOSE}\n\n`
  const end = prompt.indexOf(suffix)
  return end >= 0 ? prompt.slice(end + suffix.length) : prompt
}

const TASKWRAITH_MCP_FILE_PROVIDERS = new Set<ProviderId>(['codex', 'cursor'])

type FileRoutingPermissions = Pick<EffectiveRunPermissions, 'agenticServices'>

function fileGrantSentence(
  policy: FileRoutingPermissions['agenticServices']['fileChanges']
): string {
  if (policy === 'allow') {
    return 'The user has already allowed in-workspace file changes for this participant.'
  }
  if (policy === 'workspace') {
    return 'A user-approved workspace file grant covers this participant.'
  }
  return 'This call uses the normal user approval request when the current policy requires it.'
}

/**
 * Keep the exact mutation route present on every dual-surface Ensemble turn.
 * Native file tools remain visible while intentionally read-only; after provider
 * context compaction, relying on an older routing note is not durable enough.
 */
export function buildProviderFileRoutingPrompt(input: {
  provider: ProviderId
  effectivePermissions: FileRoutingPermissions | null | undefined
}): string {
  const permissions = input.effectivePermissions
  const filePolicy = permissions?.agenticServices.fileChanges
  const mcpPolicy = permissions?.agenticServices.mcpTools
  if (
    !permissions ||
    !filePolicy ||
    !TASKWRAITH_MCP_FILE_PROVIDERS.has(input.provider) ||
    filePolicy === 'deny'
  ) {
    return ''
  }

  if (mcpPolicy === 'deny') return ''
  const writeTool = taskWraithToolNameForProvider(input.provider, 'write_file')
  const replaceTool = taskWraithToolNameForProvider(input.provider, 'replace')
  const patchTool = taskWraithToolNameForProvider(input.provider, 'apply_patch')
  const nativeToolFamily = input.provider === 'cursor' ? 'Cursor-native' : 'Codex-native'

  return [
    TASKWRAITH_FILE_ROUTING_PROMPT_OPEN,
    'TaskWraith file-routing (effective grant):',
    `- For workspace edits, call \`${patchTool}\` for a patch, or \`${writeTool}\` / \`${replaceTool}\` for an exact file operation, when the tool is listed. ${fileGrantSentence(filePolicy)}`,
    `- A refusal from a ${nativeToolFamily} apply_patch/edit/write tool that mentions a read-only sandbox or user approval settings describes that native containment route; it does not cancel the effective TaskWraith file grant. Do not repeat or reinterpret the native refusal. Route the original edit once through \`${patchTool}\` or the matching listed TaskWraith file tool.`,
    '- The brokered call is the write attempt: it enforces the signed permission posture, approved lane scope, exact path claims, and audit identity through TaskWraith locks, audit, and grants. If that TaskWraith call is unavailable, denied, or scope-blocked, report that exact blocker and do not probe another write transport.',
    TASKWRAITH_FILE_ROUTING_PROMPT_CLOSE,
    '',
    ''
  ].join('\n')
}
