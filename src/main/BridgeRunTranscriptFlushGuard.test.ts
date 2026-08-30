import { describe, expect, it, vi } from 'vitest'
import { tryFlushBridgeRunTranscript } from './BridgeRunTranscriptFlushGuard'

describe('tryFlushBridgeRunTranscript', () => {
  it('returns success when the live transcript flush completes', () => {
    const flush = vi.fn()

    expect(tryFlushBridgeRunTranscript('run-1', flush)).toBe(true)
    expect(flush).toHaveBeenCalledWith('run-1')
  })

  it('contains a live flush failure and reports it for a later retry or terminal seal', () => {
    const error = new Error('duplicate transcript id')
    const flush = vi.fn(() => {
      throw error
    })
    const reportFailure = vi.fn()

    expect(tryFlushBridgeRunTranscript('run-2', flush, reportFailure)).toBe(false)
    expect(reportFailure).toHaveBeenCalledWith('run-2', error)
  })
})
