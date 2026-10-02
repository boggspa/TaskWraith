import { describe, expect, it, vi } from 'vitest'
import { bindMainResidualInstrumentation } from './MainResidualInstrumentation'
import type { MainPerfInstrumentation } from './MainPerfSnapshot'

describe('residual snapshot guard', () => {
  it('cancels private state and preserves an underlying snapshot error', () => {
    const original = new Error('snapshot failed')
    const cancel = vi.fn()
    const windows = {
      begin: () => {},
      end: () => {
        throw new Error('unused')
      },
      cancel
    }
    const base: MainPerfInstrumentation = {
      start: () => {},
      stop: () => {},
      snapshot: () => {
        throw original
      }
    }
    const guarded = bindMainResidualInstrumentation(base, windows)
    expect(() => guarded.snapshot()).toThrow(original)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
