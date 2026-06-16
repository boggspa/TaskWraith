// Pure builder for the Cursor Agent CLI argv (`cursor-agent -p …`). No Electron
// imports — unit-testable. Mirrors GrokCliArgs.
//
// LOAD-BEARING SAFETY (proven by the CR3 live spike — see the blueprint):
//   * A bare `cursor-agent -p` has write+shell and uses them UNMEDIATED. So we
//     NEVER spawn bare `-p`: read-only runs always pass `--mode plan` (proven
//     to refuse edits), and write runs are contained by a workspace-local
//     `.cursor/cli.json` deny-list (written by CursorWorkspaceConfig, NOT here).
//   * We NEVER pass `--force` / `--yolo` (they auto-allow everything).
//   * Only Composer 2.5 model ids are forwarded — TaskWraith exposes no other
//     Cursor-proxied model.

import { CURSOR_COMPOSER_MODEL_IDS } from './CursorCliProbe'

/**
 * `'plan'` / unset = read-only (`--mode plan`, no edits). Anything else =
 * write-capable (default mode + the deny-list config contains native side
 * effects). Mirrors grokWriteCapable / claudePermissionModeForApproval.
 */
export function cursorWriteCapable(approvalMode: string | null | undefined): boolean {
  return typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode !== 'plan'
}

export interface BuildCursorCliArgsInput {
  prompt: string
  workspace: string
  model?: string | null
  /** Resume a prior chat by id (Cursor `--resume <chatId>`). */
  providerSessionId?: string | null
  /** Composer approval mode: 'plan'/unset = read-only; else write-capable. */
  approvalMode?: string | null
  /**
   * True when the TaskWraith MCP bridge is active for this run (a per-run
   * `.cursor/mcp.json` registering the `taskwraith` MCP server was written, with
   * an `allow: ["Mcp(taskwraith:*)"]` rule). Adds `--approve-mcps` so the
   * bridge's tools don't block on the interactive MCP-approval prompt. Only ever
   * set for write-capable runs (default mode); plan mode executes no MCP tools.
   * `--approve-mcps` auto-approves MCP servers ONLY — never shell/write — so it
   * stays within the never-`--force`/`--yolo` rule.
   */
  webBridgeActive?: boolean
}

export interface BuildCursorProviderCliArgsInput extends BuildCursorCliArgsInput {
  taskWraithMcpActive?: boolean
}

/** True only for the canonical Composer 2.5 ids (composer-2.5 / -fast). Any
 *  other value (CLI-default sentinel, a leaked id from another provider's
 *  picker) is dropped so Cursor falls back to its account default rather than
 *  erroring on an unknown model. */
function isComposerModel(model: string | null | undefined): model is string {
  return typeof model === 'string' && CURSOR_COMPOSER_MODEL_IDS.includes(model)
}

export function buildCursorCliArgs(input: BuildCursorCliArgsInput): string[] {
  const writeCapable = cursorWriteCapable(input.approvalMode)
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    // Headless: trust the workspace so the run doesn't block on the interactive
    // "Trust this workspace" prompt (only valid with --print).
    '--trust',
    '--workspace',
    input.workspace
  ]
  // Read-only safety: plan mode performs no edits (proven). Write mode runs in
  // default mode; native side effects are contained by the deny-list config.
  // NEVER `--force` / `--yolo`.
  if (!writeCapable) {
    args.push('--mode', 'plan')
  }
  // TaskWraith MCP bridge: pre-approve the TaskWraith MCP server's tools (write
  // mode only — guarded by the caller, which sets this only when it wrote the
  // mcp.json + allow rule). Auto-approves MCP servers ONLY, not shell/write.
  if (writeCapable && input.webBridgeActive) {
    args.push('--approve-mcps')
  }
  const resumeId = typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : ''
  if (resumeId) {
    args.push('--resume', resumeId)
  }
  if (isComposerModel(input.model)) {
    args.push('--model', input.model)
  }
  // Prompt is the trailing positional.
  args.push(input.prompt)
  return args
}

export function buildCursorProviderCliArgs(input: BuildCursorProviderCliArgsInput): string[] {
  return buildCursorCliArgs({
    ...input,
    approvalMode: input.taskWraithMcpActive ? input.approvalMode : 'plan',
    webBridgeActive: Boolean(input.taskWraithMcpActive)
  })
}
