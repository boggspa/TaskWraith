import type { ReactNode } from 'react'
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
  XSymbolIcon
} from './AppChromeSymbols'

export interface ComposerPlanImportCardProps {
  pendingPlanImport: PlanImportReviewState
  disabled?: boolean
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

export function ComposerPlanImportCard({
  pendingPlanImport,
  disabled = false,
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
  return (
    <div
      className="composer-plan-import-card"
      role="region"
      aria-labelledby={`plan-import-title-${pendingPlanImport.id}`}
    >
      <div className="plan-import-header">
        <div className="plan-import-title">
          <GoalSymbolIcon />
          <div>
            <strong id={`plan-import-title-${pendingPlanImport.id}`}>Plan import</strong>
            <span>From pasted plan - untrusted</span>
          </div>
        </div>
        <div className="plan-import-header-actions">
          <span className="plan-import-source">{pendingPlanImport.contract.source}</span>
          <button
            className="composer-inline-clear"
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

      <div className="plan-import-goal">
        <span>Goal</span>
        <strong>{pendingPlanImport.contract.goal}</strong>
      </div>

      <div className="plan-import-policy-row" role="radiogroup" aria-label="Plan import policy">
        <button
          className={`plan-import-policy-chip${pendingPlanImport.selectedPolicy === 'read_only' ? ' active' : ''}`}
          type="button"
          role="radio"
          aria-checked={pendingPlanImport.selectedPolicy === 'read_only'}
          onClick={() => setPlanImportPolicy('read_only')}
          disabled={disabled}
        >
          <PermissionSymbolIcon />
          Plan / read-only
        </button>
        <button
          className={`plan-import-policy-chip${pendingPlanImport.selectedPolicy === 'ask_before_edits' ? ' active' : ''}`}
          type="button"
          role="radio"
          aria-checked={pendingPlanImport.selectedPolicy === 'ask_before_edits'}
          onClick={() => setPlanImportPolicy('ask_before_edits')}
          disabled={disabled}
        >
          <ExclamationShieldIcon />
          Ask before edits
        </button>
        <span className="plan-import-policy-note">
          {pendingPlanImport.selectedPolicy === 'read_only'
            ? 'File writes, shell, and network stay denied by the read-only preset.'
            : 'Uses Default Approval; write actions go through the existing approval flow.'}
        </span>
      </div>

      <div className="plan-import-chip-row">
        <span className="plan-import-chip-label">Enforced</span>
        {pendingPlanImport.enabledChips.map((chip) => (
          <span key={chip} className="plan-import-chip">
            {PLAN_IMPORT_CHIP_LABELS[chip]}
          </span>
        ))}
      </div>
      {pendingPlanImport.contract.detectedChips.length > 0 && (
        <div className="plan-import-chip-row">
          <span className="plan-import-chip-label">Detected</span>
          {pendingPlanImport.contract.detectedChips.map((chip) => (
            <span key={chip} className="plan-import-chip detected">
              {PLAN_IMPORT_CHIP_LABELS[chip]}
            </span>
          ))}
        </div>
      )}
      {pendingPlanImport.contract.fearTranslations.length > 0 && (
        <div className="plan-import-section plan-import-fear-section">
          <span>Requested restrictions recognized</span>
          <ul className="plan-import-fear-list">
            {pendingPlanImport.contract.fearTranslations.map((translation) => (
              <li key={`${translation.sourceText}-${translation.requestedSignals.join('-')}`}>
                <strong>{translation.sourceText}</strong>
                <div>
                  {translation.requestedSignals.map((signal) => (
                    <span key={signal} className="plan-import-chip detected">
                      {PLAN_IMPORT_CHIP_LABELS[signal]}
                    </span>
                  ))}
                </div>
                <small>Requested signals only; enforced policy is shown above.</small>
                <small>{translation.note}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pendingPlanImport.contract.runConstraints.length > 0 && (
        <div className="plan-import-section plan-import-fear-section">
          <span>Untrusted requested guidance</span>
          <ul className="plan-import-fear-list">
            {pendingPlanImport.contract.runConstraints.map((constraint) => {
              const value = formatPlanImportRunConstraintValue(constraint)
              return (
                <li key={`${constraint.kind}-${constraint.sourceText}`}>
                  <strong>{PLAN_IMPORT_RUN_CONSTRAINT_LABELS[constraint.kind]}</strong>
                  {value && <code>{value}</code>}
                  <small>{constraint.sourceText}</small>
                  <small>{constraint.note}</small>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {planImportExecutionEstimate && (
        <div
          className={`plan-import-section plan-import-estimate-section risk-${planImportExecutionEstimate.riskLevel}`}
          aria-label="Plan import pre-run estimate"
        >
          <span>Pre-run estimate</span>
          <div className="plan-import-estimate-metrics">
            <span>
              <strong>Cost</strong>
              {formatPlanImportCostEstimate(
                planImportExecutionEstimate,
                displayCurrency,
                overestimatePercent
              )}
            </span>
            <span>
              <strong>Tokens</strong>~
              {formatPlanImportTokenEstimate(planImportExecutionEstimate.totalTokens)}
            </span>
            <span>
              <strong>Risk</strong>
              {PLAN_IMPORT_RISK_LABELS[planImportExecutionEstimate.riskLevel]}
            </span>
          </div>
          <small>{planImportExecutionEstimate.tokenNote}</small>
          <small>{planImportExecutionEstimate.routingNote}</small>
          <ul className="plan-import-estimate-reasons">
            {planImportExecutionEstimate.riskReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="plan-import-grid">
        <div className="plan-import-section">
          <span>Constraints</span>
          {renderPlanImportItems(pendingPlanImport.contract.constraints)}
        </div>
        <div className="plan-import-section">
          <span>Assumptions</span>
          {pendingPlanImport.contract.assumptions.length === 0 ? (
            <span className="plan-import-empty">None detected</span>
          ) : (
            <ul className="plan-import-list">
              {pendingPlanImport.contract.assumptions.map((assumption) => (
                <li key={assumption.text}>
                  {assumption.text}
                  <em>Unverified</em>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="plan-import-section" aria-busy={planImportGroundingBusy}>
          <div className="plan-import-section-heading">
            <span>Path mentions</span>
            {pendingPlanImport.contract.fileGroundings.length > 0 && (
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
          </div>
          {planImportGroundingDisabledReason && (
            <small
              id={`plan-import-grounding-reason-${pendingPlanImport.id}`}
              className="plan-import-grounding-reason"
            >
              {planImportGroundingDisabledReason}
            </small>
          )}
          {renderPlanImportFileGroundings(
            pendingPlanImport.contract.fileGroundings,
            planImportGroundingBusy
          )}
        </div>
        <div className="plan-import-section">
          <span>Risky or contradictory text</span>
          {renderPlanImportItems([
            ...pendingPlanImport.contract.riskyInstructions,
            ...pendingPlanImport.contract.contradictions
          ])}
        </div>
      </div>

      <div className="plan-import-actions">
        <button
          className="btn btn-sm"
          type="button"
          onClick={handleRunImportedPlan}
          disabled={disabled || planImportGroundingBusy}
        >
          Run imported plan
        </button>
        <button className="btn btn-sm btn-ghost" type="button" onClick={handleRunRawPrompt} disabled={disabled}>
          Use raw prompt
        </button>
      </div>
    </div>
  )
}
