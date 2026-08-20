import { describe, expect, it } from 'vitest'
import {
  ReasoningLedgerCoalescer,
  coalescedReasoningInput,
  reasoningChunkFromInput
} from './ReasoningLedgerCoalescer'
import type { RunEventInput } from './store/types'

function chunk(runId: string, toolId: string, text: string, toolName = 'pi_thinking'): RunEventInput {
  return {
    runId,
    chatId: 'chat-1',
    provider: 'pi',
    kind: 'tool',
    phase: 'raw',
    source: 'provider',
    summary: 'Provider output: tool_result',
    payload: {
      type: 'tool_result',
      tool_id: toolId,
      tool_name: toolName,
      status: 'success',
      output: text,
      provider: 'pi'
    }
  } as RunEventInput
}

function other(runId: string, kind: RunEventInput['kind'] = 'lifecycle'): RunEventInput {
  return {
    runId,
    chatId: 'chat-1',
    provider: 'pi',
    kind,
    phase: 'control',
    source: 'main',
    summary: 'Run completed',
    payload: { status: 'completed' }
  } as RunEventInput
}

const NOW = '2026-08-20T04:00:00.000Z'

describe('reasoningChunkFromInput', () => {
  it('recognises provider thinking and reasoning tool results', () => {
    expect(reasoningChunkFromInput(chunk('r', 't', 'abc'))?.toolName).toBe('pi_thinking')
    expect(
      reasoningChunkFromInput(chunk('r', 't', 'abc', 'codex_reasoning'))?.toolName
    ).toBe('codex_reasoning')
    expect(reasoningChunkFromInput(chunk('r', 't', 'abc', 'mistral_thinking'))).not.toBeNull()
  })

  it('ignores ordinary tool results and non-tool payloads', () => {
    expect(reasoningChunkFromInput(chunk('r', 't', 'abc', 'run_shell_command'))).toBeNull()
    expect(reasoningChunkFromInput(other('r'))).toBeNull()
  })
})

describe('ReasoningLedgerCoalescer', () => {
  it('defers every chunk of an open segment', () => {
    const coalescer = new ReasoningLedgerCoalescer()

    for (const text of ['Let', 'Let me', 'Let me understand']) {
      const result = coalescer.absorb(chunk('run-1', 'seg-1', text), NOW)
      expect(result.deferred).toBe(true)
      expect(result.flushed).toEqual([])
    }
    expect(coalescer.openSegmentCount).toBe(1)
  })

  it('writes ONE consolidated record when another durable event closes the run', () => {
    const coalescer = new ReasoningLedgerCoalescer()
    for (const text of ['Let', 'Let me', 'Let me understand']) {
      coalescer.absorb(chunk('run-1', 'seg-1', text), NOW)
    }

    const closing = coalescer.absorb(other('run-1'), NOW)

    expect(closing.deferred).toBe(false)
    expect(closing.flushed).toHaveLength(1)
    const consolidated = coalescedReasoningInput(closing.flushed[0])
    const payload = consolidated.payload as Record<string, unknown>
    expect(payload.output).toBe('Let me understand')
    expect(payload.reasoning).toMatchObject({ coalesced: true, chunkCount: 3 })
    expect(consolidated.summary).toBe('pi_thinking segment (3 chunks)')
    expect(coalescer.openSegmentCount).toBe(0)
  })

  it('closes the previous segment when a new tool id starts', () => {
    const coalescer = new ReasoningLedgerCoalescer()
    coalescer.absorb(chunk('run-1', 'seg-1', 'first thought'), NOW)

    const started = coalescer.absorb(chunk('run-1', 'seg-2', 'second'), NOW)

    expect(started.deferred).toBe(true)
    expect(started.flushed).toHaveLength(1)
    expect(started.flushed[0].toolId).toBe('seg-1')
    expect(
      (coalescedReasoningInput(started.flushed[0]).payload as Record<string, unknown>).output
    ).toBe('first thought')
  })

  it('keeps runs independent', () => {
    const coalescer = new ReasoningLedgerCoalescer()
    coalescer.absorb(chunk('run-1', 'seg-1', 'a'), NOW)
    coalescer.absorb(chunk('run-2', 'seg-1', 'b'), NOW)

    const closed = coalescer.absorb(other('run-1'), NOW)

    expect(closed.flushed).toHaveLength(1)
    expect(closed.flushed[0].template.runId).toBe('run-1')
    expect(coalescer.openSegmentCount).toBe(1)
  })

  it('appends rather than replaces when a provider streams deltas instead', () => {
    const coalescer = new ReasoningLedgerCoalescer()
    coalescer.absorb(chunk('run-1', 'seg-1', 'alpha '), NOW)
    coalescer.absorb(chunk('run-1', 'seg-1', 'beta'), NOW)

    const closed = coalescer.absorb(other('run-1'), NOW)

    expect(
      (coalescedReasoningInput(closed.flushed[0]).payload as Record<string, unknown>).output
    ).toBe('alpha beta')
  })

  it('preserves the template routing fields on the consolidated record', () => {
    const coalescer = new ReasoningLedgerCoalescer()
    coalescer.absorb(chunk('run-1', 'seg-1', 'thinking'), NOW)

    const consolidated = coalescedReasoningInput(coalescer.drain('run-1')[0])

    expect(consolidated).toMatchObject({
      runId: 'run-1',
      chatId: 'chat-1',
      provider: 'pi',
      kind: 'tool',
      phase: 'raw',
      source: 'provider'
    })
    const payload = consolidated.payload as Record<string, unknown>
    expect(payload.tool_id).toBe('seg-1')
    expect(payload.tool_name).toBe('pi_thinking')
    expect(payload.type).toBe('tool_result')
  })

  it('collapses a cumulative stream the way the corpus measured it', () => {
    // Shaped like pi-1786909124356: 59 segments restated on every chunk.
    const coalescer = new ReasoningLedgerCoalescer()
    const written: RunEventInput[] = []
    let cumulativeBytes = 0

    for (let segment = 0; segment < 59; segment += 1) {
      let text = ''
      for (let step = 0; step < 200; step += 1) {
        text += `token${step} `
        const input = chunk('run-1', `seg-${segment}`, text)
        cumulativeBytes += JSON.stringify(input.payload).length
        for (const closed of coalescer.absorb(input, NOW).flushed) {
          written.push(coalescedReasoningInput(closed))
        }
      }
    }
    for (const closed of coalescer.drain('run-1')) written.push(coalescedReasoningInput(closed))

    expect(written).toHaveLength(59)
    const coalescedBytes = written.reduce((sum, i) => sum + JSON.stringify(i.payload).length, 0)
    expect(coalescedBytes).toBeLessThan(cumulativeBytes / 50)
  })

  it('flushes the oldest segment rather than dropping it past the open cap', () => {
    const coalescer = new ReasoningLedgerCoalescer()
    const flushed: string[] = []

    for (let index = 0; index < 70; index += 1) {
      const result = coalescer.absorb(chunk(`run-${index}`, 'seg-1', `text ${index}`), NOW)
      for (const segment of result.flushed) flushed.push(segment.template.runId)
    }

    expect(flushed).toEqual(['run-0', 'run-1', 'run-2', 'run-3', 'run-4', 'run-5'])
    expect(coalescer.openSegmentCount).toBe(64)
  })
})
