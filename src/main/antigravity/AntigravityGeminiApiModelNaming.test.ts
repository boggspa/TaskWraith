import { describe, expect, it } from 'vitest'
import {
  antigravityGeminiApiModelLabel,
  curateAntigravityGeminiApiModels,
  isCuratedAntigravityGeminiApiModelId
} from './AntigravityGeminiApiModelNaming'

describe('antigravityGeminiApiModelLabel', () => {
  it('reads as a product name, not an API id', () => {
    const expected: Record<string, string> = {
      'gemini-3.6-flash': '3.6 Flash',
      'gemini-3.5-flash': '3.5 Flash',
      'gemini-3.5-live-translate': '3.5 Live Translate',
      'gemini-3.5-flash-lite': '3.5 Flash-Lite',
      'gemini-3.1-pro-preview': '3.1 Pro Preview',
      'gemini-3.1-flash-lite': '3.1 Flash-Lite',
      'gemini-3.1-flash-live': '3.1 Flash Live',
      'gemini-3.1-flash-tts': '3.1 Flash TTS',
      'gemini-omni-flash': 'Omni Flash',
      'gemini-2.5-pro': '2.5 Pro',
      'gemini-2.5-pro-tts': '2.5 Pro TTS',
      'gemini-2.5-flash': '2.5 Flash',
      'gemini-2.5-flash-live': '2.5 Flash Live',
      'gemini-2.5-flash-tts': '2.5 Flash TTS',
      'gemini-2.5-flash-lite': '2.5 Flash-Lite'
    }
    for (const [modelId, label] of Object.entries(expected)) {
      expect(antigravityGeminiApiModelLabel(modelId)).toBe(label)
    }
  })

  it('title-cases an unrecognised token rather than waiting for a mapping', () => {
    expect(antigravityGeminiApiModelLabel('gemini-4.0-nova')).toBe('4.0 Nova')
  })
})

describe('isCuratedAntigravityGeminiApiModelId', () => {
  it('keeps current families including bare previews and unversioned ones', () => {
    for (const modelId of [
      'gemini-3.6-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-flash-lite',
      'gemini-omni-flash'
    ]) {
      expect(isCuratedAntigravityGeminiApiModelId(modelId)).toBe(true)
    }
  })

  it('drops aliases, dated revisions, dated previews and legacy families', () => {
    for (const modelId of [
      'gemini-flash-latest',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite-001',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-embedding-001',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro'
    ]) {
      expect(isCuratedAntigravityGeminiApiModelId(modelId)).toBe(false)
    }
  })
})

describe('curateAntigravityGeminiApiModels', () => {
  it('curates prefixed rows', () => {
    expect(
      curateAntigravityGeminiApiModels([
        { id: 'gemini-api:gemini-2.5-flash' },
        { id: 'gemini-api:gemini-2.0-flash-001' },
        { id: 'gemini-api:gemini-flash-latest' }
      ])
    ).toEqual([{ id: 'gemini-api:gemini-2.5-flash' }])
  })

  it('keeps everything rather than curating the provider into invisibility', () => {
    // An empty catalogue withdraws AntiGravity from every surface, so a
    // catalogue of only legacy rows is still better than no provider at all.
    const legacyOnly = [{ id: 'gemini-api:gemini-2.0-flash' }, { id: 'gemini-api:gemini-1.5-pro' }]
    expect(curateAntigravityGeminiApiModels(legacyOnly)).toEqual(legacyOnly)
  })
})
