import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PI_XIAOMI_REGISTERED_MODEL_IDS,
  isPiXiaomiTokenPlanUpstream,
  writePiXiaomiModelRegistration
} from './PiXiaomiModelRegistration'
import { XIAOMI_TOKEN_PLAN_UPSTREAMS } from './PiModelPolicy'
import { PI_STATIC_MODELS } from './PiModels'
import { resolvePiReasoningSupport } from '../../shared/piReasoning'

const homes: string[] = []
function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'pi-xiaomi-registration-'))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const REGISTERED_ROUTES = XIAOMI_TOKEN_PLAN_UPSTREAMS.flatMap((upstream) =>
  PI_XIAOMI_REGISTERED_MODEL_IDS.map((modelId) => [upstream, modelId] as const)
)

describe('writePiXiaomiModelRegistration', () => {
  it('covers exactly the V2.6 pair, each catalogued on all three regions', () => {
    expect(PI_XIAOMI_REGISTERED_MODEL_IDS).toEqual(['mimo-v2.6-pro', 'mimo-v2.6-flash'])
    expect(REGISTERED_ROUTES).toHaveLength(6)
    for (const [upstream, modelId] of REGISTERED_ROUTES) {
      expect(
        PI_STATIC_MODELS.find((model) => model.wireId === `${upstream}/${modelId}`),
        `${upstream}/${modelId}`
      ).toMatchObject({ upstream, modelId, thinking: true, images: true })
    }
  })

  it.each(REGISTERED_ROUTES)(
    'registers %s/%s with the shape pi bundles for the V2.5 rows on that upstream',
    (upstream, modelId) => {
      const home = isolatedHome()
      expect(writePiXiaomiModelRegistration({ isolatedHomeDir: home, upstream, modelId })).toBe(
        true
      )
      const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
      expect(config).toEqual({
        providers: {
          [upstream]: {
            models: [
              {
                id: modelId,
                name: `MiMo V2.6 ${modelId === 'mimo-v2.6-pro' ? 'Pro' : 'Flash'} (${upstream
                  .slice('xiaomi-token-plan-'.length)
                  .toUpperCase()})`,
                api: 'openai-completions',
                reasoning: true,
                input: ['text', 'image'],
                contextWindow: 1_048_576,
                maxTokens: 131_072,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat: {
                  requiresReasoningContentOnAssistantMessages: true,
                  thinkingFormat: 'deepseek'
                }
              }
            ]
          }
        }
      })
      // No effort map on purpose: the ladder is the on/off toggle and nothing
      // else, so a map here would advertise stops the upstream discards.
      expect(config.providers[upstream].models[0].thinkingLevelMap).toBeUndefined()
      expect(resolvePiReasoningSupport(`${upstream}/${modelId}`).efforts).toEqual(['off', 'high'])
      if (process.platform !== 'win32') {
        expect(statSync(join(home, 'models.json')).mode & 0o777).toBe(0o600)
      }
    }
  )

  it.each(['mimo-v2.5', 'mimo-v2.5-pro', 'mimo-v2-pro'])(
    'writes nothing for %s, which pi already bundles',
    (modelId) => {
      const home = isolatedHome()
      expect(
        writePiXiaomiModelRegistration({
          isolatedHomeDir: home,
          upstream: 'xiaomi-token-plan-sgp',
          modelId
        })
      ).toBe(false)
      expect(existsSync(join(home, 'models.json'))).toBe(false)
    }
  )

  it('writes nothing for a non-Xiaomi upstream even with a V2.6 id', () => {
    const home = isolatedHome()
    expect(isPiXiaomiTokenPlanUpstream('cerebras')).toBe(false)
    expect(
      writePiXiaomiModelRegistration({
        isolatedHomeDir: home,
        upstream: 'cerebras',
        modelId: 'mimo-v2.6-pro'
      })
    ).toBe(false)
    expect(existsSync(join(home, 'models.json'))).toBe(false)
  })

  it('refuses malformed ids and an existing models file', () => {
    const home = isolatedHome()
    expect(() =>
      writePiXiaomiModelRegistration({
        isolatedHomeDir: home,
        upstream: 'xiaomi-token-plan-cn',
        modelId: '   '
      })
    ).toThrow(TypeError)
    const path = join(home, 'models.json')
    writeFileSync(path, 'existing configuration')
    expect(() =>
      writePiXiaomiModelRegistration({
        isolatedHomeDir: home,
        upstream: 'xiaomi-token-plan-cn',
        modelId: 'mimo-v2.6-pro'
      })
    ).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('existing configuration')
  })
})
