// Pure helpers for building the Grok CLI argv. Kept free of Electron / IPC / fs
// imports so it can be unit-tested directly. The flags match `grok --help` on
// 0.2.8 and were re-verified unchanged on 0.2.32 and 0.2.51 — every flag we
// emit (-p, --cwd, --output-format streaming-json, --permission-mode, --deny,
// --resume, --model, --effort, --disable-web-search) is still present with
// the same value enums, and there is still NO per-run `--mcp-config` (per-run
// MCP stays an ACP session/new concern; `grok mcp add` mutates user/project
// config and is never used). The CLI is closely modelled on Claude Code, so
// `--deny` == `--disallowedTools` and `--permission-mode acceptEdits` mirrors
// Claude's.
//
// PERMISSION POSTURE (keyed off the composer's approval mode, exactly like
// Claude — see claudePermissionModeForApproval):
//   - approvalMode === 'plan' (or unset) → READ-ONLY: `--permission-mode plan`
//     + deny Bash/Edit/Write. Nothing is written.
//   - any other approval mode → FILE-WRITE: `--permission-mode acceptEdits`
//     so native Edit/Write are applied (then surfaced + gated by TaskWraith's
//     diff / Create-PR review, the same workspace-authority model TaskWraith uses
//     for Codex/Claude). Native **Bash stays denied** — TaskWraith can't mediate
//     Grok's native shell without an MCP server, and Grok 0.2.8 has no per-run
//     `--mcp-config` flag (G5c-ACP routes shell through TaskWraith's MCP + the
//     approval ledger instead).
// In NO mode is `--always-approve` ever emitted.

const GROK_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export function normalizeGrokEffortFlag(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed || trimmed === 'off') return null
  return GROK_EFFORT_LEVELS.has(trimmed) ? trimmed : null
}

/**
 * The deny rules that keep a Grok run read-only. Grok mirrors Claude Code's
 * tool-name grammar, so these map to `--disallowedTools` semantics.
 */
export const GROK_READ_ONLY_DENY_RULES = ['Bash(*)', 'Edit(*)', 'Write(*)'] as const

/**
 * Deny rules for FILE-WRITE mode: Edit/Write are allowed (diff-reviewed via
 * TaskWraith), but native shell stays denied — TaskWraith can't mediate Grok's Bash
 * without an MCP server, and 0.2.8 has no per-run `--mcp-config`. Shell
 * mediation is the ACP path (G5c-ACP: TaskWraith MCP + approval ledger).
 */
// Write mode now allows Bash too: a write-capable Grok turn that runs a shell
// command was hitting this deny and HARD-CANCELLING with no answer (stopReason
// Cancelled, 0 output). Since the user opted into write permissions, Grok's Bash
// runs unmediated in write mode (Edit/Write remain diff-reviewed via TaskWraith).
// Was ['Bash(*)'].
export const GROK_WRITE_MODE_DENY_RULES = [] as const

/** True when the approval mode permits writes (anything other than read-only plan). */
export function grokWriteCapable(approvalMode: string | null | undefined): boolean {
  // Trim before the 'plan' compare: a stray-whitespace value like 'plan ' must
  // still read as READ-ONLY. Without the trim it falls through to write-capable,
  // which silently drops the read-only posture (observed on resumed Grok runs).
  return (
    typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode.trim() !== 'plan'
  )
}

/**
 * READ-ONLY steer prepended to a read-only ACP seat's prompt. A read-only Grok
 * turn whose write/shell tool is refused by the host gate hard-cancels
 * (stopReason: cancelled / PermissionRejected) and dead-ends with no answer —
 * even ignoring an explicit user fallback. Steering Grok NOT to attempt the
 * write up front keeps the turn productive (it answers from read/inspection
 * tools instead). This is purely preventive UX: the host gate (the read-only
 * `--deny` rules + the onPermissionRequest auto-deny) remains the safety floor
 * and is unchanged. NEVER applied to a write-capable seat.
 */
export const GROK_READ_ONLY_PROMPT_PREAMBLE =
  'You are running in READ-ONLY mode. File writes, edits, and shell commands ' +
  'will be refused by the host — do not attempt them. Use only read and ' +
  'inspection tools and answer directly; if the task would require a write, ' +
  'explain what you would change instead of attempting it.'

/**
 * WRITE-mode steer prepended to a write-capable Grok turn's prompt. In write
 * mode Grok's Edit/Write tools are auto-approved (diff-reviewed), but a raw
 * shell command (mkdir/touch/…) is NOT auto-approved on the headless path and is
 * refused by the host — and Grok was treating that refusal as a dead-end
 * (stopReason: Cancelled, 0 output) instead of just writing the file. Steer it
 * to use the file tools and to adapt rather than end the turn on a refusal. Very
 * small on purpose: a nudge, not a policy. The host gate stays the safety floor.
 */
export const GROK_WRITE_MODE_PROMPT_PREAMBLE =
  'Create and edit files with the Write and Edit tools (they are approved and ' +
  'diff-reviewed here), not shell commands like mkdir or touch. If a tool call ' +
  'is refused or fails, do not end your turn — switch to an available tool such ' +
  'as Write and finish the task.'

/**
 * Prepend the read-only steer to a Grok ACP turn's prompt when the seat is
 * read-only; return the prompt unchanged for a write-capable seat. The
 * read-only-only gate lives here (single-sourced + unit-tested) so callers just
 * pass the already-computed `grokReadOnlySeat`.
 */
export function applyGrokReadOnlyPromptPreamble(prompt: string, readOnlySeat: boolean): string {
  if (!readOnlySeat) return prompt
  return `${GROK_READ_ONLY_PROMPT_PREAMBLE}\n\n${prompt}`
}

/**
 * Prepend the mode-appropriate steer to a Grok turn's prompt: a write-capable
 * seat gets the WRITE steer (use Write/Edit, and don't dead-end on a refused
 * tool); a read-only seat gets the read-only steer. Unlike
 * applyGrokReadOnlyPromptPreamble (which no-ops a write seat), this ALWAYS
 * prepends a steer — that is the fix for write/'default' seats silently
 * hard-cancelling when a shell tool is refused. Single-sourced + unit-tested so
 * the headless and ACP run paths stay in parity.
 */
export function applyGrokPromptPreamble(prompt: string, writeCapable: boolean): string {
  if (!writeCapable) return applyGrokReadOnlyPromptPreamble(prompt, true)
  return `${GROK_WRITE_MODE_PROMPT_PREAMBLE}\n\n${prompt}`
}

export function buildGrokProviderPrompt(
  prompt: string,
  approvalMode: string | null | undefined
): string {
  return applyGrokPromptPreamble(prompt, grokWriteCapable(approvalMode))
}

export interface BuildGrokCliArgsInput {
  prompt: string
  workspace: string
  model?: string | null
  reasoningEffort?: string | null
  /**
   * G6 — resume a prior Grok session by id so a chat is a persistent
   * conversation rather than a fresh turn each message. Grok's `-r/--resume
   * [SESSION_ID]` mirrors Claude's `--resume` and is valid in print (`-p`)
   * mode. The id is captured from the previous turn's terminal
   * `{type:'end',sessionId}` event (GrokStreamingJson → updateCliProviderSession)
   * and threaded back via the renderer's providerSessionId, exactly like
   * Claude. Grok sessions are cwd-scoped, so the workspace must match across
   * turns for the resume to attach.
   */
  providerSessionId?: string | null
  /**
   * G5c — the composer's approval mode. `'plan'`/unset = read-only;
   * anything else = file-write (acceptEdits + Edit/Write allowed, Bash still
   * denied). Mirrors Claude's claudePermissionModeForApproval.
   */
  approvalMode?: string | null
}

export function buildGrokCliArgs(input: BuildGrokCliArgsInput): string[] {
  const writeCapable = grokWriteCapable(input.approvalMode)
  const args: string[] = [
    '--no-auto-update',
    '-p',
    input.prompt,
    '--cwd',
    input.workspace,
    '--output-format',
    'streaming-json',
    '--permission-mode',
    // acceptEdits applies file edits without an interactive prompt (they're
    // reviewed via TaskWraith's diff/Create-PR surface); plan writes nothing.
    writeCapable ? 'acceptEdits' : 'plan',
    '--disable-web-search'
  ]
  const denyRules = writeCapable ? GROK_WRITE_MODE_DENY_RULES : GROK_READ_ONLY_DENY_RULES
  for (const rule of denyRules) {
    args.push('--deny', rule)
  }
  // G6 — resume the prior session by id (persistent conversation). Only emit
  // for a genuine non-empty id; a fresh chat (no id yet) starts a new session,
  // whose id is captured from the terminal event for the next turn.
  const resumeId = typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : ''
  if (resumeId) {
    args.push('--resume', resumeId)
  }
  // Only forward genuine Grok model ids (e.g. grok-code-fast-1). The composer's
  // CLI-default option — and any model id that leaked in from another provider's
  // picker (e.g. Gemini's 'flash-lite') — must NOT be passed: Grok rejects
  // unknown ids and the whole run fails. Real Grok model wiring is a later slice.
  if (input.model && input.model.startsWith('grok')) {
    args.push('--model', input.model)
  }
  const effort = normalizeGrokEffortFlag(input.reasoningEffort)
  if (effort) {
    args.push('--effort', effort)
  }
  return args
}

export function buildGrokProviderCliArgs(input: BuildGrokCliArgsInput): string[] {
  return buildGrokCliArgs({
    ...input,
    prompt: buildGrokProviderPrompt(input.prompt, input.approvalMode)
  })
}
