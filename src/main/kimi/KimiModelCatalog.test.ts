import { describe, expect, it, vi } from 'vitest'

import { getStaticProviderModels } from '../providers/StaticProviderModels'
import {
  discoverKimiManagedModelRows,
  parseKimiManagedModelAliases,
  projectKimiManagedModelRows
} from './KimiModelCatalog'

const FULL_CONFIG = `
default_model = "kimi-code/kimi-for-coding"
api_key = "must-never-be-read-as-model-metadata"

[providers."managed:kimi-code"]
type = "kimi"
api_key = "also-ignored"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
display_name = "K2.7 Coding"

[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
max_context_size = 262144
display_name = "K2.7 Coding Highspeed"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
display_name = "K3"
support_efforts = [ "low", "high", "max" ]
default_effort = "high"

[models."kimi-code/k3-256k"]
provider = "managed:kimi-code"
model = "k3-256k"
max_context_size = 262144
display_name = "K3-256k"
support_efforts = [ "low", "high", "max" ]
default_effort = "high"
`

const fallbackRows = () => getStaticProviderModels('kimi')

describe('KimiModelCatalog', () => {
  it('parses only managed model aliases and their credential-free metadata', () => {
    const aliases = parseKimiManagedModelAliases(FULL_CONFIG)
    expect([...aliases.keys()]).toEqual([
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
      'kimi-code/k3',
      'kimi-code/k3-256k'
    ])
    expect(aliases.get('kimi-code/k3')).toEqual({
      alias: 'kimi-code/k3',
      modelId: 'k3',
      displayName: 'K3',
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      maxContextSize: 1_048_576
    })
    expect(JSON.stringify([...aliases.values()])).not.toContain('must-never')
    expect(JSON.stringify([...aliases.values()])).not.toContain('also-ignored')
  })

  it('projects both K3 routes and gates K2.7 Fast on the discovered Highspeed alias', () => {
    const rows = projectKimiManagedModelRows(FULL_CONFIG, fallbackRows())
    expect(rows?.map((row) => row.id)).toEqual(['kimi-k2.7-code', 'kimi-k3', 'kimi-k3-256k'])
    expect(rows?.find((row) => row.id === 'kimi-k2.7-code')).toMatchObject({
      additionalSpeedTiers: ['fast']
    })
    const k3 = rows?.find((row) => row.id === 'kimi-k3')
    expect(k3).toMatchObject({
      label: 'K3 (1M)',
      defaultReasoningEffort: 'high',
      contextWindow: 1_048_576
    })
    expect(k3?.additionalSpeedTiers).toBeUndefined()
    const k3Short = rows?.find((row) => row.id === 'kimi-k3-256k')
    expect(k3Short).toMatchObject({
      label: 'K3 (256K)',
      defaultReasoningEffort: 'high',
      contextWindow: 262_144
    })
    expect(k3Short?.additionalSpeedTiers).toBeUndefined()
  })

  it('shows a plan-capped long route and removes Fast when Highspeed is unavailable', () => {
    const config = FULL_CONFIG.replace(
      /\n\[models\."kimi-code\/kimi-for-coding-highspeed"\][\s\S]*?(?=\n\[models\.)/,
      '\n'
    ).replace('max_context_size = 1048576', 'max_context_size = 262144')
    const rows = projectKimiManagedModelRows(config, fallbackRows())

    expect(rows?.find((row) => row.id === 'kimi-k2.7-code')).toMatchObject({
      additionalSpeedTiers: []
    })
    expect(rows?.find((row) => row.id === 'kimi-k3')?.label).toBe('K3 (plan-capped 256K)')
  })

  it('honors a user context override without borrowing another alias window', () => {
    const config = `${FULL_CONFIG}
[models."kimi-code/k3".overrides]
max_context_size = 262144
`
    const rows = projectKimiManagedModelRows(config, fallbackRows())
    expect(rows?.find((row) => row.id === 'kimi-k3')?.label).toBe('K3 (plan-capped 256K)')
    expect(rows?.find((row) => row.id === 'kimi-k3-256k')?.label).toBe('K3 (256K)')
  })

  it('omits absent managed routes and falls back when no recognized alias exists', () => {
    const standardOnly = `
[models."kimi-code/kimi-for-coding"]
max_context_size = 262144
`
    expect(projectKimiManagedModelRows(standardOnly, fallbackRows())?.map((row) => row.id)).toEqual(
      ['kimi-k2.7-code']
    )
    expect(
      projectKimiManagedModelRows('[models."custom/kimi"]\nmax_context_size = 1', fallbackRows())
    ).toBeNull()
  })

  it('does not label a remapped alias as K3 or expose unknown effort tokens', () => {
    const config = FULL_CONFIG.replace('model = "k3-256k"', 'model = "not-k3"').replace(
      'support_efforts = [ "low", "high", "max" ]',
      'support_efforts = [ "low", "invented", "max" ]'
    )
    const rows = projectKimiManagedModelRows(config, fallbackRows())

    expect(rows?.map((row) => row.id)).not.toContain('kimi-k3-256k')
    expect(
      rows
        ?.find((row) => row.id === 'kimi-k3')
        ?.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort)
    ).toEqual(['low', 'max'])
  })

  it('loads config.toml from the selected Kimi home and returns null on read failure', async () => {
    const readFile = vi.fn(async () => FULL_CONFIG)
    await expect(
      discoverKimiManagedModelRows('/tmp/kimi-home', fallbackRows(), readFile)
    ).resolves.toHaveLength(3)
    expect(readFile).toHaveBeenCalledWith('/tmp/kimi-home/config.toml')

    await expect(
      discoverKimiManagedModelRows('/tmp/kimi-home', fallbackRows(), async () => {
        throw new Error('missing')
      })
    ).resolves.toBeNull()
  })
})
