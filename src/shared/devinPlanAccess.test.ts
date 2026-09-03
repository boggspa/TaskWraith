import { describe, expect, it } from 'vitest'
import {
  DEVIN_FREE_PLAN_MODEL_IDS,
  clampDevinModelForPlan,
  filterDevinModelsForPlan,
  isDevinFreePlanGated,
  isDevinModelAllowedForPlan
} from './devinPlanAccess'
import { DEVIN_DEFAULT_MODEL_ID, DEVIN_MODEL_CATALOG } from './devinModelCatalog'

const FREE = { freePlan: true }
const PAID = { freePlan: false }

describe('Devin free-plan model access', () => {
  it('allows exactly SWE-1.6 Slow on a free plan', () => {
    expect([...DEVIN_FREE_PLAN_MODEL_IDS]).toEqual(['swe-1-6-slow'])
    expect(DEVIN_FREE_PLAN_MODEL_IDS.has(DEVIN_DEFAULT_MODEL_ID)).toBe(true)
  })

  it('gates only on a positively observed free plan', () => {
    expect(isDevinFreePlanGated(FREE)).toBe(true)
    expect(isDevinFreePlanGated(PAID)).toBe(false)
    expect(isDevinFreePlanGated({})).toBe(false)
    expect(isDevinFreePlanGated(undefined)).toBe(false)
    expect(isDevinFreePlanGated(null)).toBe(false)
  })

  it('withholds paid families from a free plan', () => {
    expect(isDevinModelAllowedForPlan('swe-1-6-slow', FREE)).toBe(true)
    expect(isDevinModelAllowedForPlan('  SWE-1-6-Slow  ', FREE)).toBe(true)
    expect(isDevinModelAllowedForPlan('claude-opus-5', FREE)).toBe(false)
    expect(isDevinModelAllowedForPlan('swe-1-7', FREE)).toBe(false)
    expect(isDevinModelAllowedForPlan('gpt-5-6-sol', FREE)).toBe(false)
  })

  it('leaves an unknown or paid plan entirely ungated', () => {
    for (const access of [PAID, {}, undefined, null]) {
      expect(isDevinModelAllowedForPlan('claude-opus-5', access)).toBe(true)
      expect(isDevinModelAllowedForPlan('some-custom-id', access)).toBe(true)
    }
  })

  it('reduces the real catalogue to one row for a free plan', () => {
    const all = filterDevinModelsForPlan(DEVIN_MODEL_CATALOG, PAID)
    const free = filterDevinModelsForPlan(DEVIN_MODEL_CATALOG, FREE)
    expect(all.length).toBe(DEVIN_MODEL_CATALOG.length)
    expect(all.length).toBeGreaterThan(1)
    expect(free.map((row) => row.id)).toEqual(['swe-1-6-slow'])
  })

  it('does not narrow the catalogue when the plan is unknown', () => {
    const unknown = filterDevinModelsForPlan(DEVIN_MODEL_CATALOG, undefined)
    expect(unknown.length).toBe(DEVIN_MODEL_CATALOG.length)
    expect(unknown.map((r) => r.id)).toContain('claude-opus-5')
  })

  it('preserves order and skips malformed rows', () => {
    const rows = [null, { id: 'swe-1-6-slow' }, { id: 'claude-opus-5' }, undefined] as any
    expect(filterDevinModelsForPlan(rows, PAID).map((r: any) => r.id)).toEqual([
      'swe-1-6-slow',
      'claude-opus-5'
    ])
    expect(filterDevinModelsForPlan(rows, FREE).map((r: any) => r.id)).toEqual(['swe-1-6-slow'])
  })

  it('clamps a persisted paid model down on a gated seat', () => {
    expect(clampDevinModelForPlan('claude-opus-5', FREE)).toBe('swe-1-6-slow')
    expect(clampDevinModelForPlan('swe-1-6-slow', FREE)).toBe('swe-1-6-slow')
    expect(clampDevinModelForPlan('', FREE)).toBe('swe-1-6-slow')
  })

  it('passes a model through untouched when the plan is not gated', () => {
    expect(clampDevinModelForPlan('claude-opus-5', PAID)).toBe('claude-opus-5')
    expect(clampDevinModelForPlan('claude-opus-5', undefined)).toBe('claude-opus-5')
    expect(clampDevinModelForPlan('', undefined)).toBe(DEVIN_DEFAULT_MODEL_ID)
  })
})
