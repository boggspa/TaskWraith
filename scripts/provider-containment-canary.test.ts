import { createRequire } from 'module'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  applyRequiredLivePreflight,
  canarySubprocessEnv,
  captureBinaryIdentity,
  capabilityFingerprint,
  cursorEnvironmentAuthAvailable,
  cursorUnauthenticatedProbeSourceEnv,
  extractCommands,
  extractLongFlags,
  liveExecutionAllowed,
  parseArgs,
  parseVersion,
  processControlFailure,
  providerInventoryCommands,
  providerInventoryProbeLayout,
  qualificationFor,
  reviewedLiveSuite,
  REVIEWED_LIVE_ASSERTIONS,
  REVIEWED_LIVE_TESTS,
  renderAggregateJunit,
  sameBinaryIdentity,
  summarize,
  validateVitestReport
}: {
  applyRequiredLivePreflight: (
    probes: Array<{
      provider: string
      qualificationScope: string | null
      runtimeAvailable: boolean
      reviewedSuiteAvailable: boolean
      unavailableReasons: string[]
      qualificationBlockers: string[]
      capabilities: { recognized: boolean }
      liveTests: { status: string; reason: string | null }
    }>,
    options: { required: string[]; requireKnownFingerprints: boolean }
  ) => boolean
  canarySubprocessEnv: (
    extra: Record<string, string>,
    source: Record<string, string>
  ) => Record<string, string>
  captureBinaryIdentity: (
    sourcePath: string,
    hooks?: { afterDescriptorHash?: () => void | Promise<void> }
  ) => Promise<{
    realPath: string
    sha256: string
    stat: Record<string, string>
  }>
  capabilityFingerprint: (document: unknown) => string
  cursorEnvironmentAuthAvailable: (env?: Record<string, string>) => boolean
  cursorUnauthenticatedProbeSourceEnv: (env?: Record<string, string>) => Record<string, string>
  extractCommands: (raw: string) => string[]
  extractLongFlags: (raw: string) => string[]
  liveExecutionAllowed: (provider: string) => boolean
  parseArgs: (args: string[]) => {
    live: boolean
    providers: string[]
    required: string[]
    requireKnownFingerprints: boolean
  }
  parseVersion: (raw: string) => string | null
  processControlFailure: (error: unknown, action: string) => string | null
  providerInventoryCommands: (provider: string) => string[][]
  providerInventoryProbeLayout: (
    provider: string,
    root: string
  ) => { home: string; workspace: string; env: Record<string, string> }
  qualificationFor: (
    manifest: unknown,
    provider: string,
    probe: {
      qualificationScope: string | null
      binary: { version: string; sha256: string; distribution?: string }
      capabilities: { fingerprint: string }
      runtimeContract?: {
        authentication: string
        backendBaseUrl: string
        modelAlias: string
        model: string
      }
    }
  ) => unknown
  reviewedLiveSuite: (
    provider: string,
    root?: string,
    stat?: (path: string) => { isFile: () => boolean }
  ) => {
    expected: string[]
    present: string[]
    missingOrInvalid: string[]
    complete: boolean
  }
  REVIEWED_LIVE_ASSERTIONS: Record<string, readonly string[]>
  REVIEWED_LIVE_TESTS: { kimi: readonly string[]; cursor: readonly string[] }
  renderAggregateJunit: (report: unknown) => string
  sameBinaryIdentity: (left: unknown, right: unknown) => boolean
  summarize: (
    probes: Array<{
      provider: string
      qualificationScope?: string | null
      available: boolean
      capabilities: { recognized: boolean }
      liveTests: { status: string }
    }>,
    options: { live: boolean; required: string[]; requireKnownFingerprints: boolean }
  ) => { status: string; exitCode: number }
  validateVitestReport: (
    report: unknown,
    expectedTitles: readonly string[]
  ) => {
    valid: boolean
    errors: string[]
    counts: { total: number; passed: number; failed: number; skipped: number }
  }
} = require('./provider-containment-canary.cjs')

describe('provider containment canary runner', () => {
  it('defaults to a non-mutating probe and parses strict release options', () => {
    expect(parseArgs([])).toMatchObject({
      live: false,
      providers: ['kimi', 'cursor'],
      required: [],
      requireKnownFingerprints: false
    })
    expect(
      parseArgs([
        '--live',
        '--providers=cursor,kimi',
        '--require',
        'kimi,cursor',
        '--require-known-fingerprints'
      ])
    ).toMatchObject({
      live: true,
      providers: ['cursor', 'kimi'],
      required: ['kimi', 'cursor'],
      requireKnownFingerprints: true
    })
    expect(
      parseArgs(['--output=artifacts/custom.json', '--junit-output=artifacts/custom.xml'])
    ).toMatchObject({
      // path.resolve uses platform separators (Windows → artifacts\custom.json).
      outputPath: expect.stringMatching(/artifacts[/\\]custom\.json$/),
      junitOutputPath: expect.stringMatching(/artifacts[/\\]custom\.xml$/)
    })
  })

  it('rejects unsupported or unrequested required providers', () => {
    expect(() => parseArgs(['--providers=claude'])).toThrow('unsupported provider')
    expect(() => parseArgs(['--providers=kimi', '--require=cursor'])).toThrow(
      'is not in --providers'
    )
    expect(() => parseArgs(['--live', '--probe-only'])).toThrow('cannot be combined')
    expect(() => parseArgs(['--probe-only', '--live'])).toThrow('cannot be combined')
    expect(() => parseArgs(['--require-known-fingerprints', '--require=kimi'])).toThrow(
      'requires --live'
    )
    expect(() => parseArgs(['--live', '--require-known-fingerprints'])).toThrow(
      'non-empty --require'
    )
    expect(() => parseArgs(['--live', '--providers=kimi', '--require=kimi', '--help'])).toThrow(
      '--help cannot be combined'
    )
  })

  it('normalizes help capabilities and versions without retaining prose', () => {
    const help = `Options:
  -p, --print        Print mode
  --force            Force mode

Commands:
  status|whoami      Show status
  mcp                Manage MCP
    continuation line`
    expect(extractLongFlags(help)).toEqual(['--force', '--print'])
    expect(extractCommands(help)).toEqual(['mcp', 'status'])
    expect(parseVersion('cursor-agent 2026.07.16-899851b')).toBe('2026.07.16-899851b')
    expect(parseVersion('0.27.0')).toBe('0.27.0')
    expect(parseVersion('unknown')).toBeNull()
  })

  it('treats only ESRCH as affirmative process-group disappearance', () => {
    expect(
      processControlFailure(Object.assign(new Error('gone'), { code: 'ESRCH' }), 'check')
    ).toBe(null)
    expect(
      processControlFailure(Object.assign(new Error('not permitted'), { code: 'EPERM' }), 'check')
    ).toBe('check: not permitted')
    expect(processControlFailure(new Error('unknown'), 'signal')).toBe('signal: unknown')
  })

  it('builds a stable capability fingerprint independent of object key order', () => {
    expect(capabilityFingerprint({ b: 2, a: { y: 2, x: 1 } })).toBe(
      capabilityFingerprint({ a: { x: 1, y: 2 }, b: 2 })
    )
    expect(capabilityFingerprint({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it.skipIf(process.platform === 'win32')(
    'detects provider executable symlink and target swaps',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'taskwraith-binary-identity-'))
      const targetA = join(root, 'provider-a')
      const targetB = join(root, 'provider-b')
      const selected = join(root, 'provider')
      try {
        writeFileSync(targetA, '#!/bin/sh\necho 0.27.0\n', { mode: 0o700 })
        writeFileSync(targetB, '#!/bin/sh\necho 0.27.1\n', { mode: 0o700 })
        symlinkSync(targetA, selected)
        const initial = await captureBinaryIdentity(selected)

        unlinkSync(selected)
        symlinkSync(targetB, selected)
        const swappedLink = await captureBinaryIdentity(selected)
        expect(sameBinaryIdentity(initial, swappedLink)).toBe(false)

        unlinkSync(selected)
        symlinkSync(targetA, selected)
        writeFileSync(targetA, '#!/bin/sh\necho replaced\n', { mode: 0o700 })
        const replacedTarget = await captureBinaryIdentity(selected)
        expect(sameBinaryIdentity(initial, replacedTarget)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a source-path swap between descriptor hashing and identity join',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'taskwraith-binary-capture-swap-'))
      const targetA = join(root, 'provider-a')
      const targetB = join(root, 'provider-b')
      const selected = join(root, 'provider')
      try {
        writeFileSync(targetA, '#!/bin/sh\necho 0.27.0\n', { mode: 0o700 })
        writeFileSync(targetB, '#!/bin/sh\necho swapped\n', { mode: 0o700 })
        symlinkSync(targetA, selected)

        await expect(
          captureBinaryIdentity(selected, {
            afterDescriptorHash: async () => {
              unlinkSync(selected)
              symlinkSync(targetB, selected)
            }
          })
        ).rejects.toThrow('identity changed while it was being captured')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('does not admit any fingerprint scope for disabled Cursor', () => {
    const tuple = {
      version: '2026.07.16-test',
      capabilityFingerprint: 'sha256:capabilities',
      binarySha256: 'sha256:binary',
      platform: process.platform,
      arch: process.arch
    }
    const manifest = { providers: { cursor: [{ ...tuple, scope: 'plan-no-tools' }] } }
    const probe = {
      qualificationScope: null,
      binary: { version: tuple.version, sha256: tuple.binarySha256 },
      capabilities: { fingerprint: tuple.capabilityFingerprint }
    }

    expect(qualificationFor(manifest, 'cursor', probe)).toBeNull()
  })

  it('matches every exact native Kimi distribution/backend tuple field', () => {
    const tuple = {
      scope: 'acp-synthetic-cwd-gateway-v1',
      postureVersion: 'synthetic-cwd-gateway-v1',
      attestationSource: 'credentialed-live-containment-canary',
      version: '0.27.0',
      capabilityFingerprint: `sha256:${'a'.repeat(64)}`,
      binarySha256: `sha256:${'b'.repeat(64)}`,
      distribution: 'official-native-single-binary',
      harnessNodeVersion: process.version,
      authentication: 'kimi-code-provider-api-key',
      backendBaseUrl: 'https://api.kimi.com/coding/v1',
      modelAlias: 'kimi-code/kimi-for-coding',
      model: 'kimi-for-coding',
      platform: process.platform,
      arch: process.arch
    }
    const probe = {
      qualificationScope: tuple.scope,
      binary: {
        version: tuple.version,
        sha256: tuple.binarySha256,
        distribution: tuple.distribution
      },
      capabilities: { fingerprint: tuple.capabilityFingerprint },
      runtimeContract: {
        authentication: tuple.authentication,
        backendBaseUrl: tuple.backendBaseUrl,
        modelAlias: tuple.modelAlias,
        model: tuple.model
      }
    }
    expect(qualificationFor({ providers: { kimi: [tuple] } }, 'kimi', probe)).toEqual(tuple)
    expect(
      qualificationFor(
        { providers: { kimi: [{ ...tuple, distribution: 'npm-package' }] } },
        'kimi',
        probe
      )
    ).toBeNull()
    expect(
      qualificationFor(
        { providers: { kimi: [{ ...tuple, model: 'another-model' }] } },
        'kimi',
        probe
      )
    ).toBeNull()
    expect(
      qualificationFor(
        { providers: { kimi: [{ ...tuple, postureVersion: 'legacy' }] } },
        'kimi',
        probe
      )
    ).toBeNull()
    expect(
      qualificationFor(
        { providers: { kimi: [{ ...tuple, attestationSource: 'manual' }] } },
        'kimi',
        probe
      )
    ).toBeNull()
  })

  it('passes only runtime plumbing and never unrelated provider credentials', () => {
    expect(
      canarySubprocessEnv(
        { TASKWRAITH_KIMI_CANARY_BIN: '/qualified/kimi' },
        {
          HOME: '/worker',
          PATH: '/bin',
          RUNNER_TRACKING_ID: 'actions-orphan-reaper',
          CURSOR_API_KEY: 'provider-auth',
          GH_TOKEN: 'must-not-leak',
          AWS_SECRET_ACCESS_KEY: 'must-not-leak'
        }
      )
    ).toEqual({
      HOME: '/worker',
      PATH: '/bin',
      RUNNER_TRACKING_ID: 'actions-orphan-reaper',
      TASKWRAITH_KIMI_CANARY_BIN: '/qualified/kimi',
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    })
  })

  it('reports explicit Cursor token presence without invoking native login status', () => {
    expect(cursorEnvironmentAuthAvailable({})).toBe(false)
    expect(cursorEnvironmentAuthAvailable({ CURSOR_AUTH_TOKEN: '   ' })).toBe(false)
    expect(cursorEnvironmentAuthAvailable({ CURSOR_API_KEY: 'opaque' })).toBe(true)
  })

  it('strips explicit Cursor credentials from bounded inventory probes', () => {
    expect(
      cursorUnauthenticatedProbeSourceEnv({
        HOME: '/owned-home',
        PATH: '/bin',
        CURSOR_AUTH_TOKEN: 'must-not-reach-process',
        CURSOR_API_KEY: 'must-not-reach-process'
      })
    ).toEqual({ HOME: '/owned-home', PATH: '/bin' })
  })

  it('uses fresh unauthenticated homes and synthetic cwd for provider inventory', () => {
    const root = join('/owned', 'probe')
    const kimi = providerInventoryProbeLayout('kimi', root)
    expect(kimi.home).toBe(join(root, 'home'))
    expect(kimi.workspace).toBe(join(root, 'workspace'))
    expect(kimi.env.HOME).toBe(kimi.home)
    expect(kimi.env.TMPDIR).toBe(join(root, 'tmp'))
    expect(kimi.env.XDG_RUNTIME_DIR).toBe(join(root, 'xdg-runtime'))
    expect(kimi.env.KIMI_CODE_HOME).toBe(join(root, 'kimi-code'))
    expect(kimi.env.CURSOR_AUTH_TOKEN).toBeUndefined()

    const cursor = providerInventoryProbeLayout('cursor', root)
    expect(cursor.workspace).toBe(join(root, 'workspace'))
    expect(cursor.env.HOME).toBe(join(root, 'home'))
    expect(cursor.env.CURSOR_CONFIG_DIR).toBe(join(root, 'home', '.cursor'))
    expect(cursor.env.CURSOR_DATA_DIR).toBe(join(root, 'cursor-data'))
    expect(cursor.env.KIMI_CODE_HOME).toBeUndefined()
  })

  it('limits disabled Cursor inventory to unauthenticated version and help', () => {
    expect(providerInventoryCommands('cursor')).toEqual([['--version'], ['--help']])
    expect(providerInventoryCommands('cursor')).not.toContainEqual(['mcp', '--help'])
    expect(providerInventoryCommands('kimi')).toEqual([
      ['--version'],
      ['--help'],
      ['acp', '--help']
    ])
  })

  it('arms the Cursor startup-containment suite but keeps its manifest roster and the required live scripts fail-closed', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    // Cursor's DRAFT startup-containment suite is allowlisted and live execution
    // is armed, but the manifest providers.cursor roster stays empty and the
    // required live/release scripts stay kimi-only — so no managed Cursor run is
    // admissible until a real live pass mints its exact fingerprint.
    expect(REVIEWED_LIVE_TESTS.cursor).toEqual([
      'src/main/cursor/CursorStartupContainment.live.test.ts'
    ])
    expect(liveExecutionAllowed('cursor')).toBe(true)
    expect(liveExecutionAllowed('kimi')).toBe(true)
    expect(REVIEWED_LIVE_TESTS.kimi).toEqual([
      'src/main/kimi/KimiProductionContainment.live.test.ts'
    ])
    expect(
      REVIEWED_LIVE_ASSERTIONS['src/main/kimi/KimiProductionContainment.live.test.ts']
    ).toEqual([
      'uses the private production process/session cwd and leaves workspace project config inert',
      'advertises no ACP client fs and keeps the exact native deny roster',
      'reads the real workspace only through the authenticated TaskWraith HTTP gateway',
      'cold-starts a legacy posture through session/new without session/resume',
      'tears down the provider, gateway, private cwd, workspace, and credential home',
      'returns a same-id structured terminal denial for native FetchURL with zero client-fs fallback',
      'returns a same-id structured terminal denial for native WebSearch with zero client-fs fallback',
      'returns a same-id structured terminal denial for native AgentSwarm with zero client-fs fallback',
      'returns a same-id structured terminal denial for native Bash with zero client-fs fallback',
      'returns a same-id structured terminal denial for native Glob with zero client-fs fallback',
      'returns a same-id structured terminal denial for native Grep with zero client-fs fallback',
      'returns a same-id structured terminal denial for native Read with zero client-fs fallback',
      'returns a same-id structured terminal denial for native Write with zero client-fs fallback',
      'returns a same-id structured terminal denial for native Edit with zero client-fs fallback',
      'rejects gateway disablement and bridge startup failure before invoking provider spawn',
      'is gated behind KIMI_ACP_LIVE_TRACE + an authenticated Kimi Code install'
    ])
    expect(
      REVIEWED_LIVE_ASSERTIONS['src/main/cursor/CursorStartupContainment.live.test.ts']
    ).toEqual([
      'spawns the contained read-only argv the production runtime builds (sandbox enabled, prompt guarded)',
      'never auto-executes a hostile project MCP server in a read-only turn',
      'lets an in-workspace write land but sandbox-blocks a write to the user home',
      'requires a real contained attempt and tears down the workspace and process',
      'builds a contained managed argv that enforces the sandbox and never emits force, yolo, or approve-mcps',
      'denies an unqualified cursor-agent binary while the embedded runtime roster is empty',
      'is gated behind CURSOR_API_KEY and an installed cursor-agent binary'
    ])
    expect(packageJson.scripts['verify:provider-permissions:live']).toBe(
      'node scripts/provider-containment-canary.cjs --live --providers=kimi --require=kimi'
    )
    expect(packageJson.scripts['verify:provider-permissions:release']).toBe(
      'node scripts/provider-containment-canary.cjs --live --providers=kimi --require=kimi --require-known-fingerprints'
    )
    expect(packageJson.scripts['verify:provider-permissions:live']).not.toContain('cursor')
    expect(packageJson.scripts['verify:provider-permissions:release']).not.toContain('cursor')
    const runnerSource = readFileSync(
      join(process.cwd(), 'scripts/provider-containment-canary.cjs'),
      'utf8'
    )
    expect(runnerSource).not.toContain('TASKWRAITH_CURSOR_LIVE_PLAN_ONLY')
    const productionContainmentSource = readFileSync(
      join(process.cwd(), 'src/main/kimi/KimiProductionContainment.ts'),
      'utf8'
    )
    expect(productionContainmentSource).toContain("'RUNNER_TRACKING_ID'")
    for (const liveSuite of REVIEWED_LIVE_TESTS.kimi) {
      const liveSource = readFileSync(join(process.cwd(), liveSuite), 'utf8')
      expect(liveSource).toContain('buildKimiContainedProcessEnv')
      expect(liveSource).toContain('admitKimiRuntime')
      expect(liveSource).toContain('assertRuntimeReadyForSpawn: admission.assertReadyForSpawn')
      expect(liveSource).toContain('classifyKimiToolPermission')
      expect(liveSource).toContain("unqualifyKimiMcpToolName(request.toolName) === 'read_file'")
      expect(liveSource).not.toContain("includes('read_file')")
    }
  })

  it('requires every reviewed suite file to exist as a regular file', () => {
    const firstPath = join('/repo', REVIEWED_LIVE_TESTS.kimi[0])
    const complete = reviewedLiveSuite('kimi', '/repo', (candidate) => {
      if (candidate === firstPath) return { isFile: () => true }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    expect(complete.complete).toBe(true)
    expect(complete.present).toEqual([REVIEWED_LIVE_TESTS.kimi[0]])
    expect(complete.missingOrInvalid).toEqual([])

    const missing = reviewedLiveSuite('kimi', '/repo', () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    expect(missing.complete).toBe(false)
    expect(missing.missingOrInvalid).toEqual([...REVIEWED_LIVE_TESTS.kimi])

    const nonRegular = reviewedLiveSuite('kimi', '/repo', () => ({ isFile: () => false }))
    expect(nonRegular.complete).toBe(false)
    expect(nonRegular.present).toEqual([])
    expect(nonRegular.missingOrInvalid).toEqual([...REVIEWED_LIVE_TESTS.kimi])
  })

  it('rejects Vitest false greens where live assertions were skipped', () => {
    const report = {
      success: true,
      testResults: [
        {
          assertionResults: [
            {
              fullName: 'live containment blocks escape',
              title: 'blocks escape',
              status: 'skipped'
            },
            {
              fullName: 'live trace availability is gated behind env',
              title: 'availability',
              status: 'passed'
            }
          ]
        }
      ]
    }
    const expectedTitles = ['blocks escape', 'availability']
    expect(validateVitestReport(report, expectedTitles)).toMatchObject({
      valid: false,
      counts: { total: 2, passed: 1, failed: 0, skipped: 1 }
    })
    expect(validateVitestReport(report, expectedTitles).errors.join(' ')).toContain('skipped')
  })

  it('accepts only a report with an executed non-availability assertion', () => {
    expect(
      validateVitestReport(
        {
          success: true,
          testResults: [
            {
              assertionResults: [
                {
                  fullName: 'live containment blocks escape',
                  title: 'blocks escape',
                  status: 'passed'
                }
              ]
            }
          ]
        },
        ['blocks escape']
      )
    ).toMatchObject({ valid: true, counts: { total: 1, passed: 1, failed: 0, skipped: 0 } })
  })

  it('rejects missing or extra assertions outside the reviewed live roster', () => {
    const report = {
      success: true,
      testResults: [
        {
          assertionResults: [
            { fullName: 'suite boundary A', title: 'boundary A', status: 'passed' },
            { fullName: 'suite unreviewed C', title: 'unreviewed C', status: 'passed' }
          ]
        }
      ]
    }
    const validation = validateVitestReport(report, ['boundary A', 'boundary B'])
    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain('1 reviewed assertion(s) were missing')
    expect(validation.errors).toContain('1 unreviewed assertion(s) were present')
  })

  it('rejects todo or pending assertions even when their titles resemble meta checks', () => {
    const validation = validateVitestReport(
      {
        success: true,
        testResults: [
          {
            assertionResults: [
              { fullName: 'suite boundary A', title: 'boundary A', status: 'passed' },
              {
                fullName: 'suite availability of a new boundary',
                title: 'availability of a new boundary',
                status: 'todo'
              }
            ]
          }
        ]
      },
      ['boundary A']
    )
    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain('1 unreviewed assertion(s) were present')
    expect(validation.errors).toContain('1 assertion(s) did not pass')
  })

  it('rejects reporter assertions without a stable title', () => {
    const validation = validateVitestReport(
      {
        success: true,
        testResults: [
          {
            assertionResults: [
              { fullName: 'suite boundary A', title: 'boundary A', status: 'passed' },
              { fullName: 'suite unnamed', status: 'passed' }
            ]
          }
        ]
      },
      ['boundary A']
    )
    expect(validation.valid).toBe(false)
    expect(validation.errors).toContain('1 assertion(s) had no stable title')
  })

  it('makes strict release absence/fingerprint drift non-zero', () => {
    const unavailable = {
      provider: 'kimi',
      available: false,
      capabilities: { recognized: false },
      liveTests: { status: 'unavailable' }
    }
    expect(
      summarize([unavailable], {
        live: true,
        required: ['kimi'],
        requireKnownFingerprints: true
      })
    ).toEqual({ status: 'unavailable', exitCode: 2 })

    const unknown = {
      provider: 'kimi',
      qualificationScope: 'acp-synthetic-cwd-gateway-v1',
      available: true,
      capabilities: { recognized: false },
      liveTests: { status: 'blocked_unrecognized_fingerprint' }
    }
    expect(
      summarize([unknown], {
        live: true,
        required: ['kimi'],
        requireKnownFingerprints: true
      })
    ).toEqual({ status: 'unrecognized_fingerprint', exitCode: 3 })
  })

  it('keeps probe readiness separate from a missing reviewed live suite', () => {
    expect(
      summarize(
        [
          {
            provider: 'cursor',
            runtimeAvailable: true,
            reviewedSuiteAvailable: false,
            available: false,
            capabilities: { recognized: false },
            liveTests: { status: 'not_run' }
          }
        ],
        { live: false, required: ['cursor'], requireKnownFingerprints: false }
      )
    ).toEqual({ status: 'probe_only', exitCode: 0 })

    expect(
      summarize(
        [
          {
            provider: 'cursor',
            runtimeAvailable: true,
            reviewedSuiteAvailable: false,
            available: false,
            capabilities: { recognized: false },
            liveTests: { status: 'blocked_no_reviewed_suite' }
          }
        ],
        { live: true, required: ['cursor'], requireKnownFingerprints: false }
      )
    ).toEqual({ status: 'no_reviewed_suite', exitCode: 2 })
  })

  it('blocks the whole required run before spending credentials on partial evidence', () => {
    const probes = [
      {
        provider: 'kimi',
        qualificationScope: 'acp-synthetic-cwd-gateway-v1',
        runtimeAvailable: true,
        reviewedSuiteAvailable: true,
        unavailableReasons: [],
        qualificationBlockers: [],
        capabilities: { recognized: false },
        liveTests: { status: 'not_run', reason: null }
      },
      {
        provider: 'cursor',
        qualificationScope: null,
        runtimeAvailable: true,
        reviewedSuiteAvailable: false,
        unavailableReasons: [],
        qualificationBlockers: ['no reviewed cursor live suite is allowlisted'],
        capabilities: { recognized: false },
        liveTests: { status: 'not_run', reason: null }
      }
    ]

    expect(
      applyRequiredLivePreflight(probes, {
        required: ['kimi', 'cursor'],
        requireKnownFingerprints: false
      })
    ).toBe(true)
    expect(probes[0].liveTests).toMatchObject({
      status: 'blocked_by_required_provider_preflight'
    })
    expect(probes[1].liveTests).toMatchObject({ status: 'blocked_no_reviewed_suite' })
  })

  it('applies strict fingerprint blocking only to required providers', () => {
    const optional = {
      provider: 'kimi',
      qualificationScope: 'acp-synthetic-cwd-gateway-v1',
      runtimeAvailable: true,
      reviewedSuiteAvailable: true,
      unavailableReasons: [],
      qualificationBlockers: [],
      capabilities: { recognized: false },
      liveTests: { status: 'not_run', reason: null }
    }

    expect(
      applyRequiredLivePreflight([optional], {
        required: [],
        requireKnownFingerprints: true
      })
    ).toBe(false)
  })

  it('cannot execute disabled Cursor by adding a reviewed suite alone', () => {
    const syntheticCursorWithSuite = {
      provider: 'cursor',
      qualificationScope: null,
      runtimeAvailable: true,
      reviewedSuiteAvailable: true,
      unavailableReasons: [],
      qualificationBlockers: ['provider has no admissible live qualification scope'],
      capabilities: { recognized: false },
      liveTests: { status: 'not_run', reason: null }
    }

    expect(
      applyRequiredLivePreflight([syntheticCursorWithSuite], {
        required: ['cursor'],
        requireKnownFingerprints: false
      })
    ).toBe(true)
    expect(syntheticCursorWithSuite.liveTests).toEqual({
      status: 'blocked_no_qualification_scope',
      reason: 'provider has no admissible live qualification scope'
    })
    expect(
      summarize([syntheticCursorWithSuite], {
        live: true,
        required: ['cursor'],
        requireKnownFingerprints: false
      })
    ).toEqual({ status: 'no_qualification_scope', exitCode: 2 })
  })

  it('reports an explicitly requested disabled optional provider as incomplete', () => {
    expect(
      summarize(
        [
          {
            provider: 'kimi',
            qualificationScope: 'acp-synthetic-cwd-gateway-v1',
            available: true,
            capabilities: { recognized: true },
            liveTests: { status: 'passed' }
          },
          {
            provider: 'cursor',
            qualificationScope: null,
            available: true,
            capabilities: { recognized: false },
            liveTests: { status: 'blocked_no_qualification_scope' }
          }
        ],
        { live: true, required: ['kimi'], requireKnownFingerprints: true }
      )
    ).toEqual({ status: 'partial_pass', exitCode: 0 })
  })

  it('allows an explicitly requested unknown live tuple to produce review evidence', () => {
    expect(
      summarize(
        [
          {
            provider: 'kimi',
            qualificationScope: 'acp-synthetic-cwd-gateway-v1',
            available: true,
            capabilities: { recognized: false },
            liveTests: { status: 'passed_unrecognized' }
          }
        ],
        { live: true, required: ['kimi'], requireKnownFingerprints: false }
      )
    ).toEqual({ status: 'unattested_pass', exitCode: 0 })
  })

  it('emits one aggregate JUnit document with failures and skips represented', () => {
    const xml = renderAggregateJunit({
      mode: 'live',
      requiredProviders: ['kimi'],
      requireKnownFingerprints: true,
      providers: [
        {
          provider: 'kimi',
          qualificationScope: 'acp-synthetic-cwd-gateway-v1',
          available: true,
          unavailableReasons: [],
          capabilities: { recognized: false },
          liveTests: {
            reason: 'binary/capability tuple is not in the reviewed manifest',
            reports: []
          }
        }
      ]
    })
    expect(xml).toContain('<testsuites name="provider-permission-conformance"')
    expect(xml).toContain('exact reviewed acp-synthetic-cwd-gateway-v1 fingerprint')
    expect(xml).toContain('<failure')
    expect(xml).not.toContain('[object Object]')
  })
})
