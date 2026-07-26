import type { TaskWraithMcpProfileId } from '../store/types'
import {
  isCoreTaskWraithMcpProfile,
  isGatewayTaskWraithMcpProfile
} from '../mcp/McpSessionProfileFence'
import { sanitizeTaskWraithMcpPromptClaims } from '../PromptComposition'
import { normalizeCliProviderModel } from '../providers/StaticProviderModels'
import { isCursorGrok45ModelId, resolveCursorGrok45CliModelId } from '../../shared/grok45Models'
import { buildContainedCursorReadOnlyArgv, buildContainedCursorWriteArgv } from './CursorCliArgs'
import {
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
      denyRules: Object.freeze([]),
      ...common
    })
  }
  if (input.planSeat) {
    return Object.freeze({
      bridgeMode: 'plan-subset',
      allowRules: Object.freeze([...CURSOR_BROKER_PLAN_MCP_ALLOW_RULES]),
      denyRules: Object.freeze(['Shell(**)', 'Write(**)']),
      ...common
    })
  }
  return Object.freeze({
    bridgeMode: 'safe-subset',
    allowRules: Object.freeze([...CURSOR_BROKER_READONLY_MCP_ALLOW_RULES]),
    denyRules: Object.freeze(['Shell(**)', 'Write(**)']),
    ...common
  })
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
  const policy = resolveCursorPathBBrokerPolicy(input)
  const brokerActive = input.brokerOutcome === 'active'
  const prompt = brokerActive
    ? input.prompt
    : sanitizeTaskWraithMcpPromptClaims(input.prompt, {
        advertised: false,
        coreProfile: false
      })
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : ''
  const cursorGrokModel = requestedModel
    ? resolveCursorGrok45CliModelId({
        model: requestedModel,
        reasoningEffort: input.reasoningEffort,
        fastModeEnabled: input.fastMode
      })
    : null
  const wireModel = requestedModel
    ? cursorGrokModel || normalizeCliProviderModel('cursor', requestedModel)
    : null
  const grokControlsApplied = isCursorGrok45ModelId(requestedModel)
  const argvInput = {
    workspace: input.workspacePath,
    prompt,
    model: wireModel
  }
  const argv = input.writeCapable
    ? buildContainedCursorWriteArgv({
        ...argvInput,
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
      executionMode: input.writeCapable || brokerActive ? 'contained-default' : 'ask',
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
