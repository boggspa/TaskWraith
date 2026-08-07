import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const harness = require('./run-interference-harness.cjs') as {
  parseArgs: (argv: string[]) => {
    json: boolean
    allowLivePost: boolean
    fixturePid: number | null
    mode: string
    observeOnly: boolean
  }
  evaluatePolicy: (input: {
    mode: string
    fixturePid: number | null
    allowLivePost: boolean
    envAllowPost: boolean
    operation: string
  }) => { allow: boolean; refused?: string; dryRun?: boolean; actuation?: string }
  buildReport: (
    apps: Array<{ appId: string; appLabel: string }>,
    opts: {
      mode: string
      allowLivePost: boolean
      fixturePid: number | null
    }
  ) => {
    schemaVersion: number
    defaultDryRun: true
    results: Array<{
      dimensions: Array<{ dimension: string; verdict: string }>
      nonInterferenceProven: boolean
      dryRun: boolean
      productionAuthority: false
      refused: Array<{ kind: string }>
    }>
    summary: {
      appsMeasured: number
      provenNonInterference: number
      dryRunOnly: number
    }
  }
  REQUIRED_DIMENSIONS: string[]
  main: (argv?: string[]) => number
}

const temps: string[] = []
afterEach(() => {
  for (const t of temps.splice(0)) {
    rmSync(t, { recursive: true, force: true })
  }
})

describe('appdrive interference harness CLI', () => {
  it('defaults to dry-run and measures all eight dimensions', () => {
    const report = harness.buildReport(
      [
        {
          appId: 'com.taskwraith.harness.AppDriveFixture',
          appLabel: 'Fixture'
        }
      ],
      { mode: 'dry_run', allowLivePost: false, fixturePid: null }
    )
    expect(report.schemaVersion).toBe(1)
    expect(report.defaultDryRun).toBe(true)
    expect(report.summary.appsMeasured).toBe(1)
    expect(report.summary.provenNonInterference).toBe(0)
    expect(report.summary.dryRunOnly).toBe(1)
    const r = report.results[0]
    expect(r.productionAuthority).toBe(false)
    expect(r.nonInterferenceProven).toBe(false)
    expect(r.dryRun).toBe(true)
    const dims = new Set(r.dimensions.map((d) => d.dimension))
    for (const d of harness.REQUIRED_DIMENSIONS) {
      expect(dims.has(d)).toBe(true)
    }
    expect(r.dimensions.find((d) => d.dimension === 'targetScopedHumanArbitration')?.verdict).toBe(
      'fail'
    )
  })

  it('refuses global post and live post without gates', () => {
    expect(
      harness.evaluatePolicy({
        mode: 'live_post',
        fixturePid: 1,
        allowLivePost: true,
        envAllowPost: true,
        operation: 'global_cgevent_post'
      }).allow
    ).toBe(false)

    expect(
      harness.evaluatePolicy({
        mode: 'live_post',
        fixturePid: null,
        allowLivePost: false,
        envAllowPost: false,
        operation: 'cgevent_post_to_pid'
      }).allow
    ).toBe(false)
  })

  it('live gates still refuse native post without silent foreground fallback claim', () => {
    const prev = process.env.APPDRIVE_BG_ALLOW_POST
    process.env.APPDRIVE_BG_ALLOW_POST = '1'
    try {
      const report = harness.buildReport(
        [{ appId: 'com.taskwraith.harness.AppDriveFixture', appLabel: 'Fixture' }],
        { mode: 'live_post', allowLivePost: true, fixturePid: 99901 }
      )
      const r = report.results[0]
      expect(r.nonInterferenceProven).toBe(false)
      expect(r.refused.some((x) => x.kind === 'silent_foreground_fallback')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.APPDRIVE_BG_ALLOW_POST
      else process.env.APPDRIVE_BG_ALLOW_POST = prev
    }
  })

  it('main writes JSON report file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'appdrive-interference-'))
    temps.push(dir)
    const outPath = path.join(dir, 'report.json')
    const code = harness.main(['--out', outPath])
    expect(code).toBe(0)
    const report = JSON.parse(readFileSync(outPath, 'utf8')) as {
      summary: { appsMeasured: number; provenNonInterference: number }
    }
    expect(report.summary.appsMeasured).toBeGreaterThan(0)
    expect(report.summary.provenNonInterference).toBe(0)
  })

  it('parseArgs recognizes flags', () => {
    const a = harness.parseArgs([
      '--json',
      '--allow-live-post',
      '--fixture-pid',
      '42',
      '--observe-only'
    ])
    expect(a.json).toBe(true)
    expect(a.allowLivePost).toBe(true)
    expect(a.fixturePid).toBe(42)
    expect(a.observeOnly).toBe(true)
  })
})
