import {
  buildCodexThreadResumeRequest,
  resolveCodexOutboundReasoning,
  type CodexOutboundReasoning
} from './CodexOutboundReasoning'
import { normalizeCodexModel } from '../providers/StaticProviderModels'
import { CODEX_THREAD_MCP_ROUTE_CONFIG_KEY } from './CodexThreadMcpRouteEnv'

export type CodexThreadConfigValue = string | number | Readonly<Record<string, string>>

export type CodexAppServerApprovalPolicy = 'never' | 'on-request'
// Mirrors the host-node transport's posture union (HostNodeCodexProvider).
// 'danger-full-access' is reachable only from a signed Full Access grant —
// see codexSandboxForMode.
export type CodexAppServerSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type CodexAppServerThreadRequest =
  | Readonly<{
      method: 'thread/start'
      params: Readonly<{
        cwd: string
        model: string
        config: Readonly<Record<string, CodexThreadConfigValue>>
        serviceTier?: string
        approvalPolicy: CodexAppServerApprovalPolicy
        sandbox: CodexAppServerSandboxMode
        experimentalRawEvents: false
        persistExtendedHistory: true
      }>
    }>
  | Readonly<{
      method: 'thread/resume'
      params: Readonly<{
        threadId: string
        config: Readonly<Record<string, CodexThreadConfigValue>>
        persistExtendedHistory: true
      }>
    }>

export interface CodexAppServerThreadLaunchPlan {
  readonly transport: 'app-server'
  readonly model: string
  /** Runtime-frozen reasoning object reused by turn/start construction. */
  readonly reasoning: CodexOutboundReasoning
  readonly reasoningEffort: string
  readonly reasoningSummary: string | null
  readonly threadConfig: Readonly<Record<string, CodexThreadConfigValue>>
  readonly serviceTier: string | null
  readonly request: CodexAppServerThreadRequest
  /** Scheduled launch evidence authorizes no transport reroute. */
  readonly fallbackPolicy: 'forbid'
}

export interface CodexAppServerThreadLaunchPlanInput {
  readonly model: string | null | undefined
  readonly reasoningEffort: string | null | undefined
  readonly serviceTier: string | null | undefined
  readonly workspacePath: string
  readonly approvalPolicy: CodexAppServerApprovalPolicy
  readonly sandbox: CodexAppServerSandboxMode
  /** Final post-continuity thread id, or null for a fresh thread. */
  readonly resumableThreadId: string | null
  /** Per-thread TaskWraith MCP bridge environment. Thread launch only. */
  readonly mcpRouteEnv?: Readonly<Record<string, string>> | null
}

/**
 * Build the exact immutable thread/start-or-resume request.
 *
 * Callers must finish private-home continuity before selecting
 * `resumableThreadId`; changing fresh/resume mode afterward invalidates the
 * plan. Production dispatch and scheduled evidence share this builder so
 * omitted-vs-present request fields cannot silently drift.
 */
export function buildCodexAppServerThreadLaunchPlan(
  input: CodexAppServerThreadLaunchPlanInput
): CodexAppServerThreadLaunchPlan {
  const model = normalizeCodexModel(input.model)
  const resolvedReasoning = resolveCodexOutboundReasoning(model, input.reasoningEffort)
  const reasoningThreadConfig = Object.freeze({ ...resolvedReasoning.threadConfig })
  const threadConfigValue: Record<string, CodexThreadConfigValue> = {
    ...reasoningThreadConfig,
    ...(input.mcpRouteEnv ? { [CODEX_THREAD_MCP_ROUTE_CONFIG_KEY]: input.mcpRouteEnv } : {})
  }
  const threadConfig = Object.freeze(threadConfigValue)
  const reasoning: CodexOutboundReasoning = {
    ...resolvedReasoning,
    turnParams: Object.freeze({ ...resolvedReasoning.turnParams }),
    threadConfig: reasoningThreadConfig,
    execConfigArgs: Object.freeze([...resolvedReasoning.execConfigArgs]) as string[]
  }
  Object.freeze(reasoning)
  const request: CodexAppServerThreadRequest = input.resumableThreadId
    ? (() => {
        const resumeRequest = buildCodexThreadResumeRequest(input.resumableThreadId!, {
          ...reasoning,
          threadConfig: reasoningThreadConfig
        })
        return Object.freeze({
          method: 'thread/resume' as const,
          params: Object.freeze({
            ...resumeRequest,
            config: threadConfig
          })
        })
      })()
    : Object.freeze({
        method: 'thread/start' as const,
        params: Object.freeze({
          cwd: input.workspacePath,
          model,
          config: threadConfig,
          ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
          approvalPolicy: input.approvalPolicy,
          sandbox: input.sandbox,
          experimentalRawEvents: false as const,
          persistExtendedHistory: true as const
        })
      })

  return Object.freeze({
    transport: 'app-server' as const,
    model,
    reasoning,
    reasoningEffort: reasoning.effort,
    reasoningSummary: reasoning.summary ?? null,
    threadConfig,
    serviceTier: input.serviceTier ?? null,
    request,
    fallbackPolicy: 'forbid' as const
  })
}
