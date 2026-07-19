import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseArgs,
  validateProviderCanaryAggregate
}: {
  parseArgs: (args: string[]) => { input: string; sha: string }
  validateProviderCanaryAggregate: (
    report: unknown,
    expectedSha: string
  ) => {
    valid: boolean
    errors: string[]
  }
} = require('./verify-provider-canary-aggregate.cjs')

const SHA = 'a'.repeat(40)
const SUITES = ['src/main/kimi/KimiProductionContainment.live.test.ts']
const ASSERTIONS = {
  [SUITES[0]]: [
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
  ]
}
const BINARY_SHA = 'sha256:550bca0ba6e474f4e0faeadfae03a9294c7c25688670f38ff488ab8cf176d817'
const CAPABILITY_SHA = `sha256:${'b'.repeat(64)}`
const RUNTIME_CONTRACT = {
  distribution: 'official-native-single-binary',
  harnessNodeVersion: 'v22.19.0',
  authentication: 'kimi-code-provider-api-key',
  providerType: 'kimi',
  backendBaseUrl: 'https://api.kimi.com/coding/v1',
  modelAlias: 'kimi-code/kimi-for-coding',
  model: 'kimi-for-coding'
}

function validateAggregate(report: unknown, sha = SHA): { valid: boolean; errors: string[] } {
  return validateProviderCanaryAggregate(report, sha)
}

function passingReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    reportKind: 'provider-permission-conformance',
    mode: 'live',
    fingerprintEnforcementScope: 'release-evidence-only',
    requestedProviders: ['kimi'],
    requireKnownFingerprints: true,
    requiredProviders: ['kimi'],
    reviewedSuiteAllowlist: { kimi: SUITES },
    reviewedAssertionRoster: ASSERTIONS,
    environment: {
      gitCommit: SHA,
      platform: 'darwin',
      arch: 'arm64',
      node: 'v22.19.0'
    },
    providers: [
      {
        provider: 'kimi',
        runtimeAvailable: true,
        reviewedSuiteAvailable: true,
        qualificationScope: 'acp-synthetic-cwd-gateway-v1',
        binary: {
          version: '0.27.0',
          sha256: BINARY_SHA,
          distribution: 'official-native-single-binary'
        },
        runtimeContract: RUNTIME_CONTRACT,
        auth: {
          available: true,
          method: 'provider-api-key-config',
          configPresent: true,
          configApiKeyPresent: true
        },
        qualification: {
          scope: 'acp-synthetic-cwd-gateway-v1',
          postureVersion: 'synthetic-cwd-gateway-v1',
          attestationSource: 'credentialed-live-containment-canary',
          version: '0.27.0',
          binarySha256: BINARY_SHA,
          distribution: 'official-native-single-binary',
          capabilityFingerprint: CAPABILITY_SHA,
          harnessNodeVersion: 'v22.19.0',
          authentication: 'kimi-code-provider-api-key',
          backendBaseUrl: 'https://api.kimi.com/coding/v1',
          modelAlias: 'kimi-code/kimi-for-coding',
          model: 'kimi-for-coding',
          platform: 'darwin',
          arch: 'arm64'
        },
        capabilities: { recognized: true, fingerprint: CAPABILITY_SHA },
        liveTests: {
          status: 'passed',
          testPaths: SUITES,
          counts: { total: 16, passed: 16, failed: 0, skipped: 0 },
          reports: [
            {
              testPath: SUITES[0],
              status: 'passed',
              counts: { total: 16, passed: 16, failed: 0, skipped: 0 },
              errors: []
            }
          ]
        }
      }
    ],
    summary: { status: 'passed', exitCode: 0 },
    ...overrides
  }
}

describe('provider canary aggregate verifier', () => {
  it('accepts a strict live Kimi report with a recognized tuple and passed live tests', () => {
    expect(validateAggregate(passingReport())).toEqual({ valid: true, errors: [] })
  })

  it('rejects optional provider records outside the exact requested release scope', () => {
    const report = passingReport({
      providers: [...(passingReport().providers as unknown[]), { provider: 'cursor' }]
    })
    expect(validateAggregate(report).valid).toBe(false)
    expect(validateAggregate(report).errors).toContain(
      'providers must contain only the required Kimi result'
    )
  })

  it('rejects a same-length substitution in the reviewed assertion roster', () => {
    const report = passingReport()
    const roster = report.reviewedAssertionRoster as Record<string, string[]>
    report.reviewedAssertionRoster = {
      ...roster,
      [SUITES[0]]: [...roster[SUITES[0]].slice(0, -1), 'weaker substituted assertion']
    }
    const result = validateAggregate(report)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(`reviewed assertion roster is incomplete for ${SUITES[0]}`)
  })

  it.each([
    'scope',
    'postureVersion',
    'attestationSource',
    'version',
    'binarySha256',
    'distribution',
    'capabilityFingerprint',
    'harnessNodeVersion',
    'authentication',
    'backendBaseUrl',
    'modelAlias',
    'model',
    'platform',
    'arch'
  ])('rejects a qualification tuple mismatch for %s', (field) => {
    const report = passingReport()
    const provider = (report.providers as Array<Record<string, unknown>>)[0]
    provider.qualification = {
      ...(provider.qualification as Record<string, unknown>),
      [field]: 'mismatched'
    }
    const result = validateAggregate(report)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(`Kimi qualification.${field} must match reported evidence`)
  })

  it.each([
    ['probe-only mode', { mode: 'probe-only' }, "mode must be exactly 'live'"],
    [
      'nonstrict fingerprints',
      { requireKnownFingerprints: false },
      'requireKnownFingerprints must be exactly true'
    ],
    [
      'missing required Kimi',
      { requiredProviders: [] },
      "requiredProviders must be exactly ['kimi']"
    ],
    [
      'an extra required provider',
      { requiredProviders: ['kimi', 'cursor'] },
      "requiredProviders must be exactly ['kimi']"
    ],
    [
      'an unrecognized Kimi tuple',
      {
        providers: [
          {
            provider: 'kimi',
            capabilities: { recognized: false },
            liveTests: { status: 'passed' }
          }
        ]
      },
      'Kimi capabilities.recognized must be exactly true'
    ],
    [
      'a non-passing Kimi live suite',
      {
        providers: [
          {
            provider: 'kimi',
            capabilities: { recognized: true },
            liveTests: { status: 'passed_unrecognized' }
          }
        ]
      },
      "Kimi liveTests.status must be exactly 'passed'"
    ],
    [
      'an unattested aggregate pass',
      { summary: { status: 'unattested_pass' } },
      "summary.status must be exactly 'passed'"
    ]
  ])('rejects %s', (_label, overrides, expectedError) => {
    const result = validateAggregate(passingReport(overrides))
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(expectedError)
  })

  it.each([
    ['a non-object report', null, 'report must be a JSON object'],
    ['a malformed required-provider list', { requiredProviders: 'kimi' }, 'requiredProviders'],
    ['a malformed provider list', { providers: {} }, 'providers must be an array'],
    ['a malformed provider record', { providers: [null] }, 'providers[0] must be an object'],
    [
      'duplicate Kimi results',
      {
        providers: [
          {
            provider: 'kimi',
            capabilities: { recognized: true },
            liveTests: { status: 'passed' }
          },
          {
            provider: 'kimi',
            capabilities: { recognized: true },
            liveTests: { status: 'passed' }
          }
        ]
      },
      "providers contains duplicate provider 'kimi'"
    ],
    [
      'a missing Kimi capability object',
      {
        providers: [{ provider: 'kimi', liveTests: { status: 'passed' } }]
      },
      'Kimi capabilities must be an object'
    ],
    [
      'a missing Kimi live-test object',
      {
        providers: [{ provider: 'kimi', capabilities: { recognized: true } }]
      },
      'Kimi liveTests must be an object'
    ],
    ['a malformed summary', { summary: null }, 'summary must be an object']
  ])('rejects malformed input: %s', (_label, override, expectedError) => {
    const report = override === null ? null : passingReport(override as Record<string, unknown>)
    const result = validateAggregate(report)
    expect(result.valid).toBe(false)
    expect(result.errors.some((error) => error.includes(expectedError))).toBe(true)
  })

  it('parses one required report path and rejects ambiguous CLI input', () => {
    expect(parseArgs(['--input=artifacts/report.json', `--sha=${SHA}`])).toEqual({
      input: 'artifacts/report.json',
      sha: SHA
    })
    expect(parseArgs(['--input', 'artifacts/report.json', '--sha', SHA])).toEqual({
      input: 'artifacts/report.json',
      sha: SHA
    })
    expect(() => parseArgs([])).toThrow('--input is required')
    expect(() => parseArgs(['--input', 'report.json'])).toThrow('--sha is required')
    expect(() => parseArgs(['--input'])).toThrow('--input requires a value')
    expect(() => parseArgs(['report.json'])).toThrow('Unknown option')
    expect(() => parseArgs(['--input=a.json', '--input=b.json', `--sha=${SHA}`])).toThrow(
      'only once'
    )
    expect(() => parseArgs(['--input=a.json', '--sha=short'])).toThrow('40-character')
  })
})
