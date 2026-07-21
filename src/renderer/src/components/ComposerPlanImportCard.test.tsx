import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PlanImportExecutionEstimate, PlanImportReviewState } from '../lib/planImport'
import { ComposerPlanImportCard, type ComposerPlanImportCardProps } from './ComposerPlanImportCard'

const review: PlanImportReviewState = {
  id: 'plan-1',
  rawText: 'Implementation plan',
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
    runConstraints: [],
    stages: ['Audit current board surface', 'Compact the primary controls'],
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
  riskReasons: ['Imported paste is untrusted model-facing context.'],
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
    PLAN_IMPORT_RISK_LABELS: { low: 'Low risk', medium: 'Medium risk', high: 'High risk' },
    formatPlanImportCostEstimate: () => '$0.04',
    formatPlanImportTokenEstimate: (tokens) => `${tokens.toLocaleString()} tok`,
    renderPlanImportFileGroundings: renderGroundings,
    renderPlanImportItems: renderItems,
    setPendingPlanImport: () => undefined,
    handleGroundImportedPlanFiles: () => undefined,
    handleRunImportedPlan: () => undefined,
    handlePastePlanAsPrompt: () => undefined,
    ...overrides
  }
}

describe('ComposerPlanImportCard', () => {
  it('renders a compact collapsed review strip by default', () => {
    const html = renderToStaticMarkup(<ComposerPlanImportCard {...props()} />)

    expect(html).toContain('Plan detected')
    expect(html).toContain('Pasted plan - untrusted')
    expect(html).toContain('2 steps')
    expect(html).toContain('Low risk')
    expect(html).toContain('$0.04')
    expect(html).toContain('Paste as Prompt')
    expect(html).toContain('Import &amp; run')
    expect(html.indexOf('Review')).toBeLessThan(html.indexOf('Paste as Prompt'))
    expect(html.indexOf('Paste as Prompt')).toBeLessThan(html.indexOf('Import &amp; run'))
    expect(html).not.toContain('Read-only')
    expect(html).not.toContain('plan-import-review-panel')
    expect(html).not.toContain('Safety')
  })

  it('renders the detailed review sections when expanded', () => {
    const html = renderToStaticMarkup(<ComposerPlanImportCard {...props({ defaultExpanded: true })} />)

    expect(html).toContain('plan-import-review-panel')
    expect(html).toContain('Estimate')
    expect(html).toContain('Imported context')
    expect(html).toContain('Constraints')
    expect(html).toContain('Assumptions')
    expect(html).toContain('Paths')
    expect(html).toContain('Paste as Prompt')
    expect(html).not.toContain('Send as-is')
    expect(html).toContain('Plan Import never changes or recommends permissions.')
  })
})
