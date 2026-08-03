import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runInterferenceScenarios } from './runScenario'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('runInterferenceScenarios', () => {
  it('emits machine-readable per-app results covering all eight dimensions', () => {
    const catalog = JSON.parse(
      readFileSync(path.join(here, 'fixtures/sample-apps.json'), 'utf8')
    ) as { apps: Array<{ appId: string; appLabel: string }> }

    const report = runInterferenceScenarios({
      apps: catalog.apps.map((a) => ({
        appId: a.appId,
        appLabel: a.appLabel,
        target: {
          kind: 'harness_fixture',
          appId: a.appId,
          appLabel: a.appLabel,
          pid: null,
          ownedByHarness: true
        }
      })),
      mode: 'dry_run',
      nowMs: (() => {
        let t = 1_000_000
        return () => {
          t += 1
          return t
        }
      })()
    })

    expect(report.schemaVersion).toBe(1)
    expect(report.defaultDryRun).toBe(true)
    expect(report.summary.appsMeasured).toBe(3)
    expect(report.summary.provenNonInterference).toBe(0)
    expect(report.summary.dryRunOnly).toBe(3)

    for (const r of report.results) {
      expect(r.productionAuthority).toBe(false)
      expect(r.modeClaimed).toBe('background')
      expect(r.dryRun).toBe(true)
      expect(r.nonInterferenceProven).toBe(false)
      const dims = new Set(r.dimensions.map((d) => d.dimension))
      for (const required of [
        'focus',
        'frontmostApp',
        'hostCursor',
        'keyboardTarget',
        'clipboardHash',
        'activation',
        'targetSuccess',
        'targetScopedHumanArbitration'
      ]) {
        expect(dims.has(required as never)).toBe(true)
      }
    }
  })
})
