import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  resolveRuntimeNodeVersion,
  validateRuntimePolicy
}: {
  resolveRuntimeNodeVersion: (
    packageJson: unknown,
    env?: Record<string, string | undefined>,
    now?: Date
  ) => string
  validateRuntimePolicy: (packageJson: unknown, now?: Date) => string[]
} = require('./tui-runtime-policy.cjs')

function packageWithPolicy(overrides: Record<string, unknown> = {}) {
  return {
    taskwraithRelease: {
      tuiNodeRuntime: {
        version: '22.23.2',
        releasedOn: '2026-07-29',
        maximumAgeDays: 45,
        ...overrides
      }
    }
  }
}

describe('TUI Node runtime policy', () => {
  it('pins the repository policy to the reviewed current Node 22 LTS patch', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    )

    expect(resolveRuntimeNodeVersion(packageJson, {}, new Date('2026-07-29T12:00:00Z'))).toBe(
      '22.23.2'
    )
  })

  it('rejects a runtime override that diverges from package policy', () => {
    expect(() =>
      resolveRuntimeNodeVersion(
        packageWithPolicy(),
        { TASKWRAITH_TUI_NODE_VERSION: '22.23.1' },
        new Date('2026-07-29T12:00:00Z')
      )
    ).toThrow('does not match package policy 22.23.2')
  })

  it('fails closed after the offline freshness window expires', () => {
    expect(validateRuntimePolicy(packageWithPolicy(), new Date('2026-09-13T00:00:00Z'))).toEqual([
      expect.stringContaining('policy maximum is 45 days')
    ])
  })

  it('rejects invalid or future-dated policy metadata', () => {
    expect(
      validateRuntimePolicy(
        packageWithPolicy({ version: '23.0.0', releasedOn: '2026-08-05' }),
        new Date('2026-07-29T00:00:00Z')
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('supported Node 22 LTS line'),
        expect.stringContaining('is in the future')
      ])
    )
  })
})
