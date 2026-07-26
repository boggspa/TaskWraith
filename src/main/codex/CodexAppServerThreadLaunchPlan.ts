import {
  buildCodexThreadResumeRequest,
  resolveCodexOutboundReasoning,
  type CodexOutboundReasoning
} from './CodexOutboundReasoning'
import { normalizeCodexModel } from '../providers/StaticProviderModels'

export type CodexAppServerApprovalPolicy = 'never' | 'on-request'
export type CodexAppServerSandboxMode = 'read-only' | 'workspace-write'

export type CodexAppServerThreadRequest =
  | Readonly<{
      method: 'thread/start'
      params: Readonly<{
        cwd: string
        model: string
        config: Readonly<Record<string, string | number>>
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
        config: Readonly<Record<string, string | number>>
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
  readonly threadConfig: Readonly<Record<string, string | number>>
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
  const threadConfigValue = { ...resolvedReasoning.threadConfig }
  const threadConfig = Object.freeze(threadConfigValue)
  const reasoning: CodexOutboundReasoning = {
    ...resolvedReasoning,
    turnParams: Object.freeze({ ...resolvedReasoning.turnParams }),
    threadConfig: threadConfigValue,
    execConfigArgs: Object.freeze([...resolvedReasoning.execConfigArgs]) as string[]
  }
  Object.freeze(reasoning)
  const request: CodexAppServerThreadRequest = input.resumableThreadId
    ? (() => {
        const resumeRequest = buildCodexThreadResumeRequest(input.resumableThreadId!, {
          ...reasoning,
          threadConfig: threadConfigValue
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
