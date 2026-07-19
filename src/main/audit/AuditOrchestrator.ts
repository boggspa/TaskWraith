/*
 * AuditOrchestrator — the deterministic phase-DAG executor.
 *
 * recon → plan(+confirm) → (gates ‖ reviewers) → dedup → verify → synthesis.
 *
 * Dependency-injected so the whole pipeline unit-tests with fakes BEFORE any
 * RunCoordinator/index.ts wiring. The one seam that hides all the
 * spawn/track/MCP plumbing is `dispatchRole(req) → result`: the orchestrator
 * builds a role prompt + picks a provider, the dep spawns the run and returns
 * the typed artifacts that run recorded (via the audit MCP tools) plus its
 * token/cost. The orchestrator is the SINGLE writer to the run record.
 *
 * Safety guarantees enforced here (see plan): provider eligibility resolved
 * up front via the resolver, mid-run fallback substitution (never hard-fail a
 * lane), hard budget ceiling, the dedup barrier, cross-provider skeptics with
 * the evidence-anchor rule, Ollama local semaphore, cooperative cancellation,
 * and honest coverage.
 */

import {
  resolveProviderCapabilities,
  nextProviderInChain,
  type ProviderSignal
} from './ProviderCapabilityResolver'
import {
  applyVerdictStates,
  budgetExhausted,
  computeCoverage,
  dedupeFindings,
  makeBudget,
  markTruncated,
  recordSpend,
  skepticCountForSeverity,
  survivingFindings
} from './AuditRunModel'
import type {
  AuditBudget,
  AuditFinding,
  AuditGateResult,
  AuditMode,
  AuditOrchestrationSettings,
  AuditParticipant,
  AuditPhase,
  AuditPhaseId,
  AuditProjectProfile,
  AuditRole,
  AuditRoster,
  AuditRunRecord,
  AuditVerdict,
  ProviderId
} from '../store/types'

// ── injected contracts ──────────────────────────────────────────────────────

export interface AuditRoleRunRequest {
  auditRunId: string
  role: AuditRole
  provider: ProviderId
  dimension?: string
  findingId?: string
  workspacePath: string
  prompt: string
}

export interface AuditRoleRunResult {
  ok: boolean
  runId: string
  error?: string
  tokens?: number
  costUsd?: number
  durationMs?: number
  /** Artifacts the role-run recorded via the audit MCP tools. */
  profile?: AuditProjectProfile
  findings?: AuditFinding[]
  verdicts?: AuditVerdict[]
  report?: string
}

export interface AuditGateCheck {
  check: string
  command: string
}

export interface AuditOrchestratorStore {
  createAuditRun: (
    input: Parameters<typeof import('../store')['AppStore']['createAuditRun']>[0]
  ) => AuditRunRecord
  updateAuditRun: (id: string, partial: Partial<AuditRunRecord>) => AuditRunRecord | null
}

export interface AuditOrchestratorDeps {
  store: AuditOrchestratorStore
  resolveSignals: () => Promise<ProviderSignal[]>
  dispatchRole: (req: AuditRoleRunRequest) => Promise<AuditRoleRunResult>
  runGates: (
    checks: AuditGateCheck[],
    workspacePath: string,
    authority?: {
      auditRunId: string
      appChatId: string
      workspaceId?: string
      workspacePath: string
    },
    projectGate?: (gate: AuditGateResult) => void
  ) => Promise<AuditGateResult[]>
  /** Static policy fallback, mostly for tests/back-compat. */
  policy?: AuditOrchestrationSettings
  /** Dynamic settings source. Snapshotted once at run start. */
  getPolicy?: () => AuditOrchestrationSettings | undefined
  /** Plan-confirmation gate (the UI supplies the real one). Default: approve. */
  confirmPlan?: (run: AuditRunRecord) => Promise<boolean>
  /** Cooperative cancellation, checked between phases + spawns. */
  isCancelled?: () => boolean
  /** Live-update hook (renderer + iOS projection). */
  onUpdate?: (run: AuditRunRecord) => void
  now: () => string
  uuid: () => string
  log?: (line: string) => void
  /** Overall fan-out concurrency (cloud). Default 8. */
  cloudConcurrency?: number
}

export interface StartAuditInput {
  mode: AuditMode
  chatId: string
  /** Provider of the chat that triggered /audit. Used as the default audit roster
   * envelope so v1 does not silently spend usage on an unrelated provider. */
  preferredProvider?: ProviderId
  workspaceId?: string
  workspacePath: string
}

// ── planning (pure, exported for tests) ─────────────────────────────────────

const QUICK_DIMENSIONS = ['code health', 'test depth', 'security & policy']
const RELEASE_DIMENSIONS = [
  'packaging & signing',
  'update feed integrity',
  'secrets & credentials',
  'CI & release pipeline',
  'release notes vs reality'
]
const DEEP_BASE_DIMENSIONS = ['code health', 'test depth', 'security & policy', 'docs vs reality']
const MAX_DEEP_DIMENSIONS = 8

export function planDimensions(mode: AuditMode, profile?: AuditProjectProfile): string[] {
  if (mode === 'quick') return [...QUICK_DIMENSIONS]
  if (mode === 'release') return [...RELEASE_DIMENSIONS]
  // deep: base set + recon-surfaced risk zones, deduped + capped.
  const seen = new Set<string>()
  const out: string[] = []
  for (const dim of [...DEEP_BASE_DIMENSIONS, ...(profile?.riskZones ?? [])]) {
    const key = dim.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(dim.trim())
    if (out.length >= MAX_DEEP_DIMENSIONS) break
  }
  return out
}

export function gateChecksForMode(mode: AuditMode): AuditGateCheck[] {
  const base: AuditGateCheck[] = [
    { check: 'typecheck', command: 'npm run typecheck' },
    { check: 'test', command: 'npm run test' }
  ]
  if (mode === 'release') {
    return [
      ...base,
      { check: 'supply-chain', command: 'node scripts/security-supply-chain-check.cjs' },
      { check: 'validate-release', command: 'node scripts/validate-release.cjs' },
      { check: 'outdated', command: 'npm outdated' }
    ]
  }
  if (mode === 'deep') {
    return [...base, { check: 'supply-chain', command: 'node scripts/security-supply-chain-check.cjs' }]
  }
  return base
}

function defaultBudgetForMode(mode: AuditMode, policy?: AuditOrchestrationSettings): AuditBudget {
  const fallback = mode === 'quick' ? 12 : mode === 'release' ? 24 : 40
  return makeBudget(policy?.budgetMaxAgents ?? fallback, policy?.budgetMaxTokens)
}

// ── small async helpers ─────────────────────────────────────────────────────

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function isLocalProvider(provider: ProviderId): boolean {
  return provider === 'ollama'
}

const AUDIT_ROLES: AuditRole[] = ['recon', 'reviewer', 'skeptic', 'synthesis']

function prependProvider(list: ProviderId[] | undefined, provider: ProviderId): ProviderId[] {
  return [provider, ...(list ?? []).filter((item) => item !== provider)]
}

function hasExplicitAuditRouting(policy: AuditOrchestrationSettings | undefined): boolean {
  if (!policy) return false
  if (policy.providerAllowlist?.length) return true
  return Object.values(policy.perRolePreferences ?? {}).some((providers) => providers.length > 0)
}

function policyForRun(
  policy: AuditOrchestrationSettings | undefined,
  preferredProvider: ProviderId | undefined
): AuditOrchestrationSettings | undefined {
  if (!preferredProvider) return policy
  const perRolePreferences: Partial<Record<AuditRole, ProviderId[]>> = {
    ...(policy?.perRolePreferences ?? {})
  }
  for (const role of AUDIT_ROLES) {
    perRolePreferences[role] = prependProvider(perRolePreferences[role], preferredProvider)
  }
  return {
    ...(policy ?? {}),
    // Until the plan-confirm/settings surface exists, default /audit to the
    // parent chat's provider. Explicit audit routing policy may still opt into
    // cross-provider fallback chains.
    ...(!hasExplicitAuditRouting(policy) ? { providerAllowlist: [preferredProvider] } : {}),
    perRolePreferences
  }
}

// ── orchestrator ─────────────────────────────────────────────────────────────

export class AuditOrchestrator {
  private readonly deps: AuditOrchestratorDeps
  private localGate: Semaphore
  private record!: AuditRunRecord
  private substitutions = 0

  constructor(deps: AuditOrchestratorDeps) {
    this.deps = deps
    this.localGate = new Semaphore(Math.max(1, deps.policy?.ollamaMaxConcurrent ?? 1))
  }

  private currentPolicy(): AuditOrchestrationSettings | undefined {
    return this.deps.getPolicy?.() ?? this.deps.policy
  }

  async run(input: StartAuditInput): Promise<AuditRunRecord> {
    const basePolicy = this.currentPolicy()
    this.localGate = new Semaphore(Math.max(1, basePolicy?.ollamaMaxConcurrent ?? 1))
    this.substitutions = 0
    this.completedDimensions = 0
    const phases: AuditPhase[] = (
      ['recon', 'plan', 'gates', 'review', 'dedup', 'verify', 'synthesis'] as AuditPhaseId[]
    ).map((id) => ({ id, status: 'pending' }))
    this.record = this.deps.store.createAuditRun({
      mode: input.mode,
      chatId: input.chatId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      status: 'planning',
      phases,
      dimensions: [],
      budget: defaultBudgetForMode(input.mode, basePolicy),
      startedAt: this.deps.now()
    })
    this.persist({})

    try {
      // ── eligibility (before a single token is spent) ──────────────────────
      const signals = await this.deps.resolveSignals()
      const policy = policyForRun(basePolicy, input.preferredProvider)
      const roster = resolveProviderCapabilities({
        rolesNeeded: AUDIT_ROLES,
        signals,
        policy
      })
      this.persist({ roster })
      if (!roster.perRole.reviewer?.length || !roster.perRole.synthesis?.length) {
        const preferred = input.preferredProvider
          ? ` The parent provider (${input.preferredProvider}) is not eligible for audit role-runs.`
          : ''
        return this.fail(
          `No eligible provider for the audit.${preferred} Check provider auth/health, or configure an audit provider policy.`
        )
      }
      if (this.cancelled()) return this.cancel()

      // ── recon ─────────────────────────────────────────────────────────────
      this.beginPhase('recon')
      const reconResult = await this.dispatchWithFallback({
        role: 'recon',
        chain: roster.perRole.recon ?? roster.perRole.synthesis ?? [],
        workspacePath: input.workspacePath,
        prompt: reconPrompt(input.workspacePath)
      })
      const profile = reconResult?.profile
      if (profile) this.persist({ profile })
      this.endPhase('recon', reconResult ? 'completed' : 'failed')
      if (this.cancelled()) return this.cancel()

      // ── plan (+ confirm) ────────────────────────────────────────────────────
      this.beginPhase('plan')
      const dimensions = planDimensions(input.mode, profile)
      if (this.deps.confirmPlan) {
        this.persist({ dimensions, status: 'awaitingConfirm' })
      } else {
        this.persist({ dimensions, status: 'running' })
      }
      const confirmed = this.deps.confirmPlan ? await this.deps.confirmPlan(this.record) : true
      if (!confirmed) {
        this.endPhase('plan', 'completed')
        return this.cancel()
      }
      this.persist({ status: 'running' })
      this.endPhase('plan', 'completed')

      // ── gates ‖ reviewers ─────────────────────────────────────────────────
      const findings = await this.runGatesAndReviewers(input, dimensions, roster)
      if (this.cancelled()) return this.cancel()

      // ── dedup (barrier) ─────────────────────────────────────────────────────
      this.beginPhase('dedup')
      const deduped = dedupeFindings(findings)
      this.persist({ findings: deduped })
      this.endPhase('dedup', 'completed')

      // ── verify ──────────────────────────────────────────────────────────────
      this.beginPhase('verify')
      const verdicts = await this.runSkeptics(input, deduped, roster)
      const judged = applyVerdictStates(deduped, verdicts)
      this.persist({ findings: judged, verdicts })
      this.endPhase('verify', 'completed')
      if (this.cancelled()) return this.cancel()

      // ── synthesis ────────────────────────────────────────────────────────────
      this.beginPhase('synthesis')
      const survivors = survivingFindings(judged)
      const coverage = computeCoverage({
        dimensionsPlanned: dimensions.length,
        dimensionsCompleted: this.completedDimensions,
        findings: judged,
        verdicts,
        substitutions: this.substitutions,
        budgetTruncated: this.record.budget.truncated
      })
      const synthResult = await this.dispatchWithFallback({
        role: 'synthesis',
        chain: roster.perRole.synthesis ?? [],
        workspacePath: input.workspacePath,
        prompt: synthesisPrompt(survivors, coverage.notes ?? [])
      })
      const report = synthResult?.report ?? this.fallbackReport(survivors, coverage.notes ?? [])
      this.persist({ report, coverage })
      this.endPhase('synthesis', synthResult ? 'completed' : 'failed')

      return this.persist({ status: 'completed', endedAt: this.deps.now() })
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  // ── phases ───────────────────────────────────────────────────────────────

  private completedDimensions = 0

  private async runGatesAndReviewers(
    input: StartAuditInput,
    dimensions: string[],
    roster: AuditRoster
  ): Promise<AuditFinding[]> {
    this.beginPhase('gates')
    this.beginPhase('review')
    const reviewerChain = roster.perRole.reviewer ?? []
    const collected: AuditFinding[] = []

    const projectedGateIds = new Set<string>()
    const projectGate = (gate: AuditGateResult): void => {
      this.appendGate(gate)
      projectedGateIds.add(gate.id)
    }
    const gatesP = this.deps
      .runGates(
        gateChecksForMode(input.mode),
        input.workspacePath,
        {
          auditRunId: this.record.id,
          appChatId: input.chatId,
          workspaceId: input.workspaceId,
          workspacePath: input.workspacePath
        },
        projectGate
      )
      .then((gates) => {
        // Test/back-compat runners may ignore the projection callback. Persist
        // those results here; the production runner invokes it before releasing
        // each exact host-command projection handle.
        for (const gate of gates) {
          if (!projectedGateIds.has(gate.id)) projectGate(gate)
        }
        this.endPhase('gates', 'completed')
      })
      .catch(() => this.endPhase('gates', 'failed'))

    const reviewP = mapWithConcurrency(
      dimensions,
      this.deps.cloudConcurrency ?? 8,
      async (dimension, index) => {
        if (this.cancelled() || budgetExhausted(this.record.budget)) {
          this.persist({ budget: markTruncated(this.record.budget) })
          return
        }
        // Distribute dimensions across the reviewer chain for diversity.
        const preferred = reviewerChain[index % reviewerChain.length]
        const chain = orderChainFrom(reviewerChain, preferred)
        const result = await this.dispatchWithFallback({
          role: 'reviewer',
          dimension,
          chain,
          workspacePath: input.workspacePath,
          prompt: reviewerPrompt(dimension, input.workspacePath)
        })
        if (result) {
          this.completedDimensions += 1
          for (const f of result.findings ?? []) collected.push({ ...f, dimension })
        }
      }
    ).then(() => this.endPhase('review', 'completed'))

    await Promise.all([gatesP, reviewP])
    return collected
  }

  private async runSkeptics(
    input: StartAuditInput,
    findings: AuditFinding[],
    roster: AuditRoster
  ): Promise<AuditVerdict[]> {
    const skepticChain = roster.perRole.skeptic ?? []
    const verdicts: AuditVerdict[] = []
    // Build the work list first so the budget gates the TOTAL skeptic spend.
    const jobs: { finding: AuditFinding; provider: ProviderId }[] = []
    for (const finding of findings) {
      const count = skepticCountForSeverity(finding.severity)
      // Cross-provider: prefer providers other than the finding's author.
      const ordered = preferCrossProvider(skepticChain, finding.authorProvider)
      for (let i = 0; i < count; i++) {
        const provider = ordered[i % Math.max(1, ordered.length)]
        if (provider) jobs.push({ finding, provider })
      }
    }
    await mapWithConcurrency(jobs, this.deps.cloudConcurrency ?? 8, async (job) => {
      if (this.cancelled()) return
      if (budgetExhausted(this.record.budget)) {
        this.persist({ budget: markTruncated(this.record.budget) })
        return
      }
      const chain = orderChainFrom(skepticChain, job.provider)
      const result = await this.dispatchWithFallback({
        role: 'skeptic',
        findingId: job.finding.id,
        chain,
        workspacePath: input.workspacePath,
        prompt: skepticPrompt(job.finding)
      })
      for (const v of result?.verdicts ?? []) verdicts.push({ ...v, findingId: job.finding.id })
    })
    return verdicts
  }

  // ── dispatch with fallback substitution ─────────────────────────────────────

  private async dispatchWithFallback(args: {
    role: AuditRole
    chain: ProviderId[]
    workspacePath: string
    prompt: string
    dimension?: string
    findingId?: string
  }): Promise<AuditRoleRunResult | null> {
    const tried: ProviderId[] = []
    let firstProvider: ProviderId | null = null
    for (;;) {
      const provider = nextProviderInChain(args.chain, tried)
      if (!provider) break
      if (budgetExhausted(this.record.budget)) {
        this.persist({ budget: markTruncated(this.record.budget) })
        break
      }
      // Reserve each provider-run attempt SYNCHRONOUSLY before the first await.
      // This keeps concurrent fan-out honest and counts fallback substitutions
      // as the additional spawned agents they really are.
      this.persist({ budget: recordSpend(this.record.budget, { agents: 1 }) })
      tried.push(provider)
      if (firstProvider === null) firstProvider = provider
      else {
        this.substitutions += 1
        this.deps.log?.(`[audit] ${args.role} substituting ${firstProvider} → ${provider}`)
      }

      const req: AuditRoleRunRequest = {
        auditRunId: this.record.id,
        role: args.role,
        provider,
        dimension: args.dimension,
        findingId: args.findingId,
        workspacePath: args.workspacePath,
        prompt: args.prompt
      }
      const exec = (): Promise<AuditRoleRunResult> => this.deps.dispatchRole(req)
      let result: AuditRoleRunResult
      try {
        result = isLocalProvider(provider) ? await this.localGate.run(exec) : await exec()
      } catch (err) {
        result = {
          ok: false,
          runId: 'n/a',
          error: err instanceof Error ? err.message : String(err)
        }
      }

      this.upsertParticipant({
        runId: result.runId,
        role: args.role,
        dimension: args.dimension,
        provider,
        status: result.ok ? 'completed' : 'failed',
        substitutedFrom:
          firstProvider && provider !== firstProvider ? firstProvider : undefined,
        tokens: result.tokens,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        endedAt: this.deps.now()
      })
      // Agent already reserved for this attempt; record only token spend here.
      this.persist({
        budget: recordSpend(this.record.budget, { tokens: result.tokens ?? 0 })
      })

      if (result.ok) return result
      // else walk to next provider in the chain (substitution)
    }
    return null
  }

  // ── record helpers (single writer) ──────────────────────────────────────────

  private beginPhase(id: AuditPhaseId): void {
    const phases = this.record.phases.map((p) =>
      p.id === id ? { ...p, status: 'running' as const, startedAt: this.deps.now() } : p
    )
    this.persist({ phases })
  }

  private endPhase(id: AuditPhaseId, status: 'completed' | 'failed'): void {
    const phases = this.record.phases.map((p) =>
      p.id === id ? { ...p, status, endedAt: this.deps.now() } : p
    )
    this.persist({ phases })
  }

  private appendGate(gate: AuditGateResult): void {
    this.persist({ gates: [...this.record.gates.filter((g) => g.id !== gate.id), gate] })
  }

  private upsertParticipant(participant: AuditParticipant): void {
    const participants = [
      ...this.record.participants.filter((p) => p.runId !== participant.runId || !participant.runId),
      participant
    ]
    this.persist({ participants })
  }

  private persist(partial: Partial<AuditRunRecord>): AuditRunRecord {
    const updated = this.deps.store.updateAuditRun(this.record.id, partial)
    if (updated) this.record = updated
    else this.record = { ...this.record, ...partial }
    this.deps.onUpdate?.(this.record)
    return this.record
  }

  private cancelled(): boolean {
    return Boolean(this.deps.isCancelled?.())
  }

  private cancel(): AuditRunRecord {
    return this.persist({ status: 'cancelled', endedAt: this.deps.now() })
  }

  private fail(error: string): AuditRunRecord {
    this.deps.log?.(`[audit] failed: ${error}`)
    return this.persist({ status: 'failed', error, endedAt: this.deps.now() })
  }

  private fallbackReport(survivors: AuditFinding[], notes: string[]): string {
    const lines = ['# Audit report', '', `${survivors.length} surviving finding(s).`, '']
    for (const f of survivors) {
      const flag = f.verdictState === 'unverified' ? ' (unverified)' : ''
      lines.push(`- [${f.severity}] ${f.claim}${flag}`)
    }
    if (notes.length) {
      lines.push('', '## Coverage', ...notes.map((n) => `- ${n}`))
    }
    return lines.join('\n')
  }
}

// ── prompt builders (kept terse; tuning is a follow-up) ──────────────────────

function reconPrompt(workspacePath: string): string {
  return (
    `Recon the project at ${workspacePath}. Survey its stack, test surface, release ` +
    `paths, security-sensitive areas, provider/runtime boundaries, docs surface, and ` +
    `known risk zones. Call audit_set_profile ONCE with concise string arrays. Do not edit files.`
  )
}

function reviewerPrompt(dimension: string, workspacePath: string): string {
  return (
    `Review the project at ${workspacePath} along the "${dimension}" dimension. For each ` +
    `distinct issue or strength, call audit_record_finding with a concrete claim, severity, ` +
    `confidence, and at least one file:line evidence ref. Read-only — do not edit files.`
  )
}

function skepticPrompt(finding: AuditFinding): string {
  return (
    `Adversarially judge this audit finding and try to REFUTE it:\n\n"${finding.claim}"\n` +
    `(severity: ${finding.severity}; evidence: ${finding.evidenceRefs
      .map((e) => `${e.path}:${e.line ?? '?'}`)
      .join(', ')})\n\n` +
    `Call audit_record_verdict for finding ${finding.id}. To refute you MUST cite contradicting ` +
    `evidence in counterEvidence; otherwise use accept or downgrade. Read-only.`
  )
}

function synthesisPrompt(survivors: AuditFinding[], notes: string[]): string {
  return (
    `Synthesize a strengths/weaknesses audit report from these ${survivors.length} verified ` +
    `findings. Cite evidence; mark unverified findings as such; include a coverage footer.\n\n` +
    survivors.map((f) => `- [${f.severity}] ${f.claim} (${f.verdictState})`).join('\n') +
    (notes.length ? `\n\nCoverage notes:\n${notes.map((n) => `- ${n}`).join('\n')}` : '')
  )
}

// ── chain ordering helpers ───────────────────────────────────────────────────

/** Reorder a chain so `first` leads, preserving the rest as fallbacks. */
function orderChainFrom(chain: ProviderId[], first: ProviderId | undefined): ProviderId[] {
  if (!first || !chain.includes(first)) return [...chain]
  return [first, ...chain.filter((p) => p !== first)]
}

/** Prefer providers other than the finding's author (cross-provider
 * decorrelation); authors fall to the back rather than being dropped, so a
 * single-provider run still verifies (recorded as single-provider coverage). */
function preferCrossProvider(chain: ProviderId[], author: ProviderId): ProviderId[] {
  const others = chain.filter((p) => p !== author)
  const self = chain.filter((p) => p === author)
  return [...others, ...self]
}
