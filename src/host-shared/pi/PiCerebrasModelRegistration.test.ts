import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writePiCerebrasModelRegistration } from './PiCerebrasModelRegistration'
import { resolvePiReasoningSupport } from '../../shared/piReasoning'

const homes: string[] = []
function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'pi-cerebras-registration-'))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('writePiCerebrasModelRegistration', () => {
  it.each([
    ['gemma-4-31b', 'Gemma 4 31B (Cerebras)', 40_000],
    ['qwen-3.8-27b', 'Qwen 3.8 27B (Cerebras)', 40_960]
  ] as const)(
    'registers %s without requiring a user completion cap',
    (modelId, label, maxTokens) => {
      const home = isolatedHome()
      expect(writePiCerebrasModelRegistration({ isolatedHomeDir: home, modelId })).toBe(true)
      const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
      expect(Object.keys(config.providers)).toEqual(['cerebras'])
      expect(config.providers.cerebras.models).toHaveLength(1)
      const model = config.providers.cerebras.models[0]
      expect(model).toMatchObject({
        id: modelId,
        name: label,
        api: 'openai-completions',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 131_072,
        maxTokens,
        thinkingLevelMap: { off: 'none', high: 'high', xhigh: null, max: null }
      })
      const mappedStops = Object.entries(model.thinkingLevelMap)
        .filter(([, value]) => value !== null)
        .map(([key]) => key)
      expect(mappedStops).toEqual(resolvePiReasoningSupport(`cerebras/${modelId}`).efforts)
      if (process.platform !== 'win32') {
        expect(statSync(join(home, 'models.json')).mode & 0o777).toBe(0o600)
      }
    }
  )

  it.each(['gemma-4-31b', 'qwen-3.8-27b'])(
    'combines the user cap with %s registration in one file',
    (modelId) => {
      const home = isolatedHome()
      writePiCerebrasModelRegistration({
        isolatedHomeDir: home,
        modelId,
        maxCompletionTokens: 16_384
      })
      const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
      expect(config.providers.cerebras.models[0].maxTokens).toBe(16_384)
      expect(config.providers.cerebras.modelOverrides).toBeUndefined()
    }
  )

  it('respects Gemma’s model ceiling when the shared user cap is larger', () => {
    const home = isolatedHome()
    writePiCerebrasModelRegistration({
      isolatedHomeDir: home,
      modelId: 'gemma-4-31b',
      maxCompletionTokens: 40_960
    })
    const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    expect(config.providers.cerebras.models[0].maxTokens).toBe(40_000)
  })

  it('keeps bundled GPT-OSS defaults when there is no explicit cap', () => {
    const home = isolatedHome()
    expect(
      writePiCerebrasModelRegistration({ isolatedHomeDir: home, modelId: 'gpt-oss-120b' })
    ).toBe(false)
    expect(existsSync(join(home, 'models.json'))).toBe(false)
  })

  it('refuses to overwrite an existing models file', () => {
    const home = isolatedHome()
    const path = join(home, 'models.json')
    writeFileSync(path, 'existing configuration')
    expect(() =>
      writePiCerebrasModelRegistration({ isolatedHomeDir: home, modelId: 'qwen-3.8-27b' })
    ).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('existing configuration')
  })
})
