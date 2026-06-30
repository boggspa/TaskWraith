import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  PlanImportChipId,
  PlanImportExecutionEstimate,
  PlanImportReviewState,
  PlanImportRunConstraintKind
} from '../lib/planImport'
import { ComposerPlanImportCard, type ComposerPlanImportCardProps } from './ComposerPlanImportCard'

const CHIP_LABELS: Record<PlanImportChipId, string> = {
  read_only: 'Read-only',
  ask_before_edits: 'Ask before edits',
  no_shell: 'No shell',
  no_network: 'No network',
  no_telemetry: 'No telemetry',
  quiet_summary: 'Quiet summary'
}

const RUN_CONSTRAINT_LABELS: Record<PlanImportRunConstraintKind, string> = {
  max_changed_files: 'Max changed files',
  exclude_paths_request: 'Exclude paths',
  verification_request: 'Verification requested'
}

const review: PlanImportReviewState = {
  id: 'plan-1',
  rawText: 'Implementation plan',
  selectedPolicy: 'read_only',
  enabledChips: ['read_only', 'no_shell', 'no_network'],
  contract: {
    goal: 'Refine the workspace boards interaction model without changing data contracts.',
    constraints: ['Keep storage untouched', 'Preserve existing IPC contracts'],
    assumptions: [{ text: 'Workspace board cards already have stable ids', status: 'unverified' }],
    filesMentioned: ['src/renderer/src/components/WorkspaceBoards.tsx'],
    fileGroundings: [
      {
        path: 'src/renderer/src/components/WorkspaceBoards.tsx',
        status: 'unverified',
        evidenceRefs: [],
        note: 'Mentioned in pasted plan'
      }
    ],
    riskyInstructions: [],
    contradictions: [],
    fearTranslations: [],
    runConstraints: [],
    stages: ['Audit current board surface', 'Compact the primary controls'],
    suggestedPreset: 'read_only',
    detectedChips: ['read_only', 'no_shell'],
    rawPreview: 'Implementation plan',
    source: 'pasted_plan_untrusted'
  }
}

const estimate: PlanImportExecutionEstimate = {
  promptTokens: 900,
  contextTokens: 4000,
  expectedOutputTokens: 1200,
  totalTokens: 6100,
  estimatedCostUsd: 0.04,
  costStatus: 'estimated',
  costAvailable: true,
  riskLevel: 'low',
  riskReasons: ['Read-only policy selected'],
  routingNote: 'Routes through the selected provider.',
  tokenNote: 'Estimate includes pasted plan and workspace context.'
}

function renderItems(items: string[]) {
  return items.length ? (
    <ul className="plan-import-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <span className="plan-import-empty">None detected</span>
  )
}

function renderGroundings(items: PlanImportReviewState['contract']['fileGroundings']) {
  return items.length ? (
    <ul className="plan-import-grounding-list">
      {items.map((item) => (
        <li key={item.path}>{item.path}</li>
      ))}
    </ul>
  ) : (
    <span className="plan-import-empty">None detected</span>
  )
}

function props(overrides: Partial<ComposerPlanImportCardProps> = {}): ComposerPlanImportCardProps {
  return {
    pendingPlanImport: review,
    disabled: false,
    displayCurrency: 'USD',
    overestimatePercent: 0,
    planImportExecutionEstimate: estimate,
    planImportGroundingBusy: false,
    planImportGroundingDisabledReason: '',
    PLAN_IMPORT_CHIP_LABELS: CHIP_LABELS,
    PLAN_IMPORT_RISK_LABELS: { low: 'Low risk', medium: 'Medium risk', high: 'High risk' },
    PLAN_IMPORT_RUN_CONSTRAINT_LABELS: RUN_CONSTRAINT_LABELS,
    formatPlanImportCostEstimate: () => '$0.04',
    formatPlanImportRunConstraintValue: () => '',
    formatPlanImportTokenEstimate: (tokens) => `${tokens.toLocaleString()} tok`,
    renderPlanImportFileGroundings: renderGroundings,
    renderPlanImportItems: renderItems,
    setPendingPlanImport: () => undefined,
    setPlanImportPolicy: () => undefined,
    handleGroundImportedPlanFiles: () => undefined,
    handleRunImportedPlan: () => undefined,
    handleRunRawPrompt: () => undefined,
    ...overrides
  }
}

describe('ComposerPlanImportCard', () => {
  it('renders a compact collapsed review strip by default', () => {
    const html = renderToStaticMarkup(<ComposerPlanImportCard {...props()} />)

    expect(html).toContain('Plan detected')
    expect(html).toContain('Pasted plan - untrusted')
    expect(html).toContain('2 steps')
    expect(html).toContain('Read-only')
    expect(html).toContain('Low risk')
    expect(html).toContain('$0.04')
    expect(html).toContain('Import &amp; run')
    expect(html).not.toContain('plan-import-review-panel')
    expect(html).not.toContain('Safety')
  })

  it('renders the detailed review sections when expanded', () => {
    const html = renderToStaticMarkup(<ComposerPlanImportCard {...props({ defaultExpanded: true })} />)

    expect(html).toContain('plan-import-review-panel')
    expect(html).toContain('Estimate')
    expect(html).toContain('Safety')
    expect(html).toContain('Constraints')
    expect(html).toContain('Assumptions')
    expect(html).toContain('Paths')
    expect(html).toContain('Send as-is')
    expect(html).toContain('File writes, shell commands, and network access stay denied.')
  })
})
