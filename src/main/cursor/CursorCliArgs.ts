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
   * `.cursor/mcp.json` registering the full brokered TaskWraith MCP server was
   * written, with matching `Mcp(<server>:<tool>)` allow rules). Adds
   * `--approve-mcps` so the bridge's tools don't block on the interactive
   * MCP-approval prompt. Only ever set for write-capable runs (default mode);
   * plan mode executes no MCP tools. `--approve-mcps` auto-approves MCP servers
   * ONLY — never shell/write — so it stays within the never-`--force`/`--yolo`
   * rule.
   */
  webBridgeActive?: boolean
  /**
   * True when a READ-ONLY safe-subset TaskWraith MCP bridge is active for this
   * run (Grok-parity: a scoped `--safe-subset` broker advertising ONLY the
   * non-mutating read tools was registered, with native `Shell(**)`/`Write(**)`
   * denied in `.cursor/cli.json`). Because Cursor `--mode plan` executes NO
   * tools, a read-only seat that should still be able to read must run in
   * DEFAULT mode — contained by the deny-list + the safe-subset broker (which
   * offers no write/shell tool at all), which is strictly more restrictive than
   * a write seat. Set only by the caller after it wrote the containment config.
   * Ignored for write-capable runs (which use the full bridge via
   * `webBridgeActive`). Adds `--approve-mcps` and SUPPRESSES `--mode plan`.
   */
  readOnlyBridgeActive?: boolean
}

export interface BuildCursorProviderCliArgsInput extends BuildCursorCliArgsInput {
  taskWraithMcpActive?: boolean
  /** True when the read-only safe-subset broker was set up for this run (only
   *  ever true when `taskWraithMcpActive` is false — the two are exclusive). */
  taskWraithReadOnlyMcpActive?: boolean
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
  // A read-only seat with an active safe-subset bridge is CONTAINED (deny-list +
  // read-only-only broker) and must run in DEFAULT mode, because `--mode plan`
  // executes no tools — including the read tools the seat was just given.
  const readOnlyContained = !writeCapable && Boolean(input.readOnlyBridgeActive)
  // Read-only safety: plan mode performs no edits (proven). Write mode runs in
  // default mode; native side effects are contained by the deny-list config.
  // A read-only-contained seat also runs in default mode (contained instead).
  // NEVER `--force` / `--yolo`.
  if (!writeCapable && !readOnlyContained) {
    args.push('--mode', 'plan')
  }
  // TaskWraith MCP bridge: pre-approve the TaskWraith MCP server's tools —
  // guarded by the caller, which sets webBridgeActive / readOnlyBridgeActive
  // only when it wrote the mcp.json + allow rule. Auto-approves MCP servers
  // ONLY, not shell/write; the read-only path's broker is safe-subset anyway.
  if ((writeCapable && input.webBridgeActive) || readOnlyContained) {
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
    // Honor the chat's approval mode only when the WRITE containment config is
    // in place; otherwise force read-only. A read-only seat with the safe-subset
    // broker still runs (contained) in default mode via readOnlyBridgeActive.
    approvalMode: input.taskWraithMcpActive ? input.approvalMode : 'plan',
    webBridgeActive: Boolean(input.taskWraithMcpActive),
    readOnlyBridgeActive:
      !input.taskWraithMcpActive && Boolean(input.taskWraithReadOnlyMcpActive)
  })
}
