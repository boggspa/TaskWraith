#!/usr/bin/env node
/**
 * App Drive interference harness CLI (candidate only).
 *
 * Default: dry-run / observe-only over offline catalog or injected JSON.
 * Never posts global CGEvents, warps the cursor, writes clipboard, activates
 * apps, or silently falls back to foreground control.
 *
 * Live CGEventPostToPid is intentionally not implemented. Even with
 * --allow-live-post + APPDRIVE_BG_ALLOW_POST=1 + --fixture-pid, this CLI
 * records a refusal rather than calling native APIs.
 *
 * Usage:
 *   node scripts/appdrive-interference/run-interference-harness.cjs
 *   node scripts/appdrive-interference/run-interference-harness.cjs --json
 *   node scripts/appdrive-interference/run-interference-harness.cjs --out path.json
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_DIMENSIONS = [
  'focus',
  'frontmostApp',
  'hostCursor',
  'keyboardTarget',
  'clipboardHash',
  'activation',
  'targetSuccess',
  'targetScopedHumanArbitration'
]

const FORBIDDEN = new Set([
  'global_cgevent_post',
  'cursor_warp',
  'clipboard_write',
  'activate_or_raise',
  'permission_prompt',
  'silent_foreground_fallback'
])

function parseArgs(argv) {
  const out = {
    json: false,
    outPath: null,
    catalogPath: null,
    allowLivePost: false,
    fixturePid: null,
    mode: 'dry_run',
    observeOnly: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--observe-only') {
      out.observeOnly = true
      out.mode = 'observe_only'
    } else if (a === '--allow-live-post') out.allowLivePost = true
    else if (a === '--out') out.outPath = argv[++i]
    else if (a === '--catalog') out.catalogPath = argv[++i]
    else if (a === '--fixture-pid') out.fixturePid = Number(argv[++i])
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--mode') out.mode = argv[++i]
  }
  return out
}

function defaultCatalog() {
  const p = path.join(
    __dirname,
    '..',
    '..',
    'prototypes',
    'appdrive-background',
    'fixtures',
    'sample-apps.json'
  )
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  return {
    schemaVersion: 1,
    apps: [
      {
        appId: 'com.taskwraith.harness.AppDriveFixture',
        appLabel: 'AppDrive Interference Fixture'
      }
    ]
  }
}

function evaluatePolicy({ mode, fixturePid, allowLivePost, envAllowPost, operation }) {
  if (FORBIDDEN.has(operation)) {
    return {
      allow: false,
      refused: operation,
      reason: `Forbidden operation "${operation}"`
    }
  }
  if (operation === 'global_cgevent_post' || operation === 'cgevent_post') {
    return {
      allow: false,
      refused: 'global_cgevent_post',
      reason: 'Global CGEventPost is forbidden'
    }
  }
  if (mode === 'observe_only') {
    return { allow: true, actuation: 'observe_only', dryRun: true }
  }
  if (mode === 'dry_run') {
    return { allow: true, actuation: 'dry_run_cgevent_post_to_pid', dryRun: true }
  }
  if (!allowLivePost) {
    return {
      allow: false,
      refused: 'missing_explicit_user_invocation',
      reason: 'Live post requires --allow-live-post'
    }
  }
  if (!envAllowPost) {
    return {
      allow: false,
      refused: 'missing_env_allow_post',
      reason: 'Live post requires APPDRIVE_BG_ALLOW_POST=1'
    }
  }
  if (fixturePid == null || !(fixturePid > 0)) {
    return {
      allow: false,
      refused: 'missing_fixture_pid',
      reason: 'Live post requires --fixture-pid <harness-owned-pid>'
    }
  }
  return { allow: true, actuation: 'cgevent_post_to_pid', dryRun: false }
}

function baseSnapshot(now, targetPid) {
  return {
    capturedAtMs: now,
    frontmostAppId: 'com.apple.Terminal',
    focusedWindowId: 'win-terminal-1',
    keyboardTargetPid: 4242,
    hostCursor: { x: 100, y: 200 },
    clipboardHash: 'sha256:dryrun-clipboard-placeholder',
    targetIsActive: false,
    targetPid,
    humanInputScope: 'global_hid',
    humanInputRecentOnTarget: null,
    humanInputRecentElsewhere: null
  }
}

function dim(dimension, verdict, before, after, detail) {
  return { dimension, verdict, before, after, detail }
}

function diffSnapshots(before, after, { dryRun, targetActionSucceeded }) {
  const dims = []
  const sameOr = (a, b, name, passDetail, failDetail) => {
    if (a == null || b == null) {
      dims.push(dim(name, dryRun ? 'not_measured' : 'unknown', a, b, `${name} unavailable`))
    } else if (a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b))) {
      dims.push(dim(name, dryRun ? 'not_measured' : 'pass', a, b, passDetail))
    } else {
      dims.push(dim(name, 'fail', a, b, failDetail))
    }
  }

  sameOr(
    before.focusedWindowId,
    after.focusedWindowId,
    'focus',
    'Focused window unchanged.',
    'Focus theft.'
  )
  sameOr(
    before.frontmostAppId,
    after.frontmostAppId,
    'frontmostApp',
    'Frontmost app unchanged.',
    'Frontmost theft.'
  )
  sameOr(
    before.hostCursor,
    after.hostCursor,
    'hostCursor',
    'Host cursor unchanged.',
    'Host cursor moved.'
  )
  sameOr(
    before.keyboardTargetPid,
    after.keyboardTargetPid,
    'keyboardTarget',
    'Keyboard target unchanged.',
    'Keyboard target changed.'
  )
  sameOr(
    before.clipboardHash,
    after.clipboardHash,
    'clipboardHash',
    'Clipboard hash unchanged.',
    'Clipboard changed.'
  )

  if (dryRun) {
    dims.push(
      dim(
        'activation',
        'not_measured',
        before.targetIsActive,
        after.targetIsActive,
        'Dry-run: activation not measured.'
      )
    )
  } else if (!before.targetIsActive && after.targetIsActive) {
    dims.push(
      dim('activation', 'fail', before.targetIsActive, after.targetIsActive, 'Activation theft.')
    )
  } else {
    dims.push(
      dim('activation', 'pass', before.targetIsActive, after.targetIsActive, 'No activation theft.')
    )
  }

  if (targetActionSucceeded == null) {
    dims.push(
      dim(
        'targetSuccess',
        dryRun ? 'not_measured' : 'unknown',
        null,
        targetActionSucceeded,
        dryRun ? 'Dry-run does not deliver events.' : 'Target success unknown.'
      )
    )
  } else if (targetActionSucceeded) {
    dims.push(dim('targetSuccess', dryRun ? 'not_measured' : 'pass', null, true, 'Target success.'))
  } else {
    dims.push(dim('targetSuccess', 'fail', null, false, 'Target action failed.'))
  }

  if (after.humanInputScope === 'target_scoped') {
    const ok = after.humanInputRecentOnTarget !== null && after.humanInputRecentElsewhere !== null
    dims.push(
      dim(
        'targetScopedHumanArbitration',
        ok ? (dryRun ? 'not_measured' : 'pass') : 'unknown',
        before.humanInputScope,
        after.humanInputScope,
        ok ? 'Target-scoped arbitration present.' : 'Incomplete target-scoped signals.'
      )
    )
  } else if (after.humanInputScope === 'global_hid') {
    dims.push(
      dim(
        'targetScopedHumanArbitration',
        'fail',
        before.humanInputScope,
        after.humanInputScope,
        'Only global HID idle available — not target-scoped.'
      )
    )
  } else {
    dims.push(
      dim(
        'targetScopedHumanArbitration',
        dryRun ? 'not_measured' : 'unknown',
        before.humanInputScope,
        after.humanInputScope,
        'Target-scoped arbitration unavailable.'
      )
    )
  }

  for (const required of REQUIRED_DIMENSIONS) {
    if (!dims.some((d) => d.dimension === required)) {
      dims.push(dim(required, 'unknown', null, null, 'Missing dimension — fail closed.'))
    }
  }
  return dims
}

function runApp(app, opts, now) {
  const startedAtMs = now()
  const targetPid = opts.fixturePid
  const policy = evaluatePolicy({
    mode: opts.mode,
    fixturePid: targetPid,
    allowLivePost: opts.allowLivePost,
    envAllowPost: process.env.APPDRIVE_BG_ALLOW_POST === '1',
    operation: 'cgevent_post_to_pid'
  })

  const refused = []
  let dryRun = true
  let actuation = 'observe_only'
  let posted = false
  const notes = []

  if (!policy.allow) {
    refused.push({ kind: policy.refused, reason: policy.reason })
    notes.push(policy.reason)
  } else {
    dryRun = policy.dryRun
    actuation = policy.actuation
    if (!policy.dryRun) {
      // Live native post is not implemented in this candidate.
      refused.push({
        kind: 'silent_foreground_fallback',
        reason:
          'Live CGEventPostToPid is not implemented; refusing rather than falling back to foreground AX or global CGEventPost.'
      })
      notes.push('Live post refused: no native implementation in candidate harness.')
      dryRun = false
      posted = false
    } else {
      notes.push(
        policy.actuation === 'observe_only'
          ? 'Observe-only: no event synthesized.'
          : `Dry-run: would CGEventPostToPid(pid=${targetPid ?? 'null'}) — not posted.`
      )
    }
  }

  const before = baseSnapshot(startedAtMs, targetPid)
  const finishedAtMs = now()
  const after = { ...before, capturedAtMs: finishedAtMs }
  const effectiveDryRun = dryRun || opts.mode !== 'live_post'
  const dimensions = diffSnapshots(before, after, {
    dryRun: effectiveDryRun,
    targetActionSucceeded: posted ? true : null
  })

  notes.push('Dry-run/observe-only cannot set nonInterferenceProven=true; live proof required.')
  notes.push(
    'Human arbitration scope is global_hid (production-like); Background Drive target-only pause is not claimable.'
  )

  const nonInterferenceProven = !effectiveDryRun && dimensions.every((d) => d.verdict === 'pass')

  return {
    schemaVersion: 1,
    modeClaimed: 'background',
    productionAuthority: false,
    appId: app.appId,
    appLabel: app.appLabel,
    targetPid: targetPid ?? null,
    fixtureOwned: true,
    actuation: policy.allow ? actuation : 'observe_only',
    dryRun: effectiveDryRun,
    startedAtMs,
    finishedAtMs,
    dimensions,
    nonInterferenceProven,
    refused,
    notes
  }
}

function buildReport(apps, opts) {
  let t = Date.now()
  const now = () => ++t
  const results = apps.map((app) => runApp(app, opts, now))
  let proven = 0
  let failed = 0
  let unknown = 0
  let dryRunOnly = 0
  for (const r of results) {
    if (r.dryRun) dryRunOnly += 1
    if (r.nonInterferenceProven) proven += 1
    if (r.dimensions.some((d) => d.verdict === 'fail')) failed += 1
    else if (r.dimensions.some((d) => d.verdict === 'unknown' || d.verdict === 'not_measured'))
      unknown += 1
  }
  return {
    schemaVersion: 1,
    harness: 'scripts/appdrive-interference',
    prototype: 'prototypes/appdrive-background',
    generatedAtMs: Date.now(),
    defaultDryRun: true,
    results,
    summary: {
      appsMeasured: results.length,
      provenNonInterference: proven,
      failed,
      unknown,
      dryRunOnly
    }
  }
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    const text =
      `App Drive interference harness (candidate, dry-run default)\n\n` +
      `  --json                 print JSON report to stdout\n` +
      `  --out <path>           write JSON report\n` +
      `  --catalog <path>       app catalog JSON\n` +
      `  --observe-only         no event synthesis\n` +
      `  --allow-live-post      explicit user gate (still no native post)\n` +
      `  --fixture-pid <pid>    harness-owned fixture PID for live gate\n` +
      `  APPDRIVE_BG_ALLOW_POST=1  env gate for live mode\n`
    process.stdout.write(text)
    return 0
  }

  if (opts.mode === 'live_post' || opts.allowLivePost) {
    opts.mode = 'live_post'
  } else if (!opts.observeOnly) {
    opts.mode = 'dry_run'
  }

  const catalog = opts.catalogPath
    ? JSON.parse(fs.readFileSync(opts.catalogPath, 'utf8'))
    : defaultCatalog()
  const apps = catalog.apps || []
  const report = buildReport(apps, opts)

  const json = JSON.stringify(report, null, 2)
  if (opts.outPath) {
    fs.mkdirSync(path.dirname(path.resolve(opts.outPath)), { recursive: true })
    fs.writeFileSync(opts.outPath, json + '\n', 'utf8')
  }
  if (opts.json || !opts.outPath) {
    process.stdout.write(json + '\n')
  } else {
    process.stdout.write(
      `Wrote ${opts.outPath} (apps=${report.summary.appsMeasured}, proven=${report.summary.provenNonInterference}, dryRunOnly=${report.summary.dryRunOnly})\n`
    )
  }
  return 0
}

module.exports = {
  parseArgs,
  evaluatePolicy,
  buildReport,
  diffSnapshots,
  REQUIRED_DIMENSIONS,
  main
}

if (require.main === module) {
  process.exitCode = main()
}
