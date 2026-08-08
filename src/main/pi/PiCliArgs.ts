/**
 * Argv + environment builders for spawning `pi --mode rpc`. Pure module.
 *
 * Containment posture (pi ships NO permission system of its own — its docs
 * say to containerize; TaskWraith's containment is therefore built entirely
 * from pi's own flag surface, all verified live on 0.82.1):
 *  - Workspace-local files are never trusted: `-na` (ignore project-local
 *    files), `-nc` (no AGENTS.md/CLAUDE.md discovery), `--no-extensions`,
 *    `--no-skills` (default / suppress / tw-only; omitted only when Wave C
 *    skills posture is `allow-native`), `--no-prompt-templates` close the
 *    project-config pre-prompt execution class (the Kimi B3 lesson) by flag
 *    instead of by guard-and-refuse.
 *  - Pi's native allowlist is always read-only (`read,grep,find,ls`). A
 *    write-approved seat receives only TaskWraith's explicit exact-file
 *    extension tools; native bash/edit/write never bypass transaction locks.
 *  - `PI_CODING_AGENT_DIR` points at a per-run isolated home so user-level
 *    settings/extensions never load; sessions live in a persistent per-chat
 *    dir via `--session-dir` + `--session-id` (deterministic resume).
 *  - `--offline` + PI_SKIP_VERSION_CHECK + PI_TELEMETRY=0 kill startup
 *    network ops and telemetry ([[grok-data-egress-disable]] precedent);
 *    provider API traffic is unaffected.
 */

import {
  piShouldPassNoSkills,
  type ProviderHarnessPosture
} from '../../shared/providerHarnessPosture'
import {
  isPiTaskWraithToolName,
  type PiTaskWraithToolName
} from './PiEnsembleCoordination'

export const PI_READ_ONLY_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls']
export const PI_WRITE_TOOLS: readonly string[] = PI_READ_ONLY_TOOLS

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PiRpcArgsInput {
  upstream: string
  modelId: string
  writeCapable: boolean
  /** Omitted → pi's default for the model. */
  thinkingLevel?: PiThinkingLevel
  sessionDir: string
  /** Deterministic per-chat id; pi creates it if missing (`--session-id`). */
  sessionId?: string
  /** Ephemeral turn (ensemble lanes): no session persisted at all. */
  ephemeralSession?: boolean
  appendSystemPrompt?: string
  /**
   * A TaskWraith-owned explicit extension path. `--no-extensions` still
   * disables every discovery path; Pi documents `-e` as an explicit allowlist
   * which remains valid under that discovery clamp.
   */
  coordinationExtensionPath?: string
  /** Fixed custom tool names implemented by coordinationExtensionPath. */
  coordinationToolNames?: readonly PiTaskWraithToolName[]
  /**
   * Optional Wave C harness posture. When omitted, keeps today's fail-safe
   * `--no-skills`. `allow-native` skills omits `--no-skills`; suppress and
   * tw-only keep it. Hooks have no separate Pi argv today.
   */
  harnessPosture?: ProviderHarnessPosture | null
}

export function buildPiRpcArgs(input: PiRpcArgsInput): string[] {
  const args: string[] = ['--mode', 'rpc']
  args.push('--provider', input.upstream)
  args.push('--model', input.modelId)
  if (input.thinkingLevel) args.push('--thinking', input.thinkingLevel)
  const nativeTools = input.writeCapable ? PI_WRITE_TOOLS : PI_READ_ONLY_TOOLS
  const coordinationToolNames = input.coordinationToolNames || []
  if (input.coordinationExtensionPath && coordinationToolNames.length === 0) {
    throw new TypeError('Pi coordination extension requires an explicit custom tool allowlist.')
  }
  if (!input.coordinationExtensionPath && coordinationToolNames.length > 0) {
    throw new TypeError('Pi coordination tools require their TaskWraith-owned extension path.')
  }
  if (!coordinationToolNames.every(isPiTaskWraithToolName)) {
    throw new TypeError('Pi extension tools must come from TaskWraith fixed allowlists.')
  }
  const tools = [...new Set([...nativeTools, ...coordinationToolNames])]
  args.push('--tools', tools.join(','))
  args.push('--no-extensions')
  const passNoSkills = input.harnessPosture
    ? piShouldPassNoSkills(input.harnessPosture)
    : true
  if (passNoSkills) args.push('--no-skills')
  args.push('--no-prompt-templates')
  if (input.coordinationExtensionPath) {
    args.push('--extension', input.coordinationExtensionPath)
  }
  args.push('--no-context-files', '--no-approve')
  args.push('--offline')
  if (input.ephemeralSession) {
    args.push('--no-session')
  } else {
    args.push('--session-dir', input.sessionDir)
    if (input.sessionId) args.push('--session-id', input.sessionId)
  }
  if (input.appendSystemPrompt) {
    args.push('--append-system-prompt', input.appendSystemPrompt)
  }
  return args
}

export interface PiProcessEnvInput {
  /** Credential-firewalled env from buildPiCredentialEnv. */
  credentialEnv: Readonly<Record<string, string | undefined>>
  /** Per-run isolated config home (PI_CODING_AGENT_DIR). */
  isolatedHomeDir: string
}

export function buildPiProcessEnv(
  input: PiProcessEnvInput
): Record<string, string | undefined> {
  return {
    ...input.credentialEnv,
    PI_CODING_AGENT_DIR: input.isolatedHomeDir,
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
    PI_OFFLINE: '1'
  }
}
