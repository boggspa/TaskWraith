import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { appendWirePromptCapture, buildPromptEnvelopeSnapshot } from './PromptEnvelope'
import type { PromptEnvelopeLayerSnapshot } from '../../shared/instructions/InstructionTypes'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const layers: PromptEnvelopeLayerSnapshot[] = [
  {
    id: 'runtime_preamble',
    label: 'TaskWraith runtime preamble',
    state: 'applied',
    content: 'preamble text'
  },
  {
    id: 'instructions_global',
    label: 'User instructions — global',
    state: 'applied',
    sha256: 'precomputed-by-resolver',
    bytes: 9,
    content: 'Be terse.'
  },
  {
    id: 'conversation_context',
    label: 'Conversation context',
    state: 'applied',
    reason: '3 turn(s) of host-fed transcript'
  },
  { id: 'current_request', label: 'Current request', state: 'applied', bytes: 12 }
]

describe('buildPromptEnvelopeSnapshot', () => {
  it('digests content layers, keeps resolver-precomputed hashes, and strips content by default', () => {
    const envelope = buildPromptEnvelopeSnapshot({
      provider: 'cursor',
      model: 'cursor-default',
      composedPrompt: 'THE COMPOSED PROMPT',
      layers,
      instructionsDigest: 'digest-abc',
      storeContent: false
    })
    expect(envelope.version).toBe(1)
    expect(envelope.accuracy).toBe('composed')
    expect(envelope.contentStored).toBe(false)
    expect(envelope.instructionsDigest).toBe('digest-abc')
    expect(envelope.composedSha256).toBe(sha('THE COMPOSED PROMPT'))
    expect(envelope.composedBytes).toBe(Buffer.byteLength('THE COMPOSED PROMPT'))
    const preamble = envelope.layers.find((layer) => layer.id === 'runtime_preamble')
    expect(preamble?.sha256).toBe(sha('preamble text'))
    expect(preamble?.bytes).toBe(Buffer.byteLength('preamble text'))
    expect(preamble?.content).toBeUndefined()
    const instructions = envelope.layers.find((layer) => layer.id === 'instructions_global')
    expect(instructions?.sha256).toBe('precomputed-by-resolver')
    expect(instructions?.content).toBeUndefined()
    const conversation = envelope.layers.find((layer) => layer.id === 'conversation_context')
    expect(conversation?.reason).toBe('3 turn(s) of host-fed transcript')
    expect(conversation?.sha256).toBeUndefined()
  })

  it('keeps content when raw-event storage is on', () => {
    const envelope = buildPromptEnvelopeSnapshot({
      provider: 'cursor',
      composedPrompt: 'p',
      layers,
      instructionsDigest: 'none',
      storeContent: true
    })
    expect(envelope.contentStored).toBe(true)
    expect(envelope.layers.find((layer) => layer.id === 'runtime_preamble')?.content).toBe(
      'preamble text'
    )
  })
})

describe('appendWirePromptCapture', () => {
  it('appends attempts without overwriting and flips accuracy to wire', () => {
    const base = buildPromptEnvelopeSnapshot({
      provider: 'grok',
      composedPrompt: 'composed',
      layers: [],
      instructionsDigest: 'none',
      storeContent: false
    })
    const first = appendWirePromptCapture(base, {
      transport: 'grok-acp',
      capturedAt: '2026-08-11T12:00:00Z',
      part: 'user',
      transforms: ['mode-preamble'],
      text: 'wire text one'
    })
    const second = appendWirePromptCapture(first, {
      transport: 'grok-acp',
      capturedAt: '2026-08-11T12:00:05Z',
      part: 'user',
      text: 'wire text two'
    })
    expect(second.accuracy).toBe('wire')
    expect(second.wire).toHaveLength(2)
    expect(second.wire?.[0].attempt).toBe(1)
    expect(second.wire?.[1].attempt).toBe(2)
    expect(second.wire?.[0].sha256).toBe(sha('wire text one'))
    expect(second.wire?.[0].content).toBeUndefined()
    expect(second.wire?.[0].transforms).toEqual(['mode-preamble'])
  })

  it('stores wire content only when the envelope stored content', () => {
    const base = buildPromptEnvelopeSnapshot({
      provider: 'grok',
      composedPrompt: 'composed',
      layers: [],
      instructionsDigest: 'none',
      storeContent: true
    })
    const captured = appendWirePromptCapture(base, {
      transport: 'grok-acp',
      capturedAt: '2026-08-11T12:00:00Z',
      part: 'user',
      text: 'wire text'
    })
    expect(captured.wire?.[0].content).toBe('wire text')
  })
})
