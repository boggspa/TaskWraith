import { describe, expect, it } from 'vitest'
import type { PlanImportExecutionEstimate, PlanImportRunConstraint } from './planImport'
import {
  formatPlanImportCostEstimate,
  formatPlanImportRunConstraintValue,
  formatPlanImportTokenEstimate,
  PLAN_IMPORT_GROUNDING_LABELS,
  PLAN_IMPORT_RISK_LABELS,
  PLAN_IMPORT_RUN_CONSTRAINT_LABELS
} from './planImportPresentation'

describe('planImportPresentation', () => {
  it('exposes stable label maps', () => {
    expect(PLAN_IMPORT_RUN_CONSTRAINT_LABELS.max_changed_files).toBe('Changed-file limit request')
    expect(PLAN_IMPORT_GROUNDING_LABELS.verified_from_repo).toBe('Path indexed')
    expect(PLAN_IMPORT_RISK_LABELS.high).toBe('High')
  })

  it('formats run constraint values', () => {
    const numeric: PlanImportRunConstraint = {
      kind: 'max_changed_files',
      sourceText: 'limit 3 files',
      value: 3,
      note: ''
    }
    expect(formatPlanImportRunConstraintValue(numeric)).toBe('3 changed-file limit')

    const paths: PlanImportRunConstraint = {
      kind: 'exclude_paths_request',
      sourceText: 'avoid dist',
      value: ['dist/', 'node_modules/'],
      note: ''
    }
    expect(formatPlanImportRunConstraintValue(paths)).toBe('dist/, node_modules/')

    const empty: PlanImportRunConstraint = {
      kind: 'verification_request',
      sourceText: 'run tests',
      note: ''
    }
    expect(formatPlanImportRunConstraintValue(empty)).toBeNull()
  })

  it('formats token estimates', () => {
    expect(formatPlanImportTokenEstimate(0)).toBe('0')
    expect(formatPlanImportTokenEstimate(850)).toBe('850')
    expect(formatPlanImportTokenEstimate(12_500)).toBe('12.5k')
    expect(formatPlanImportTokenEstimate(2_400_000)).toBe('2.4M')
  })

  it('formats cost estimates', () => {
    const zeroRate: PlanImportExecutionEstimate = {
      promptTokens: 0,
      contextTokens: 0,
      expectedOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      costAvailable: false,
      costStatus: 'zero_rate',
      riskLevel: 'low',
      riskReasons: [],
      routingNote: '',
      tokenNote: ''
    }
    expect(formatPlanImportCostEstimate(zeroRate, 'USD', 0)).toBe('Local / zero-rate')

    const unavailable: PlanImportExecutionEstimate = {
      promptTokens: 500,
      contextTokens: 0,
      expectedOutputTokens: 500,
      totalTokens: 1000,
      estimatedCostUsd: 0,
      costAvailable: false,
      costStatus: 'unavailable',
      riskLevel: 'medium',
      riskReasons: [],
      routingNote: '',
      tokenNote: ''
    }
    expect(formatPlanImportCostEstimate(unavailable, 'USD', 0)).toBe('Pricing unavailable')
  })
})