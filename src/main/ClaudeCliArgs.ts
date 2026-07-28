// Pure helpers for building Claude CLI argv. Kept free of Electron / IPC / fs
// imports so it can be unit-tested directly. The argv values match the flags
// exposed by the installed Claude Code CLI (`claude --help`).

const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CLAUDE_SONNET_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])
// Sonnet 5 family (claude-sonnet-5, claude-sonnet-5-1m, …) gets the full Opus
// ladder; the trailing non-digit guard avoids matching a `claude-sonnet-50`
// lookalike. Kept in sync with ensembleProviderDefaults' CLAUDE_SONNET_5_FAMILY.
const CLAUDE_SONNET_5_FAMILY = /sonnet-5(?![0-9])/
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
  // Sonnet 5 uses the full Opus-equivalent effort ladder; only the legacy
  // Sonnet 4.x line is clamped to the reduced set.
  if (modelKey.includes('sonnet') && !CLAUDE_SONNET_5_FAMILY.test(modelKey)) {
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

/** Select the prompt for a Claude dispatch (SDK and CLI lanes share this
 * rule). A resumable session carries its own history, so the slim prompt is
 * correct. A sessionless dispatch — fresh chat, lost CLI session, or a seat
 * rotation that nulled providerSessionId AFTER composition — must send the
 * full-context recovery prompt (compaction summary + compact transcript)
 * composed for exactly this case, so the conversation is seeded rather than
 * starting cold. Prompt and fallback are HMAC-signed together in the run
 * posture; selecting between them here never mutates the signed payload. */
export function claudeDispatchPrompt(payload: {
  prompt: string
  providerSessionId?: string | null
  resumeFallbackPrompt?: string | null
}): string {
  if (payload.providerSessionId) return payload.prompt
  return payload.resumeFallbackPrompt || payload.prompt
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
    input.permissionMode,
    // Empty --tools disables every built-in, including future additions. MCP
    // servers load separately and remain available through their namespaces.
    '--tools',
    ''
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
