#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_PROVIDERS = Object.freeze(['kimi'])
const EXPECTED_SUITES = Object.freeze([
  Object.freeze({
    path: 'src/main/kimi/KimiProductionContainment.live.test.ts',
    assertions: Object.freeze([
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
  })
])
const EXPECTED_BINARY_SHA256 =
  'sha256:550bca0ba6e474f4e0faeadfae03a9294c7c25688670f38ff488ab8cf176d817'
const EXPECTED_POSTURE_VERSION = 'synthetic-cwd-gateway-v1'
const EXPECTED_ATTESTATION_SOURCE = 'credentialed-live-containment-canary'
const EXPECTED_RUNTIME_CONTRACT = Object.freeze({
  distribution: 'official-native-single-binary',
  harnessNodeVersion: 'v22.19.0',
  authentication: 'kimi-code-provider-api-key',
  providerType: 'kimi',
  backendBaseUrl: 'https://api.kimi.com/coding/v1',
  modelAlias: 'kimi-code/kimi-for-coding',
  model: 'kimi-for-coding'
})

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  )
}

function exactPassedCounts(value, expectedTotal) {
  return (
    isRecord(value) &&
    value.total === expectedTotal &&
    value.passed === expectedTotal &&
    value.failed === 0 &&
    value.skipped === 0
  )
}

function validateProviderCanaryAggregate(report, expectedSha) {
  const errors = []

  if (!isRecord(report)) {
    return { valid: false, errors: ['report must be a JSON object'] }
  }

  if (report.schemaVersion !== 2) errors.push('schemaVersion must be exactly 2')
  if (report.reportKind !== 'provider-permission-conformance') {
    errors.push("reportKind must be exactly 'provider-permission-conformance'")
  }

  if (report.mode !== 'live') {
    errors.push("mode must be exactly 'live'")
  }
  if (report.requireKnownFingerprints !== true) {
    errors.push('requireKnownFingerprints must be exactly true')
  }
  if (report.fingerprintEnforcementScope !== 'release-evidence-only') {
    errors.push("fingerprintEnforcementScope must be exactly 'release-evidence-only'")
  }
  if (!exactStringArray(report.requestedProviders, REQUIRED_PROVIDERS)) {
    errors.push("requestedProviders must be exactly ['kimi']")
  }

  if (!Array.isArray(report.requiredProviders)) {
    errors.push('requiredProviders must be an array')
  } else if (
    report.requiredProviders.length !== REQUIRED_PROVIDERS.length ||
    report.requiredProviders.some((provider, index) => provider !== REQUIRED_PROVIDERS[index])
  ) {
    errors.push("requiredProviders must be exactly ['kimi']")
  }

  let kimi = null
  if (!Array.isArray(report.providers)) {
    errors.push('providers must be an array')
  } else {
    const providerNames = new Set()
    let kimiCount = 0
    for (const [index, provider] of report.providers.entries()) {
      if (!isRecord(provider)) {
        errors.push(`providers[${index}] must be an object`)
        continue
      }
      if (typeof provider.provider !== 'string' || provider.provider.length === 0) {
        errors.push(`providers[${index}].provider must be a non-empty string`)
        continue
      }
      if (providerNames.has(provider.provider)) {
        errors.push(`providers contains duplicate provider '${provider.provider}'`)
      }
      providerNames.add(provider.provider)
      if (provider.provider === 'kimi') {
        kimi = provider
        kimiCount += 1
      }
    }
    if (kimiCount !== 1) {
      errors.push('providers must contain exactly one Kimi result')
      kimi = null
    }
    if (report.providers.length !== 1) {
      errors.push('providers must contain only the required Kimi result')
    }
  }

  if (kimi) {
    if (kimi.runtimeAvailable !== true) errors.push('Kimi runtimeAvailable must be exactly true')
    if (kimi.reviewedSuiteAvailable !== true) {
      errors.push('Kimi reviewedSuiteAvailable must be exactly true')
    }
    if (kimi.qualificationScope !== 'acp-synthetic-cwd-gateway-v1') {
      errors.push("Kimi qualificationScope must be exactly 'acp-synthetic-cwd-gateway-v1'")
    }
    if (!isRecord(kimi.binary)) {
      errors.push('Kimi binary must be an object')
    } else {
      if (kimi.binary.version !== '0.27.0') errors.push('Kimi binary.version must be 0.27.0')
      if (kimi.binary.sha256 !== EXPECTED_BINARY_SHA256) {
        errors.push('Kimi binary.sha256 must match the reviewed native release asset')
      }
      if (kimi.binary.distribution !== EXPECTED_RUNTIME_CONTRACT.distribution) {
        errors.push('Kimi binary.distribution must match the official native distribution')
      }
    }
    if (!isRecord(kimi.runtimeContract)) {
      errors.push('Kimi runtimeContract must be an object')
    } else {
      for (const [key, expected] of Object.entries(EXPECTED_RUNTIME_CONTRACT)) {
        if (kimi.runtimeContract[key] !== expected) {
          errors.push(`Kimi runtimeContract.${key} must match the reviewed contract`)
        }
      }
    }
    if (
      !isRecord(kimi.auth) ||
      kimi.auth.available !== true ||
      kimi.auth.method !== 'provider-api-key-config' ||
      kimi.auth.configApiKeyPresent !== true
    ) {
      errors.push('Kimi auth must be the reviewed provider API-key config')
    }
    if (!isRecord(kimi.capabilities)) {
      errors.push('Kimi capabilities must be an object')
    } else if (kimi.capabilities.recognized !== true) {
      errors.push('Kimi capabilities.recognized must be exactly true')
    }
    if (!isRecord(kimi.liveTests)) {
      errors.push('Kimi liveTests must be an object')
    } else {
      if (kimi.liveTests.status !== 'passed') {
        errors.push("Kimi liveTests.status must be exactly 'passed'")
      }
      const expectedPaths = EXPECTED_SUITES.map((suite) => suite.path)
      if (!exactStringArray(kimi.liveTests.testPaths, expectedPaths)) {
        errors.push('Kimi liveTests.testPaths must match the complete reviewed suite')
      }
      if (!exactPassedCounts(kimi.liveTests.counts, 16)) {
        errors.push('Kimi liveTests.counts must be exactly 16 passed assertions')
      }
      if (!Array.isArray(kimi.liveTests.reports) || kimi.liveTests.reports.length !== 1) {
        errors.push('Kimi liveTests.reports must contain exactly one suite report')
      } else {
        for (const [index, expected] of EXPECTED_SUITES.entries()) {
          const suite = kimi.liveTests.reports[index]
          if (!isRecord(suite) || suite.testPath !== expected.path || suite.status !== 'passed') {
            errors.push(`Kimi live suite report ${index} must be the expected passed suite`)
            continue
          }
          if (!exactPassedCounts(suite.counts, expected.assertions.length)) {
            errors.push(
              `Kimi live suite report ${index} must have ${expected.assertions.length} passed assertions`
            )
          }
          if (!Array.isArray(suite.errors) || suite.errors.length !== 0) {
            errors.push(`Kimi live suite report ${index} must have no errors`)
          }
        }
      }
    }
    if (!isRecord(kimi.qualification)) {
      errors.push('Kimi qualification must be an object')
    } else {
      const bindings = {
        scope: kimi.qualificationScope,
        postureVersion: EXPECTED_POSTURE_VERSION,
        attestationSource: EXPECTED_ATTESTATION_SOURCE,
        version: kimi.binary?.version,
        binarySha256: kimi.binary?.sha256,
        distribution: kimi.binary?.distribution,
        capabilityFingerprint: kimi.capabilities?.fingerprint,
        harnessNodeVersion: report.environment?.node,
        authentication: kimi.runtimeContract?.authentication,
        backendBaseUrl: kimi.runtimeContract?.backendBaseUrl,
        modelAlias: kimi.runtimeContract?.modelAlias,
        model: kimi.runtimeContract?.model,
        platform: report.environment?.platform,
        arch: report.environment?.arch
      }
      for (const [key, expected] of Object.entries(bindings)) {
        if (kimi.qualification[key] !== expected) {
          errors.push(`Kimi qualification.${key} must match reported evidence`)
        }
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(String(kimi.capabilities?.fingerprint || ''))) {
        errors.push('Kimi capability fingerprint must be a SHA-256 value')
      }
    }
  }

  const expectedPaths = EXPECTED_SUITES.map((suite) => suite.path)
  if (
    !isRecord(report.reviewedSuiteAllowlist) ||
    !exactStringArray(report.reviewedSuiteAllowlist.kimi, expectedPaths)
  ) {
    errors.push('reviewedSuiteAllowlist.kimi must match the complete reviewed suite')
  }
  if (!isRecord(report.reviewedAssertionRoster)) {
    errors.push('reviewedAssertionRoster must be an object')
  } else {
    for (const suite of EXPECTED_SUITES) {
      const roster = report.reviewedAssertionRoster[suite.path]
      if (!exactStringArray(roster, suite.assertions)) {
        errors.push(`reviewed assertion roster is incomplete for ${suite.path}`)
      }
    }
  }

  if (!isRecord(report.environment)) {
    errors.push('environment must be an object')
  } else {
    if (report.environment.gitCommit !== expectedSha) {
      errors.push('environment.gitCommit must match the expected release SHA')
    }
    if (report.environment.platform !== 'darwin' || report.environment.arch !== 'arm64') {
      errors.push('environment must be the reviewed hosted darwin-arm64 lane')
    }
    if (report.environment.node !== EXPECTED_RUNTIME_CONTRACT.harnessNodeVersion) {
      errors.push('environment.node must match the reviewed harness version')
    }
  }

  if (!isRecord(report.summary)) {
    errors.push('summary must be an object')
  } else {
    if (report.summary.status !== 'passed') errors.push("summary.status must be exactly 'passed'")
    if (report.summary.exitCode !== 0) errors.push('summary.exitCode must be exactly 0')
  }

  return { valid: errors.length === 0, errors }
}

function parseArgs(argv) {
  let input = null
  let sha = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const inputMatch = arg.match(/^--input(?:=(.*))?$/)
    const shaMatch = arg.match(/^--sha(?:=(.*))?$/)
    if (!inputMatch && !shaMatch) throw new Error(`Unknown option: ${arg}`)
    const match = inputMatch || shaMatch
    const flag = inputMatch ? '--input' : '--sha'
    const value = match[1] ?? argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`)
    if (inputMatch) {
      if (input !== null) throw new Error('--input may be specified only once.')
      input = value
    } else {
      if (sha !== null) throw new Error('--sha may be specified only once.')
      sha = value.toLowerCase()
    }
  }
  if (!input) throw new Error('--input is required.')
  if (!sha) throw new Error('--sha is required.')
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha must be a full 40-character Git SHA.')
  return { input, sha }
}

function main(argv = process.argv.slice(2)) {
  const { input, sha } = parseArgs(argv)
  const inputPath = path.resolve(input)
  const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const result = validateProviderCanaryAggregate(report, sha)
  if (!result.valid) {
    process.stderr.write(
      `[provider-canary-aggregate] rejected ${path.basename(inputPath)}: ${result.errors.join('; ')}\n`
    )
    return 1
  }
  process.stdout.write(`[provider-canary-aggregate] accepted ${path.basename(inputPath)}\n`)
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`[provider-canary-aggregate] ${error.message}\n`)
    process.exitCode = 2
  }
}

module.exports = {
  main,
  parseArgs,
  validateProviderCanaryAggregate
}
