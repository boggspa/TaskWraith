#!/usr/bin/env node

/**
 * validate-release.cjs — Phase G1 release-readiness gate.
 *
 * Runs the broad local pre-release check pipeline and reports a structured
 * summary. It intentionally stays below the full artifact-publication gate:
 * platform-specific packaging validation only, while notarized and signed
 * publication still runs through dedicated release scripts.
 *
 * This wrapper expands the usual local typecheck / security / test / smoke
 * loop with:
 *   - Step-by-step progress (so it's obvious where it stalls).
 *   - Optional notarization preflight (skipped unless
 *     TASKWRAITH_VALIDATE_NOTARIZE=1).
 *   - A final pass/fail summary table the user can paste into a
 *     release checklist.
 *
 * Invocation:
 *
 *   node scripts/validate-release.cjs
 *
 *   # Skip platform package validation (much faster — useful for iterating
 *   # on the validation script itself):
 *   TASKWRAITH_VALIDATE_SKIP_BUILD=1 node scripts/validate-release.cjs
 *
 *   # Include the notarization preflight (requires CSC_NAME +
 *   # APPLE_KEYCHAIN_PROFILE to be set):
 *   TASKWRAITH_VALIDATE_NOTARIZE=1 node scripts/validate-release.cjs
 *
 * Exit codes:
 *   0  — all required steps passed
 *   2  — required env / tooling missing
 *   3  — one or more steps failed (summary lists which)
 */

const { spawnSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')
const { validateCodeSigningIdentityOutput } = require('./macos-codesign-preflight.cjs')
const { resolvePlatformCommandInvocation } = require('./windows-cmd-invocation.cjs')

const REPO_ROOT = join(__dirname, '..')
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const SKIP_BUILD = process.env.TASKWRAITH_VALIDATE_SKIP_BUILD === '1'
const DO_NOTARIZE = process.env.TASKWRAITH_VALIDATE_NOTARIZE === '1'

const steps = []

function step(name, opts = {}) {
  steps.push({ name, ...opts })
}

function npmStep(name, scriptName = name, opts = {}) {
  step(name, {
    cmd: NPM_COMMAND,
    args: ['run', scriptName],
    required: true,
    ...opts
  })
}

npmStep('kimi-runtime-qualification-projection', 'verify:kimi-runtime-qualifications')
npmStep('cursor-runtime-qualification-projection', 'verify:cursor-runtime-qualifications')
npmStep('tui-runtime-policy', 'verify:tui-runtime-policy')
npmStep('security:deps')
npmStep('lint:errors')
npmStep('guard:platform-path-literals')
npmStep('typecheck')
npmStep('guard:architecture')
npmStep('guard:provider-intent')
npmStep('guard:doctrine-integrity')
npmStep('guard:ios-plist')
npmStep('format:ratchet')
npmStep('test')
npmStep('test:precommit-hook')
npmStep('test:swift:bridge', 'test:swift:bridge', {
  skipOn: process.platform !== 'darwin'
})
npmStep('test:swift:ios-kit', 'test:swift:ios-kit', {
  skipOn: process.platform !== 'darwin'
})
npmStep('lint', 'lint', {
  // Lint failures are advisory for now — pre-existing warnings
  // outnumber actionable errors and the gate is too noisy.
  required: false
})
npmStep('smoke:node-pty')
if (!SKIP_BUILD) {
  npmStep('clean:dist')
  npmStep('build:unpack', 'build:unpack', {
    skipOn: process.platform !== 'darwin'
  })
  npmStep('build:win:nopublish', 'build:win:nopublish', {
    skipOn: process.platform !== 'win32'
  })
  npmStep('build:linux:nopublish', 'build:linux:nopublish', {
    skipOn: process.platform !== 'linux'
  })
}
if (DO_NOTARIZE) {
  step('notarize:preflight', {
    cmd: '/usr/bin/security',
    args: ['find-identity', '-v', '-p', 'codesigning'],
    required: true,
    requiredEnv: ['CSC_NAME', 'APPLE_KEYCHAIN_PROFILE'],
    validateOutput: (output) => validateCodeSigningIdentityOutput(output, process.env.CSC_NAME),
    skipOn: process.platform !== 'darwin'
  })
}

// Secret-leak / #1-invariant guard. The import-boundary check always runs; the
// bundle scan runs against out/main + any packaged app.asar produced above.
npmStep('guard:no-bundled-secrets')

const results = []

console.log(`[validate-release] starting (${steps.length} steps)`)
console.log(
  `[validate-release] platform=${process.platform} skipBuild=${SKIP_BUILD} notarize=${DO_NOTARIZE}\n`
)

for (const stepSpec of steps) {
  if (stepSpec.skipOn) {
    results.push({ name: stepSpec.name, status: 'skipped', reason: 'platform not applicable' })
    console.log(`  ⊘ ${stepSpec.name} (skipped — platform)`)
    continue
  }
  const missingEnv = (stepSpec.requiredEnv || []).filter(
    (name) => !String(process.env[name] || '').trim()
  )
  if (missingEnv.length > 0) {
    const status = stepSpec.required ? 'missing-requirement' : 'missing-requirement-advisory'
    const reason = `missing environment: ${missingEnv.join(', ')}`
    results.push({ name: stepSpec.name, status, reason })
    console.log(`  ✗ ${stepSpec.name} (${reason})`)
    continue
  }
  process.stdout.write(`  ▶ ${stepSpec.name} … `)
  const startedAt = Date.now()
  const invocation = resolvePlatformCommandInvocation(
    stepSpec.cmd,
    stepSpec.args,
    process.platform,
    process.env
  )
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...stepSpec.env },
    ...invocation.spawnOptions
  })
  const durationMs = Date.now() - startedAt
  if (result.error?.code === 'ENOENT') {
    const status = stepSpec.required ? 'missing-requirement' : 'missing-requirement-advisory'
    const reason = `required tool not found: ${invocation.command}`
    console.log(`✗ (${formatDuration(durationMs)}; ${reason})`)
    results.push({ name: stepSpec.name, status, durationMs, reason })
    continue
  }
  const output = `${(result.stdout || Buffer.alloc(0)).toString('utf8')}\n${(
    result.stderr || Buffer.alloc(0)
  ).toString('utf8')}`
  let validationError = null
  if (result.status === 0 && stepSpec.validateOutput) {
    try {
      validationError = stepSpec.validateOutput(output)
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error)
    }
  }
  const ok = result.status === 0 && !validationError
  if (ok) {
    console.log(`✓ (${formatDuration(durationMs)})`)
    results.push({ name: stepSpec.name, status: 'passed', durationMs })
  } else {
    console.log(`✗ (${formatDuration(durationMs)})`)
    const tail = [output.trim(), validationError]
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .slice(-20)
      .join('\n')
    console.log(`    ${tail.replace(/\n/g, '\n    ')}`)
    results.push({
      name: stepSpec.name,
      status: stepSpec.required ? 'failed' : 'failed-advisory',
      durationMs,
      tail
    })
  }
}

console.log('\n── Summary ──')
const padName = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  const icon =
    r.status === 'passed'
      ? '✓'
      : r.status === 'skipped'
        ? '⊘'
        : r.status === 'failed-advisory' || r.status === 'missing-requirement-advisory'
          ? '~'
          : '✗'
  const duration = r.durationMs ? `(${formatDuration(r.durationMs)})` : ''
  const reason = r.reason ? ` — ${r.reason}` : ''
  console.log(
    `  ${icon} ${r.name.padEnd(padName)}  ${r.status}${duration ? ' ' + duration : ''}${reason}`
  )
}

const hardFailures = results.filter((r) => r.status === 'failed')
const missingRequirements = results.filter((r) => r.status === 'missing-requirement')
if (missingRequirements.length > 0) {
  console.error(
    `\n[validate-release] ${missingRequirements.length} required environment/tooling prerequisite(s) missing.`
  )
  process.exit(2)
}
if (hardFailures.length > 0) {
  console.error(`\n[validate-release] ${hardFailures.length} required step(s) failed.`)
  process.exit(3)
}
const advisoryFailures = results.filter(
  (r) => r.status === 'failed-advisory' || r.status === 'missing-requirement-advisory'
)
if (advisoryFailures.length > 0) {
  console.warn(
    `\n[validate-release] All required steps passed. ${advisoryFailures.length} advisory step(s) failed (lint, etc.) — review before release but not blocking.`
  )
} else {
  console.log('\n[validate-release] all steps passed.')
}

const buildArtifactExists = existsSync(join(REPO_ROOT, 'dist'))
const buildCompleted = !SKIP_BUILD && hardFailures.length === 0
if (buildCompleted && process.platform === 'darwin' && buildArtifactExists) {
  console.log('[validate-release] build artifacts present in dist/. Next step:')
  console.log(
    '  CSC_NAME=$CSC_NAME APPLE_KEYCHAIN_PROFILE=$APPLE_KEYCHAIN_PROFILE npm run build:mac:notarized'
  )
} else if (buildCompleted && process.platform === 'win32' && buildArtifactExists) {
  console.log('[validate-release] build artifacts present in dist/. Next step:')
  console.log('  CSC_LINK=$CSC_LINK CSC_KEY_PASSWORD=$CSC_KEY_PASSWORD npm run build:win:signed')
}

process.exit(0)

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`
}
