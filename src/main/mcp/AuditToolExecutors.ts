/*
 * Audit MCP tools — typed artifacts by construction.
 *
 * Reviewers/skeptics/recon agents emit STRUCTURED output by calling these
 * tools, never by writing prose the orchestrator has to parse:
 *   - audit_set_profile   (recon)    → the typed project profile
 *   - audit_record_finding(reviewer) → a finding with evidence + severity
 *   - audit_record_verdict(skeptic)  → accept/downgrade/refute on ONE finding
 *
 * The executor is injectable (record* callbacks + id/clock) so it unit-tests
 * without the orchestrator, AppStore, or a live run. The orchestrator (Slice 4)
 * wires the callbacks to AppStore.appendAuditFinding/Verdict + run-events, and
 * scopes exposure per role (a reviewer is never offered audit_record_verdict).
 * The executor ALSO enforces role as defense-in-depth.
 */

import type { McpToolDefinition } from './McpBridgeRuntime'
import { TAXONOMY_AUDIT_MCP_TOOL_NAMES } from '../../shared/providerActionTaxonomy'
import type {
  AuditEvidenceRef,
  AuditFinding,
  AuditFindingPolarity,
  AuditFindingSeverity,
  AuditFindingVerdictState,
  AuditProjectProfile,
  AuditRole,
  AuditVerdict,
  AuditVerdictDecision,
  ProviderId
} from '../store/types'

export const AUDIT_MCP_TOOL_NAMES = TAXONOMY_AUDIT_MCP_TOOL_NAMES

export type AuditMcpToolName = (typeof AUDIT_MCP_TOOL_NAMES)[number]

/** Which role is permitted to call which tool. */
const TOOL_ROLE: Record<AuditMcpToolName, AuditRole> = {
  audit_set_profile: 'recon',
  audit_record_finding: 'reviewer',
  audit_record_verdict: 'skeptic'
}

export interface AuditToolContext {
  auditRunId: string
  /** The provider run id this tool call belongs to — lets the collector
   * attribute artifacts to the specific role-run that produced them, so the
   * orchestrator's dispatchRole can drain exactly that run's output. */
  runId: string
  role: AuditRole
  /** Reviewer's dimension; ignored for other roles. */
  dimension?: string
  /** The provider running this agent — stamped as authorProvider/skepticProvider. */
  provider: ProviderId
}

export interface AuditToolDependencies {
  recordFinding: (context: AuditToolContext, finding: AuditFinding) => void | Promise<void>
  recordVerdict: (context: AuditToolContext, verdict: AuditVerdict) => void | Promise<void>
  setProfile: (context: AuditToolContext, profile: AuditProjectProfile) => void | Promise<void>
  /** Injected for deterministic tests. */
  uuid: () => string
  now: () => string
}

export interface AuditToolExecution {
  result: { ok: boolean; error?: string; id?: string }
  isError: boolean
}

// ── pure coercion helpers (exported for tests) ──────────────────────────────

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clampConfidence(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

const SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'critical'])
const DECISIONS: ReadonlySet<string> = new Set(['accept', 'downgrade', 'refute'])

function coerceSeverity(value: unknown): AuditFindingSeverity {
  return SEVERITIES.has(asString(value)) ? (value as AuditFindingSeverity) : 'medium'
}

function coercePolarity(value: unknown): AuditFindingPolarity {
  return asString(value) === 'strength' ? 'strength' : 'weakness'
}

export function coerceEvidenceRefs(value: unknown): AuditEvidenceRef[] {
  if (!Array.isArray(value)) return []
  const refs: AuditEvidenceRef[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const path = asString(r.path).trim()
    if (!path) continue
    const line = Number(r.line)
    refs.push({
      path,
      ...(Number.isFinite(line) && line > 0 ? { line: Math.trunc(line) } : {}),
      ...(asString(r.note).trim() ? { note: asString(r.note).trim() } : {})
    })
  }
  return refs
}

/** Stable dedup key: first evidence anchor (path:line) + normalized claim, so
 * the same issue surfaced under several dimensions collapses to one finding in
 * the Slice-4 dedup barrier. */
export function deriveDedupKey(claim: string, evidence: AuditEvidenceRef[]): string {
  const normalizedClaim = claim
    .toLowerCase()
    .replace(/[`"'*_#]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  const anchor = evidence[0] ? `${evidence[0].path}:${evidence[0].line ?? 0}` : 'no-anchor'
  return `${anchor}|${normalizedClaim}`
}

export function coerceProfile(args: Record<string, unknown>): AuditProjectProfile {
  const strArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const cleaned = v.map((x) => asString(x).trim()).filter(Boolean)
    return cleaned.length > 0 ? cleaned : undefined
  }
  const profile: AuditProjectProfile = {}
  const assign = (key: keyof AuditProjectProfile): void => {
    const cleaned = strArr(args[key])
    if (cleaned) profile[key] = cleaned
  }
  assign('stack')
  assign('testSurface')
  assign('releasePaths')
  assign('securityAreas')
  assign('providerBoundaries')
  assign('docsSurface')
  assign('riskZones')
  return profile
}

export function coerceFinding(
  args: Record<string, unknown>,
  context: AuditToolContext,
  ids: { uuid: () => string; now: () => string }
): AuditFinding | null {
  const claim = asString(args.claim).trim()
  if (!claim) return null
  const evidenceRefs = coerceEvidenceRefs(args.evidenceRefs)
  return {
    id: ids.uuid(),
    dimension: asString(args.dimension).trim() || context.dimension || 'general',
    polarity: coercePolarity(args.polarity),
    claim,
    severity: coerceSeverity(args.severity),
    confidence: clampConfidence(args.confidence),
    evidenceRefs,
    verification: asString(args.verification).trim() || undefined,
    suggestedFix: asString(args.suggestedFix).trim() || undefined,
    blastRadius: asString(args.blastRadius).trim() || undefined,
    authorProvider: context.provider,
    dedupKey: deriveDedupKey(claim, evidenceRefs),
    verdictState: 'pending',
    createdAt: ids.now()
  }
}

export function coerceVerdict(
  args: Record<string, unknown>,
  context: AuditToolContext,
  ids: { uuid: () => string; now: () => string }
): AuditVerdict | null {
  const findingId = asString(args.findingId).trim()
  if (!findingId) return null
  const decision = DECISIONS.has(asString(args.decision))
    ? (args.decision as AuditVerdictDecision)
    : 'downgrade'
  const counterEvidence = coerceEvidenceRefs(args.counterEvidence)
  return {
    id: ids.uuid(),
    findingId,
    skepticProvider: context.provider,
    decision,
    ...(counterEvidence.length > 0 ? { counterEvidence } : {}),
    rationale: asString(args.rationale).trim() || undefined,
    createdAt: ids.now()
  }
}

/**
 * Evidence-anchor verdict rule — the heart of "refuse unsupported claims".
 * Given all verdicts for ONE finding, resolve its state:
 *   - an evidence-anchored refute (refute + counterEvidence) KILLS it → refuted
 *   - any weakening vote (downgrade, OR a refute WITHOUT counter-evidence)
 *     with no kill → unverified (kept, flagged — never silently dropped)
 *   - only accepts → confirmed
 *   - no verdicts → pending
 */
export function resolveFindingVerdictState(
  verdicts: Pick<AuditVerdict, 'decision' | 'counterEvidence'>[]
): AuditFindingVerdictState {
  if (verdicts.length === 0) return 'pending'
  let weakening = 0
  let accepts = 0
  for (const v of verdicts) {
    const hasCounter = Boolean(v.counterEvidence && v.counterEvidence.length > 0)
    if (v.decision === 'refute' && hasCounter) return 'refuted'
    if (v.decision === 'refute' || v.decision === 'downgrade') weakening += 1
    else if (v.decision === 'accept') accepts += 1
  }
  if (weakening > 0) return 'unverified'
  return accepts > 0 ? 'confirmed' : 'pending'
}

// ── tool definitions ────────────────────────────────────────────────────────

const EVIDENCE_SCHEMA = {
  type: 'array',
  description: 'Evidence anchors — file paths (workspace-relative) with optional line + note.',
  items: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      line: { type: 'number' },
      note: { type: 'string' }
    },
    required: ['path']
  }
}

export function auditToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'audit_set_profile',
      description:
        'Record the typed project profile from recon. Call ONCE with arrays of short strings.',
      inputSchema: {
        type: 'object',
        properties: {
          stack: { type: 'array', items: { type: 'string' } },
          testSurface: { type: 'array', items: { type: 'string' } },
          releasePaths: { type: 'array', items: { type: 'string' } },
          securityAreas: { type: 'array', items: { type: 'string' } },
          providerBoundaries: { type: 'array', items: { type: 'string' } },
          docsSurface: { type: 'array', items: { type: 'string' } },
          riskZones: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    {
      name: 'audit_record_finding',
      description:
        'Record ONE audit finding. Every finding MUST carry concrete evidence (file:line). ' +
        'Call once per distinct finding; do not batch.',
      inputSchema: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'The finding, stated concisely.' },
          polarity: { type: 'string', enum: ['strength', 'weakness'] },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          confidence: { type: 'number', description: '0..1 self-assessed confidence.' },
          evidenceRefs: EVIDENCE_SCHEMA,
          verification: { type: 'string', description: 'How to reproduce/verify.' },
          suggestedFix: { type: 'string' },
          blastRadius: { type: 'string' },
          dimension: { type: 'string' }
        },
        required: ['claim', 'severity', 'evidenceRefs']
      }
    },
    {
      name: 'audit_record_verdict',
      description:
        'Adversarially judge ONE finding. To REFUTE you MUST cite contradicting evidence in ' +
        'counterEvidence; a refute with no counter-evidence only downgrades the finding to ' +
        'unverified (it is never silently dropped).',
      inputSchema: {
        type: 'object',
        properties: {
          findingId: { type: 'string' },
          decision: { type: 'string', enum: ['accept', 'downgrade', 'refute'] },
          counterEvidence: EVIDENCE_SCHEMA,
          rationale: { type: 'string' }
        },
        required: ['findingId', 'decision']
      }
    }
  ]
}

export interface AuditToolExecutors {
  executeAuditMcpTool: (
    toolName: AuditMcpToolName,
    args: Record<string, unknown>,
    context: AuditToolContext
  ) => Promise<AuditToolExecution>
}

export function createAuditToolExecutors(deps: AuditToolDependencies): AuditToolExecutors {
  const ids = { uuid: deps.uuid, now: deps.now }
  const fail = (error: string): AuditToolExecution => ({
    result: { ok: false, error },
    isError: true
  })

  return {
    async executeAuditMcpTool(toolName, args, context) {
      // Defense-in-depth: the orchestrator scopes exposure per role, but the
      // executor refuses a tool the calling role isn't entitled to.
      const requiredRole = TOOL_ROLE[toolName]
      if (requiredRole && context.role !== requiredRole) {
        return fail(`Tool "${toolName}" is not available to the ${context.role} role.`)
      }
      if (toolName === 'audit_set_profile') {
        await deps.setProfile(context, coerceProfile(args))
        return { result: { ok: true }, isError: false }
      }
      if (toolName === 'audit_record_finding') {
        const finding = coerceFinding(args, context, ids)
        if (!finding) return fail('A finding requires a non-empty `claim`.')
        if (finding.evidenceRefs.length === 0) {
          return fail('A finding requires at least one evidence ref (file path).')
        }
        await deps.recordFinding(context, finding)
        return { result: { ok: true, id: finding.id }, isError: false }
      }
      if (toolName === 'audit_record_verdict') {
        const verdict = coerceVerdict(args, context, ids)
        if (!verdict) return fail('A verdict requires a `findingId`.')
        await deps.recordVerdict(context, verdict)
        return { result: { ok: true, id: verdict.id }, isError: false }
      }
      return fail(`Unknown audit tool "${toolName}".`)
    }
  }
}
