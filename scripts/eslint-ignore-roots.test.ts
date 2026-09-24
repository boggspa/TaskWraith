import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const eslint = new ESLint({ cwd: repoRoot })

describe('ESLint local-output root exclusions', () => {
  it.each([
    'perf-homes/example-run/build/main/generated.js',
    'perf-artifacts/example-run/generated.ts'
  ])('ignores root-local measurement output: %s', async (relativePath) => {
    expect(await eslint.isPathIgnored(join(repoRoot, relativePath))).toBe(true)
  })

  it.each([
    'src/main/index.ts',
    'scripts/format-ratchet.cjs',
    'src/perf-homes/ordinary-source.ts',
    'scripts/perf-artifacts/ordinary-source.cjs'
  ])('keeps ordinary source eligible: %s', async (relativePath) => {
    expect(await eslint.isPathIgnored(join(repoRoot, relativePath))).toBe(false)
  })
})
