import { describe, expect, it, vi } from 'vitest'
import {
  CURSOR_COMPLETION_WATCHDOG_ALIVE_QUIESCENCE_MS,
  CURSOR_COMPLETION_WATCHDOG_POLL_MS,
  CURSOR_COMPLETION_WATCHDOG_STARTUP_MS,
  EnsembleCursorCompletionWatchdog,
  cursorTransportLivenessFromRunSession,
  decideCursorCompletionWatchdog
} from './EnsembleCursorCompletionWatchdog'
import type { RunSession } from '../RunManager'

function runSession(over: Record<string, unknown> = {}): RunSession {
  return {
    runId: 'cursor-run',
    provider: 'cursor',
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    approvalIds: new Set(),
    sessionGrants: new Set(),
    ...over
  } as RunSession
}

describe('cursorTransportLivenessFromRunSession', () => {
  it('is conservative for an untracked session', () => {
    expect(cursorTransportLivenessFromRunSession(undefined)).toBe('unknown')
  })

  it('separates a tracked session that has not spawned a child from a silent one', () => {
    expect(cursorTransportLivenessFromRunSession(runSession())).toBe('starting')
    expect(cursorTransportLivenessFromRunSession(runSession({ status: 'starting' }))).toBe(
      'starting'
    )
  })

  it('treats an active child as alive until Node reports exit', () => {
    expect(cursorTransportLivenessFromRunSession(runSession({ process: { exitCode: null } }))).toBe(
      'alive'
    )
    expect(cursorTransportLivenessFromRunSession(runSession({ process: { exitCode: 1 } }))).toBe(
      'exited'
    )
    expect(cursorTransportLivenessFromRunSession(runSession({ process: { killed: true } }))).toBe(
      'exited'
    )
  })

  it('treats a terminal RunManager session as exited', () => {
    expect(cursorTransportLivenessFromRunSession(runSession({ status: 'failed' }))).toBe('exited')
  })
})

describe('decideCursorCompletionWatchdog', () => {
  const base = {
    active: true,
    nowMs: 30_000,
    lastActivityAt: 0,
    hasActiveToolOrApproval: false,
    timeoutMs: 30_000,
    pollMs: 1_000
  }

  it('stops when the run is no longer active', () => {
    expect(
      decideCursorCompletionWatchdog({ ...base, active: false, transportLiveness: 'exited' })
    ).toEqual({ kind: 'stop' })
  })

  it('fails a silent unknown transport at the bounded deadline', () => {
    expect(decideCursorCompletionWatchdog({ ...base, transportLiveness: 'unknown' })).toEqual({
      kind: 'fail',
      reason: expect.stringContaining('silent')
    })
  })

  it('fails an exited transport even when the stream had active output', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        transportLiveness: 'exited',
        hasActiveToolOrApproval: true
      })
    ).toMatchObject({ kind: 'fail', reason: expect.stringContaining('exited') })
  })

  it('keeps a known-live process within bounded quiescence and never times out active work', () => {
    expect(decideCursorCompletionWatchdog({ ...base, transportLiveness: 'alive' })).toEqual({
      kind: 'wait',
      delayMs: CURSOR_COMPLETION_WATCHDOG_POLL_MS
    })
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        transportLiveness: 'unknown',
        hasActiveToolOrApproval: true
      })
    ).toEqual({ kind: 'wait', delayMs: CURSOR_COMPLETION_WATCHDOG_POLL_MS })
  })

  it('fails a known-live but quiescent transport at the explicit safety deadline', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: CURSOR_COMPLETION_WATCHDOG_ALIVE_QUIESCENCE_MS,
        transportLiveness: 'alive'
      })
    ).toMatchObject({
      kind: 'fail',
      reason: expect.stringContaining('quiescent')
    })
  })

  it('recovers a critically full live seat before the long quiescence deadline', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: 45_000,
        lastActivityAt: 40_000,
        transportLiveness: 'alive',
        contextPressurePercent: 100,
        lastTokenGrowthAt: 0,
        contextPressureQuietMs: 45_000
      })
    ).toMatchObject({
      kind: 'recover_context',
      reason: expect.stringContaining('Path-B')
    })
  })

  it('keeps an active approval alive beyond the quiescence deadline', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: CURSOR_COMPLETION_WATCHDOG_ALIVE_QUIESCENCE_MS + 60_000,
        transportLiveness: 'alive',
        hasActiveToolOrApproval: true
      })
    ).toEqual({ kind: 'wait', delayMs: CURSOR_COMPLETION_WATCHDOG_POLL_MS })
  })

  it('keeps a seat that has not spawned past the silence deadline', () => {
    // Measured 2026-09-03: a read-only reviewer seat queued 2m31s on the
    // workspace-config lease behind a write-posture seat and was killed at 30s.
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: 151_000,
        transportLiveness: 'starting'
      })
    ).toEqual({ kind: 'wait', delayMs: CURSOR_COMPLETION_WATCHDOG_POLL_MS })
  })

  it('recovers a seat that never started at the bounded startup window', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: CURSOR_COMPLETION_WATCHDOG_STARTUP_MS,
        transportLiveness: 'starting'
      })
    ).toMatchObject({
      kind: 'recover_startup',
      reason: expect.stringContaining('workspace configuration lease')
    })
  })

  it('still fails an untracked transport at the silence deadline', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: 151_000,
        transportLiveness: 'unknown'
      })
    ).toMatchObject({ kind: 'fail', reason: expect.stringContaining('silent') })
  })

  it('waits for the bounded window after recent provider activity', () => {
    expect(
      decideCursorCompletionWatchdog({
        ...base,
        nowMs: 30_001,
        lastActivityAt: 30_000,
        transportLiveness: 'unknown'
      })
    ).toEqual({ kind: 'wait', delayMs: 1_000 })
  })
})

describe('EnsembleCursorCompletionWatchdog', () => {
  it('bounds an OS-alive silent child after the quiescence window', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const onMissingTerminal = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        now: () => now,
        timeoutMs: 30_000,
        aliveQuiescenceMs: 60_000,
        pollMs: 1_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => 'alive',
        isActive: () => true,
        onMissingTerminal
      })

      now = 30_000
      vi.advanceTimersByTime(30_000)
      expect(onMissingTerminal).not.toHaveBeenCalled()

      now = 60_000
      vi.advanceTimersByTime(1_000)
      expect(onMissingTerminal).toHaveBeenCalledTimes(1)
      expect(onMissingTerminal).toHaveBeenCalledWith(expect.stringContaining('quiescent'))
      expect(watchdog.has('cursor-run')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets on activity and invokes terminal recovery exactly once', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      let alive: 'unknown' | 'exited' = 'unknown'
      const onMissingTerminal = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        now: () => now,
        timeoutMs: 30_000,
        pollMs: 1_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => alive,
        isActive: () => true,
        onMissingTerminal
      })

      now = 29_000
      vi.advanceTimersByTime(29_000)
      watchdog.touch('cursor-run')
      now = 58_999
      vi.advanceTimersByTime(29_999)
      expect(onMissingTerminal).not.toHaveBeenCalled()

      now = 59_000
      alive = 'exited'
      vi.advanceTimersByTime(1_000)
      expect(onMissingTerminal).toHaveBeenCalledTimes(1)
      expect(watchdog.has('cursor-run')).toBe(false)
      vi.advanceTimersByTime(10_000)
      expect(onMissingTerminal).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops on terminal completion before a late watchdog tick', () => {
    vi.useFakeTimers()
    try {
      const onMissingTerminal = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        timeoutMs: 30_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => 'exited',
        isActive: () => false,
        onMissingTerminal
      })
      watchdog.stop('cursor-run')
      vi.advanceTimersByTime(60_000)
      expect(onMissingTerminal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never fails a queued seat that spawns before the startup window closes', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      let liveness: 'starting' | 'alive' = 'starting'
      const onMissingTerminal = vi.fn()
      const onStartupRecovery = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        now: () => now,
        timeoutMs: 30_000,
        startupMs: 300_000,
        pollMs: 1_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => liveness,
        isActive: () => true,
        onMissingTerminal,
        onStartupRecovery
      })

      // The whole 2m31s lease queue, well past the 30s silence deadline.
      now = 151_000
      vi.advanceTimersByTime(151_000)
      expect(onMissingTerminal).not.toHaveBeenCalled()
      expect(onStartupRecovery).not.toHaveBeenCalled()

      liveness = 'alive'
      watchdog.touch('cursor-run')
      now = 180_000
      vi.advanceTimersByTime(29_000)
      expect(onMissingTerminal).not.toHaveBeenCalled()
      expect(watchdog.has('cursor-run')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invokes startup recovery once without the missing-terminal fail path', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const onMissingTerminal = vi.fn()
      const onStartupRecovery = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        now: () => now,
        timeoutMs: 30_000,
        startupMs: 120_000,
        pollMs: 1_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => 'starting',
        isActive: () => true,
        onMissingTerminal,
        onStartupRecovery
      })

      now = 120_000
      vi.advanceTimersByTime(120_000)
      expect(onStartupRecovery).toHaveBeenCalledTimes(1)
      expect(onMissingTerminal).not.toHaveBeenCalled()
      expect(watchdog.has('cursor-run')).toBe(false)
      vi.advanceTimersByTime(120_000)
      expect(onStartupRecovery).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the fail path for embedders with no startup recovery lane', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const onMissingTerminal = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        now: () => now,
        timeoutMs: 30_000,
        startupMs: 120_000,
        pollMs: 1_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => 'starting',
        isActive: () => true,
        onMissingTerminal
      })

      now = 120_000
      vi.advanceTimersByTime(120_000)
      expect(onMissingTerminal).toHaveBeenCalledTimes(1)
      expect(onMissingTerminal).toHaveBeenCalledWith(expect.stringContaining('did not start'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('invokes context-pressure recovery without the missing-terminal fail path', () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const onMissingTerminal = vi.fn()
      const onContextPressureRecovery = vi.fn()
      const watchdog = new EnsembleCursorCompletionWatchdog()
      watchdog.start({
        runId: 'cursor-run',
        now: () => now,
        timeoutMs: 30_000,
        pollMs: 1_000,
        contextPressureQuietMs: 45_000,
        hasActiveToolOrApproval: () => false,
        transportLiveness: () => 'alive',
        contextPressurePercent: () => 100,
        isActive: () => true,
        onMissingTerminal,
        onContextPressureRecovery
      })
      watchdog.noteTokenSample('cursor-run', 1_000)
      now = 45_000
      vi.advanceTimersByTime(45_000)
      expect(onContextPressureRecovery).toHaveBeenCalledTimes(1)
      expect(onMissingTerminal).not.toHaveBeenCalled()
      expect(watchdog.has('cursor-run')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
