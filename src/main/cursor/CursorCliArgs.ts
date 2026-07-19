// Pure builder for the Cursor Agent CLI argv (`cursor-agent -p …`). No Electron
// imports — unit-testable. Mirrors GrokCliArgs.
//
// LOAD-BEARING SAFETY:
//   * A bare `cursor-agent -p` has write+shell and uses them UNMEDIATED. So we
//     NEVER spawn a production Cursor run. Authenticated startup can preload
//     account/team hooks, managed skills/plugins, and MCP before a turn, even
//     with private roots, excluded workspace context, and plan mode.
//   * This builder is retained for hermetic argv tests and non-production
//     qualification work only; it is not a production admission boundary.
//   * `--force` remains behind an explicit containment-attestation input. No
//     production caller currently supplies that attestation. `--yolo` is never
//     emitted. `--approve-mcps` is never emitted because it approves Cursor's
//     aggregate MCP catalogue rather than one TaskWraith-owned server.
//   * Only TaskWraith-exposed Cursor model ids are forwarded. Cursor-proxied
//     native-provider models are still dropped unless explicitly listed here.

import { CURSOR_COMPOSER_MODEL_IDS } from './CursorCliProbe'
import { resolveCursorGrok45CliModelId } from '../../shared/grok45Models'
import { normalizeCliProviderModel } from '../providers/StaticProviderModels'
import type { EffectiveRunPermissions } from '../store/types'
import { cursorMcpToolsDenied } from './CursorMcpPolicy'

/**
 * Classify a requested legacy/qualification argv posture. This does not make
 * either posture admissible for a production Cursor process.
 */
export function cursorWriteCapable(approvalMode: string | null | undefined): boolean {
  return typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode !== 'plan'
}

export interface BuildCursorCliArgsInput {
  prompt: string
  workspace: string
  model?: string | null
  reasoningEffort?: string | null
  fastModeEnabled?: boolean | null
  /** Resume a prior chat by id (Cursor `--resume <chatId>`). */
  providerSessionId?: string | null
  /** Composer approval mode: 'plan'/unset = read-only; else write-capable. */
  approvalMode?: string | null
  /** Canonical main-resolved posture. An explicit MCP deny suppresses every
   * bridge approval/force flag even if a stale caller claims a bridge is live. */
  effectivePermissions?: Pick<EffectiveRunPermissions, 'agenticServices'> | null
  /**
   * Qualification-only exact-version containment input. Production admission
   * is disabled before this builder is reached.
   */
  containmentAttested?: boolean
  /** Add exact-build flags that suppress provider project config/context. */
  isolateProjectConfigs?: boolean
  /**
   * Legacy/qualification-only bridge input (a per-run
   * `.cursor/mcp.json` registering the full brokered TaskWraith MCP server was
   * written, with matching `Mcp(<server>:<tool>)` allow rules). Adds
   * `--approve-mcps` so the bridge's tools don't block on the interactive
   * MCP-approval prompt. Only ever set for write-capable runs (default mode);
   * plan mode executes no MCP tools. Ignored without `containmentAttested`.
   * No production caller may set this.
   */
  webBridgeActive?: boolean
  /**
   * Legacy/qualification-only READ-ONLY safe-subset bridge input for this
   * run (Grok-parity: a scoped `--safe-subset` broker advertising ONLY the
   * non-mutating read tools was registered, with native `Shell(**)`/`Write(**)`
   * denied in `.cursor/cli.json`). Because Cursor `--mode plan` executes NO
   * tools, a read-only seat that should still be able to read must run in
   * DEFAULT mode — contained by the deny-list + the safe-subset broker (which
   * offers no write/shell tool at all), which is strictly more restrictive than
   * a write seat. Set only by the caller after it wrote the containment config.
   * Ignored for write-capable runs (which use the full bridge via
   * `webBridgeActive`). Suppresses `--mode plan` only when attested. No
   * production caller may set this.
   */
  readOnlyBridgeActive?: boolean
  /**
   * Qualification-only request to emit `--force` alongside the active bridge
   * headlessly (see the `--force` note in buildCursorCliArgs). Default (undefined)
   * = ON whenever the bridge is active. Set to `false` to withhold it (the MCP
   * tools then get rejected, the pre-fix behavior). Only ever has effect when the
   * bridge is active — never adds `--force` to a bare/plan run. Production
   * Cursor admission is disabled and must never reach this branch.
   */
  forceAllowTools?: boolean
}

export interface BuildCursorProviderCliArgsInput extends BuildCursorCliArgsInput {
  taskWraithMcpActive?: boolean
  /** True when the read-only safe-subset broker was set up for this run (only
   *  ever true when `taskWraithMcpActive` is false — the two are exclusive). */
  taskWraithReadOnlyMcpActive?: boolean
  /** Gate for `--force` (see forceAllowTools). Threaded from cursorForceMcpEnabled();
   *  index.ts passes `false` when the kill-switch is set. */
  forceAllowMcpTools?: boolean
}

/** Resolve only canonical TaskWraith-exposed Cursor ids. Any other value
 * (CLI-default sentinel, a leaked id from another provider's picker) is dropped
 * so Cursor falls back to its account default rather than erroring. */
function resolveCursorModelArg(input: {
  model?: string | null
  reasoningEffort?: string | null
  fastModeEnabled?: boolean | null
}): string | null {
  const grok45 = resolveCursorGrok45CliModelId(input)
  if (grok45) return grok45
  return typeof input.model === 'string' && CURSOR_COMPOSER_MODEL_IDS.includes(input.model)
    ? input.model
    : null
}

export function buildCursorCliArgs(input: BuildCursorCliArgsInput): string[] {
  const mcpToolsDenied = cursorMcpToolsDenied(input.effectivePermissions)
  // Production admission rejects Cursor before this qualification-only builder.
  // Independently clamp absent attestation so stale bridge booleans cannot
  // produce an uncontained default-mode argv in tests or future probes.
  const containmentAttested = input.containmentAttested === true
  const writeCapable =
    containmentAttested && cursorWriteCapable(input.approvalMode) && !mcpToolsDenied
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
  if (input.isolateProjectConfigs) {
    args.push('--disable-project-configs', '--exclude-workspace-context')
  }
  // A read-only seat with an active safe-subset bridge is CONTAINED (deny-list +
  // read-only-only broker) and must run in DEFAULT mode, because `--mode plan`
  // executes no tools — including the read tools the seat was just given.
  const readOnlyContained =
    containmentAttested &&
    !mcpToolsDenied &&
    !writeCapable &&
    Boolean(input.readOnlyBridgeActive)
  const bridgeActive =
    !mcpToolsDenied &&
    ((writeCapable && Boolean(input.webBridgeActive)) || readOnlyContained)
  // Read-only safety: plan mode performs no edits (proven). Write mode runs in
  // default mode; native side effects are contained by the deny-list config.
  // A read-only-contained seat also runs in default mode (contained instead).
  if (!writeCapable && !readOnlyContained) {
    args.push('--mode', 'plan')
  }
  if (bridgeActive) {
    // Cursor has no single-server approve flag. Never use `--approve-mcps`,
    // which approves the aggregate catalogue. This qualification-only branch
    // is unreachable from production while Cursor admission is disabled.
    if (input.forceAllowTools !== false) {
      args.push('--force')
    }
  }
  const resumeId = typeof input.providerSessionId === 'string' ? input.providerSessionId.trim() : ''
  if (resumeId) {
    args.push('--resume', resumeId)
  }
  const modelArg = resolveCursorModelArg(input)
  if (modelArg) {
    args.push('--model', modelArg)
  }
  // Prompt is the trailing positional.
  args.push(input.prompt)
  return args
}

export function buildCursorProviderCliArgs(input: BuildCursorProviderCliArgsInput): string[] {
  const mcpToolsDenied = cursorMcpToolsDenied(input.effectivePermissions)
  return buildCursorCliArgs({
    ...input,
    // Honor the chat's approval mode only when the WRITE containment config is
    // in place; otherwise force read-only. A read-only seat with the safe-subset
    // broker still runs (contained) in default mode via readOnlyBridgeActive.
    approvalMode:
      input.containmentAttested && input.taskWraithMcpActive && !mcpToolsDenied
        ? input.approvalMode
        : 'plan',
    webBridgeActive:
      input.containmentAttested && !mcpToolsDenied && Boolean(input.taskWraithMcpActive),
    readOnlyBridgeActive:
      input.containmentAttested &&
      !mcpToolsDenied &&
      !input.taskWraithMcpActive &&
      Boolean(input.taskWraithReadOnlyMcpActive),
    forceAllowTools: input.forceAllowMcpTools
  })
}

export interface BuildContainedCursorReadOnlyArgvInput {
  workspace: string
  prompt: string
  model?: string | null
  /** Both `ask` and `plan` are read-only (non-mutating) Cursor modes. */
  mode?: 'ask' | 'plan'
}

/**
 * Production read-only Cursor launch surface (Path B: real ~/.cursor login +
 * native OS sandbox). Unlike the legacy/qualification `buildCursorCliArgs`, this
 * argv is what `runCursorProvider` actually spawns once a binary clears
 * `admitCursorRuntime`. Its containment is LOAD-BEARING:
 *   * `--sandbox enabled` hard-pins the native Seatbelt OS sandbox — live
 *     validated to block writes to the user's HOME even with write+shell — and
 *     is the universal impact bound for any startup-executed account code. It is
 *     never droppable; `--sandbox disabled` is never emitted.
 *   * A read-only `--mode` (`ask`/`plan`, both non-mutating) is the belt to the
 *     sandbox's suspenders.
 *   * `--skip-worktree-setup` blocks the `.cursor/worktrees.json` setup scripts.
 *   * `--trust` avoids the interactive "trust this workspace" prompt (headless).
 * It NEVER emits `--force`, `--yolo`, `--approve-mcps`, `--api-key`, or
 * `--sandbox disabled`. No CURSOR_CONFIG_DIR/DATA override is applied — the
 * caller inherits the user's real config via the process env (Path B), bounded
 * by the sandbox. The prompt is passed after a `--` end-of-options guard (see
 * below). Only canonical TaskWraith-exposed Cursor model ids survive
 * normalization; a requested model is always coerced to a concrete Cursor id,
 * and an absent model falls back to Cursor's own account default (no `--model`).
 */
/**
 * Shared contained-argv base. `readOnlyMode` is `'ask'`/`'plan'` for a read-only
 * seat (adds `--mode`), or `null` for a write-capable seat (Cursor's DEFAULT mode
 * exposes write+shell tools — no `--mode`). Containment is identical either way:
 * `--sandbox enabled` (native OS sandbox — blocks writes to $HOME, allows the
 * workspace), `--skip-worktree-setup`, and the end-of-options `--` prompt guard.
 * NEVER `--force`/`--yolo`/`--approve-mcps`/`--api-key`/`--sandbox disabled`.
 */
function buildContainedCursorArgv(
  input: { workspace: string; prompt: string; model?: string | null },
  readOnlyMode: 'ask' | 'plan' | null
): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--trust',
    '--sandbox',
    'enabled',
    ...(readOnlyMode ? ['--mode', readOnlyMode] : []),
    '--skip-worktree-setup',
    ...(input.model ? ['--model', normalizeCliProviderModel('cursor', input.model)] : []),
    '--workspace',
    input.workspace,
    // End-of-options guard. cursor-agent parses options INTERSPERSED (live-
    // verified: a positional `--version` prints the version instead of running a
    // turn), so without this a flag-shaped user prompt — e.g. `--sandbox disabled`
    // or `--force` — would be reparsed as a real flag and could disable the
    // sandbox or widen tools. Everything after `--` is positional, so the prompt
    // can never inject a flag. Keep the prompt strictly last.
    '--',
    input.prompt
  ]
}

export function buildContainedCursorReadOnlyArgv(
  input: BuildContainedCursorReadOnlyArgvInput
): string[] {
  return buildContainedCursorArgv(input, input.mode ?? 'ask')
}

export interface BuildContainedCursorWriteArgvInput {
  workspace: string
  prompt: string
  model?: string | null
}

/**
 * Write-capable contained Cursor launch surface. Cursor's DEFAULT mode (no
 * `--mode`) exposes its write + shell tools; the ONLY containment is the native
 * `--sandbox enabled` (validated to block writes to $HOME while allowing the
 * workspace) plus the `--` prompt guard. It NEVER emits `--force`/`--yolo`/
 * `--approve-mcps`/`--api-key`/`--sandbox disabled`.
 */
export function buildContainedCursorWriteArgv(
  input: BuildContainedCursorWriteArgvInput
): string[] {
  return buildContainedCursorArgv(input, null)
}
