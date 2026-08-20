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

import type { ActiveGoal } from '../store/types'
import {
  isGrok45ReasoningModelId,
  isGrokReasoningModelId
} from '../../shared/grok45Models'
import { GROK_BROKER_MCP_TOOL_NAMESPACE } from '../index.constants'

const GROK_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh'])

export function normalizeGrokEffortFlag(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = String(value).trim().toLowerCase()
  if (!trimmed || trimmed === 'off') return null
  return GROK_EFFORT_LEVELS.has(trimmed) ? trimmed : null
}

/**
 * The deny rules that keep a Grok run read-only. Grok mirrors Claude Code's
 * tool-name grammar, so these map to `--disallowedTools` semantics.
 *
 * Deny BOTH shell tool names: the classic Grok CLI names its shell tool `Bash`,
 * but the Grok Composer model (Composer 2.5 Fast) names it `Shell`. These deny
 * rules are the PREVENTION backstop behind the read-only prompt steer, and a
 * gap here is fatal: if Composer reaches for an un-denied `Shell` (e.g. a
 * `git status` during a read-only review), the host gate refuses it and Grok
 * treats the bare reject as a turn-ending CANCEL (stopReason: cancelled, no
 * answer) instead of answering from the reads it already did. See the read-only
 * seat wiring in index.ts.
 */
export const GROK_READ_ONLY_DENY_RULES = [
  'Bash(*)',
  'Shell(*)',
  'Edit(*)',
  'Write(*)',
  'Read(*)',
  'ReadFile(*)',
  'Glob(*)',
  'Grep(*)'
] as const

/**
 * Deny rules for FILE-WRITE mode: Edit/Write are allowed (diff-reviewed via
 * TaskWraith), but native shell stays denied — TaskWraith can't mediate Grok's Bash
 * without an MCP server, and 0.2.8 has no per-run `--mcp-config`. Shell
 * mediation is the ACP path (G5c-ACP: TaskWraith MCP + approval ledger).
 */
// Write-capable turns use the TaskWraith MCP broker for the same operations.
// Approval posture changes what that signed broker may do inside the canonical
// workspace; it never gives Grok's opaque native tools host filesystem access.
export const GROK_WRITE_MODE_DENY_RULES = GROK_READ_ONLY_DENY_RULES

/**
 * ACP seats deny the native mutation primitives in BOTH modes — read-only and
 * write-capable alike. `GROK_ACP_WRITE_MODE_DENY_RULES` is deliberately the
 * same list as the read-only one, so a write-capable seat still ships
 * `--deny Edit(*) --deny Write(*)`; native reads (Read/Glob/Grep) stay
 * available in both. This is intentional, not drift: it is pinned by the
 * "keeps ACP native edits broker-only on write-capable seats" test.
 *
 * The consequence is worth stating plainly, because the argv reads like a
 * posture leak when you see it on a live write-capable process: a Grok seat's
 * writes go through the TaskWraith broker (`apply_patch` / `write_file`),
 * never through Grok's own Edit/Write. Elevating the permission preset does
 * NOT change these flags, and is not supposed to.
 *
 * Native shell remains denied in both modes too: the client-mediated
 * `session/request_permission` hook can validate cwd, but Grok does not yet
 * provide a hard workspace-rooted shell sandbox to contain absolute paths or
 * network egress. Shell goes through the broker as well.
 */
export const GROK_ACP_READ_ONLY_DENY_RULES = [
  'Bash(*)',
  'Shell(*)',
  'Edit(*)',
  'Write(*)'
] as const

export const GROK_ACP_WRITE_MODE_DENY_RULES = GROK_ACP_READ_ONLY_DENY_RULES

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
  'You are running in READ-ONLY mode (recon / investigation). You CAN read and ' +
  'inspect through the native read/file tools that are actually listed. Native Bash/Shell ' +
  'and TaskWraith shell tools are unavailable in this seat, so do not attempt or search ' +
  'for a shell route. An explicit no-tools instruction ' +
  'in the user request or role brief overrides that allowance: do not call read, ' +
  'shell, file, goal, or any other tool. File writes and edits, and ' +
  'MUTATING shell commands (anything that changes files or git state, installs ' +
  'packages, or has other side effects) are refused by the host — do not ' +
  'attempt them; if the task would need one, describe what you would change ' +
  'instead. If a tool call is refused, do NOT end your turn — summarise what ' +
  'you found from the reads you did and answer the user directly. Do not substitute ' +
  'unrelated workspace or goal tools for a failed coordination call.'

const GROK_MCP_QUESTION_TOOL_NAME = `${GROK_BROKER_MCP_TOOL_NAMESPACE}__ask_user_question`
export const GROK_MCP_SHELL_TOOL_NAME = `${GROK_BROKER_MCP_TOOL_NAMESPACE}__run_shell_command`

export const GROK_MCP_QUESTION_PROMPT_NOTE =
  `To ask the user a question, call ${GROK_MCP_QUESTION_TOOL_NAME}. ` +
  'Do not use Grok native question or elicitation UI; ACP does not connect it to TaskWraith desktop or iOS.'

export const GROK_MCP_SHELL_PROMPT_NOTE =
  `For shell work (tests, builds, git, directory listings, npm), call ${GROK_MCP_SHELL_TOOL_NAME}. ` +
  'That route is host-mediated and honors your shell permission grants and approval policy. ' +
  'Native Bash/Shell tools are unavailable here — do not attempt them.'

/**
 * WRITE-mode steer prepended to a write-capable Grok turn's prompt. In write
 * mode Grok's native Edit/Write/Bash/Shell tools remain denied. Mutations go
 * through the TaskWraith MCP broker so each exact edit target is acquired and
 * released around the operation. Steer away from dead-ending on a refused tool.
 * The host gate stays the safety floor.
 */
export const GROK_WRITE_MODE_PROMPT_PREAMBLE =
  'When the task requests file changes, use the TaskWraith MCP file tools; native Write/Edit ' +
  'cannot participate in exact edit transactions. For supported shell work, use the TaskWraith ' +
  'MCP run_shell_command tool — native Bash/Shell are unavailable. An explicit no-tools instruction in the user ' +
  'request or role brief overrides that allowance: do not call shell, file, goal, ' +
  'or any other tool. If a tool call is refused or fails, do not end your turn; ' +
  'retry only the same requested operation with an equivalent allowed tool. Never ' +
  'substitute unrelated shell, file, or goal calls for a failed coordination call; ' +
  'otherwise report the failure and answer in prose.'

/**
 * Write seats remain useful when the per-run broker setup fails, but must never
 * be told to call a tool that did not attach. Native Bash/Shell remains denied
 * in both variants; this one makes the degraded boundary explicit.
 */
export const GROK_WRITE_MODE_NO_BROKER_PROMPT_PREAMBLE =
  'The TaskWraith mutation broker is not verified for this turn, so this run can inspect and explain but cannot change files. ' +
  'Native Write/Edit/Bash/Shell are unavailable. ' +
  'Do not call, search for, or retry a TaskWraith shell tool. An explicit no-tools instruction in the user ' +
  'request or role brief overrides that allowance: do not call file, goal, or any other tool. ' +
  'If shell work is required, report that exact blocker and answer from the evidence already available; ' +
  'do not substitute unrelated side effects.'

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
export function applyGrokPromptPreamble(
  prompt: string,
  writeCapable: boolean,
  taskWraithShellToolAvailable = false
): string {
  if (!writeCapable) return applyGrokReadOnlyPromptPreamble(prompt, true)
  const preamble = taskWraithShellToolAvailable
    ? GROK_WRITE_MODE_PROMPT_PREAMBLE
    : GROK_WRITE_MODE_NO_BROKER_PROMPT_PREAMBLE
  return `${preamble}\n\n${prompt}`
}

export function formatGrokGoalSlashCommand(goal: ActiveGoal | null | undefined): string | null {
  if (!goal) return null
  if (goal.mode !== 'grok_native') return null
  if (goal.status !== 'active' && goal.status !== 'blocked') return null
  const objective = goal.objective.replace(/\s+/g, ' ').trim()
  if (!objective) return null
  return `/goal ${objective}`
}

export function applyGrokNativeGoalPrompt(
  prompt: string,
  goal: ActiveGoal | null | undefined
): string {
  const command = formatGrokGoalSlashCommand(goal)
  if (!command) return prompt
  return `${command}\n\n${prompt}`
}

export function buildGrokProviderPrompt(
  prompt: string,
  approvalMode: string | null | undefined,
  activeGoal?: ActiveGoal | null,
  options?: {
    taskWraithQuestionToolAvailable?: boolean
    taskWraithShellToolAvailable?: boolean
  }
): string {
  let brokerAwarePrompt = prompt
  if (
    options?.taskWraithShellToolAvailable &&
    grokWriteCapable(approvalMode) &&
    !prompt.includes(GROK_MCP_SHELL_TOOL_NAME)
  ) {
    brokerAwarePrompt = `${GROK_MCP_SHELL_PROMPT_NOTE}\n\n${brokerAwarePrompt}`
  }
  const questionAwarePrompt =
    options?.taskWraithQuestionToolAvailable && !brokerAwarePrompt.includes(GROK_MCP_QUESTION_TOOL_NAME)
      ? `${GROK_MCP_QUESTION_PROMPT_NOTE}\n\n${brokerAwarePrompt}`
      : brokerAwarePrompt
  return applyGrokNativeGoalPrompt(
    applyGrokPromptPreamble(
      questionAwarePrompt,
      grokWriteCapable(approvalMode),
      Boolean(options?.taskWraithShellToolAvailable)
    ),
    activeGoal
  )
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
  activeGoal?: ActiveGoal | null
}

export interface BuildGrokAcpCliArgsInput {
  model?: string | null
  reasoningEffort?: string | null
  readOnlySeat?: boolean
}

function appendGrokModelAndEffortArgs(
  args: string[],
  input: { model?: string | null; reasoningEffort?: string | null }
): void {
  // Only forward genuine Grok model ids (e.g. grok-composer-2.5-fast). The
  // composer's CLI-default option — and any model id that leaked in from another
  // provider's picker (e.g. Gemini's 'flash-lite') — must NOT be passed: Grok
  // rejects unknown ids and the whole run fails.
  if (input.model && input.model.startsWith('grok')) {
    args.push('--model', input.model)
  }
  const allowsReasoning = !input.model || isGrokReasoningModelId(input.model)
  const effort = allowsReasoning ? normalizeGrokEffortFlag(input.reasoningEffort) : null
  // Extra High is a Grok 4.6 capability; retained 4.5 aliases still expose
  // only low/medium/high in the catalogue and must not receive `xhigh` argv.
  if (effort && !(effort === 'xhigh' && isGrok45ReasoningModelId(input.model))) {
    args.push('--effort', effort)
  }
}

export function buildGrokCliArgs(input: BuildGrokCliArgsInput): string[] {
  const writeCapable = grokWriteCapable(input.approvalMode)
  const args: string[] = [
    '--no-auto-update',
    '--tools',
    '',
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
  appendGrokModelAndEffortArgs(args, input)
  return args
}

export function buildGrokAcpCliArgs(input: BuildGrokAcpCliArgsInput): string[] {
  const args = ['--no-auto-update', '--tools', '']
  const denyRules = input.readOnlySeat
    ? GROK_ACP_READ_ONLY_DENY_RULES
    : GROK_ACP_WRITE_MODE_DENY_RULES
  for (const rule of denyRules) args.push('--deny', rule)
  appendGrokModelAndEffortArgs(args, input)
  args.push('agent', 'stdio')
  return args
}

export function buildGrokProviderCliArgs(input: BuildGrokCliArgsInput): string[] {
  return buildGrokCliArgs({
    ...input,
    prompt: buildGrokProviderPrompt(input.prompt, input.approvalMode, input.activeGoal)
  })
}
