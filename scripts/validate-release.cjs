#!/usr/bin/env node

/**
 * validate-release.cjs — Phase G1 release-readiness gate.
 *
 * Runs the broad local pre-release check pipeline and reports a structured
 * summary. It intentionally stays below the full artifact-publication gate:
 * credentialed notarized builds, update-feed validation, SBOM generation, and
 * final platform signing still run through the dedicated release scripts.
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
 *   # Skip the build-unpack step (much faster — useful for iterating
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

const REPO_ROOT = join(__dirname, '..')

const SKIP_BUILD = process.env.TASKWRAITH_VALIDATE_SKIP_BUILD === '1'
const DO_NOTARIZE = process.env.TASKWRAITH_VALIDATE_NOTARIZE === '1'

const steps = []

function step(name, opts = {}) {
  steps.push({ name, ...opts })
}

step('typecheck:node', {
  cmd: 'npm',
  args: ['run', 'typecheck:node'],
  required: true
})
step('security:deps', {
  cmd: 'npm',
  args: ['run', 'security:deps'],
  required: true
})
step('lint:errors', {
  cmd: 'npm',
  args: ['run', 'lint:errors'],
  required: true
})
step('typecheck:web', {
  cmd: 'npm',
  args: ['run', 'typecheck:web'],
  required: true
})
step('test', {
  cmd: 'npm',
  args: ['run', 'test'],
  required: true
})
step('test:swift:bridge', {
  cmd: 'npm',
  args: ['run', 'test:swift:bridge'],
  required: true,
  skipOn: process.platform !== 'darwin'
})
step('lint', {
  cmd: 'npm',
  args: ['run', 'lint'],
  // Lint failures are advisory for now — pre-existing warnings
  // outnumber actionable errors and the gate is too noisy.
  required: false
})
step('smoke:node-pty', {
  cmd: 'npm',
  args: ['run', 'smoke:node-pty'],
  required: true
})
if (!SKIP_BUILD) {
  step('prebuild:bridge-daemon', {
    cmd: 'npm',
    args: ['run', 'prebuild:bridge-daemon'],
    required: true,
    skipOn: process.platform !== 'darwin'
  })
  step('build', {
    cmd: 'npm',
    args: ['run', 'build'],
    required: true
  })
  step('build-unpack', {
    cmd: 'npx',
    args: ['electron-builder', '--dir'],
    required: true,
    skipOn: process.platform !== 'darwin'
  })
  step('build-win-unpack', {
    cmd: 'npm',
    args: ['run', 'build:win:unpack'],
    required: true,
    skipOn: process.platform !== 'win32'
  })
  step('smoke:package', {
    cmd: 'node',
    args: ['scripts/smoke-packaged-electron.cjs', 'dist'],
    required: true,
    skipOn: process.platform !== 'darwin' && process.platform !== 'win32'
  })
}
if (DO_NOTARIZE) {
  step('notarize:preflight', {
    cmd: 'sh',
    args: [
      '-c',
      'security find-identity -v -p codesigning | head -5 && [ -n "$CSC_NAME" ] && [ -n "$APPLE_KEYCHAIN_PROFILE" ]'
    ],
    required: true,
    skipOn: process.platform !== 'darwin'
  })
}

// Secret-leak / #1-invariant guard. The import-boundary check always runs; the
// bundle scan runs against out/main + any packaged app.asar produced above.
step('guard:no-bundled-secrets', {
  cmd: 'npm',
  args: ['run', 'guard:no-bundled-secrets'],
  required: true
})

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
  process.stdout.write(`  ▶ ${stepSpec.name} … `)
  const startedAt = Date.now()
  const result = spawnSync(stepSpec.cmd, stepSpec.args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })
  const durationMs = Date.now() - startedAt
  const ok = result.status === 0
  if (ok) {
    console.log(`✓ (${formatDuration(durationMs)})`)
    results.push({ name: stepSpec.name, status: 'passed', durationMs })
  } else {
    console.log(`✗ (${formatDuration(durationMs)})`)
    const stdout = (result.stdout || Buffer.alloc(0)).toString('utf-8')
    const stderr = (result.stderr || Buffer.alloc(0)).toString('utf-8')
    const tail = (stdout + '\n' + stderr).trim().split('\n').slice(-20).join('\n')
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
        : r.status === 'failed-advisory'
          ? '~'
          : '✗'
  const duration = r.durationMs ? `(${formatDuration(r.durationMs)})` : ''
  const reason = r.reason ? ` — ${r.reason}` : ''
  console.log(
    `  ${icon} ${r.name.padEnd(padName)}  ${r.status}${duration ? ' ' + duration : ''}${reason}`
  )
}

const hardFailures = results.filter((r) => r.status === 'failed')
if (hardFailures.length > 0) {
  console.error(`\n[validate-release] ${hardFailures.length} required step(s) failed.`)
  process.exit(3)
}
const advisoryFailures = results.filter((r) => r.status === 'failed-advisory')
if (advisoryFailures.length > 0) {
  console.warn(
    `\n[validate-release] All required steps passed. ${advisoryFailures.length} advisory step(s) failed (lint, etc.) — review before release but not blocking.`
  )
} else {
  console.log('\n[validate-release] all steps passed.')
}

const buildArtifactExists = existsSync(join(REPO_ROOT, 'dist'))
if (!SKIP_BUILD && process.platform === 'darwin' && buildArtifactExists) {
  console.log('[validate-release] build artifacts present in dist/. Next step:')
  console.log(
    `  CSC_NAME=$CSC_NAME APPLE_KEYCHAIN_PROFILE=$APPLE_KEYCHAIN_PROFILE npm run build:mac:notarized`
  )
} else if (!SKIP_BUILD && process.platform === 'win32' && buildArtifactExists) {
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
