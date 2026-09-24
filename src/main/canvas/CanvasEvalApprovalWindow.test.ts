import { describe, expect, it } from 'vitest'
import {
  appendCanvasEvalApprovalWindowDisclosure,
  CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE,
  CANVAS_EVAL_APPROVAL_WINDOW_HOURS,
  CANVAS_EVAL_APPROVAL_WINDOW_MS
} from './CanvasEvalApprovalWindow'

describe('Canvas eval approval-window disclosure', () => {
  it('keeps the duration constant and the human-facing copy in lockstep', () => {
    expect(CANVAS_EVAL_APPROVAL_WINDOW_HOURS).toBe(12)
    expect(CANVAS_EVAL_APPROVAL_WINDOW_MS).toBe(12 * 60 * 60 * 1000)
    expect(CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE).toContain('12-hour')
  })

  it('states the exact live-surface scope, including navigation and later turns', () => {
    expect(CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE).toContain('this live Canvas surface')
    expect(CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE).toContain('after navigation')
    expect(CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE).toContain('in later turns')
    expect(CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE).toContain(
      'Other Canvas surfaces are not covered'
    )
    expect(CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE).toContain('restarting TaskWraith ends')
  })

  it('appends once after the provider-specific body without changing its text', () => {
    expect(appendCanvasEvalApprovalWindowDisclosure('Review this exact script.  ')).toBe(
      `Review this exact script.\n\n${CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE}`
    )
    expect(appendCanvasEvalApprovalWindowDisclosure(undefined)).toBe(
      CANVAS_EVAL_APPROVAL_WINDOW_DISCLOSURE
    )
  })
})
