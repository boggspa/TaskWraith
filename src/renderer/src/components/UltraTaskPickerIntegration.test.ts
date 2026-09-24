import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')

describe('UltraTask picker integration', () => {
  it('never treats missing model metadata as UltraTask eligibility', () => {
    expect(composerSource).toContain('model?.ultraTaskSupported === true')
    expect(composerSource).toContain('ultraTaskSelectedModel?.ultraTaskSupported === true')
    expect(composerSource).not.toContain('ultraTaskSupported !== false')
  })

  it('carries a queued UltraTask selection only onto an explicitly supported model', () => {
    expect(appSource).toContain('const modelMetadata = getProviderModelOptions(provider).find(')
    expect(appSource).toContain('modelMetadata?.ultraTaskSupported === true')
    expect(appSource).not.toContain('ultraTaskSupported !== false')
  })
})
