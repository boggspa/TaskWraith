import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enrichPiCerebrasRateLimitError,
  writePiCerebrasCompletionCapOverride
} from './PiCerebrasCompletionCap'

const temporaryHomes: string[] = []

function isolatedHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-pi-cerebras-cap-'))
  temporaryHomes.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('writePiCerebrasCompletionCapOverride', () => {
  it('writes only the selected Cerebras model override into Pi’s isolated home', () => {
    const home = isolatedHome()
    writePiCerebrasCompletionCapOverride({
      isolatedHomeDir: home,
      modelId: 'gpt-oss-120b',
      maxCompletionTokens: 16_384
    })

    expect(JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))).toEqual({
      providers: {
        cerebras: {
          modelOverrides: {
            'gpt-oss-120b': { maxTokens: 16_384 }
          }
        }
      }
    })
  })

  it('refuses an invalid cap instead of producing a Pi config Pi would ignore', () => {
    expect(() =>
      writePiCerebrasCompletionCapOverride({
        isolatedHomeDir: isolatedHome(),
        modelId: 'gpt-oss-120b',
        maxCompletionTokens: 40_961
      })
    ).toThrow('completion cap')
  })
})

describe('enrichPiCerebrasRateLimitError', () => {
  it('explains a bodyless Cerebras 429 without changing other provider errors', () => {
    const enriched = enrichPiCerebrasRateLimitError(
      'cerebras/gpt-oss-120b',
      '429 status code (no body)'
    )
    expect(enriched).toContain('16,384')
    expect(enriched).toContain('30,000 TPM')
    expect(enriched).toContain('project allocation')
    expect(enrichPiCerebrasRateLimitError('groq/openai/gpt-oss-120b', '429 status code')).toBe(
      '429 status code'
    )
  })
})
