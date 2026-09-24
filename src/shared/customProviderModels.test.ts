import { describe, expect, it } from 'vitest'
import {
  CUSTOM_MODEL_ENTRY_ID,
  MAX_CUSTOM_MODELS_PER_PROVIDER,
  addCustomProviderModel,
  customModelIdFromRowId,
  customModelRowId,
  customModelsForProvider,
  isCustomModelEntryId,
  normalizeCustomModelId,
  removeCustomProviderModel,
  sanitizeCustomProviderModels
} from './customProviderModels'

describe('normalizeCustomModelId', () => {
  it('keeps a real tag and trims surrounding space', () => {
    expect(normalizeCustomModelId('  qwen3-coder:30b  ')).toBe('qwen3-coder:30b')
  })

  it('rejects the picker sentinel so the entry row can never be saved as a model', () => {
    expect(normalizeCustomModelId(CUSTOM_MODEL_ENTRY_ID)).toBe('')
  })

  it('rejects values that could never be a wire tag', () => {
    expect(normalizeCustomModelId('')).toBe('')
    expect(normalizeCustomModelId('   ')).toBe('')
    expect(normalizeCustomModelId('two words')).toBe('')
    expect(normalizeCustomModelId('tab\tseparated')).toBe('')
    expect(normalizeCustomModelId(`bell${String.fromCharCode(7)}byte`)).toBe('')
    expect(normalizeCustomModelId('x'.repeat(201))).toBe('')
    expect(normalizeCustomModelId(42)).toBe('')
    expect(normalizeCustomModelId(null)).toBe('')
  })

  it('accepts a 200-character id at the boundary', () => {
    expect(normalizeCustomModelId('x'.repeat(200))).toHaveLength(200)
  })
})

describe('picker row encoding', () => {
  it('round-trips an id that itself contains a colon', () => {
    const rowId = customModelRowId('qwen3:4b-instruct')
    expect(rowId).toBe('custom:qwen3:4b-instruct')
    expect(customModelIdFromRowId(rowId)).toBe('qwen3:4b-instruct')
  })

  it('does not mistake the entry row or a catalogue id for a saved model', () => {
    expect(customModelIdFromRowId(CUSTOM_MODEL_ENTRY_ID)).toBe('')
    expect(customModelIdFromRowId('llama3.2:3b')).toBe('')
    expect(customModelIdFromRowId(undefined)).toBe('')
    // Prefix present but nothing usable behind it.
    expect(customModelIdFromRowId('custom:')).toBe('')
  })

  it('separates the entry row from saved rows', () => {
    expect(isCustomModelEntryId(CUSTOM_MODEL_ENTRY_ID)).toBe(true)
    expect(isCustomModelEntryId(customModelRowId('gpt-oss:20b'))).toBe(false)
  })
})

describe('addCustomProviderModel', () => {
  it('remembers a new id per provider without touching its neighbours', () => {
    const first = addCustomProviderModel({}, 'ollama', 'qwen3-coder:30b')
    const second = addCustomProviderModel(first, 'codex', 'my-internal-build')
    expect(customModelsForProvider(second, 'ollama')).toEqual(['qwen3-coder:30b'])
    expect(customModelsForProvider(second, 'codex')).toEqual(['my-internal-build'])
  })

  it('appends in save order', () => {
    let store = addCustomProviderModel({}, 'ollama', 'a:1')
    store = addCustomProviderModel(store, 'ollama', 'b:2')
    expect(customModelsForProvider(store, 'ollama')).toEqual(['a:1', 'b:2'])
  })

  it('keeps an existing id in place instead of reordering the list', () => {
    let store = addCustomProviderModel({}, 'ollama', 'a:1')
    store = addCustomProviderModel(store, 'ollama', 'b:2')
    const reSaved = addCustomProviderModel(store, 'ollama', 'a:1')
    expect(customModelsForProvider(reSaved, 'ollama')).toEqual(['a:1', 'b:2'])
  })

  it('drops nothing and adds nothing for an unusable id', () => {
    const store = addCustomProviderModel({ ollama: ['a:1'] }, 'ollama', '  ')
    expect(customModelsForProvider(store, 'ollama')).toEqual(['a:1'])
  })

  it('evicts the oldest id once the cap is reached', () => {
    let store = {}
    for (let index = 0; index < MAX_CUSTOM_MODELS_PER_PROVIDER; index += 1) {
      store = addCustomProviderModel(store, 'ollama', `model:${index}`)
    }
    const full = customModelsForProvider(store, 'ollama')
    expect(full).toHaveLength(MAX_CUSTOM_MODELS_PER_PROVIDER)
    expect(full[0]).toBe('model:0')

    const overflowedStore = addCustomProviderModel(store, 'ollama', 'one:more')
    // Read the STORED array, not the accessor: `customModelsForProvider` caps
    // on read too, so going through it would pass even if the write path kept
    // growing the persisted list forever.
    expect(overflowedStore.ollama).toHaveLength(MAX_CUSTOM_MODELS_PER_PROVIDER)

    const overflowed = customModelsForProvider(overflowedStore, 'ollama')
    expect(overflowed).toHaveLength(MAX_CUSTOM_MODELS_PER_PROVIDER)
    expect(overflowed).not.toContain('model:0')
    expect(overflowed.at(-1)).toBe('one:more')
  })
})

describe('removeCustomProviderModel', () => {
  it('forgets one id and leaves the rest', () => {
    const store = removeCustomProviderModel({ ollama: ['a:1', 'b:2', 'c:3'] }, 'ollama', 'b:2')
    expect(customModelsForProvider(store, 'ollama')).toEqual(['a:1', 'c:3'])
  })

  it('drops the provider key entirely once its last id goes', () => {
    const store = removeCustomProviderModel({ ollama: ['a:1'], codex: ['z:9'] }, 'ollama', 'a:1')
    expect(store).toEqual({ codex: ['z:9'] })
    expect(Object.keys(store)).not.toContain('ollama')
  })

  it('is a no-op for an id that was never saved', () => {
    const store = removeCustomProviderModel({ ollama: ['a:1'] }, 'ollama', 'never:saved')
    expect(customModelsForProvider(store, 'ollama')).toEqual(['a:1'])
  })
})

describe('sanitizeCustomProviderModels', () => {
  it('drops malformed input rather than throwing', () => {
    expect(sanitizeCustomProviderModels(null)).toEqual({})
    expect(sanitizeCustomProviderModels('nope')).toEqual({})
    expect(sanitizeCustomProviderModels(['a'])).toEqual({})
    expect(sanitizeCustomProviderModels({ ollama: 'not-an-array' })).toEqual({})
  })

  it('filters unusable entries and de-duplicates what survives', () => {
    const sanitized = sanitizeCustomProviderModels({
      ollama: ['a:1', 'a:1', '   ', 'two words', 42, CUSTOM_MODEL_ENTRY_ID, 'b:2'],
      empty: []
    })
    expect(sanitized).toEqual({ ollama: ['a:1', 'b:2'] })
  })

  it('truncates an over-long persisted list to the cap', () => {
    const oversized = Array.from({ length: MAX_CUSTOM_MODELS_PER_PROVIDER + 5 }, (_, i) => `m:${i}`)
    const sanitized = sanitizeCustomProviderModels({ ollama: oversized })
    expect(sanitized.ollama).toHaveLength(MAX_CUSTOM_MODELS_PER_PROVIDER)
    // Truncation keeps the newest ids, so a save is never silently reverted.
    expect(sanitized.ollama.at(-1)).toBe(`m:${MAX_CUSTOM_MODELS_PER_PROVIDER + 4}`)
  })
})
