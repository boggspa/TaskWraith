/**
 * UltraTaskReasoningResolver.test.ts
 *
 * Unit tests for the UltraTask reasoning resolver.
 */

import { describe, expect, it } from 'vitest'
import {
  resolveUltraTaskReasoningEffort,
  isUltraTaskSupported,
  getAvailableReasoningEfforts,
  compareReasoningEfforts
} from './UltraTaskReasoningResolver'

describe('resolveUltraTaskReasoningEffort', () => {
  describe('Codex provider', () => {
    it('returns ultracode for gpt-5.6-sol', () => {
      const result = resolveUltraTaskReasoningEffort('codex', 'gpt-5.6-sol')
      expect(result).toBe('ultracode')
    })

    it('returns ultracode for gpt-5.6-terra', () => {
      const result = resolveUltraTaskReasoningEffort('codex', 'gpt-5.6-terra')
      expect(result).toBe('ultracode')
    })

    it('returns max for gpt-5.6-luna', () => {
      const result = resolveUltraTaskReasoningEffort('codex', 'gpt-5.6-luna')
      expect(result).toBe('max')
    })

    it('returns xhigh for gpt-5.5', () => {
      const result = resolveUltraTaskReasoningEffort('codex', 'gpt-5.5')
      expect(result).toBe('xhigh')
    })

    it('returns xhigh for gpt-5.4', () => {
      const result = resolveUltraTaskReasoningEffort('codex', 'gpt-5.4')
      expect(result).toBe('xhigh')
    })
  })

  describe('Claude provider', () => {
    it('returns ultracode for claude-opus-5', () => {
      const result = resolveUltraTaskReasoningEffort('claude', 'claude-opus-5')
      expect(result).toBe('ultracode')
    })

    it('returns ultracode for claude-sonnet-5', () => {
      const result = resolveUltraTaskReasoningEffort('claude', 'claude-sonnet-5')
      expect(result).toBe('ultracode')
    })

    it('returns ultracode for claude-fable-5', () => {
      const result = resolveUltraTaskReasoningEffort('claude', 'claude-fable-5')
      expect(result).toBe('ultracode')
    })

    it('returns none for claude-haiku-4-5', () => {
      const result = resolveUltraTaskReasoningEffort('claude', 'claude-haiku-4-5')
      expect(result).toBe('none')
    })
  })

  describe('Kimi provider', () => {
    it('returns max for kimi-k3', () => {
      const result = resolveUltraTaskReasoningEffort('kimi', 'kimi-k3')
      expect(result).toBe('max')
    })

    it('returns high for kimi-k2.7-code', () => {
      const result = resolveUltraTaskReasoningEffort('kimi', 'kimi-k2.7-code')
      expect(result).toBe('high')
    })
  })

  describe('Grok provider', () => {
    it('returns xhigh for grok models', () => {
      const result = resolveUltraTaskReasoningEffort('grok', 'grok-4.6')
      expect(result).toBe('xhigh')
    })
  })

  describe('Other providers', () => {
    it('returns high for cursor', () => {
      const result = resolveUltraTaskReasoningEffort('cursor', 'cursor-grok-4.6')
      expect(result).toBe('high')
    })

    it('returns high for ollama', () => {
      const result = resolveUltraTaskReasoningEffort('ollama', 'llama-3.2')
      expect(result).toBe('high')
    })

    it('returns high for pi', () => {
      const result = resolveUltraTaskReasoningEffort('pi', 'pi-ox')
      expect(result).toBe('high')
    })

    it('returns max for mistral-medium-3.5', () => {
      const result = resolveUltraTaskReasoningEffort('mistral', 'mistral-medium-3.5')
      expect(result).toBe('max')
    })

    it('returns high for muse', () => {
      const result = resolveUltraTaskReasoningEffort('muse', 'muse-v1')
      expect(result).toBe('high')
    })
  })

  describe('Edge cases', () => {
    it('handles empty model id', () => {
      const result = resolveUltraTaskReasoningEffort('codex', '')
      expect(result).toBe('xhigh') // Falls back to provider default
    })

    it('handles null model id', () => {
      const result = resolveUltraTaskReasoningEffort('codex', null as unknown as string)
      expect(result).toBe('xhigh')
    })

    it('handles unknown provider', () => {
      const result = resolveUltraTaskReasoningEffort('unknown' as any, 'model-1')
      expect(result).toBe('high')
    })
  })
})

describe('isUltraTaskSupported', () => {
  it('returns true for gpt-5.6-sol', () => {
    expect(isUltraTaskSupported('codex', 'gpt-5.6-sol')).toBe(true)
  })

  it('returns true for claude-opus-5', () => {
    expect(isUltraTaskSupported('claude', 'claude-opus-5')).toBe(true)
  })

  it('returns true for kimi-k3', () => {
    expect(isUltraTaskSupported('kimi', 'kimi-k3')).toBe(true)
  })

  it('returns true for grok-4.6', () => {
    expect(isUltraTaskSupported('grok', 'grok-4.6')).toBe(true)
  })

  it('returns false for claude-haiku-4-5', () => {
    expect(isUltraTaskSupported('claude', 'claude-haiku-4-5')).toBe(false)
  })

  it('returns false for none effort model', () => {
    expect(isUltraTaskSupported('unknown', 'unknown-model')).toBe(true) // Falls back to high
  })
})

describe('getAvailableReasoningEfforts', () => {
  it('returns all efforts up to ultracode for gpt-5.6-sol', () => {
    const efforts = getAvailableReasoningEfforts('codex', 'gpt-5.6-sol')
    expect(efforts).toContain('ultracode')
    expect(efforts).toContain('max')
    expect(efforts).toContain('xhigh')
    expect(efforts).toContain('high')
    expect(efforts).toContain('medium')
    expect(efforts).toContain('low')
    // Should not include 'none'
    expect(efforts).not.toContain('none')
  })

  it('returns efforts up to max for kimi-k3', () => {
    const efforts = getAvailableReasoningEfforts('kimi', 'kimi-k3')
    expect(efforts).toContain('max')
    expect(efforts).toContain('high')
    expect(efforts).toContain('medium')
    expect(efforts).toContain('low')
    // Should not contain ultracode since Kimi's highest is max
    expect(efforts).not.toContain('ultracode')
  })

  it('returns at least high for any provider', () => {
    const efforts = getAvailableReasoningEfforts('unknown', 'unknown-model')
    expect(efforts).toContain('high')
  })

  it('returns only high for claude-haiku-4-5', () => {
    const efforts = getAvailableReasoningEfforts('claude', 'claude-haiku-4-5')
    expect(efforts).toEqual(['high'])
  })
})

describe('compareReasoningEfforts', () => {
  it('returns 0 for equal efforts', () => {
    expect(compareReasoningEfforts('high', 'high')).toBe(0)
  })

  it('returns positive when a > b', () => {
    expect(compareReasoningEfforts('ultracode', 'high')).toBeGreaterThan(0)
    expect(compareReasoningEfforts('max', 'medium')).toBeGreaterThan(0)
  })

  it('returns negative when a < b', () => {
    expect(compareReasoningEfforts('medium', 'high')).toBeLessThan(0)
    expect(compareReasoningEfforts('low', 'ultracode')).toBeLessThan(0)
  })

  it('handles unknown efforts', () => {
    expect(compareReasoningEfforts('unknown', 'high')).toBe(0)
    expect(compareReasoningEfforts('high', 'unknown')).toBe(0)
  })

  it('correctly orders the hierarchy', () => {
    expect(compareReasoningEfforts('minimal', 'low')).toBeLessThan(0)
    expect(compareReasoningEfforts('low', 'medium')).toBeLessThan(0)
    expect(compareReasoningEfforts('medium', 'high')).toBeLessThan(0)
    expect(compareReasoningEfforts('high', 'xhigh')).toBeLessThan(0)
    expect(compareReasoningEfforts('xhigh', 'max')).toBeLessThan(0)
    expect(compareReasoningEfforts('max', 'ultracode')).toBeLessThan(0)
  })
})
