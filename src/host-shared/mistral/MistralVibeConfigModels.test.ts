import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  mistralVibeConfigModelByAlias,
  mistralVibeHome,
  parseMistralVibeConfigModels,
  readMistralVibeConfigModels,
  withMistralVibePlanRow
} from './MistralVibeConfigModels'

const FULL_CONFIG = `
theme = "ansi-dark"
active_model = "mistral-large-4"
installed_agents = [
    "lean",
]

[tools.bash]
allowlist = [
    "ls",
    "cat",
]

[[models]]
thinking = "max"
alias = "mistral-medium-3.5"

[[models]]
name = "zai-glm-5-2"
alias = "glm-5-2"
provider = "mistral"
thinking = "max"

[[models]]
name = "mistral-large-4"
alias = "mistral-large-4"
display_name = "Mistral Large 4"
provider = "mistral"
thinking = "high"
temperature = 1.0
supports_images = true
max_context_length = 1048576

[[models]]
name = "local-llama"
alias = "local"
provider = "llamacpp"
`

describe('parseMistralVibeConfigModels', () => {
  it('reads only the Mistral provider model tables', () => {
    const models = parseMistralVibeConfigModels(FULL_CONFIG)
    expect(models.map((model) => model.alias)).toEqual([
      'mistral-medium-3.5',
      'glm-5-2',
      'mistral-large-4'
    ])
  })

  it('captures the fields the catalogue uses, ignoring the rest', () => {
    const large4 = mistralVibeConfigModelByAlias(
      parseMistralVibeConfigModels(FULL_CONFIG),
      'mistral-large-4'
    )
    expect(large4).toEqual({
      alias: 'mistral-large-4',
      name: 'mistral-large-4',
      provider: 'mistral',
      displayName: 'Mistral Large 4',
      contextWindow: 1_048_576,
      thinking: 'high',
      supportsImages: true
    })
  })

  it('returns an empty list for an empty config and ignores non-model tables', () => {
    expect(parseMistralVibeConfigModels('')).toEqual([])
    expect(parseMistralVibeConfigModels('[tools.bash]\nallowlist = ["ls"]')).toEqual([])
  })

  it('treats a malformed table line as the end of the model block', () => {
    expect(
      parseMistralVibeConfigModels('[[models]]\nalias = "a"\n[[models]]\nalias = "b"').map(
        (model) => model.alias
      )
    ).toEqual(['a', 'b'])
  })
})

describe('readMistralVibeConfigModels', () => {
  it('reads config.toml from the given Vibe home and tolerates a missing file', async () => {
    const dir = join(
      await fs.mkdtemp(join(process.env.TMPDIR || '/tmp', 'vibe-config-test-')),
      '.vibe'
    )
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'config.toml'), FULL_CONFIG)
    expect((await readMistralVibeConfigModels(dir)).map((model) => model.alias)).toContain(
      'mistral-large-4'
    )

    expect(await readMistralVibeConfigModels(join(dir, 'nope'))).toEqual([])
    expect(await readMistralVibeConfigModels('/definitely/missing/.vibe')).toEqual([])
  })
})

describe('mistralVibeHome', () => {
  it('honours a VIBE_HOME override and defaults to ~/.vibe', () => {
    expect(mistralVibeHome({ VIBE_HOME: '/opt/custom/vibe' }, '/home/user')).toBe(
      '/opt/custom/vibe'
    )
    expect(mistralVibeHome({}, '/home/user')).toBe('/home/user/.vibe')
    expect(mistralVibeHome({ VIBE_HOME: '   ' }, '/home/user')).toBe('/home/user/.vibe')
  })
})

describe('withMistralVibePlanRow', () => {
  const rows = [
    { id: 'mistral-medium-3.5' },
    { id: 'mistral-large-4' },
    { id: 'mistral-large-2512' }
  ]

  it('adds the plan row once, directly after the API-key row', () => {
    const offered = withMistralVibePlanRow(rows, [{ alias: 'mistral-large-4' }])
    expect(offered.map((row) => row.id)).toEqual([
      'mistral-medium-3.5',
      'mistral-large-4',
      'mistral-large-4-hosted',
      'mistral-large-2512'
    ])
    expect(offered[2]).toMatchObject({
      label: 'Mistral Large 4 (Vibe Plan)',
      defaultReasoningEffort: 'high',
      ultraTaskSupported: true,
      contextWindow: 524_288
    })
  })

  it('takes the context window from the user entry when it declares one', () => {
    const offered = withMistralVibePlanRow(rows, [
      { alias: 'mistral-large-4', contextWindow: 1_048_576 }
    ])
    expect(offered.find((row) => row.id === 'mistral-large-4-hosted')).toMatchObject({
      contextWindow: 1_048_576
    })
  })

  it('leaves the rows alone when the config does not carry the model', () => {
    expect(withMistralVibePlanRow(rows, [])).toEqual(rows)
    expect(withMistralVibePlanRow(rows, [{ alias: 'glm-5-2' }])).toEqual(rows)
  })
})
