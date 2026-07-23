import type { ProviderId } from './store/types'

/**
 * ApprovalTimeoutScheduler — Phase E1.
 *
 * Tracks a setTimeout per outstanding approval-id so the desktop can
 * auto-deny when nobody (renderer modal or paired iOS device) responds
 * in time. Without this, an approval that fires an APNs push and gets
 * no answer would hang the agent's run forever.
 *
 * Lifecycle:
 *   1. `schedule(approvalId, provider)` called right after each
 *      `pending*Approvals.set(...)` registry insertion.
 *   2. `cancel(approvalId)` called whenever the approval is resolved
 *      by any path (renderer click, iOS reply, programmatic cancel).
 *   3. If the timer fires before cancel, `onTimeout` is invoked with
 *      the approval id and a structured reason. The caller is expected
 *      to walk the registries and force a `decline` decision.
 *
 * Policy:
 *   - Per-provider defaults. Codex (a fast-twitch CLI) ticks faster
 *     than Claude/Gemini, which tolerate minutes of think-time.
 *   - Per-approval-kind override map for special cases (host-command
 *     rerun, workspace trust, etc.). Looked up by an optional `kind`
 *     argument; falls back to provider default.
 *
 * Failure modes:
 *   - `schedule` for an id that's already scheduled — last call wins,
 *     previous timer cleared. This matches the renderer's "if user
 *     re-opens an approval modal" pattern.
 *   - `cancel` for an unknown id — silent no-op.
 *   - `onTimeout` throwing — error logged via `log` callback, timer
 *     still removed from the map. We do not retry; auto-deny is a
 *     one-shot event and the registry walker handles the actual deny.
 *
 * Testability: `setTimeoutFn` + `clearTimeoutFn` are injectable so
 * unit tests can drive the scheduler with a fake clock without
 * `vi.useFakeTimers()`.
 */

export interface ApprovalTimeoutPolicy {
  /** Per-provider timeout in milliseconds. */
  defaultTimeoutsMs: Record<ProviderId, number>
  /** "Main" authority approvals (workspace trust, etc.) — distinct
   * from provider-flavored approvals because the same `requestMainApproval`
   * helper services all providers and they often need a longer window
   * to give the user time to read what they're trusting. */
  mainTimeoutMs: number
  /** Optional override keyed by a custom kind string (e.g. the approval
   * `method` field or a `kind` tag we pass in). Used for things like
   * host-command rerun that have their own pace. */
  perKindOverridesMs?: Record<string, number>
}

export const DEFAULT_APPROVAL_TIMEOUT_POLICY: ApprovalTimeoutPolicy = {
  // These match the decisions from the original plan file: Codex is
  // a tight CLI (default 30s), Claude/Gemini tolerate a couple of
  // minutes, Kimi sits in the middle. Numbers in ms.
  defaultTimeoutsMs: {
    codex: 30_000,
    claude: 120_000,
    gemini: 120_000,
    kimi: 60_000,
    // Grok is read-only/plan-mode (G3) so approvals shouldn't fire, but the
    // Record<ProviderId> requires a value — mirror the Claude/Gemini window.
    grok: 120_000,
    // Cursor compatibility slot only; source-ahead managed runs are disabled.
    cursor: 120_000,
    // Ollama Phase 1 is read-only/no-approval, but keep the record complete.
    ollama: 120_000,
    // Opt-in antigravity has no approval flow yet; keep the record complete.
    antigravity: 120_000
  },
  mainTimeoutMs: 60_000,
  perKindOverridesMs: {
    'hostCommand/rerun': 90_000,
    'workspace/session-trust': 180_000,
    // Kimi Code starts its fixed MCP client deadline when streamed tool args
    // begin, before the complete request reaches TaskWraith. A 60s approval
    // therefore loses the race and returns an ambiguous client timeout. Settle
    // this user-visible roster mutation clearly (accept or auto-deny) first.
    'kimi-mcp/ensemble_roster_edit': 40_000
  }
}

export interface ApprovalTimeoutSchedulerOptions {
  /** Resolver from id to applied timeout. Mostly a logging hook. */
  log?: (line: string) => void
  /** Inject for tests. Defaults to global setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => NodeJS.Timeout
  /** Inject for tests. Defaults to global clearTimeout. */
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void
}

export interface ScheduleArgs {
  approvalId: string
  /** Provider whose approval queue holds this id. Drives the default
   * timeout when no kind override matches. */
  provider: ProviderId
  /** When `true`, treat as a "main authority" approval (workspace
   * trust, etc.) — uses `mainTimeoutMs` instead of the provider
   * default. */
  isMainAuthority?: boolean
  /** Optional kind tag for per-kind overrides (e.g. `'hostCommand/rerun'`,
   * `'workspace/session-trust'`). Most specific wins:
   *   `perKindOverridesMs[kind]` > `isMainAuthority` > provider default. */
  kind?: string
}

export type ApprovalTimeoutReason = {
  approvalId: string
  appliedMs: number
  /** Which policy slot produced the timeout value. Useful for
   * logging + ledger so the user can see "this auto-denied because
   * the Codex default of 30s elapsed". */
  source: 'perKind' | 'mainAuthority' | 'providerDefault'
}

export class ApprovalTimeoutScheduler {
  private timers = new Map<string, NodeJS.Timeout>()
  /** Epoch-ms deadline per armed timer — lets remote projections stamp
   * the REAL auto-deny moment (`expiresAt`) instead of re-deriving it
   * from settings that may have changed since arming. */
  private deadlines = new Map<string, number>()
  private policy: ApprovalTimeoutPolicy
  private setTimeoutFn: (cb: () => void, ms: number) => NodeJS.Timeout
  private clearTimeoutFn: (handle: NodeJS.Timeout) => void
  private log: (line: string) => void
  private onTimeout: (reason: ApprovalTimeoutReason) => void | Promise<void>

  constructor(
    policy: ApprovalTimeoutPolicy,
    onTimeout: (reason: ApprovalTimeoutReason) => void | Promise<void>,
    options: ApprovalTimeoutSchedulerOptions = {}
  ) {
    this.policy = policy
    this.onTimeout = onTimeout
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h))
    this.log = options.log ?? (() => {})
  }

  /** Resolve the timeout (ms) + the policy slot that produced it.
   * Public for the wiring code to write a "scheduled approval with
   * Xs timeout" ledger entry. */
  resolveTimeout(args: ScheduleArgs): { ms: number; source: ApprovalTimeoutReason['source'] } {
    if (args.kind && this.policy.perKindOverridesMs?.[args.kind] !== undefined) {
      return { ms: this.policy.perKindOverridesMs[args.kind], source: 'perKind' }
    }
    if (args.isMainAuthority) {
      return { ms: this.policy.mainTimeoutMs, source: 'mainAuthority' }
    }
    return { ms: this.policy.defaultTimeoutsMs[args.provider], source: 'providerDefault' }
  }

  schedule(args: ScheduleArgs): { appliedMs: number; source: ApprovalTimeoutReason['source'] } {
    // Replace an existing timer if any — re-registering the same id
    // is a legitimate scenario (renderer re-pops an approval modal
    // after a runtime hiccup).
    const existing = this.timers.get(args.approvalId)
    if (existing) this.clearTimeoutFn(existing)

    const { ms, source } = this.resolveTimeout(args)
    const handle = this.setTimeoutFn(async () => {
      this.timers.delete(args.approvalId)
      this.deadlines.delete(args.approvalId)
      try {
        await this.onTimeout({ approvalId: args.approvalId, appliedMs: ms, source })
      } catch (err) {
        this.log(
          `[ApprovalTimeoutScheduler] onTimeout threw for approvalId=${args.approvalId}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }, ms)
    this.timers.set(args.approvalId, handle)
    this.deadlines.set(args.approvalId, Date.now() + ms)
    this.log(
      `[ApprovalTimeoutScheduler] scheduled approvalId=${args.approvalId} provider=${args.provider} ms=${ms} source=${source}`
    )
    return { appliedMs: ms, source }
  }

  cancel(approvalId: string): boolean {
    const handle = this.timers.get(approvalId)
    if (!handle) return false
    this.clearTimeoutFn(handle)
    this.timers.delete(approvalId)
    this.deadlines.delete(approvalId)
    this.log(`[ApprovalTimeoutScheduler] cancelled approvalId=${approvalId}`)
    return true
  }

  /** Epoch-ms moment the armed timer will auto-deny, or undefined when
   * no timer is armed for the id (timeouts disabled / already fired). */
  deadlineFor(approvalId: string): number | undefined {
    return this.deadlines.get(approvalId)
  }

  /** Replace the policy used for FUTURE schedule() calls. Existing
   * armed timers continue to use the values they were scheduled with —
   * a settings change applies to the next approval, not in-flight ones.
   * Per-kind overrides survive a partial update if not specified. */
  updatePolicy(partial: Partial<ApprovalTimeoutPolicy>): void {
    this.policy = {
      ...this.policy,
      ...partial,
      defaultTimeoutsMs: {
        ...this.policy.defaultTimeoutsMs,
        ...(partial.defaultTimeoutsMs || {})
      },
      perKindOverridesMs: {
        ...this.policy.perKindOverridesMs,
        ...(partial.perKindOverridesMs || {})
      }
    }
  }

  cancelAll(): void {
    for (const handle of this.timers.values()) {
      this.clearTimeoutFn(handle)
    }
    this.timers.clear()
    this.deadlines.clear()
  }

  get pendingCount(): number {
    return this.timers.size
  }

  has(approvalId: string): boolean {
    return this.timers.has(approvalId)
  }
}
