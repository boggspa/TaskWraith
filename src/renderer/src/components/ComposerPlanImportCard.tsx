import { useMemo, useState, type ReactNode } from 'react'
import type {
  PlanImportChipId,
  PlanImportExecutionEstimate,
  PlanImportPolicyMode,
  PlanImportReviewState,
  PlanImportRunConstraint
} from '../lib/planImport'
import {
  ExclamationShieldIcon,
  GoalSymbolIcon,
  PermissionSymbolIcon,
  ReviewSymbolIcon,
  RunSymbolIcon,
  XSymbolIcon
} from './AppChromeSymbols'
import './ComposerPlanImportCard.css'

export interface ComposerPlanImportCardProps {
  pendingPlanImport: PlanImportReviewState
  disabled?: boolean
  defaultExpanded?: boolean
  displayCurrency: string
  overestimatePercent: number
  planImportExecutionEstimate: PlanImportExecutionEstimate | null
  planImportGroundingBusy: boolean
  planImportGroundingDisabledReason?: string
  PLAN_IMPORT_CHIP_LABELS: Record<PlanImportChipId, string>
  PLAN_IMPORT_RISK_LABELS: Record<string, string>
  PLAN_IMPORT_RUN_CONSTRAINT_LABELS: Record<string, string>
  formatPlanImportCostEstimate: (
    estimate: PlanImportExecutionEstimate,
    currency: string,
    overestimatePercent: number
  ) => string
  formatPlanImportRunConstraintValue: (constraint: PlanImportRunConstraint) => string
  formatPlanImportTokenEstimate: (tokens: number) => string
  renderPlanImportFileGroundings: (
    groundings: PlanImportReviewState['contract']['fileGroundings'],
    busy: boolean
  ) => ReactNode
  renderPlanImportItems: (items: string[]) => ReactNode
  setPendingPlanImport: (next: PlanImportReviewState | null) => void
  setPlanImportPolicy: (policy: PlanImportPolicyMode) => void
  handleGroundImportedPlanFiles: () => void
  handleRunImportedPlan: () => void
  handleRunRawPrompt: () => void
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function compactSourceLabel(source: string): string {
  return source === 'pasted_plan_untrusted' ? 'Pasted plan - untrusted' : source
}

function policyLabel(policy: PlanImportPolicyMode): string {
  return policy === 'read_only' ? 'Read-only' : 'Ask before edits'
}

function policyDescription(policy: PlanImportPolicyMode): string {
  return policy === 'read_only'
    ? 'File writes, shell commands, and network access stay denied.'
    : 'Uses the default approval flow before edit-capable actions proceed.'
}

export function ComposerPlanImportCard({
  pendingPlanImport,
  disabled = false,
  defaultExpanded = false,
  displayCurrency,
  overestimatePercent,
  planImportExecutionEstimate,
  planImportGroundingBusy,
  planImportGroundingDisabledReason,
  PLAN_IMPORT_CHIP_LABELS,
  PLAN_IMPORT_RISK_LABELS,
  PLAN_IMPORT_RUN_CONSTRAINT_LABELS,
  formatPlanImportCostEstimate,
  formatPlanImportRunConstraintValue,
  formatPlanImportTokenEstimate,
  renderPlanImportFileGroundings,
  renderPlanImportItems,
  setPendingPlanImport,
  setPlanImportPolicy,
  handleGroundImportedPlanFiles,
  handleRunImportedPlan,
  handleRunRawPrompt
}: ComposerPlanImportCardProps): React.JSX.Element {
  const [reviewOpen, setReviewOpen] = useState(defaultExpanded)
  const reviewId = `plan-import-review-${pendingPlanImport.id}`
  const titleId = `plan-import-title-${pendingPlanImport.id}`
  const contract = pendingPlanImport.contract
  const issueCount = contract.riskyInstructions.length + contract.contradictions.length
  const stageCount = contract.stages.length
  const pathCount = contract.fileGroundings.length || contract.filesMentioned.length
  const assumptionCount = contract.assumptions.length
  const requestedGuidanceCount = contract.fearTranslations.length + contract.runConstraints.length
  const riskLabel = planImportExecutionEstimate
    ? PLAN_IMPORT_RISK_LABELS[planImportExecutionEstimate.riskLevel]
    : 'Estimate pending'
  const costLabel = planImportExecutionEstimate
    ? formatPlanImportCostEstimate(
        planImportExecutionEstimate,
        displayCurrency,
        overestimatePercent
      )
    : null
  const tokenLabel = planImportExecutionEstimate
    ? formatPlanImportTokenEstimate(planImportExecutionEstimate.totalTokens)
    : null
  const enforcedSummary = useMemo(
    () =>
      pendingPlanImport.enabledChips
        .map((chip) => PLAN_IMPORT_CHIP_LABELS[chip])
        .filter(Boolean)
        .join(' / '),
    [PLAN_IMPORT_CHIP_LABELS, pendingPlanImport.enabledChips]
  )
  const detectedSummary = useMemo(
    () =>
      contract.detectedChips
        .map((chip) => PLAN_IMPORT_CHIP_LABELS[chip])
        .filter(Boolean)
        .join(' / '),
    [PLAN_IMPORT_CHIP_LABELS, contract.detectedChips]
  )

  return (
    <section
      className={`composer-plan-import-card plan-import-card-v2 risk-${planImportExecutionEstimate?.riskLevel ?? 'unknown'}${reviewOpen ? ' is-review-open' : ''}`}
      role="region"
      aria-labelledby={titleId}
    >
      <div className="plan-import-compact-row">
        <div className="plan-import-compact-title">
          <GoalSymbolIcon />
          <div className="plan-import-compact-copy">
            <div className="plan-import-compact-kicker">
              <strong id={titleId}>Plan detected</strong>
              <span>{compactSourceLabel(contract.source)}</span>
            </div>
            <p title={contract.goal}>{contract.goal}</p>
          </div>
        </div>

        <div className="plan-import-compact-metrics" aria-label="Detected plan summary">
          <span>{stageCount > 0 ? pluralize(stageCount, 'step') : 'Steps pending'}</span>
          <span>{policyLabel(pendingPlanImport.selectedPolicy)}</span>
          <span>{riskLabel}</span>
          {costLabel && <span>{costLabel}</span>}
          {pathCount > 0 && <span>{pluralize(pathCount, 'path')}</span>}
        </div>

        <div className="plan-import-compact-actions">
          <button
            className="plan-import-review-toggle"
            type="button"
            aria-expanded={reviewOpen}
            aria-controls={reviewId}
            onClick={() => setReviewOpen((open) => !open)}
          >
            <ReviewSymbolIcon />
            {reviewOpen ? 'Hide review' : 'Review'}
          </button>
          <button
            className="btn btn-sm plan-import-primary-action"
            type="button"
            onClick={handleRunImportedPlan}
            disabled={disabled || planImportGroundingBusy}
          >
            <RunSymbolIcon />
            Import & run
          </button>
          <button
            className="composer-inline-clear plan-import-dismiss"
            type="button"
            onClick={() => setPendingPlanImport(null)}
            disabled={disabled}
            title="Dismiss plan import"
            aria-label="Dismiss plan import"
          >
            <XSymbolIcon />
          </button>
        </div>
      </div>

      {reviewOpen && (
        <div id={reviewId} className="plan-import-review-panel">
          <div className="plan-import-review-summary">
            <div className="plan-import-policy-control" role="radiogroup" aria-label="Plan import policy">
              <button
                className={`plan-import-policy-segment${pendingPlanImport.selectedPolicy === 'read_only' ? ' active' : ''}`}
                type="button"
                role="radio"
                aria-checked={pendingPlanImport.selectedPolicy === 'read_only'}
                onClick={() => setPlanImportPolicy('read_only')}
                disabled={disabled}
                title="Run the imported plan with read-only permissions"
              >
                <PermissionSymbolIcon />
                Read-only
              </button>
              <button
                className={`plan-import-policy-segment${pendingPlanImport.selectedPolicy === 'ask_before_edits' ? ' active' : ''}`}
                type="button"
                role="radio"
                aria-checked={pendingPlanImport.selectedPolicy === 'ask_before_edits'}
                onClick={() => setPlanImportPolicy('ask_before_edits')}
                disabled={disabled}
                title="Use default approvals before edit-capable actions"
              >
                <ExclamationShieldIcon />
                Ask before edits
              </button>
            </div>
            <p>{policyDescription(pendingPlanImport.selectedPolicy)}</p>
          </div>

          {planImportExecutionEstimate && (
            <section className="plan-import-review-section plan-import-review-estimate">
              <header>
                <span>Estimate</span>
              </header>
              <dl>
                <div>
                  <dt>Cost</dt>
                  <dd>{costLabel}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>{tokenLabel}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{riskLabel}</dd>
                </div>
              </dl>
              <p>{planImportExecutionEstimate.tokenNote}</p>
              <p>{planImportExecutionEstimate.routingNote}</p>
              {planImportExecutionEstimate.riskReasons.length > 0 && (
                <ul>
                  {planImportExecutionEstimate.riskReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <div className="plan-import-review-grid">
            <section className="plan-import-review-section">
              <header>
                <span>Safety</span>
              </header>
              <div className="plan-import-summary-line">
                <span>Enforced</span>
                <strong>{enforcedSummary || 'Policy selected'}</strong>
              </div>
              {detectedSummary && (
                <div className="plan-import-summary-line">
                  <span>Detected</span>
                  <strong>{detectedSummary}</strong>
                </div>
              )}
              {requestedGuidanceCount > 0 && (
                <div className="plan-import-requested-guidance">
                  {contract.fearTranslations.map((translation) => (
                    <div key={`${translation.sourceText}-${translation.requestedSignals.join('-')}`}>
                      <strong>{translation.sourceText}</strong>
                      <span>{translation.note}</span>
                    </div>
                  ))}
                  {contract.runConstraints.map((constraint) => {
                    const value = formatPlanImportRunConstraintValue(constraint)
                    return (
                      <div key={`${constraint.kind}-${constraint.sourceText}`}>
                        <strong>
                          {PLAN_IMPORT_RUN_CONSTRAINT_LABELS[constraint.kind]}
                          {value ? `: ${value}` : ''}
                        </strong>
                        <span>{constraint.note}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section className="plan-import-review-section">
              <header>
                <span>Constraints</span>
              </header>
              {renderPlanImportItems(contract.constraints)}
            </section>

            <section className="plan-import-review-section">
              <header>
                <span>Assumptions</span>
                {assumptionCount > 0 && <small>{pluralize(assumptionCount, 'item')}</small>}
              </header>
              {assumptionCount === 0 ? (
                <span className="plan-import-empty">None detected</span>
              ) : (
                <ul className="plan-import-list">
                  {contract.assumptions.map((assumption) => (
                    <li key={assumption.text}>
                      {assumption.text}
                      <em>Unverified</em>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="plan-import-review-section" aria-busy={planImportGroundingBusy}>
              <header>
                <span>Paths</span>
                {contract.fileGroundings.length > 0 && (
                  <button
                    className="plan-import-grounding-button"
                    type="button"
                    onClick={handleGroundImportedPlanFiles}
                    aria-describedby={
                      planImportGroundingDisabledReason
                        ? `plan-import-grounding-reason-${pendingPlanImport.id}`
                        : undefined
                    }
                    disabled={Boolean(planImportGroundingDisabledReason)}
                  >
                    {planImportGroundingBusy ? 'Checking...' : 'Check paths'}
                  </button>
                )}
              </header>
              {planImportGroundingDisabledReason && (
                <small
                  id={`plan-import-grounding-reason-${pendingPlanImport.id}`}
                  className="plan-import-grounding-reason"
                >
                  {planImportGroundingDisabledReason}
                </small>
              )}
              {renderPlanImportFileGroundings(contract.fileGroundings, planImportGroundingBusy)}
            </section>

            <section className="plan-import-review-section">
              <header>
                <span>Issues</span>
                {issueCount > 0 && <small>{pluralize(issueCount, 'item')}</small>}
              </header>
              {renderPlanImportItems([...contract.riskyInstructions, ...contract.contradictions])}
            </section>
          </div>

          <div className="plan-import-review-actions">
            <button
              className="btn btn-sm plan-import-primary-action"
              type="button"
              onClick={handleRunImportedPlan}
              disabled={disabled || planImportGroundingBusy}
            >
              <RunSymbolIcon />
              Import & run
            </button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={handleRunRawPrompt} disabled={disabled}>
              Send as-is
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
