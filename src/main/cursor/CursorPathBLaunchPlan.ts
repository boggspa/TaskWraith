import type { EffectiveRunPermissions, TaskWraithMcpProfileId } from '../store/types'
import {
  isCoreTaskWraithMcpProfile,
  isGatewayTaskWraithMcpProfile
} from '../mcp/McpSessionProfileFence'
import {
  hasUltraTaskDelegationAutoAllow,
  ULTRATASK_DELEGATION_TOOL_NAMES
} from '../UltraTaskDelegationConsent'
import { sanitizeTaskWraithMcpPromptClaims } from '../PromptComposition'
import { normalizeCliProviderModel } from '../providers/StaticProviderModels'
import { isCursorGrokModelId, resolveCursorGrokCliModelId } from '../../shared/grok45Models'
import { buildContainedCursorReadOnlyArgv, buildContainedCursorWriteArgv } from './CursorCliArgs'
import {
  buildCursorCanonicalBrokerMcpAllowRulesForProfile,
  CURSOR_BROKER_MCP_ALLOW_RULES,
  CURSOR_BROKER_PLAN_MCP_ALLOW_RULES,
  CURSOR_BROKER_READONLY_MCP_ALLOW_RULES,
  CURSOR_MCP_SERVER_NAME
} from './CursorMcpBridge'

export type CursorPathBBrokerOutcome = 'not-requested' | 'active' | 'native-only-degraded'

export interface CursorPathBBrokerPolicy {
  readonly bridgeMode: 'safe-subset' | 'plan-subset' | 'full'
  readonly allowRules: readonly string[]
  readonly denyRules: readonly string[]
  readonly safeSubset: boolean
  readonly planSubset: boolean
  readonly coreSubset: boolean
  readonly gatewaySubset: boolean
}

export interface CursorPathBLaunchPlanInput {
  readonly workspacePath: string
  readonly prompt: string
  readonly model: string | null | undefined
  readonly reasoningEffort: string | null
  readonly fastMode: boolean
  readonly writeCapable: boolean
  readonly planSeat: boolean
  readonly brokerRequested: boolean
  readonly brokerOutcome: CursorPathBBrokerOutcome
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /** Main-resolved, signature-verified run posture. */
  readonly effectivePermissions?: EffectiveRunPermissions | null
  readonly workspaceMcpAliasesGlobalRegistry: boolean
}

export interface CursorPathBLaunchPlan {
  readonly workspacePath: string
  /** Exact provider-visible prompt after branch-specific MCP claim defusal. */
  readonly prompt: string
  /** Exact value passed to `--model`, or null when the flag is omitted. */
  readonly wireModel: string | null
  /** Stable evidence label for the provider-owned account default. */
  readonly evidenceModel: string
  readonly reasoningEffort: string | null
  readonly fastMode: boolean
  /** Exact argv handed to spawn. */
  readonly argv: readonly string[]
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  readonly controls: Readonly<{
    executionMode: 'ask' | 'contained-default'
    bridgeMode: 'none' | 'safe-subset' | 'plan-subset' | 'full'
    brokerRegistration: 'none' | 'global'
    forceMcpTools: boolean
    approveMcpServers: boolean
  }>
  readonly broker: Readonly<{
    requested: boolean
    outcome: CursorPathBBrokerOutcome
    serverName: typeof CURSOR_MCP_SERVER_NAME | null
    allowRules: readonly string[]
    denyRules: readonly string[]
    safeSubset: boolean
    planSubset: boolean
    coreSubset: boolean
    gatewaySubset: boolean
    workspaceMcpAliasesGlobalRegistry: boolean
  }>
}

/**
 * The broker preparation policy is pure and can be resolved before the
 * fallible registration/config/enable sequence. The final immutable launch
 * plan below reuses the same policy after that sequence selects one outcome.
 */
export function resolveCursorPathBBrokerPolicy(input: {
  readonly writeCapable: boolean
  readonly planSeat: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /** Main-resolved, signature-verified run posture. */
  readonly effectivePermissions?: EffectiveRunPermissions | null
  /** True only after broker setup failed or was not requested and no transient
   * broker policy remains installed for this process. */
  readonly nativeWriteFallback?: boolean
}): CursorPathBBrokerPolicy {
  const common = {
    safeSubset: !input.writeCapable,
    planSubset: !input.writeCapable && input.planSeat,
    coreSubset: isCoreTaskWraithMcpProfile(input.taskWraithMcpProfileId),
    gatewaySubset: isGatewayTaskWraithMcpProfile(input.taskWraithMcpProfileId)
  }
  if (input.writeCapable) {
    return Object.freeze({
      bridgeMode: 'full',
      allowRules: Object.freeze([...CURSOR_BROKER_MCP_ALLOW_RULES]),
      // While the broker is active, exact TaskWraith transactions remain the
      // only write path. A degraded launch has already released this transient
      // policy and may retain Cursor-native Shell/Write in its workspace sandbox.
      denyRules: Object.freeze(input.nativeWriteFallback ? [] : ['Shell(**)', 'Write(**)']),
      ...common
    })
  }
  if (input.planSeat) {
    const profileRules = input.taskWraithMcpProfileId
      ? buildCursorCanonicalBrokerMcpAllowRulesForProfile({
          profileId: input.taskWraithMcpProfileId,
          planSeat: true
        })
      : CURSOR_BROKER_PLAN_MCP_ALLOW_RULES
    return Object.freeze({
      bridgeMode: 'plan-subset',
      allowRules: Object.freeze(
        cursorUltraTaskDelegationAllowRules(profileRules, input.effectivePermissions)
      ),
      denyRules: Object.freeze(['Shell(**)', 'Write(**)']),
      ...common
    })
  }
  const profileRules = input.taskWraithMcpProfileId
    ? buildCursorCanonicalBrokerMcpAllowRulesForProfile({
        profileId: input.taskWraithMcpProfileId,
        planSeat: false
      })
    : CURSOR_BROKER_READONLY_MCP_ALLOW_RULES
  return Object.freeze({
    bridgeMode: 'safe-subset',
    allowRules: Object.freeze(
      cursorUltraTaskDelegationAllowRules(profileRules, input.effectivePermissions)
    ),
    denyRules: Object.freeze(['Shell(**)', 'Write(**)']),
    ...common
  })
}

/**
 * Cursor's immutable gateway-v1 allow-rule arrays predate delegate_wave and
 * ultra_task. A signed UltraTask selection adds only the three delegation
 * routes to the transient run overlay; the scoped bridge still performs its
 * own tools/list + tools/call ceiling and TaskWraith remains the host gate.
 */
function cursorUltraTaskDelegationAllowRules(
  baseRules: readonly string[],
  effectivePermissions: EffectiveRunPermissions | null | undefined
): string[] {
  if (!hasUltraTaskDelegationAutoAllow(effectivePermissions)) return [...baseRules]
  const rules = new Set(baseRules)
  for (const toolName of ULTRATASK_DELEGATION_TOOL_NAMES) {
    rules.add(`Mcp(${CURSOR_MCP_SERVER_NAME}:${toolName})`)
    rules.add(`Mcp(${CURSOR_MCP_SERVER_NAME}-${toolName})`)
  }
  return [...rules]
}

/**
 * Resolve the one final Path-B process image after broker preparation has
 * either succeeded or visibly degraded. There is no post-plan fallback:
 * production spawns `plan.argv` and uses `plan.prompt` directly.
 */
export function buildCursorPathBLaunchPlan(
  input: CursorPathBLaunchPlanInput
): CursorPathBLaunchPlan {
  assertBrokerOutcome(input)
  const brokerActive = input.brokerOutcome === 'active'
  const policy = resolveCursorPathBBrokerPolicy({
    ...input,
    nativeWriteFallback: input.writeCapable && !brokerActive
  })
  const transactionalWriteSeat = input.writeCapable
  const basePrompt = brokerActive
    ? `${input.prompt}\n\nTaskWraith Cursor broker receipt: the managed tools are ready under the exact Cursor MCP server id \`${CURSOR_MCP_SERVER_NAME}\`. Call GetMcpTools with server \`${CURSOR_MCP_SERVER_NAME}\` before concluding that TaskWraith tools are absent. Do not confuse it with user-owned \`taskwraith\` or \`agbench\` servers. Use the returned exact file and shell tools within your assigned lane.`
    : sanitizeTaskWraithMcpPromptClaims(input.prompt, {
        advertised: false,
        coreProfile: false
      })
  const prompt =
    input.writeCapable && !brokerActive
      ? `${basePrompt}\n\nTaskWraith Cursor continuity receipt: the managed broker is unavailable, but the user-approved write posture remains active. Use Cursor-native Shell/Write only inside the enabled workspace sandbox and only within your assigned lane scope. Shell is not a substitute for TaskWraith sub-thread or cross-provider spawn; when the managed broker is unavailable, continue in this seat rather than launching another provider. Keep each command/path visible in your response; if the sandbox refuses an essential action, ask the user with the exact command/path and continue any remaining work instead of cancelling the turn.`
      : basePrompt
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : ''
  const cursorGrokModel = requestedModel
    ? resolveCursorGrokCliModelId({
        model: requestedModel,
        reasoningEffort: input.reasoningEffort,
        fastModeEnabled: input.fastMode
      })
    : null
  const wireModel = requestedModel
    ? cursorGrokModel || normalizeCliProviderModel('cursor', requestedModel)
    : null
  const grokControlsApplied = isCursorGrokModelId(requestedModel)
  const argvInput = {
    workspace: input.workspacePath,
    prompt,
    model: wireModel
  }
  const argv = transactionalWriteSeat
    ? buildContainedCursorWriteArgv({
        ...argvInput,
        // `--force` is reserved for the prepared broker catalogue. A degraded
        // seat still uses Cursor's native write mode, but never force-approves
        // restored project MCP servers.
        forceAllowMcpTools: brokerActive
      })
    : buildContainedCursorReadOnlyArgv({
        ...argvInput,
        // ask/plan executes no MCP tools in Cursor headless mode. A bridged
        // read-only seat therefore uses DEFAULT mode under its deny-list.
        mode: brokerActive ? null : 'ask',
        forceAllowMcpTools: brokerActive
      })

  return Object.freeze({
    workspacePath: input.workspacePath,
    prompt,
    wireModel,
    evidenceModel: wireModel ?? 'cursor-account-default',
    reasoningEffort: grokControlsApplied ? input.reasoningEffort : null,
    fastMode: grokControlsApplied && input.fastMode,
    argv: Object.freeze([...argv]),
    taskWraithMcpAdvertised: brokerActive,
    taskWraithMcpProfileId: brokerActive ? input.taskWraithMcpProfileId : null,
    controls: Object.freeze({
      executionMode: transactionalWriteSeat || brokerActive ? 'contained-default' : 'ask',
      bridgeMode: brokerActive ? policy.bridgeMode : 'none',
      brokerRegistration: brokerActive ? 'global' : 'none',
      forceMcpTools: brokerActive,
      approveMcpServers: brokerActive
    }),
    broker: Object.freeze({
      requested: input.brokerRequested,
      outcome: input.brokerOutcome,
      serverName: brokerActive ? CURSOR_MCP_SERVER_NAME : null,
      allowRules: Object.freeze(brokerActive ? [...policy.allowRules] : []),
      denyRules: Object.freeze(brokerActive ? [...policy.denyRules] : []),
      safeSubset: brokerActive && policy.safeSubset,
      planSubset: brokerActive && policy.planSubset,
      coreSubset: brokerActive && policy.coreSubset,
      gatewaySubset: brokerActive && policy.gatewaySubset,
      workspaceMcpAliasesGlobalRegistry: brokerActive && input.workspaceMcpAliasesGlobalRegistry
    })
  })
}

function assertBrokerOutcome(input: CursorPathBLaunchPlanInput): void {
  if (input.brokerOutcome === 'active') {
    if (!input.brokerRequested || input.taskWraithMcpProfileId === null) {
      throw new TypeError('An active Cursor broker requires broker intent and an MCP profile.')
    }
    return
  }
  if (input.brokerOutcome === 'native-only-degraded') {
    if (!input.brokerRequested) {
      throw new TypeError('A degraded Cursor broker outcome requires prior broker intent.')
    }
    return
  }
  if (input.brokerRequested) {
    throw new TypeError('A not-requested Cursor broker outcome cannot carry broker intent.')
  }
}
