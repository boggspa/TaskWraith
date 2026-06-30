import type { ReactNode } from 'react'
import { formatCost, type DisplayCurrency } from './formatCost'
import type {
  PlanImportAssumptionStatus,
  PlanImportExecutionEstimate,
  PlanImportFileGrounding,
  PlanImportRiskLevel,
  PlanImportRunConstraint,
  PlanImportRunConstraintKind
} from './planImport'

export const PLAN_IMPORT_RUN_CONSTRAINT_LABELS: Record<PlanImportRunConstraintKind, string> = {
  max_changed_files: 'Changed-file limit request',
  exclude_paths_request: 'Avoid-path request',
  verification_request: 'Verification request'
}

export const PLAN_IMPORT_GROUNDING_LABELS: Record<PlanImportAssumptionStatus, string> = {
  unverified: 'Unverified',
  verified_from_repo: 'Path indexed',
  contradicted_by_repo: 'No exact path match',
  needs_user_decision: 'Needs decision'
}

export const PLAN_IMPORT_RISK_LABELS: Record<PlanImportRiskLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

export function renderPlanImportItems(items: readonly string[], emptyText = 'None detected'): ReactNode {
  if (items.length === 0) {
    return <span className="plan-import-empty">{emptyText}</span>
  }
  return (
    <ul className="plan-import-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

export function formatPlanImportRunConstraintValue(constraint: PlanImportRunConstraint): string | null {
  if (typeof constraint.value === 'number') return `${constraint.value} changed-file limit`
  if (Array.isArray(constraint.value) && constraint.value.length > 0) {
    return constraint.value.join(', ')
  }
  return null
}

export function renderPlanImportFileGroundings(
  groundings: readonly PlanImportFileGrounding[],
  busy = false
): ReactNode {
  if (groundings.length === 0) {
    return <span className="plan-import-empty">No file paths detected</span>
  }
  const indexedCount = groundings.filter((item) => item.status === 'verified_from_repo').length
  const unverifiedCount = groundings.filter((item) => item.status === 'unverified').length
  const decisionCount = groundings.filter((item) => item.status === 'needs_user_decision').length
  const missingCount = groundings.filter((item) => item.status === 'contradicted_by_repo').length
  const summaryParts = [
    `${indexedCount} indexed`,
    `${unverifiedCount} unverified`,
    decisionCount > 0 ? `${decisionCount} need decision` : null,
    missingCount > 0 ? `${missingCount} no exact match` : null
  ].filter(Boolean)
  return (
    <>
      <small className="plan-import-grounding-summary" role="status" aria-live="polite">
        Exact workspace-index matches only; plan claims remain unverified. {summaryParts.join(', ')}
        .
      </small>
      <ul className="plan-import-grounding-list" aria-busy={busy}>
        {groundings.map((grounding) => {
          const evidenceText =
            grounding.evidenceRefs.length > 0
              ? grounding.evidenceRefs
                  .map((ref) => `${ref.path}${ref.note ? ` - ${ref.note}` : ''}`)
                  .join('; ')
              : grounding.note
          return (
            <li
              key={grounding.path}
              className={`plan-import-grounding-item status-${grounding.status}`}
            >
              <div className="plan-import-grounding-top">
                <code>{grounding.path}</code>
                <span className="plan-import-grounding-status">
                  {PLAN_IMPORT_GROUNDING_LABELS[grounding.status]}
                </span>
              </div>
              {evidenceText && <small>{evidenceText}</small>}
            </li>
          )
        })}
      </ul>
    </>
  )
}

export function formatPlanImportTokenEstimate(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(Math.round(tokens))
}

export function formatPlanImportCostEstimate(
  estimate: PlanImportExecutionEstimate,
  currency: DisplayCurrency,
  overestimatePercent: number
): string {
  if (estimate.costStatus === 'zero_rate') return 'Local / zero-rate'
  if (!estimate.costAvailable) return 'Pricing unavailable'
  const formatted = formatCost(estimate.estimatedCostUsd, currency, undefined, overestimatePercent)
  return formatted ? `~${formatted} API-equiv` : 'Pricing unavailable'
}