import { describe, expect, it } from 'vitest'
import { effectiveKimiModelContextWindow } from './KimiModelContext'

describe('effectiveKimiModelContextWindow', () => {
  it('reads the selected managed model without borrowing another alias window', () => {
    const config = `
[models."kimi-code/kimi-for-coding"]
max_context_size = 262144

[models."kimi-code/k3"]
max_context_size = 1_048_576
`

    expect(effectiveKimiModelContextWindow(config, 'kimi-code/k3')).toBe(1_048_576)
    expect(effectiveKimiModelContextWindow(config, 'kimi-code/kimi-for-coding')).toBe(262_144)
  })

  it('gives a surviving user override precedence over the managed base value', () => {
    const config = `
[models."kimi-code/k3"]
max_context_size = 262144

[models."kimi-code/k3".overrides]
max_context_size = 1048576 # Allegretto+
`

    expect(effectiveKimiModelContextWindow(config, 'kimi-code/k3')).toBe(1_048_576)
  })

  it('ignores malformed and non-positive values', () => {
    const config = `
[models."kimi-code/k3"]
max_context_size = -1

[models."kimi-code/k3".overrides]
max_context_size = "1048576"
`

    expect(effectiveKimiModelContextWindow(config, 'kimi-code/k3')).toBeUndefined()
    expect(effectiveKimiModelContextWindow(config, '')).toBeUndefined()
  })
})
