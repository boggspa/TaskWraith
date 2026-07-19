import { describe, expect, it } from 'vitest'
import {
  AuditOrchestrator,
  gateChecksForMode,
  planDimensions,
  type AuditOrchestratorDeps,
  type AuditOrchestratorStore,
  type AuditRoleRunRequest,
  type AuditRoleRunResult
} from './AuditOrchestrator'
import type { ProviderSignal } from './ProviderCapabilityResolver'
import type {
  AuditFinding,
  AuditGateResult,
  AuditRunRecord,
  AuditVerdict,
  ProviderId
} from '../store/types'

// ── in-memory store ──────────────────────────────────────────────────────────

function makeStore(): { store: AuditOrchestratorStore; get: () => AuditRunRecord } {
  let record: AuditRunRecord | null = null
  let n = 0
  const store: AuditOrchestratorStore = {
    createAuditRun: (input) => {
      record = {
        schemaVersion: 1,
        id: `audit-${++n}`,
        mode: input.mode,
        chatId: input.chatId,
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        status: input.status ?? 'planning',
        phases: input.phases ?? [],
        profile: input.profile,
        dimensions: input.dimensions ?? [],
        roster: input.roster,
        participants: input.participants ?? [],
        findings: input.findings ?? [],
        verdicts: input.verdicts ?? [],
        gates: input.gates ?? [],
        budget: input.budget,
        coverage: input.coverage,
        report: input.report,
        error: input.error,
        createdAt: 't0',
        updatedAt: 't0',
        startedAt: input.startedAt,
        endedAt: input.endedAt
      }
      return record
    },
    updateAuditRun: (id, partial) => {
      if (!record || record.id !== id) return null
      record = { ...record, ...partial, updatedAt: 't1' }
      return record
    }
  }
  return { store, get: () => record! }
}

// ── finding/verdict builders ─────────────────────────────────────────────────

function finding(id: string, over: Partial<AuditFinding>): AuditFinding {
  return {
    id,
    dimension: 'd',
    polarity: 'weakness',
    claim: id,
    severity: 'medium',
    confidence: 0.7,
    evidenceRefs: [{ path: `src/${id}.ts`, line: 1 }],
    authorProvider: 'claude',
    dedupKey: `key-${id}`,
    verdictState: 'pending',
    createdAt: 't',
    ...over
  }
}

let idSeq = 0
function baseDeps(over: Partial<AuditOrchestratorDeps> = {}): AuditOrchestratorDeps {
  const { store } = makeStore()
  return {
    store,
    resolveSignals: async (): Promise<ProviderSignal[]> => [
      { provider: 'claude', configured: true, authenticated: true, healthy: true },
      { provider: 'codex', configured: true, authenticated: true, healthy: true },
      { provider: 'grok', configured: true, authenticated: true, healthy: true }
    ],
    runGates: async (): Promise<AuditGateResult[]> => [
      { id: 'g1', check: 'typecheck', command: 'npm run typecheck', status: 'pass' }
    ],
    dispatchRole: async (req): Promise<AuditRoleRunResult> => ({
      ok: true,
      runId: `r-${++idSeq}`,
      tokens: 100,
      report: req.role === 'synthesis' ? 'REPORT' : undefined,
      profile: req.role === 'recon' ? { riskZones: ['god modules'] } : undefined
    }),
    now: () => 'now',
    uuid: () => `u-${++idSeq}`,
    ...over
  }
}

const input = { mode: 'quick' as const, chatId: 'c1', workspacePath: '/repo' }

describe('planning helpers', () => {
  it('quick = 3 fixed dimensions; deep folds recon risk zones (capped); release is release-set', () => {
    expect(planDimensions('quick')).toHaveLength(3)
    const deep = planDimensions('deep', { riskZones: ['relay', 'relay', 'ios bridge'] })
    expect(deep).toContain('relay')
    expect(deep).toContain('ios bridge')
    expect(deep.length).toBeLessThanOrEqual(8)
    expect(planDimensions('release')).toContain('packaging & signing')
  })

  it('gate checks escalate by mode', () => {
    expect(gateChecksForMode('quick').map((c) => c.check)).toEqual(['typecheck', 'test'])
    expect(gateChecksForMode('release').map((c) => c.check)).toContain('validate-release')
  })
})

describe('AuditOrchestrator — full DAG', () => {
  it('projects each gate under the exact audit identity before releasing the runner', async () => {
    const state = makeStore()
    const observed: string[] = []
    const gate: AuditGateResult = {
      id: 'g-exact',
      check: 'typecheck',
      command: 'npm run typecheck',
      status: 'pass'
    }
    const deps = baseDeps({
      store: state.store,
      runGates: async (_checks, _workspacePath, authority, projectGate) => {
        expect(authority).toEqual({
          auditRunId: 'audit-1',
          appChatId: 'c1',
          workspaceId: 'workspace-1',
          workspacePath: '/repo'
        })
        projectGate?.(gate)
        expect(state.get().gates).toEqual([gate])
        observed.push('persisted-before-runner-return')
        return [gate]
      }
    })

    const result = await new AuditOrchestrator(deps).run({
      ...input,
      workspaceId: 'workspace-1'
    })

    expect(observed).toEqual(['persisted-before-runner-return'])
    expect(result.gates).toEqual([gate])
  })

  it('runs recon→gates‖reviewers→dedup→verify→synthesis to completion', async () => {
    const store = makeStore()
    const deps = baseDeps({ store: store.store })
    // Two dimensions surface the SAME dedupKey; a third surfaces a high-sev
    // finding the skeptic will refute with counter-evidence.
    deps.dispatchRole = async (req: AuditRoleRunRequest): Promise<AuditRoleRunResult> => {
      if (req.role === 'recon') return { ok: true, runId: 'r-recon', profile: { riskZones: [] } }
      if (req.role === 'synthesis') return { ok: true, runId: 'r-syn', report: 'FINAL REPORT' }
      if (req.role === 'reviewer') {
        if (req.dimension === 'code health') {
          return { ok: true, runId: 'r-rev1', findings: [finding('F-dup', { dedupKey: 'K1', severity: 'high', authorProvider: 'claude' })] }
        }
        if (req.dimension === 'test depth') {
          return {
            ok: true,
            runId: 'r-rev2',
            findings: [
              finding('F-dup2', { dedupKey: 'K1', severity: 'high', authorProvider: 'claude' }),
              finding('F-low', { dedupKey: 'K2', severity: 'low', authorProvider: 'claude' })
            ]
          }
        }
        return { ok: true, runId: 'r-rev3', findings: [finding('F-kill', { dedupKey: 'K3', severity: 'high', authorProvider: 'claude' })] }
      }
      // skeptic
      if (req.findingId === 'F-kill') {
        return {
          ok: true,
          runId: `r-sk-${++idSeq}`,
          verdicts: [
            {
              id: `v-${idSeq}`,
              findingId: 'F-kill',
              skepticProvider: req.provider,
              decision: 'refute',
              counterEvidence: [{ path: 'src/x.ts', line: 9 }],
              createdAt: 't'
            } as AuditVerdict
          ]
        }
      }
      return {
        ok: true,
        runId: `r-sk-${++idSeq}`,
        verdicts: [
          { id: `v-${idSeq}`, findingId: req.findingId!, skepticProvider: req.provider, decision: 'accept', createdAt: 't' } as AuditVerdict
        ]
      }
    }

    const result = await new AuditOrchestrator(deps).run(input)

    expect(result.status).toBe('completed')
    expect(result.profile).toBeDefined()
    expect(result.gates).toHaveLength(1)
    // dedup merged F-dup2 into F-dup → 3 distinct findings (F-dup, F-low, F-kill).
    expect(result.findings).toHaveLength(3)
    const dup = result.findings.find((f) => f.id === 'F-dup')!
    expect(dup.mergedFrom).toContain('F-dup2')
    // F-kill refuted (evidence-anchored) and dropped from survivors; report set.
    expect(result.findings.find((f) => f.id === 'F-kill')?.verdictState).toBe('refuted')
    expect(result.report).toBe('FINAL REPORT')
    // High-sev F-dup got 2 cross-provider skeptics (codex + grok, author claude).
    const dupVerdictProviders = new Set(
      result.verdicts.filter((v) => v.findingId === 'F-dup').map((v) => v.skepticProvider)
    )
    expect(dupVerdictProviders.size).toBe(2)
    expect(dupVerdictProviders.has('claude')).toBe(false)
    expect(result.coverage?.crossProviderVerifiedCount).toBeGreaterThanOrEqual(1)
    // All phases completed.
    expect(result.phases.every((p) => p.status === 'completed')).toBe(true)
  })
})

describe('AuditOrchestrator — resilience', () => {
  it('substitutes a failed provider via the fallback chain', async () => {
    const deps = baseDeps()
    let claudeReviewerFailed = false
    deps.dispatchRole = async (req): Promise<AuditRoleRunResult> => {
      if (req.role === 'reviewer' && req.provider === 'claude' && !claudeReviewerFailed) {
        claudeReviewerFailed = true
        return { ok: false, runId: 'r-fail', error: 'rate limited' }
      }
      if (req.role === 'synthesis') return { ok: true, runId: 'r-syn', report: 'R' }
      if (req.role === 'recon') return { ok: true, runId: 'r-recon', profile: {} }
      if (req.role === 'reviewer')
        return { ok: true, runId: `r-${++idSeq}`, findings: [finding(`F${idSeq}`, {})] }
      return { ok: true, runId: `r-${++idSeq}`, verdicts: [] }
    }
    const result = await new AuditOrchestrator(deps).run(input)
    expect(result.status).toBe('completed')
    expect(result.participants.some((p) => p.substitutedFrom === 'claude')).toBe(true)
  })

  it('counts fallback substitutions as additional spawned agents', async () => {
    const deps = baseDeps({ policy: { budgetMaxAgents: 6 } })
    let claudeReviewerFailed = false
    deps.dispatchRole = async (req): Promise<AuditRoleRunResult> => {
      if (req.role === 'reviewer' && req.provider === 'claude' && !claudeReviewerFailed) {
        claudeReviewerFailed = true
        return { ok: false, runId: 'r-fail', error: 'temporary provider failure' }
      }
      if (req.role === 'recon') return { ok: true, runId: 'r-recon', profile: {} }
      if (req.role === 'synthesis') return { ok: true, runId: 'r-syn', report: 'R' }
      if (req.role === 'reviewer') return { ok: true, runId: `r-${++idSeq}`, findings: [] }
      return { ok: true, runId: `r-${++idSeq}`, verdicts: [] }
    }

    const result = await new AuditOrchestrator(deps).run(input)

    expect(result.status).toBe('completed')
    expect(result.budget.spentAgents).toBe(6)
    expect(result.coverage?.substitutions).toBe(1)
  })

  it('truncates skeptics when the agent budget is exhausted', async () => {
    const deps = baseDeps({ policy: { budgetMaxAgents: 5 } })
    deps.dispatchRole = async (req): Promise<AuditRoleRunResult> => {
      if (req.role === 'recon') return { ok: true, runId: 'r', profile: {} }
      if (req.role === 'synthesis') return { ok: true, runId: 'r', report: 'R' }
      if (req.role === 'reviewer')
        return { ok: true, runId: `r-${++idSeq}`, findings: [finding(`F${idSeq}`, { severity: 'high' })] }
      return {
        ok: true,
        runId: `r-${++idSeq}`,
        verdicts: [{ id: `v${idSeq}`, findingId: req.findingId!, skepticProvider: req.provider, decision: 'accept', createdAt: 't' } as AuditVerdict]
      }
    }
    const result = await new AuditOrchestrator(deps).run(input)
    expect(result.budget.truncated).toBe(true)
    expect(result.coverage?.notes?.some((n) => n.includes('Budget ceiling'))).toBe(true)
  })

  it('snapshots the latest dynamic policy at run start', async () => {
    let policy = { providerAllowlist: ['claude' as ProviderId], budgetMaxAgents: 9 }
    const deps = baseDeps({ getPolicy: () => policy })
    const orchestrator = new AuditOrchestrator(deps)
    policy = { providerAllowlist: ['codex' as ProviderId], budgetMaxAgents: 4 }

    const result = await orchestrator.run(input)

    expect(result.budget.maxAgents).toBe(4)
    expect(result.roster?.perRole.reviewer).toEqual(['codex'])
  })

  it('resets per-run counters when the same orchestrator handles another audit', async () => {
    const deps = baseDeps()
    let failedOnce = false
    deps.dispatchRole = async (req): Promise<AuditRoleRunResult> => {
      if (req.role === 'reviewer' && req.provider === 'claude' && !failedOnce) {
        failedOnce = true
        return { ok: false, runId: 'r-fail', error: 'temporary provider failure' }
      }
      if (req.role === 'recon') return { ok: true, runId: 'r-recon', profile: {} }
      if (req.role === 'synthesis') return { ok: true, runId: 'r-syn', report: 'R' }
      if (req.role === 'reviewer') return { ok: true, runId: `r-${++idSeq}`, findings: [] }
      return { ok: true, runId: `r-${++idSeq}`, verdicts: [] }
    }
    const orchestrator = new AuditOrchestrator(deps)

    const first = await orchestrator.run(input)
    const second = await orchestrator.run(input)

    expect(first.coverage?.substitutions).toBe(1)
    expect(second.coverage?.substitutions).toBe(0)
    expect(second.coverage?.dimensionsCompleted).toBe(3)
  })

  it('does not emit awaitingConfirm when no confirmation gate is wired', async () => {
    const statuses: AuditRunRecord['status'][] = []
    const deps = baseDeps({
      onUpdate: (run) => statuses.push(run.status)
    })

    await new AuditOrchestrator(deps).run(input)

    expect(statuses).toContain('running')
    expect(statuses).not.toContain('awaitingConfirm')
  })

  it('emits awaitingConfirm only when a confirmation gate is wired', async () => {
    const statuses: AuditRunRecord['status'][] = []
    const deps = baseDeps({
      confirmPlan: async () => true,
      onUpdate: (run) => statuses.push(run.status)
    })

    await new AuditOrchestrator(deps).run(input)

    expect(statuses).toContain('awaitingConfirm')
    expect(statuses).toContain('running')
  })

  it('fails cleanly when no provider is eligible', async () => {
    const deps = baseDeps({
      resolveSignals: async () => [
        { provider: 'claude' as ProviderId, configured: true, authenticated: false, healthy: true }
      ]
    })
    const result = await new AuditOrchestrator(deps).run(input)
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/No eligible provider/)
  })

  it('defaults the audit roster to the parent chat provider when it is eligible', async () => {
    const providers: ProviderId[] = []
    const deps = baseDeps({
      resolveSignals: async () => [
        { provider: 'claude', configured: true, authenticated: true, healthy: true },
        { provider: 'kimi', configured: true, authenticated: true, healthy: true }
      ],
      dispatchRole: async (req): Promise<AuditRoleRunResult> => {
        providers.push(req.provider)
        if (req.role === 'recon') return { ok: true, runId: 'r-recon', profile: {} }
        if (req.role === 'synthesis') return { ok: true, runId: 'r-syn', report: 'R' }
        if (req.role === 'reviewer')
          return {
            ok: true,
            runId: `r-${providers.length}`,
            findings: [finding(`F${providers.length}`, { authorProvider: req.provider })]
          }
        return {
          ok: true,
          runId: `r-sk-${providers.length}`,
          verdicts: [
            { id: `v${providers.length}`, findingId: req.findingId!, skepticProvider: req.provider, decision: 'accept', createdAt: 't' } as AuditVerdict
          ]
        }
      }
    })

    const result = await new AuditOrchestrator(deps).run({ ...input, preferredProvider: 'kimi' })

    expect(result.status).toBe('completed')
    expect(result.roster?.perRole.reviewer).toEqual(['kimi'])
    expect(new Set(providers)).toEqual(new Set<ProviderId>(['kimi']))
  })

  it('does not silently fall back to Claude when the parent provider is not eligible', async () => {
    let dispatched = false
    const deps = baseDeps({
      resolveSignals: async () => [
        { provider: 'claude', configured: true, authenticated: true, healthy: true }
      ],
      dispatchRole: async (): Promise<AuditRoleRunResult> => {
        dispatched = true
        return { ok: true, runId: 'unexpected' }
      }
    })

    const result = await new AuditOrchestrator(deps).run({ ...input, preferredProvider: 'codex' })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('parent provider (codex)')
    expect(result.roster?.perRole.reviewer).toEqual([])
    expect(dispatched).toBe(false)
  })

  it('cancels mid-run when isCancelled flips', async () => {
    let reconDone = false
    const deps = baseDeps({
      isCancelled: () => reconDone,
      dispatchRole: async (req): Promise<AuditRoleRunResult> => {
        if (req.role === 'recon') {
          reconDone = true
          return { ok: true, runId: 'r', profile: {} }
        }
        return { ok: true, runId: 'r', report: 'R' }
      }
    })
    const result = await new AuditOrchestrator(deps).run(input)
    expect(result.status).toBe('cancelled')
  })

  it('cancels when the plan is rejected at the confirm gate', async () => {
    const deps = baseDeps({ confirmPlan: async () => false })
    const result = await new AuditOrchestrator(deps).run(input)
    expect(result.status).toBe('cancelled')
  })
})
