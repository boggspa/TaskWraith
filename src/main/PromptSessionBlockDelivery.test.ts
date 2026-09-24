import { describe, expect, it } from 'vitest'
import {
  planPromptSessionBlock,
  resolvePromptSessionDeliveryMode
} from './PromptSessionBlockDelivery'

describe('resolvePromptSessionDeliveryMode', () => {
  it('distinguishes native persistence from host-fed and implicit sessions', () => {
    expect(
      resolvePromptSessionDeliveryMode({
        provider: 'codex',
        resumeSessionId: 'thread-1',
        hostFedContextTurn: false
      })
    ).toBe('persistent')
    expect(
      resolvePromptSessionDeliveryMode({
        provider: 'cursor',
        resumeSessionId: 'meaningless-token',
        hostFedContextTurn: true
      })
    ).toBe('repeat')
    expect(resolvePromptSessionDeliveryMode({ provider: 'pi', hostFedContextTurn: false })).toBe(
      'persistent'
    )
    expect(
      resolvePromptSessionDeliveryMode({
        provider: 'gemini',
        resumeSessionId: 'api://history',
        hostFedContextTurn: false
      })
    ).toBe('repeat')
    expect(
      resolvePromptSessionDeliveryMode({
        provider: 'ollama',
        hostFedContextTurn: false,
        conversationalTurn: true
      })
    ).toBe('skip')
  })
})

describe('planPromptSessionBlock', () => {
  it('inherits only a matching persistent-session receipt', () => {
    expect(
      planPromptSessionBlock({
        mode: 'persistent',
        provider: 'claude',
        currentValue: 'v1',
        appliedValue: 'v1',
        appliedProvider: 'claude',
        body: 'stable rules'
      })
    ).toMatchObject({ state: 'inherited' })

    expect(
      planPromptSessionBlock({
        mode: 'persistent',
        provider: 'claude',
        currentValue: 'v1',
        appliedValue: 'v1',
        appliedProvider: 'codex',
        body: 'stable rules'
      })
    ).toMatchObject({ state: 'applied', receiptValue: 'v1' })
  })

  it('repeats host-fed context and restores it on a cold fallback', () => {
    expect(
      planPromptSessionBlock({
        mode: 'repeat',
        provider: 'cursor',
        currentValue: 'sha',
        appliedValue: 'sha',
        appliedProvider: 'cursor',
        body: 'context'
      })
    ).toEqual({
      state: 'applied',
      body: 'context',
      reason: 'provider context is host-fed on this turn'
    })
    expect(
      planPromptSessionBlock({
        mode: 'cold',
        provider: 'codex',
        currentValue: 'v1',
        appliedValue: 'v1',
        appliedProvider: 'codex',
        body: 'stable rules'
      })
    ).toMatchObject({ state: 'applied', receiptValue: 'v1' })
  })

  it('revokes removed context only when a persistent session remembers it', () => {
    expect(
      planPromptSessionBlock({
        mode: 'persistent',
        provider: 'pi',
        currentValue: 'none',
        appliedValue: 'old-sha',
        appliedProvider: 'pi',
        removalBody: 'Disregard the old context.'
      })
    ).toMatchObject({
      state: 'applied',
      receiptValue: 'none',
      body: 'Disregard the old context.'
    })
    expect(
      planPromptSessionBlock({
        mode: 'cold',
        provider: 'pi',
        currentValue: 'none',
        body: '',
        removalBody: 'Disregard the old context.'
      })
    ).toEqual({ state: 'omitted' })
  })
})
