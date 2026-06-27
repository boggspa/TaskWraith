// Pure helpers for building Claude CLI argv. Kept free of Electron / IPC / fs
// imports so it can be unit-tested directly. The argv values match the flags
// exposed by the installed Claude Code CLI (`claude --help`).

const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CLAUDE_SONNET_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])
const CLAUDE_EFFORT_ALIASES: Record<string, string> = {
  extra: 'xhigh',
  ultracode: 'max'
}

export function normalizeClaudeEffortFlag(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed || trimmed === 'off') return null
  const normalized = CLAUDE_EFFORT_ALIASES[trimmed] || trimmed
  return CLAUDE_EFFORT_LEVELS.has(normalized) ? normalized : null
}

export function normalizeClaudeEffortFlagForModel(
  value: string | null | undefined,
  model: string | null | undefined
): string | null {
  const normalized = normalizeClaudeEffortFlag(value)
  if (!normalized) return null
  const modelKey = String(model || '').toLowerCase()
  if (modelKey.includes('haiku')) return null
  if (modelKey.includes('sonnet')) {
    return CLAUDE_SONNET_EFFORT_LEVELS.has(normalized) ? normalized : null
  }
  return normalized
}

export interface BuildClaudeCliArgsInput {
  prompt: string
  permissionMode: string
  model: string
  providerSessionId?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  imagePaths?: string[] | null
}

export function claudeFastModeSettingsArg(value: boolean | null | undefined): string | null {
  return typeof value === 'boolean' ? JSON.stringify({ fastMode: value }) : null
}

export function buildClaudeCliArgs(input: BuildClaudeCliArgsInput): string[] {
  const args: string[] = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    input.permissionMode
  ]
  if (input.model && input.model !== 'default') {
    args.push('--model', input.model)
  }
  if (input.providerSessionId) {
    args.push('--resume', input.providerSessionId)
  }
  const effort = normalizeClaudeEffortFlagForModel(input.claudeReasoningEffort, input.model)
  if (effort) {
    args.push('--effort', effort)
  }
  const fastModeSettings = claudeFastModeSettingsArg(input.claudeFastMode)
  if (fastModeSettings) {
    args.push('--settings', fastModeSettings)
  }
  for (const imagePath of input.imagePaths || []) {
    args.push('--image', imagePath)
  }
  return args
}
