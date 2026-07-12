import { describe, expect, it } from 'vitest'

import { decideKimiContentFilterRetry, decideKimiWireClose } from './KimiWireExitDecision'

describe('decideKimiWireClose', () => {
  it('ignores the close event when the run is already settled', () => {
    const decision = decideKimiWireClose({
      settled: true,
      promptSent: true,
      stateCompleted: true,
      exitAlreadyEmitted: true,
      code: 0
    })
    expect(decision.ignore).toBe(true)
    expect(decision.emitExit).toBe(false)
    expect(decision.emitResultLine).toBe(false)
  })

  it('regression: state.completed set by a notification still demands an agent-exit', () => {
    // Pre-fix behavior: the close handler called `runManager.finish('completed')`
    // and returned without emitting `agent-exit`. The renderer therefore
    // never invoked `clearActiveRunContext` and the sidebar kept the chat
    // in `runningChatIds`. The decision below asserts the post-fix
    // contract: `state.completed && !exitAlreadyEmitted` => emit exit.
    const decision = decideKimiWireClose({
      settled: false,
      promptSent: true,
      stateCompleted: true,
      exitAlreadyEmitted: false,
      code: 0
    })
    expect(decision.ignore).toBe(false)
    expect(decision.emitExit).toBe(true)
    expect(decision.terminalStatus).toBe('completed')
    expect(decision.resolveWire).toBe(true)
  })

  it("still emits exit when state.completed is set and exit was already emitted (idempotence is the caller's job)", () => {
    // The decision tree is intentionally naive: it tells the caller
    // "emit exit". The caller (`emitKimiExit`) flips `exitSent` on the
    // first call and turns subsequent ones into no-ops. That separation
    // keeps the decision tree pure and dependency-free.
    const decision = decideKimiWireClose({
      settled: false,
      promptSent: true,
      stateCompleted: true,
      exitAlreadyEmitted: true,
      code: 0
    })
    expect(decision.emitExit).toBe(true)
  })

  it('lets a non-zero child close override a provisional completed notification', () => {
    const decision = decideKimiWireClose({
      settled: false,
      promptSent: true,
      stateCompleted: true,
      exitAlreadyEmitted: false,
      code: 1
    })
    expect(decision.emitExit).toBe(true)
    expect(decision.terminalStatus).toBe('failed')
    expect(decision.resolveWire).toBe(true)
  })

  it('skips the IPC when the prompt was never sent — caller will fall back to print mode', () => {
    const decision = decideKimiWireClose({
      settled: false,
      promptSent: false,
      stateCompleted: false,
      exitAlreadyEmitted: false,
      code: null
    })
    expect(decision.ignore).toBe(false)
    expect(decision.emitExit).toBe(false)
    expect(decision.emitResultLine).toBe(false)
    expect(decision.terminalStatus).toBeUndefined()
    expect(decision.resolveWire).toBe(false)
  })

  it('synthesizes a result line and exit when the child closes mid-prompt without a completion notification', () => {
    const decision = decideKimiWireClose({
      settled: false,
      promptSent: true,
      stateCompleted: false,
      exitAlreadyEmitted: false,
      code: 1
    })
    expect(decision.emitResultLine).toBe(true)
    expect(decision.emitExit).toBe(true)
    expect(decision.terminalStatus).toBe('failed')
    expect(decision.resolveWire).toBe(true)
  })

  it('treats exit code 0 as a completed terminal status in the mid-prompt close path', () => {
    const decision = decideKimiWireClose({
      settled: false,
      promptSent: true,
      stateCompleted: false,
      exitAlreadyEmitted: false,
      code: 0
    })
    expect(decision.terminalStatus).toBe('completed')
  })
})

describe('decideKimiContentFilterRetry', () => {
  it('retries first with the keyword sanitiser when it can change the prompt', () => {
    expect(
      decideKimiContentFilterRetry({
        attemptedPasses: [],
        keywordCanRetry: true,
        classifierAvailable: false,
        classifierCanRetry: false
      })
    ).toEqual({ action: 'retry', pass: 'keyword' })
  })

  it('fails safely when keyword sanitisation cannot help and classifier is unavailable', () => {
    expect(
      decideKimiContentFilterRetry({
        attemptedPasses: [],
        keywordCanRetry: false,
        classifierAvailable: false,
        classifierCanRetry: false
      })
    ).toEqual({ action: 'fail', reason: 'classifier_unavailable' })
  })

  it('escalates to classifier redaction after the keyword pass has already been tried', () => {
    expect(
      decideKimiContentFilterRetry({
        attemptedPasses: ['keyword'],
        keywordCanRetry: false,
        classifierAvailable: true,
        classifierCanRetry: true
      })
    ).toEqual({ action: 'retry', pass: 'classifier' })
  })

  it('fails explicitly when classifier redaction is available but cannot change the prompt', () => {
    expect(
      decideKimiContentFilterRetry({
        attemptedPasses: ['keyword'],
        keywordCanRetry: false,
        classifierAvailable: true,
        classifierCanRetry: false
      })
    ).toEqual({ action: 'fail', reason: 'classifier_no_redaction' })
  })

  it('stops after both retry passes have been attempted', () => {
    expect(
      decideKimiContentFilterRetry({
        attemptedPasses: ['keyword', 'classifier'],
        keywordCanRetry: true,
        classifierAvailable: true,
        classifierCanRetry: true
      })
    ).toEqual({ action: 'fail', reason: 'retry_passes_exhausted' })
  })
})
