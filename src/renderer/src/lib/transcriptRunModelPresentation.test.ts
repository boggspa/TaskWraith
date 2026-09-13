import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun } from '../../../main/store/types'
import { transcriptRunModelPresentation } from './transcriptRunModelPresentation'

function fixture(actualModel: string | undefined = 'kimi-k2.8-preview'): {
  message: ChatMessage
  run: ChatRun
} {
  return {
    message: {
      id: 'reply',
      role: 'assistant',
      content: 'Finished.',
      timestamp: '2026-09-12T12:00:00.000Z',
      runId: 'run',
      metadata: {
        ensembleProvider: 'kimi',
        ensembleModel: 'kimi-k2.7-code',
        ensembleReasoningEffort: 'on',
        ensembleThinkingEnabled: true
      }
    },
    run: {
      runId: 'run',
      provider: 'kimi',
      startedAt: '2026-09-12T12:00:00.000Z',
      actualModel,
      ensembleSeatSnapshot: {
        schemaVersion: 1,
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        reasoningEffort: 'on',
        thinkingEnabled: true,
        configuredPermissionPresetId: 'read_only'
      }
    }
  }
}

describe('transcriptRunModelPresentation', () => {
  it('shows the actual migrated model and effort without rewriting captured history', () => {
    const { message, run } = fixture()
    const before = JSON.stringify({ message, run })
    const presented = transcriptRunModelPresentation(message, run, true)
    expect(presented.metadata).toMatchObject({
      ensembleModel: 'kimi-k2.8-preview',
      ensembleReasoningEffort: 'max',
      ensembleThinkingEnabled: true
    })
    expect(JSON.stringify({ message, run })).toBe(before)
    expect(transcriptRunModelPresentation(presented, run, true)).toBe(presented)
  })

  it.each(['low', 'high', 'max', 'ultraTask'])(
    'preserves the explicitly captured %s effort',
    (effort) => {
      const { message, run } = fixture()
      message.metadata!.ensembleReasoningEffort = effort
      expect(transcriptRunModelPresentation(message, run, true).metadata).toMatchObject({
        ensembleModel: 'kimi-k2.8-preview',
        ensembleReasoningEffort: effort
      })
    }
  )

  it('recovers effort from the captured run when message metadata lacks it', () => {
    const { message, run } = fixture()
    delete message.metadata!.ensembleReasoningEffort
    run.ensembleSeatSnapshot!.reasoningEffort = 'high'
    expect(transcriptRunModelPresentation(message, run, true).metadata).toMatchObject({
      ensembleModel: 'kimi-k2.8-preview',
      ensembleReasoningEffort: 'high'
    })
  })

  it('retains an exact historical K2.7 actual model and its Thinking state', () => {
    const { message, run } = fixture('kimi-k2.7-code')
    expect(transcriptRunModelPresentation(message, run, true)).toBe(message)
  })

  it('leaves solo, pre-init failure, and missing-run messages untouched', () => {
    const { message, run } = fixture()
    expect(transcriptRunModelPresentation(message, run, false)).toBe(message)
    expect(transcriptRunModelPresentation(message, null, true)).toBe(message)
    delete run.actualModel
    expect(transcriptRunModelPresentation(message, run, true)).toBe(message)
  })

  it('keeps Highspeed and other provider efforts unchanged', () => {
    const { message, run } = fixture('kimi-k2.7-code-highspeed')
    expect(transcriptRunModelPresentation(message, run, true).metadata).toMatchObject({
      ensembleModel: 'kimi-k2.7-code-highspeed',
      ensembleReasoningEffort: 'on'
    })
    run.provider = 'codex'
    run.actualModel = 'gpt-5.6-sol'
    message.metadata!.ensembleReasoningEffort = 'xhigh'
    expect(transcriptRunModelPresentation(message, run, true).metadata).toMatchObject({
      ensembleModel: 'gpt-5.6-sol',
      ensembleReasoningEffort: 'xhigh'
    })
  })
})
