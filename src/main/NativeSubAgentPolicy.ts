import type { NativeSubAgentRequestPolicy, ProviderId } from './store/types'
import { taskWraithToolNameForProvider } from './TaskWraithMcpPromptNames'

const NATIVE_SUB_AGENT_TOOL_NAMES = new Set([
  'task',
  'invoke_agent',
  'invokeagent',
  'create_agent',
  'createagent',
  'run_agent',
  'runagent',
  'spawn_agent',
  'spawnagent',
  'subagent',
  'sub_agent',
  'agent'
])

export function normalizeNativeSubAgentPolicy(
  value: unknown
): NativeSubAgentRequestPolicy {
  return value === 'provider' || value === 'taskwraith' ? value : 'ask'
}

export function normalizeNativeSubAgentToolName(toolName: string): string {
  return String(toolName || '')
    .trim()
    .replace(/^mcp__/i, '')
    .replace(/^taskwraith__/i, '')
    .split('__')
    .pop()!
    .replace(/[\s.-]+/g, '_')
    .toLowerCase()
}

export function isNativeSubAgentToolName(toolName: string): boolean {
  const normalized = normalizeNativeSubAgentToolName(toolName)
  return NATIVE_SUB_AGENT_TOOL_NAMES.has(normalized)
}

export function previewNativeSubAgentTask(input: unknown): string {
  if (typeof input === 'string') return input.trim().slice(0, 1200)
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const candidates = [
    record.prompt,
    record.description,
    record.task,
    record.instructions,
    record.input,
    record.message
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 1200)
    }
  }
  try {
    return JSON.stringify(record).slice(0, 1200)
  } catch {
    return ''
  }
}

export function nativeSubAgentRedirectMessage(args: {
  provider: ProviderId
  toolName: string
  input?: unknown
}): string {
  const prompt = previewNativeSubAgentTask(args.input)
  const sameProvider = args.provider
  const mcpName = taskWraithToolNameForProvider(args.provider, 'delegate_to_subthread')
  return [
    'Native sub-agent requests are configured to use TaskWraith sub-threads.',
    `Do not use the provider-native ${args.toolName} tool for this request.`,
    `Call ${mcpName} with provider="${sameProvider}", prompt="${
      prompt || '<the delegated task>'
    }", returnResult=true.`,
    'TaskWraith sub-threads are durable, visible in the sidebar/iOS, recallable, and audited.'
  ].join('\n')
}

export function nativeSubAgentPromptInstruction(
  policy: NativeSubAgentRequestPolicy | undefined,
  provider: ProviderId
): string | null {
  const normalized = normalizeNativeSubAgentPolicy(policy)
  const mcpName = taskWraithToolNameForProvider(provider, 'delegate_to_subthread')
  if (normalized === 'provider') {
    return `Native sub-agent requests are set to Provider. You may use provider-native multi-agent orchestration tools for same-provider work; use ${mcpName} for durable TaskWraith sub-threads and any cross-provider delegation.`
  }
  if (normalized === 'taskwraith') {
    return `Native sub-agent requests are set to TaskWraith. Do not use provider-native multi-agent orchestration tools; call ${mcpName}({ provider, prompt, returnResult: true }) for delegated work so the task is durable, iOS-visible, recallable, and audited.`
  }
  return `Native sub-agent requests are set to Ask. If a provider-native multi-agent orchestration tool is available, TaskWraith may ask the user whether to continue natively or redirect to ${mcpName}; for durable/iOS-visible delegation, prefer ${mcpName}.`
}
