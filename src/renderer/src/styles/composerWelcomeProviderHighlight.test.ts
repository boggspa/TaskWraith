import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(new URL('../components/Composer.tsx', import.meta.url), 'utf8')

describe('Composer welcome provider highlights', () => {
  it('routes every solo and workflow welcome emphasis through the selected model hue', () => {
    const mounts = composerSource.match(
      /<WelcomeProviderHighlight\s+provider=\{currentProvider\}\s+modelId=\{contextModelId\}\s*>/g
    )

    expect(mounts).toHaveLength(3)
    expect(composerSource).not.toContain(
      'className={`workspace-name-glow provider-${currentProvider}`}'
    )
  })
})
