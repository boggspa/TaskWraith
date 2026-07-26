import type { AgentRunPayload, AgentRunRoute } from './AgentRunTypes'
import { RUN_MANAGER_PROVIDERS } from '../index.constants'
import type { RunSessionStatus } from '../RunManager'
import type { ProviderId } from '../store/types'

/**
 * Full stable identity coverage for signed posture retained by the shared
 * starting owner. This is an assurance inventory, never an offer/admission set.
 */
export const SIGNED_POSTURE_RETENTION_PROVIDER_IDS: readonly ProviderId[] = Object.freeze([
  ...RUN_MANAGER_PROVIDERS
])

export interface ProviderRunLifecycleStartingState {
  readonly lifecycleOwner: 'run-coordinator'
  readonly provider: ProviderId
  readonly sender: unknown
  readonly startedAt: number
  readonly model?: string
  readonly providerSessionId?: string | null
  readonly approvalMode?: string
  readonly workflowMode?: AgentRunPayload['workflowMode']
  readonly sessionTrust: boolean
  readonly externalPathGrants?: AgentRunPayload['externalPathGrants']
  readonly runtimeProfileId?: string
  readonly taskWraithMcpProfileId?: AgentRunPayload['taskWraithMcpProfileId']
  readonly taskWraithMcpAdvertised?: boolean
  readonly taskWraithMcpProfileFence?: AgentRunPayload['taskWraithMcpProfileFence']
  readonly effectivePermissions?: AgentRunPayload['effectivePermissions']
  readonly effectivePermissionsSignature?: string
  readonly ensembleRun?: AgentRunPayload['ensembleRun']
  readonly prompt: string
  readonly appRunId: string
  readonly appChatId?: string
}

export interface ProviderRunLifecycleRegistrationInput {
  readonly provider: ProviderId
  readonly sender: unknown
  readonly route: AgentRunRoute
  readonly workspacePath?: string
  readonly providerSessionId?: string | null
  readonly setupAbortController: AbortController
  readonly state: ProviderRunLifecycleStartingState
}

export interface ProviderRunLifecycleOwnershipDependencies {
  readonly registerStartingSession: (input: ProviderRunLifecycleRegistrationInput) => unknown
  readonly getSession: (
    runId: string
  ) => { readonly status: RunSessionStatus; readonly state?: unknown } | undefined
  readonly settleUnclaimedSession: (
    runId: string,
    status: Extract<RunSessionStatus, 'failed' | 'cancelled'>
  ) => void
  readonly now?: () => number
}

export interface ProviderRunLifecycleManager {
  readonly get: ProviderRunLifecycleOwnershipDependencies['getSession']
  readonly getClaimedTerminalStatus: (
    runId: string
  ) => Extract<RunSessionStatus, 'failed' | 'cancelled'> | undefined
  readonly finish: (
    runId: string,
    status: Extract<RunSessionStatus, 'failed' | 'cancelled'>
  ) => unknown
  readonly confirmTerminalStatus: (
    runId: string,
    status: Extract<RunSessionStatus, 'failed' | 'cancelled'>
  ) => unknown
}

export interface ProviderRunLifecycleOwnership {
  readonly provider: ProviderId
  readonly runId: string
  readonly state: ProviderRunLifecycleStartingState
  readonly setupAbortSignal: AbortSignal
  /**
   * Settle only the coordinator-owned placeholder. Once an adapter replaces
   * the state or marks the session running, its exact transport lifecycle owns
   * terminalization and this method deliberately becomes a no-op.
   */
  settleIfUnclaimed(status?: Extract<RunSessionStatus, 'failed' | 'cancelled'>): boolean
}

export interface RunWithProviderRunLifecycleOwnershipInput {
  readonly sender: unknown
  readonly payload: AgentRunPayload
  readonly route: AgentRunRoute
  readonly runProvider: () => Promise<void>
}

/**
 * Settle an exact run when a final launch fence denies transport admission.
 * For graph runs this supplies the provider/no-transport side of the terminal
 * join; for ordinary runs confirmation is deliberately a no-op.
 */
export function settleProviderRunWithoutTransport(
  runManager: ProviderRunLifecycleManager,
  runId: string,
  status: Extract<RunSessionStatus, 'failed' | 'cancelled'> = 'cancelled'
): void {
  const terminalStatus = runManager.getClaimedTerminalStatus(runId) ?? status
  runManager.finish(runId, terminalStatus)
  runManager.confirmTerminalStatus(runId, terminalStatus)
}

/**
 * Acquire a RunManager-visible owner immediately before provider adapter
 * invocation. Provider-specific setup can await binary/auth/config discovery
 * without creating a window in which an exact Stop request cannot find the
 * run. This is lifecycle assurance only: it does not select, admit, or exclude
 * a provider.
 */
export function acquireProviderRunLifecycleOwnership(
  sender: unknown,
  payload: AgentRunPayload,
  route: AgentRunRoute,
  deps: ProviderRunLifecycleOwnershipDependencies
): ProviderRunLifecycleOwnership {
  const runId = route.appRunId?.trim()
  if (!runId) throw new Error('Provider lifecycle ownership requires an exact run id.')
  if (route.appChatId !== payload.appChatId) {
    throw new Error('Provider lifecycle ownership requires the normalized chat route.')
  }

  const state: ProviderRunLifecycleStartingState = Object.freeze({
    lifecycleOwner: 'run-coordinator',
    provider: payload.provider,
    sender,
    startedAt: deps.now?.() ?? Date.now(),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    ...(payload.providerSessionId !== undefined
      ? { providerSessionId: payload.providerSessionId }
      : {}),
    ...(payload.approvalMode !== undefined ? { approvalMode: payload.approvalMode } : {}),
    ...(payload.workflowMode !== undefined ? { workflowMode: payload.workflowMode } : {}),
    sessionTrust: Boolean(payload.sessionTrust),
    ...(payload.externalPathGrants !== undefined
      ? { externalPathGrants: payload.externalPathGrants }
      : {}),
    ...(payload.runtimeProfileId !== undefined
      ? { runtimeProfileId: payload.runtimeProfileId }
      : {}),
    ...(payload.taskWraithMcpProfileId !== undefined
      ? { taskWraithMcpProfileId: payload.taskWraithMcpProfileId }
      : {}),
    ...(payload.taskWraithMcpAdvertised !== undefined
      ? { taskWraithMcpAdvertised: payload.taskWraithMcpAdvertised }
      : {}),
    ...(payload.taskWraithMcpProfileFence !== undefined
      ? { taskWraithMcpProfileFence: payload.taskWraithMcpProfileFence }
      : {}),
    ...(payload.effectivePermissions !== undefined
      ? { effectivePermissions: payload.effectivePermissions }
      : {}),
    ...(payload.effectivePermissionsSignature !== undefined
      ? { effectivePermissionsSignature: payload.effectivePermissionsSignature }
      : {}),
    ...(payload.ensembleRun !== undefined ? { ensembleRun: payload.ensembleRun } : {}),
    prompt: payload.prompt,
    appRunId: runId,
    ...(route.appChatId !== undefined ? { appChatId: route.appChatId } : {})
  })
  const setupAbortController = new AbortController()

  const registered = deps.registerStartingSession({
    provider: payload.provider,
    sender,
    route: { ...route, appRunId: runId },
    workspacePath: payload.scope === 'global' ? undefined : payload.workspace,
    providerSessionId: payload.providerSessionId,
    setupAbortController,
    state
  })
  const session = deps.getSession(runId)
  if (!registered || session?.status !== 'starting' || session.state !== state) {
    throw new Error(
      `${payload.provider} run lifecycle ownership could not be acquired before provider setup.`
    )
  }
  payload.providerSetupAbortSignal = setupAbortController.signal

  return Object.freeze({
    provider: payload.provider,
    runId,
    state,
    setupAbortSignal: setupAbortController.signal,
    settleIfUnclaimed(
      status: Extract<RunSessionStatus, 'failed' | 'cancelled'> = 'failed'
    ): boolean {
      const current = deps.getSession(runId)
      if (current?.status !== 'starting' || current.state !== state) return false
      deps.settleUnclaimedSession(runId, status)
      return true
    }
  })
}

/**
 * Run one provider adapter inside the provisional owner and always retire a
 * placeholder the adapter never adopted. Adapter-owned running/terminal state
 * is left untouched.
 */
export async function runWithProviderRunLifecycleOwnership(
  input: RunWithProviderRunLifecycleOwnershipInput,
  deps: ProviderRunLifecycleOwnershipDependencies
): Promise<void> {
  const ownership = acquireProviderRunLifecycleOwnership(
    input.sender,
    input.payload,
    input.route,
    deps
  )
  try {
    await input.runProvider()
  } finally {
    ownership.settleIfUnclaimed()
  }
}

/**
 * Bind the generic owner to one RunManager without leaking graph-terminal join
 * mechanics back into the composition root. `confirmTerminalStatus` is a no-op
 * for ordinary runs and completes the two-evidence join when a graph attempt
 * was cancelled before any provider transport existed.
 */
export function createProviderRunLifecycleOwnershipDependencies(input: {
  readonly registerStartingSession: ProviderRunLifecycleOwnershipDependencies['registerStartingSession']
  readonly runManager: ProviderRunLifecycleManager
  readonly now?: () => number
}): ProviderRunLifecycleOwnershipDependencies {
  return {
    registerStartingSession: input.registerStartingSession,
    getSession: (runId) => input.runManager.get(runId),
    settleUnclaimedSession: (runId, status) =>
      settleProviderRunWithoutTransport(input.runManager, runId, status),
    ...(input.now ? { now: input.now } : {})
  }
}
