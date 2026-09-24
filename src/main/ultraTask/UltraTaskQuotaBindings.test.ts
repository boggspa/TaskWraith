import { describe, expect, it } from 'vitest'
import { resolveUltraTaskQuotaBinding } from './UltraTaskQuotaBindings'

describe('resolveUltraTaskQuotaBinding', () => {
  it('keeps bespoke Codex and Claude pools separate from their standard pools', () => {
    expect(resolveUltraTaskQuotaBinding('codex', 'gpt-5.3-codex-spark').poolIds).toEqual([
      'codex:spark'
    ])
    expect(resolveUltraTaskQuotaBinding('codex', 'gpt-5.5').poolIds).toEqual(['codex:standard'])
    expect(resolveUltraTaskQuotaBinding('claude', 'claude-fable-5').poolIds).toEqual([
      'claude:fable'
    ])
    expect(resolveUltraTaskQuotaBinding('claude', 'claude-sonnet-5').poolIds).toEqual([
      'claude:standard'
    ])
  })

  it('maps AntiGravity models to the lane that actually consumes quota', () => {
    expect(
      resolveUltraTaskQuotaBinding('antigravity', 'gemini-api:gemini-3.6-flash').poolIds
    ).toEqual(['antigravity:gemini-api-budget'])
    expect(resolveUltraTaskQuotaBinding('antigravity', 'claude-sonnet-4-6').poolIds).toEqual([
      'antigravity:claude'
    ])
    expect(resolveUltraTaskQuotaBinding('antigravity', 'gpt-oss-120b-medium').poolIds).toEqual([
      'antigravity:gpt'
    ])
    expect(resolveUltraTaskQuotaBinding('antigravity', 'gemini-3.6-flash-high').poolIds).toEqual([
      'antigravity:gemini'
    ])
  })

  it('treats only Ollama Cloud as hosted quota consumption', () => {
    expect(resolveUltraTaskQuotaBinding('ollama', 'qwen3.5:9b')).toEqual({
      kind: 'not_applicable',
      poolIds: [],
      satisfaction: 'all'
    })
    expect(resolveUltraTaskQuotaBinding('ollama', 'glm-5.2:cloud').poolIds).toEqual([
      'ollama:cloud'
    ])
  })

  it('binds Pi by upstream and never offers sentinel models', () => {
    expect(resolveUltraTaskQuotaBinding('pi', 'mistral/mistral-medium-3.5').poolIds).toEqual([
      'pi:mistral'
    ])
    expect(resolveUltraTaskQuotaBinding('codex', 'cli-default')).toEqual({
      kind: 'unknown',
      poolIds: [],
      satisfaction: 'all'
    })
  })
})
