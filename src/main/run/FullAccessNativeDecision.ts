import { isFullShellAccessGranted } from '../EffectiveRunPermissions'
import type { EffectiveRunPermissions } from '../store/types'
import type { NativeApprovalPreflight } from '../NativeApprovalPolicy'

export interface FullAccessNativeRun {
  readonly runId: string
  readonly status?: string
  readonly state?: unknown
}

/** This port must read admitted RunManager state, never a provider request payload. */
export interface FullAccessNativeRunManager {
  get(runId: string): FullAccessNativeRun | undefined
  getClaimedTerminalStatus?(runId: string): unknown
}

export function resolveFullAccessNativeRun(
  manager: FullAccessNativeRunManager,
  runId: string | undefined
): FullAccessNativeRun | null {
  if (!runId) return null
  const run = manager.get(runId)
  const state = run?.state as { effectivePermissions?: EffectiveRunPermissions } | undefined
  if (
    !run ||
    run.runId !== runId ||
    manager.getClaimedTerminalStatus?.(runId) ||
    (run.status !== 'running' && run.status !== 'starting') ||
    state?.effectivePermissions?.readOnly !== false ||
    !isFullShellAccessGranted(state?.effectivePermissions)
  )
    return null
  return run
}

export function fullAccessNativePreflight(
  manager: FullAccessNativeRunManager,
  runId: string | undefined
): NativeApprovalPreflight | null {
  const run = resolveFullAccessNativeRun(manager, runId)
  if (!run) return null
  return {
    kind: 'allow',
    policy: 'allow',
    reason: 'trusted_session',
    scope: 'request',
    effectivePermissions: (run.state as { effectivePermissions: EffectiveRunPermissions })
      .effectivePermissions
  }
}

/** Audit and execute the exact caller-owned operation without creating a pending approval. */
export async function settleFullAccessNativeDecision(input: {
  manager: FullAccessNativeRunManager
  runId: string | undefined
  signal?: AbortSignal
  admissionBlocked?: () => boolean
  audit: (run: FullAccessNativeRun) => void | Promise<void>
  execute: (run: FullAccessNativeRun) => void | Promise<void>
}): Promise<'not-full-access' | 'cancelled' | 'accepted'> {
  if (input.signal?.aborted || input.admissionBlocked?.()) return 'cancelled'
  const run = resolveFullAccessNativeRun(input.manager, input.runId)
  if (!run) return 'not-full-access'
  await input.audit(run)
  if (
    input.signal?.aborted ||
    input.admissionBlocked?.() ||
    resolveFullAccessNativeRun(input.manager, input.runId) !== run
  )
    return 'cancelled'
  await input.execute(run)
  return 'accepted'
}

/** Wrap native permission callbacks without weakening their restricted-tier fallback. */
export function createFullAccessNativePermissionHandler<Request, Decision>(input: {
  manager: FullAccessNativeRunManager
  runId: string | undefined
  admissionBlocked?: () => boolean
  audit: (request: Request, run: FullAccessNativeRun) => void | Promise<void>
  fallback: (request: Request) => Decision | Promise<Decision>
}): (request: Request) => Promise<Decision | 'allow' | 'deny'> {
  return async (request) => {
    const run = input.runId ? input.manager.get(input.runId) : undefined
    if (
      !run ||
      run.runId !== input.runId ||
      (run.status !== 'running' && run.status !== 'starting') ||
      input.manager.getClaimedTerminalStatus?.(run.runId)
    )
      return 'deny'
    const result = await settleFullAccessNativeDecision({
      ...input,
      audit: (run) => input.audit(request, run),
      execute: () => {}
    })
    if (result === 'not-full-access') return input.fallback(request)
    return result === 'accepted' ? 'allow' : 'deny'
  }
}
