import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { providerModelCatalogueAccepts } from './providerModelCatalogueValidity'

const PI_CATALOGUE = [
  { id: 'deepseek/deepseek-v4-flash' },
  { id: 'cerebras/qwen-3.8-27b' },
  { id: 'cerebras/gemma-4-12b' }
]

describe('providerModelCatalogueAccepts', () => {
  it('accepts a model the catalogue lists', () => {
    expect(providerModelCatalogueAccepts(PI_CATALOGUE, 'cerebras/qwen-3.8-27b')).toBe(true)
  })

  it('still rejects a model a populated catalogue does not list', () => {
    // The case the membership test was written for: a retired id, or one
    // carried over from another provider. A populated catalogue is evidence.
    expect(providerModelCatalogueAccepts(PI_CATALOGUE, 'openai/gpt-5.5')).toBe(false)
  })

  it('accepts a stored model while the catalogue is still unknown', () => {
    // `agentModelsByProvider.pi` is undefined until the startup IPC resolves and
    // stays empty if it threw. Rejecting here is what swaps a Cerebras thread
    // onto DeepSeek -- in the chip AND in the dispatched run.
    expect(providerModelCatalogueAccepts([], 'cerebras/qwen-3.8-27b')).toBe(true)
  })

  it('accepts every id while unknown, not just plausible ones', () => {
    // Deliberate: an empty catalogue is not evidence about ANY id, so this
    // helper must not start guessing which ones look real. Main holds the
    // authoritative catalogue and validates the dispatch.
    expect(providerModelCatalogueAccepts([], 'anything/at-all')).toBe(true)
  })
})

/**
 * The renderer has no DOM test environment, so the call sites are fenced by
 * source shape. A bare membership test reaching back into `isValidModelForProvider`
 * is the substitution returning, and nothing else would catch it: it compiles,
 * types, and looks right.
 */
describe('the composer’s model-validity checks', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('asks the catalogue helper rather than testing membership inline', () => {
    expect(app).not.toMatch(/\.some\(\(model\) => model\.id === modelId\)/)
  })

  it('routes every catalogue-backed provider through it', () => {
    // pi, mistral, muse, devin, antigravity. Codex/Claude/Kimi/Grok/Cursor/
    // Ollama all have their own id predicates and static fallbacks, so they
    // never reach an empty list.
    expect(app.match(/providerModelCatalogueAccepts\(/g) ?? []).toHaveLength(5)
  })
})
