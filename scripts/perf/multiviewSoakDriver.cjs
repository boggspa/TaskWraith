'use strict'

/**
 * Diagnostic multiview soak driver — CURRENT SHARED MASTER, explicitly
 * NON-baseline.
 *
 * Purpose: reproduce the reported multiview/multirepo degradation (renderer
 * slowdown + process-memory growth while V8 heap stays low) against a fresh
 * build of the CURRENT checkout, including a dirty shared tree, with honest
 * captured provenance. This lane NEVER claims `authoritativeBaseline` and its
 * report is `diagnosticOnly: true` unconditionally — the official clean-tree
 * T2 gates in runT2Baseline.cjs are untouched and remain the only baseline
 * path.
 *
 * Safety posture (inherited from the T2 exact-child helpers, all reused):
 *   • builds into a UNIQUE artifact outDir (never the shared out/)
 *   • launches the resolved local Electron binary on that exact built entry
 *   • isolated HOME under <repo>/perf-homes + sibling TaskWraith Dev userData
 *   • attaches CDP/inspector only to the spawned child's owned ports
 *   • terminates only the spawned child process group
 *   • never touches live TaskWraith userData, never kills broad processes
 *   • never auto-deletes artifacts
 *
 * What it drives (all real UI / real IPC):
 *   • selects a real Multiview layout via the rendered layout picker
 *   • assigns a distinct fixture chat to each pane via Thread Home rows
 *   • chats are bound to DISTINCT registered workspaces (scratch git repos)
 *   • streams growing transcripts through window.api.saveChat (real IPC →
 *     chat-updated → pane rendering); provider/EnsembleOrchestrator traffic is
 *     NOT driven and is labeled simulated, matching replayDriver.cjs:362
 *   • samples main process.memoryUsage + app.getAppMetrics (per-PID/type,
 *     Electron reports memory in KILOBYTES — recorded as-is with the unit),
 *     main event-loop drift, renderer CDP Performance metrics (Nodes,
 *     JSHeapUsedSize, layout counts), and an injected rAF frame-gap probe
 *   • appends every sample to soak-timeseries.jsonl (append-only, outside any
 *     bounded in-app ring)
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { collectRepoProvenance, detectAppVersion } = require('./repoProvenance.cjs')
const { resolveUnpackagedDevUserDataPath } = require('./devUserDataPath.cjs')
const {
  resolveT2Home,
  assertFilesystemIsolatedHomeContainment,
  verifyIsolatedHomeAndUserDataViaMainInspector
} = require('./isolatedHome.cjs')
const { assertLaunchPortsFree } = require('./portGuard.cjs')
const {
  buildElectronSpawnPlan,
  spawnExactElectronChild,
  terminateExactChild,
  assertExactChildAttach,
  assertExactChildOwnsDebugPorts
} = require('./electronChildSession.cjs')
const {
  attachRendererCdpSession,
  attachMainInspectorSession,
  discoverMainInspectorUrl
} = require('./cdpWebSocketSession.cjs')
const { createCdpEvaluateAdapter } = require('./replayDriver.cjs')
const { generatePerfFixture, buildReplaySchedule } = require('./fixtureGenerator.cjs')
const { materializePerfUserData } = require('./materializeUserData.cjs')

const DEFAULT_SOAK_DURATION_MS = 30 * 60 * 1000
const DEFAULT_SMOKE_DURATION_MS = 90 * 1000
const DEFAULT_SAMPLE_INTERVAL_MS = 5 * 1000
const DEFAULT_STREAM_TICK_MS = 700
const DEFAULT_STREAM_PADDING_CHARS = 400
const DEFAULT_PANE_COUNT = 4
const DEFAULT_REPO_COUNT = 3
const MAX_SOAK_DURATION_MS = 4 * 60 * 60 * 1000

/** Layouts by pane count — mirrors shared/multiviewLayouts catalogue names. */
const LAYOUT_BY_PANE_COUNT = Object.freeze({
  2: 'vertical-2',
  3: 'vertical-3',
  4: 'quad',
  6: 'six-way',
  8: 'eight-way'
})

const PAGE_SOAK_GLOBAL = '__TASKWRAITH_SOAK__'
const PAGE_FRAMES_GLOBAL = '__TASKWRAITH_SOAK_FRAMES__'
const MAIN_LAG_GLOBAL = '__TASKWRAITH_SOAK_LAG__'
const PAGE_INPUT_GLOBAL = '__TASKWRAITH_SOAK_INPUT__'

function boundedInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** Content fingerprints bracket the shared-source build; this is not a frozen
 * snapshot. Hash source/config inputs as well as dirty path names. Never copy
 * .env contents into the report. */
function captureBuildProvenance(repoRoot) {
  const observed = collectRepoProvenance({ repoRoot })
  const { execFileSync } = require('child_process')
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'src',
      'swift/TaskWraithBridge',
      'scripts/perf',
      'electron.vite.config.ts',
      'package.json',
      'package-lock.json'
    ],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }
  )
    .split('\0')
    .filter(Boolean)
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    if (fs.existsSync(path.join(repoRoot, name))) paths.push(name)
  }
  const inputs = [...new Set(paths)].sort().map((name) => {
    try {
      const bytes = fs.readFileSync(path.join(repoRoot, name))
      return {
        path: name,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    } catch (error) {
      return { path: name, unavailable: error.code || String(error) }
    }
  })
  return {
    ...observed,
    capturedAt: new Date().toISOString(),
    inputs,
    contentFingerprint: crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    dirtyTreeFingerprintMeaning:
      'hash of dirty path names only; see contentFingerprint for source bytes',
    captureGuarantee:
      'observed shared source, not an immutable snapshot; before/after hashes cannot exclude changes that revert during build'
  }
}

function fingerprintBuildOutput(buildOutDir) {
  const files = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const st = fs.lstatSync(full)
      if (st.isSymbolicLink()) throw new Error('Unexpected symlink in diagnostic build: ' + full)
      if (st.isDirectory()) walk(full)
      else
        files.push({
          path: path.relative(buildOutDir, full),
          bytes: st.size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        })
    }
  }
  walk(buildOutDir)
  return files
}

function checkAbort(signal) {
  if (signal && signal.aborted) throw new Error('Soak interrupted; cleaning up the owned child')
}

/**
 * Build the soak fixture: N small chats (full-delivery panes) plus one large
 * chat that exceeds the paged-transcript open threshold, so both delivery
 * paths render. Chats are lean (tiny blobs) — the soak load is the LIVE
 * streaming, not fixture bytes.
 *
 * @param {object} options
 * @param {number} options.paneCount
 * @param {number} [options.seed=42]
 */
function buildSoakFixture(options) {
  const paneCount = boundedInt(options.paneCount, DEFAULT_PANE_COUNT, 2, 8)
  const seed = options.seed == null ? 42 : Number(options.seed)
  const small = generatePerfFixture({ workload: '50_chat_switch', seed, lean: true, scaleDown: 4 })
  // 30seat lean at scaleDown=2 keeps > 1500 messages so shouldPageTranscriptOnOpen
  // is true by message count while lean blobs keep bytes bounded.
  const paged = generatePerfFixture({ workload: '30seat', seed, lean: true, scaleDown: 2 })
  const pagedChat = paged.chats[0]
  const smallChats = small.chats.slice(0, Math.max(1, paneCount - 1))
  const chats = [...smallChats, pagedChat]
  // Adapt the historical T2 fixture to the current production record schema.
  // The old generator uses run.id; Host persistence requires run.runId.
  for (const chat of chats) {
    chat.runs = chat.runs.map(({ id, ...run }) => ({
      ...run,
      runId: id,
      endedAt: new Date(chat.updatedAt).toISOString()
    }))
    if (chat.ensemble && chat.ensemble.activeRound) {
      chat.ensemble.activeRound.roundId = chat.ensemble.activeRound.id
      chat.ensemble.activeRound.status = 'completed'
      chat.ensemble.activeRound.endedAt = new Date(chat.updatedAt).toISOString()
    }
  }
  const fixture = {
    schemaVersion: 1,
    workload: small.workload,
    seed,
    generatedAt: small.generatedAt,
    shape: small.shape,
    unscaledShape: small.unscaledShape,
    chats,
    totals: {
      chatCount: chats.length,
      messageCount: chats.reduce((n, chat) => n + chat.messages.length, 0),
      toolActivityCount: chats.reduce(
        (n, chat) => n + ((chat._perfMeta && chat._perfMeta.toolActivityCount) || 0),
        0
      ),
      seatCount: small.shape.seatCount,
      chatSerializedBytes: 0,
      toolSerializedBytes: 0
    }
  }
  fixture.replaySchedule = buildReplaySchedule(fixture)
  return { fixture, paneCount, pagedChatId: pagedChat.appChatId }
}

/**
 * Bind fixture chats to distinct registered workspaces and write the
 * production-shaped registry the app reads (userData/workspaces.json). The
 * chats are mutated in place BEFORE materialization so the on-disk records and
 * the list index agree.
 *
 * @param {object} options
 * @param {object} options.fixture
 * @param {Array<{ id: string, path: string }>} options.repos
 * @param {string} options.userDataDir
 * @param {typeof fs} [options.fsApi]
 */
function bindChatsToWorkspaces(options) {
  const fsApi = options.fsApi || fs
  const repos = options.repos
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error('bindChatsToWorkspaces requires at least one repo')
  }
  const now = Date.now()
  const workspaceRecords = repos.map((repo, index) => ({
    id: repo.id,
    path: repo.path,
    realPath: fsApi.realpathSync(repo.path),
    updatedAt: now,
    displayName: path.basename(repo.path) || `soak-repo-${index + 1}`,
    createdAt: now,
    lastOpenedAt: now,
    pinned: false
  }))
  const assignments = []
  options.fixture.chats.forEach((chat, index) => {
    const repo = repos[index % repos.length]
    chat.scope = 'workspace'
    chat.workspaceId = repo.id
    chat.workspacePath = repo.path
    assignments.push({ appChatId: chat.appChatId, workspaceId: repo.id, workspacePath: repo.path })
  })
  fsApi.mkdirSync(options.userDataDir, { recursive: true })
  const registryPath = path.join(options.userDataDir, 'workspaces.json')
  fsApi.writeFileSync(registryPath, `${JSON.stringify(workspaceRecords, null, 2)}\n`, 'utf8')
  return { registryPath, workspaceRecords, assignments }
}

/**
 * Create N scratch repos under the isolated HOME. `git init` is attempted via
 * the injected execFile; a failure downgrades honestly to plain directories
 * with `gitInitAvailable: false` rather than inventing repo status.
 *
 * @param {object} options
 * @param {string} options.baseDir
 * @param {number} options.repoCount
 * @param {{ execFileSync?: Function }} [options.adapters]
 * @param {typeof fs} [options.fsApi]
 */
function createScratchRepos(options) {
  const fsApi = options.fsApi || fs
  const repoCount = boundedInt(options.repoCount, DEFAULT_REPO_COUNT, 1, 8)
  const execFileSync =
    options.adapters && typeof options.adapters.execFileSync === 'function'
      ? options.adapters.execFileSync
      : require('child_process').execFileSync
  const repos = []
  let gitInitAvailable = true
  let gitInitError = null
  for (let index = 0; index < repoCount; index += 1) {
    const repoPath = path.join(options.baseDir, `soak-repo-${index + 1}`)
    fsApi.mkdirSync(repoPath, { recursive: true })
    fsApi.writeFileSync(
      path.join(repoPath, 'README.md'),
      `# soak repo ${index + 1}\nSynthetic diagnostic repo for the multiview soak.\n`,
      'utf8'
    )
    if (gitInitAvailable) {
      try {
        execFileSync('git', ['init', '--quiet'], { cwd: repoPath })
      } catch (error) {
        gitInitAvailable = false
        gitInitError = String(error && error.message ? error.message : error)
      }
    }
    repos.push({ id: crypto.randomUUID(), path: repoPath, index })
  }
  return { repos, gitInitAvailable, gitInitError }
}

/**
 * Build the exact-child spawn plan targeting the UNIQUE built output. Reuses
 * buildElectronSpawnPlan (ports, env, HOME, mock keychain, safety) and then
 * retargets the Electron entry from '.' to `<buildOutDir>/main/index.js` so
 * the spawned child runs the fresh diagnostic build, never the shared out/.
 *
 * @param {object} options — buildElectronSpawnPlan options + { buildOutDir }
 */
function buildSoakSpawnPlan(options) {
  if (!options.buildOutDir) throw new Error('buildOutDir required for soak spawn plan')
  const base = buildElectronSpawnPlan(options)
  const entryFile = path.join(path.resolve(options.buildOutDir), 'main', 'index.js')
  const argv = base.argv.map((arg) => (arg === '.' ? entryFile : arg))
  if (!argv.includes(entryFile)) {
    throw new Error('soak spawn plan could not retarget Electron entry to the built output')
  }
  return {
    ...base,
    electronEntry: entryFile,
    argv,
    buildOutDir: path.resolve(options.buildOutDir),
    shellCommand: null, // spawn uses argv; do not publish a misleading shell reconstruction
    safety: {
      ...base.safety,
      launchesUniqueBuiltOutput: true,
      notes: [
        ...base.safety.notes.filter(
          (note) => !/clean isolated worktree|Build from|T1 runBaseline/.test(note)
        ),
        `Launch entry is the fresh diagnostic build: ${entryFile} (shared out/ untouched)`
      ]
    }
  }
}

/**
 * Fresh diagnostic build into the unique outDir. Steps fail closed; the
 * bridge-daemon step may be explicitly skipped (recorded, never implied).
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.buildOutDir
 * @param {boolean} [options.skipBridgeBuild=false]
 * @param {{ spawnSync?: Function }} [options.adapters]
 */
function runDiagnosticBuild(options) {
  const repoRoot = path.resolve(options.repoRoot)
  const buildOutDir = path.resolve(options.buildOutDir)
  const spawnSync =
    options.adapters && typeof options.adapters.spawnSync === 'function'
      ? options.adapters.spawnSync
      : require('child_process').spawnSync
  const steps = []
  const bridgeScratch = path.join(path.dirname(buildOutDir), 'swift', 'TaskWraithBridge', '.build')
  if (process.platform === 'darwin' && !options.skipBridgeBuild) {
    steps.push({
      label: 'swift bridge build in diagnostic artifact directory',
      command: 'swift',
      argv: [
        'build',
        '--disable-sandbox',
        '-c',
        'release',
        '--package-path',
        path.join(repoRoot, 'swift', 'TaskWraithBridge'),
        '--scratch-path',
        bridgeScratch
      ]
    })
  } else {
    steps.push({
      label: 'Swift bridge',
      skipped: true,
      reason: options.skipBridgeBuild
        ? 'explicit skip-bridge-build; remote bridge not exercised'
        : 'macOS-only bridge'
    })
  }
  steps.push({
    label: 'local electron-vite build into unique output',
    command: process.execPath,
    argv: [
      path.join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
      '--outDir=' + buildOutDir
    ]
  })
  const results = []
  for (const step of steps) {
    if (step.skipped) {
      results.push({ label: step.label, skipped: true, reason: step.reason })
      continue
    }
    const startedAt = Date.now()
    const result = spawnSync(step.command, step.argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024
    })
    const code = result && typeof result.status === 'number' ? result.status : 1
    results.push({
      label: step.label,
      code,
      durationMs: Date.now() - startedAt,
      stderrTail: result && result.stderr ? String(result.stderr).slice(-800) : ''
    })
    if (code !== 0) {
      const error = new Error(
        `Diagnostic build step failed (${step.label}) with code ${code}: ${
          result && result.stderr ? String(result.stderr).slice(-400) : 'no stderr'
        }`
      )
      error.code = 'SOAK_BUILD_FAILED'
      error.buildSteps = results
      throw error
    }
  }
  const mainEntry = path.join(buildOutDir, 'main', 'index.js')
  if (!fs.existsSync(mainEntry)) {
    const error = new Error(
      `Diagnostic build completed but the expected entry is missing: ${mainEntry}`
    )
    error.code = 'SOAK_BUILD_OUTPUT_MISSING'
    error.buildSteps = results
    throw error
  }
  return { buildOutDir, mainEntry, steps: results, files: fingerprintBuildOutput(buildOutDir) }
}

/**
 * Prove via the main inspector that the launched child is executing the fresh
 * diagnostic build (argv entry + appPath inside buildOutDir). Fail closed.
 *
 * @param {{ post: Function }} mainInspector
 * @param {string} buildOutDir
 */
async function verifyLaunchedBuildIdentity(mainInspector, buildOutDir) {
  const expression =
    `(function(){ try { const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron'); return JSON.stringify({` +
    ' argv1: process.argv[1] || null, argv: process.argv,' +
    ' appPath: electron.app.getAppPath(),' +
    ' execPath: process.execPath,' +
    ' pid: process.pid' +
    ' }) } catch (error) { return JSON.stringify({ error: String(error && error.message ? error.message : error) }) } })()'
  const result = await mainInspector.post('Runtime.evaluate', {
    expression,
    returnByValue: true
  })
  const raw = result && result.result ? result.result.value : null
  let observed = null
  try {
    observed = raw ? JSON.parse(String(raw)) : null
  } catch {
    observed = null
  }
  if (!observed || observed.error) {
    throw new Error(
      `Refuse soak: could not verify launched build identity (${observed && observed.error ? observed.error : 'no result'})`
    )
  }
  const resolvedOut = path.resolve(buildOutDir)
  const argv1 = observed.argv1 ? path.resolve(String(observed.argv1)) : ''
  const appPath = observed.appPath ? path.resolve(String(observed.appPath)) : ''
  const inside = (candidate) =>
    candidate === resolvedOut || candidate.startsWith(`${resolvedOut}${path.sep}`)
  const expectedEntry = path.join(resolvedOut, 'main', 'index.js')
  const argv = Array.isArray(observed.argv) ? observed.argv : [observed.argv1]
  if (!argv.includes(expectedEntry) || !inside(appPath)) {
    throw new Error(
      `Refuse soak: launched child is NOT the fresh diagnostic build (argv1=${argv1 || 'none'}, appPath=${appPath || 'none'}, expected under ${resolvedOut})`
    )
  }
  return { ...observed, entry: expectedEntry, buildOutDir: resolvedOut, verified: true }
}

/** Poll helper with injected timers. */
async function pollUntil(fn, options) {
  const timeoutMs = options.timeoutMs
  const intervalMs = options.intervalMs == null ? 250 : options.intervalMs
  const nowMs = options.nowMs || Date.now
  const sleep =
    options.sleep ||
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }))
  const deadline = nowMs() + timeoutMs
  let last = null
  while (true) {
    last = await fn()
    if (last && last.ok) return last
    if (nowMs() >= deadline) {
      const error = new Error(
        `${options.label || 'poll'} timed out after ${timeoutMs}ms: ${
          last && last.reason ? last.reason : 'condition never satisfied'
        }`
      )
      error.code = 'SOAK_POLL_TIMEOUT'
      error.last = last
      throw error
    }
    await sleep(intervalMs)
  }
}

/**
 * Drive the REAL multiview UI over CDP: choose a layout through a rendered
 * layout picker (Thread Home grid or the composer picker), then assign one
 * distinct chat per pane by clicking its Thread Home row inside that pane.
 * No production seams are added; this clicks the same buttons a user does.
 *
 * @param {object} options
 * @param {{ evaluate: (expr: string) => Promise<unknown> }} options.page
 * @param {number} options.paneCount
 * @param {Array<{ appChatId: string, title: string }>} options.paneChats
 * @param {object} [options.timing]
 */
async function driveMultiviewPanes(options) {
  const page = options.page
  const paneCount = options.paneCount
  const layout = LAYOUT_BY_PANE_COUNT[paneCount]
  if (!layout) {
    throw new Error(`No multiview layout maps to paneCount=${paneCount} (use 2,3,4,6,8)`)
  }
  const timing = options.timing || {}
  const descriptor = `${paneCount} panes`
  const layoutLabel = {
    2: 'Vertical split',
    3: 'Vertical split',
    4: 'Quad',
    6: '6-Way',
    8: '8-Way'
  }[paneCount]

  await pollUntil(
    async () => {
      const ready = await page.evaluate(
        '(function(){ return { ok: Boolean(window.api && typeof window.api.getChat === "function" && document.body), reason: "window.api/document not ready" } })()'
      )
      return ready || { ok: false, reason: 'no evaluate result' }
    },
    { timeoutMs: timing.readyTimeoutMs || 60_000, label: 'renderer boot', ...timing }
  )

  const clickLayout = `(function(){
    const onboarding = document.querySelector('button.first-launch-sheet-close')
    if (onboarding) { onboarding.click(); return { ok: false, reason: 'dismissed onboarding through its close button' } }
    const grids = [
      document.querySelector('.thread-home-multiview-grid'),
      document.querySelector('.composer-multiview-grid')
    ].filter(Boolean)
    for (const grid of grids) {
      const buttons = Array.from(grid.querySelectorAll('button'))
      const target = buttons.find((b) => (b.textContent || '').includes(${JSON.stringify(descriptor)}) && (b.textContent || '').includes(${JSON.stringify(layoutLabel)}))
      if (target) {
        if (target.disabled) {
          return { ok: false, disabled: true, reason: 'layout option disabled (window too narrow): ' + ${JSON.stringify(descriptor)} }
        }
        target.click()
        return { ok: true, clicked: (target.textContent || '').trim() }
      }
    }
    const card = document.querySelector('button.thread-home-multiview-card')
    if (card) { card.click(); return { ok: false, reason: 'opened Thread Home multiview picker' } }
    const trigger = document.querySelector('button[data-composer-control="multiview"]')
    if (trigger) { trigger.click(); return { ok: false, reason: 'opened composer multiview picker' } }
    return { ok: false, reason: 'no multiview layout picker present yet' }
  })()`
  const layoutClick = await pollUntil(async () => page.evaluate(clickLayout), {
    timeoutMs: timing.layoutTimeoutMs || 30_000,
    label: `select multiview layout ${layout}`,
    ...timing
  })

  await pollUntil(
    async () =>
      page.evaluate(
        `(function(){ const n = document.querySelectorAll('.multiview-cell').length; return { ok: n === ${paneCount}, reason: 'multiview cells present: ' + n + ' (want ${paneCount})' } })()`
      ),
    { timeoutMs: timing.gridTimeoutMs || 20_000, label: 'multiview grid render', ...timing }
  )

  const assigned = []
  for (let paneIndex = 0; paneIndex < paneCount; paneIndex += 1) {
    const chat = options.paneChats[paneIndex % options.paneChats.length]
    const clickRow = `(function(){
      const cell = document.querySelector('.multiview-cell[data-pane-index="${paneIndex}"]')
      if (!cell) return { ok: false, reason: 'cell ${paneIndex} missing' }
      const onboarding = document.querySelector('button.first-launch-sheet-close')
      if (onboarding) { onboarding.click(); return { ok: false, reason: 'dismissed onboarding' } }
      if (cell.querySelector('.multiview-pane-runtime')) {
        const close = cell.querySelector('button[aria-label="Close pane"], button[aria-label="Dismiss pane to Thread Home"], button[aria-label="Close thread view"]')
        if (close) { close.click(); return { ok: false, reason: 'dismissed existing pane to choose its assigned fixture' } }
        return { ok: false, reason: 'existing pane has no dismiss action yet' }
      }
      const rows = Array.from(cell.querySelectorAll('button.thread-home-thread-row'))
      const target = rows.find((row) => {
        const label = row.querySelector('.thread-home-thread-copy strong')
        return label && label.textContent === ${JSON.stringify(chat.title)}
      })
      if (!target) {
        return { ok: false, reason: 'thread row not found in cell ${paneIndex}', rowTitles: rows.slice(0, 12).map((row) => { const label = row.querySelector('.thread-home-thread-copy strong'); return label ? label.textContent : null }) }
      }
      target.click()
      return { ok: true, clicked: ${JSON.stringify(chat.title)} }
    })()`
    await pollUntil(async () => page.evaluate(clickRow), {
      timeoutMs: timing.assignTimeoutMs || 20_000,
      label: `assign ${chat.appChatId} to pane ${paneIndex}`,
      ...timing
    })
    await pollUntil(
      async () =>
        page.evaluate(
          `(function(){ const cell = document.querySelector('.multiview-cell[data-pane-index="${paneIndex}"]'); if (!cell) return { ok:false, reason: 'cell ${paneIndex} missing' }; const runtime = cell.querySelector('.multiview-pane-runtime'); return { ok: Boolean(runtime), reason: 'pane ${paneIndex} runtime not rendered yet' } })()`
        ),
      { timeoutMs: timing.paneTimeoutMs || 30_000, label: `pane ${paneIndex} render`, ...timing }
    )
    assigned.push({ paneIndex, appChatId: chat.appChatId, title: chat.title })
  }
  if (assigned.length < 2) {
    throw new Error(`Soak requires >=2 assigned panes; only ${assigned.length} assigned`)
  }
  return { layout, layoutClick, assigned }
}

/** Snapshot per-pane DOM evidence (pane ids + rendered transcript size/tail). */
async function samplePaneEvidence(page, assignments = []) {
  const expression = `(function(){
    const cells = Array.from(document.querySelectorAll('.multiview-cell'))
    return {
      visibility: document.visibilityState,
      modalCount: document.querySelectorAll('[aria-modal="true"]').length,
      cellCount: cells.length,
      cells: cells.map((cell) => {
        const closeBtn = cell.querySelector('button.multiview-pane-close')
        const runtime = cell.querySelector('.multiview-pane-runtime')
        const text = runtime ? runtime.textContent || '' : ''
        const assignment = ${JSON.stringify(assignments)}.find((p) => String(p.paneIndex) === cell.getAttribute('data-pane-index'))
        const marker = assignment ? 'SOAK ' + assignment.appChatId : null
        return {
          expectedChatId: assignment ? assignment.appChatId : null,
          streamedMarkerRendered: Boolean(marker && text.includes(marker)),
          latestStreamTick: assignment ? (text.match(new RegExp('SOAK ' + assignment.appChatId + ' tick (\\\\d+)', 'g')) || []).slice(-1)[0] || null : null,
          paneIndex: cell.getAttribute('data-pane-index'),
          paneId: cell.getAttribute('data-pane-id'),
          focused: cell.classList.contains('multiview-cell-focused'),
          closeLabel: closeBtn ? closeBtn.getAttribute('aria-label') : null,
          hasRuntime: Boolean(runtime),
          textLength: text.length,
          textTail: text.slice(-320),
          displayed: Boolean(runtime && runtime.getBoundingClientRect().width && runtime.getBoundingClientRect().height)
        }
      })
    }
  })()`
  return page.evaluate(expression)
}

/**
 * Page-side streaming engine: seeds each pane chat from the store's own
 * canonical record (window.api.getChat), then appends one synthetic assistant
 * message per tick and saves through the REAL window.api.saveChat path with
 * compare-and-swap revision tracking. A non-advancing ack is a store rejection
 * and fails closed (replayDriver's seed-42 lesson).
 */
function createSoakStreamEngine(options) {
  const page = options.page
  const paddingChars = boundedInt(options.paddingChars, DEFAULT_STREAM_PADDING_CHARS, 0, 20_000)
  const padding = 'x'.repeat(paddingChars)
  const canonicalRevisions = new Map()
  const acceptedSaves = new Map()

  async function seedChat(chatId) {
    const idJson = JSON.stringify(chatId)
    const expression = `Promise.resolve(window.api.getChat(${idJson})).then((chat) => {
      if (!chat) throw new Error('soak seed: getChat returned null for ' + ${idJson})
      const store = window.${PAGE_SOAK_GLOBAL} = window.${PAGE_SOAK_GLOBAL} || { chats: {} }
      store.chats[${idJson}] = { chat, tick: 0 }
      return { seeded: ${idJson}, messageCount: (chat.messages || []).length, persistenceRevision: chat.persistenceRevision || 1 }
    })`
    const ack = await page.evaluate(expression)
    if (!ack || typeof ack.persistenceRevision !== 'number') {
      throw new Error(`soak seed failed for ${chatId}: ${JSON.stringify(ack)}`)
    }
    canonicalRevisions.set(chatId, ack.persistenceRevision)
    acceptedSaves.set(chatId, 0)
    return ack
  }

  async function appendTick(chatId, contentLabel) {
    const idJson = JSON.stringify(chatId)
    const sentRevision = canonicalRevisions.get(chatId)
    if (sentRevision == null) throw new Error(`soak appendTick before seed: ${chatId}`)
    const expression = `(function(){
      const store = window.${PAGE_SOAK_GLOBAL}
      const state = store && store.chats ? store.chats[${idJson}] : null
      if (!state || !state.chat) throw new Error('soak chat not seeded: ' + ${idJson})
      state.tick = (state.tick || 0) + 1
      const message = {
        id: 'soak-' + ${idJson} + '-' + state.tick,
        role: 'assistant',
        content: ${JSON.stringify(contentLabel)} + ' tick ' + state.tick + ' ' + ${JSON.stringify(padding)},
        timestamp: new Date().toISOString()
      }
      state.chat = Object.assign({}, state.chat, {
        messages: state.chat.messages.concat([message]),
        updatedAt: Date.now(),
        persistenceRevision: ${sentRevision}
      })
      return Promise.resolve(window.api.saveChat(state.chat)).then((saved) => {
        const revision = saved && typeof saved === 'object' && typeof saved.persistenceRevision === 'number'
          ? saved.persistenceRevision
          : null
        if (revision != null) state.chat.persistenceRevision = revision
        return { persistenceRevision: revision, messageCount: state.chat.messages.length, messageId: message.id }
      })
    })()`
    const ack = await page.evaluate(expression)
    const ackRevision =
      ack && typeof ack.persistenceRevision === 'number' ? ack.persistenceRevision : null
    if (ackRevision == null)
      throw new Error('soak save missing revision acknowledgement: ' + chatId)
    if (ackRevision != null) {
      if (ackRevision <= sentRevision) {
        const error = new Error(
          `soak save did not advance canonical revision for ${chatId}: sent ${sentRevision}, store returned ${ackRevision} — the store rejected the save`
        )
        error.code = 'SOAK_SAVE_REJECTED'
        throw error
      }
      canonicalRevisions.set(chatId, ackRevision)
    }
    acceptedSaves.set(chatId, (acceptedSaves.get(chatId) || 0) + 1)
    return ack
  }

  async function finalMessage(chatId) {
    const sentinel = `SOAK-FINAL-${chatId}`
    const ack = await appendTick(chatId, sentinel)
    return { sentinel, ack }
  }

  async function verifyFinalStoredMessage(chatId, sentinel) {
    const idJson = JSON.stringify(chatId)
    const expression = `Promise.resolve(window.api.getChat(${idJson})).then((chat) => {
      if (!chat) return { ok: false, reason: 'getChat null' }
      const messages = chat.messages || []
      const last = messages[messages.length - 1] || null
      return { ok: Boolean(last), lastId: last ? last.id : null, lastContent: last ? last.content : null, messageCount: messages.length, persistenceRevision: chat.persistenceRevision }
    })`
    const result = await page.evaluate(expression)
    const contains = Boolean(
      result && typeof result.lastContent === 'string' && result.lastContent.startsWith(sentinel)
    )
    return { ...result, sentinel, sentinelIsLastMessage: contains }
  }

  return {
    seedChat,
    appendTick,
    finalMessage,
    verifyFinalStoredMessage,
    stats: () => ({
      canonicalRevisions: Object.fromEntries(canonicalRevisions),
      acceptedSaves: Object.fromEntries(acceptedSaves)
    })
  }
}

/**
 * Probe installers + one-shot samplers. Every failed section is recorded as an
 * explicit `{ unavailable: <reason> }` — never zeros (dry-run-zero lesson).
 */
function createMetricsSamplers(options) {
  const page = options.page
  const rendererSend = options.rendererSend
  const mainInspector = options.mainInspector

  async function installProbes() {
    const installed = { rendererFrames: null, rendererPerformanceDomain: null, mainLag: null }
    try {
      installed.rendererFrames = await page.evaluate(`(function(){
        if (window.${PAGE_FRAMES_GLOBAL}) return 'already'
        const state = { frames: 0, worstGapMs: 0, over50: 0, sumGapMs: 0, last: performance.now() }
        window.${PAGE_FRAMES_GLOBAL} = state
        const input = { events: 0, maxEventDelayMs: 0, maxEventToFrameMs: 0 }
        window.${PAGE_INPUT_GLOBAL} = input
        document.addEventListener('pointermove', (event) => {
          const at = performance.now()
          input.events += 1
          input.maxEventDelayMs = Math.max(input.maxEventDelayMs, at - event.timeStamp)
          requestAnimationFrame(() => { input.maxEventToFrameMs = Math.max(input.maxEventToFrameMs, performance.now() - at) })
        }, { passive: true })
        const loop = (t) => {
          const gap = t - state.last
          state.last = t
          state.frames += 1
          state.sumGapMs += gap
          if (gap > state.worstGapMs) state.worstGapMs = gap
          if (gap > 50) state.over50 += 1
          requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
        return 'installed'
      })()`)
    } catch (error) {
      installed.rendererFrames = {
        unavailable: String(error && error.message ? error.message : error)
      }
    }
    try {
      await rendererSend('Performance.enable', {})
      installed.rendererPerformanceDomain = 'enabled'
    } catch (error) {
      installed.rendererPerformanceDomain = {
        unavailable: String(error && error.message ? error.message : error)
      }
    }
    try {
      const result = await mainInspector.post('Runtime.evaluate', {
        expression: `(function(){
          const g = globalThis
          if (g.${MAIN_LAG_GLOBAL}) return 'already'
          const state = { intervalMs: 250, last: Date.now(), maxDriftMs: 0, ticks: 0 }
          g.${MAIN_LAG_GLOBAL} = state
          state.timer = setInterval(() => {
            const now = Date.now()
            const drift = now - state.last - state.intervalMs
            if (drift > state.maxDriftMs) state.maxDriftMs = drift
            state.last = now
            state.ticks += 1
          }, state.intervalMs)
          if (state.timer && typeof state.timer.unref === 'function') state.timer.unref()
          return 'installed'
        })()`,
        returnByValue: true
      })
      installed.mainLag = result && result.result ? result.result.value : null
    } catch (error) {
      installed.mainLag = { unavailable: String(error && error.message ? error.message : error) }
    }
    return installed
  }

  async function sampleMain() {
    try {
      const result = await mainInspector.post('Runtime.evaluate', {
        expression: `(function(){
          try {
            const electron = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')
            const lag = globalThis.${MAIN_LAG_GLOBAL} || null
            const lagOut = lag ? { maxDriftMs: lag.maxDriftMs, ticks: lag.ticks, intervalMs: lag.intervalMs } : null
            if (lag) { lag.maxDriftMs = 0; lag.ticks = 0 }
            return JSON.stringify({
              sampledAt: Date.now(),
              pid: process.pid,
              renderers: electron.webContents.getAllWebContents().filter((wc) => wc.getType() === 'window').map((wc) => ({ webContentsId: wc.id, pid: wc.getOSProcessId(), url: wc.getURL() })),
              memoryUsage: process.memoryUsage(),
              appMetrics: electron.app.getAppMetrics().map((m) => ({
                pid: m.pid,
                type: m.type,
                workingSetSizeKb: m.memory ? m.memory.workingSetSize ?? null : null,
                privateBytesKb: m.memory ? m.memory.privateBytes ?? null : null,
                cpuPercent: m.cpu ? m.cpu.percentCPUUsage : null
              })),
              memoryUnit: 'appMetrics workingSetSizeKb/privateBytesKb are KILOBYTES per Electron docs; memoryUsage is bytes; null means Electron did not supply the metric',
              eventLoop: lagOut
            })
          } catch (error) {
            return JSON.stringify({ error: String(error && error.message ? error.message : error) })
          }
        })()`,
        returnByValue: true
      })
      const raw = result && result.result ? result.result.value : null
      const parsed = raw ? JSON.parse(String(raw)) : null
      if (!parsed || parsed.error) {
        return { unavailable: parsed && parsed.error ? parsed.error : 'no main sample returned' }
      }
      return parsed
    } catch (error) {
      return { unavailable: String(error && error.message ? error.message : error) }
    }
  }

  async function sampleRenderer() {
    const out = {}
    try {
      const at = performance.now()
      await rendererSend('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 5 + (Math.floor(at) % 10),
        y: 5
      })
      out.syntheticInput = {
        dispatchRoundTripMs: performance.now() - at,
        note: 'synthetic pointer movement through CDP; no human typing or provider input'
      }
    } catch (error) {
      out.syntheticInput = { unavailable: String(error.message || error) }
    }
    try {
      const metrics = await rendererSend('Performance.getMetrics', {})
      const map = {}
      for (const entry of (metrics && metrics.metrics) || []) {
        map[entry.name] = entry.value
      }
      out.performance = Object.keys(map).length ? map : { unavailable: 'CDP returned no metrics' }
    } catch (error) {
      out.performance = { unavailable: String(error && error.message ? error.message : error) }
    }
    try {
      out.frames = await page.evaluate(`(function(){
        const state = window.${PAGE_FRAMES_GLOBAL}
        if (!state) return { unavailable: 'frame probe not installed' }
        const sample = {
          input: window.${PAGE_INPUT_GLOBAL} || { unavailable: 'input probe missing' },
          frames: state.frames,
          worstGapMs: state.worstGapMs,
          over50: state.over50,
          meanGapMs: state.frames > 0 ? state.sumGapMs / state.frames : null,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus()
        }
        state.frames = 0; state.worstGapMs = 0; state.over50 = 0; state.sumGapMs = 0
        return sample
      })()`)
    } catch (error) {
      out.frames = { unavailable: String(error && error.message ? error.message : error) }
    }
    return out
  }

  return { installProbes, sampleMain, sampleRenderer }
}

/** Append one JSONL sample line (append-only; beyond any bounded in-app ring). */
function appendTimeSeriesSample(filePath, sample, fsApi) {
  const api = fsApi || fs
  api.appendFileSync(filePath, `${JSON.stringify(sample)}\n`, 'utf8')
}

/**
 * Force-honest report envelope: this lane can NEVER be a baseline and any
 * attempt to claim otherwise is overwritten, not trusted.
 */
function buildDiagnosticReportEnvelope(input) {
  return {
    ...input,
    schemaVersion: 1,
    kind: 'taskwraith-multiview-soak-report',
    diagnosticOnly: true,
    authoritativeEvidence: false,
    authoritativeBaseline: false,
    baseline: 'none',
    providerTraffic:
      'simulated (window.api.saveChat streaming only; EnsembleOrchestrator/provider runs NOT driven — see replayDriver.cjs)'
  }
}

/**
 * The soak orchestrator. Every side effect goes through an injectable adapter
 * so the whole lifecycle is unit-testable without Electron.
 *
 * @param {object} options
 */
async function runMultiviewSoak(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(__dirname, '..', '..'))
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now
  const sleep =
    options.sleep ||
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }))
  const log = typeof options.log === 'function' ? options.log : () => {}
  const fsApi = options.fs || fs

  const durationMs = boundedInt(
    options.durationMs,
    DEFAULT_SMOKE_DURATION_MS,
    5_000,
    MAX_SOAK_DURATION_MS
  )
  const sampleIntervalMs = boundedInt(
    options.sampleIntervalMs,
    DEFAULT_SAMPLE_INTERVAL_MS,
    500,
    120_000
  )
  const streamTickMs = boundedInt(options.streamTickMs, DEFAULT_STREAM_TICK_MS, 50, 60_000)
  const paneCount = boundedInt(options.paneCount, DEFAULT_PANE_COUNT, 2, 8)
  const repoCount = boundedInt(options.repoCount, DEFAULT_REPO_COUNT, 1, 8)

  const provenance = options.provenance || captureBuildProvenance(repoRoot)
  const appVersion = detectAppVersion(repoRoot)
  const instanceId = String(options.instanceId || `perf-soak-mv-${paneCount}p-${nowMs() % 100000}`)

  if (!LAYOUT_BY_PANE_COUNT[paneCount]) throw new Error('paneCount must be 2,3,4,6,8')
  if (options.mainInspectorUrl)
    throw new Error('Refuse arbitrary inspector URL: discover only the owned child port')
  if (options.home && fsApi.existsSync(options.home) && fsApi.readdirSync(options.home).length) {
    throw new Error('Refuse nonempty HOME: use a fresh directory, never reuse an active run')
  }
  checkAbort(options.signal)
  const homeResolved = resolveT2Home({
    homeArg: options.home,
    repoRoot,
    willLaunch: true,
    realHomedir: options.realHomedir,
    fs: options.fsForHome
  })
  const home = homeResolved.home
  const userDataResolved = resolveUnpackagedDevUserDataPath({
    instanceId,
    home,
    platform: options.platform || process.platform,
    env: options.env || process.env
  })
  const artifactDir = path.resolve(
    String(options.artifactDir || path.join(home, `soak-artifacts-${instanceId}`))
  )
  if (!artifactDir.startsWith(home + path.sep))
    throw new Error('artifactDir must be beneath the fresh isolated HOME')
  if (fsApi.existsSync(artifactDir)) throw new Error('Refuse existing artifact directory')
  fsApi.mkdirSync(artifactDir, { recursive: true })
  const buildOutDir = path.join(artifactDir, 'build')
  const timeSeriesPath = path.join(artifactDir, 'soak-timeseries.jsonl')
  const reportPath = path.join(artifactDir, 'soak-report.json')

  const unsupported = [
    {
      field: 'providerFanout',
      reason: 'simulated saveChat publications; no provider calls or EnsembleOrchestrator runs'
    },
    {
      field: 'nativeAllocationAttribution',
      reason:
        'process RSS and GPU working set cannot identify individual Chromium native/image/compositor allocations'
    },
    { field: 'compositorLayerCount', reason: 'not sampled' }
  ]
  const cleanupFailures = []
  const startedAt = new Date(nowMs()).toISOString()

  log(
    `[soak] provenance sha=${provenance.gitSha.slice(0, 9)} dirty=${provenance.dirty} (${provenance.dirtyPaths.length} paths)`
  )

  // Scratch repos + fixture + userData materialization (before launch).
  const scratch = createScratchRepos({
    baseDir: path.join(home, 'soak-repos'),
    repoCount,
    adapters: options.repoAdapters,
    fsApi
  })
  if (!scratch.gitInitAvailable) {
    unsupported.push({
      field: 'scratchRepos.gitInit',
      reason: `git init unavailable (${scratch.gitInitError}); plain directories used — repos are distinct paths, not git repos`
    })
  }
  const { fixture, pagedChatId } = buildSoakFixture({ paneCount, seed: options.seed })
  const binding = bindChatsToWorkspaces({
    fixture,
    repos: scratch.repos,
    userDataDir: userDataResolved.userDataPath,
    fsApi
  })
  const materialized = (options.materialize || materializePerfUserData)({
    workload: fixture.workload,
    seed: fixture.seed,
    userDataDir: userDataResolved.userDataPath,
    fixture,
    mode: 'legacy_v1',
    lean: true
  })

  // Fresh build into the UNIQUE outDir (never shared out/).
  let buildResult
  if (options.buildAdapters && typeof options.buildAdapters.build === 'function') {
    buildResult = await options.buildAdapters.build({ repoRoot, buildOutDir })
  } else {
    buildResult = runDiagnosticBuild({
      repoRoot,
      buildOutDir,
      skipBridgeBuild: Boolean(options.skipBridgeBuild),
      adapters: options.buildAdapters
    })
  }

  const provenanceAfterBuild = options.provenance || captureBuildProvenance(repoRoot)
  buildResult.sourceBefore = provenance
  buildResult.sourceAfter = provenanceAfterBuild
  buildResult.sourceChangedDuringBuild =
    provenance.gitSha !== provenanceAfterBuild.gitSha ||
    provenance.contentFingerprint !== provenanceAfterBuild.contentFingerprint
  fsApi.writeFileSync(
    path.join(artifactDir, 'build-provenance.json'),
    JSON.stringify(buildResult, null, 2) + '\n'
  )
  checkAbort(options.signal)

  const spawnPlan = buildSoakSpawnPlan({
    instanceId: userDataResolved.sanitizedInstanceId,
    repoRoot,
    remoteDebuggingPort: options.port == null ? undefined : Number(options.port),
    mainInspectorPort: options.inspectPort == null ? undefined : Number(options.inspectPort),
    userDataPath: userDataResolved.userDataPath,
    home,
    platform: options.platform || process.platform,
    buildOutDir,
    adapters: options.spawnPlanAdapters
  })

  await assertLaunchPortsFree(
    {
      remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
      mainInspectorPort: spawnPlan.mainInspectorPort,
      instanceId: userDataResolved.sanitizedInstanceId
    },
    options.portAdapters || {}
  )

  let containment = homeResolved.containment
  if (homeResolved.authoritativeHome) {
    containment = assertFilesystemIsolatedHomeContainment({
      home,
      repoRoot,
      realHomedir: options.realHomedir,
      userDataPath: userDataResolved.userDataPath,
      fs: options.fsForHome,
      createMissing: false
    })
  }

  let childSession = null
  let renderer = null
  let mainInspector = null
  let streamStats = null
  let paneDrive = null
  let finalChecks = []
  let sampleCount = 0
  let buildIdentity = null
  let isolation = null
  let childTerminationSucceeded = false
  let resultReport = null
  let resultData = null
  let termination = null
  let portOwnership = null

  try {
    log(`[soak] launching exact child: ${spawnPlan.electronEntry}`)
    childSession = (options.spawnChild || spawnExactElectronChild)({
      spawnPlan,
      adapters: options.spawnAdapters || {}
    })
    if (childSession.stdout)
      childSession.stdout.on('data', (chunk) =>
        fsApi.appendFileSync(path.join(artifactDir, 'child.stdout.log'), chunk)
      )
    if (childSession.stderr)
      childSession.stderr.on('data', (chunk) =>
        fsApi.appendFileSync(path.join(artifactDir, 'child.stderr.log'), chunk)
      )
    assertExactChildAttach(childSession, {
      pid: childSession.pid,
      remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
      mainInspectorPort: spawnPlan.mainInspectorPort
    })
    portOwnership = await assertExactChildOwnsDebugPorts(
      childSession,
      options.portOwnershipAdapters || {}
    )

    const inspectorUrl = await discoverMainInspectorUrl({
      port: spawnPlan.mainInspectorPort,
      adapters: options.cdpAdapters || {}
    })
    mainInspector = await (options.attachMainInspector || attachMainInspectorSession)({
      webSocketDebuggerUrl: inspectorUrl,
      WebSocket: options.WebSocket
    })

    const expectedHomeRealpath = containment ? containment.canonicalHome : null
    const expectedUserDataRealpath = containment ? containment.canonicalUserData : null
    if (!expectedHomeRealpath || !expectedUserDataRealpath) {
      throw new Error('Refuse soak: canonical HOME/userData realpaths required before verification')
    }
    isolation = await (
      options.verifyIsolatedHomeAndUserData || verifyIsolatedHomeAndUserDataViaMainInspector
    )(mainInspector, {
      home,
      userDataPath: userDataResolved.userDataPath,
      homeRealpath: expectedHomeRealpath,
      userDataRealpath: expectedUserDataRealpath
    })
    buildIdentity = await (options.verifyBuildIdentity || verifyLaunchedBuildIdentity)(
      mainInspector,
      buildOutDir
    )
    if (buildIdentity.pid !== childSession.pid)
      throw new Error('Refuse inspector: build PID differs from exact child PID')
    log(`[soak] child pid=${childSession.pid} runs fresh build (exact argv entry verified)`)

    // Startup can precede the first BrowserWindow; verify the child first and
    // retain an inspector CPU trace if renderer discovery times out.
    let startupProfileStarted = false
    try {
      await mainInspector.post('Profiler.enable', {})
      await mainInspector.post('Profiler.start', {})
      startupProfileStarted = true
    } catch {
      /* The CPU trace is optional and never substitutes for UI proof. */
    }
    try {
      renderer = await (options.attachRenderer || attachRendererCdpSession)({
        port: spawnPlan.remoteDebuggingPort,
        WebSocket: options.WebSocket,
        adapters: { timeoutMs: 120_000, ...options.cdpAdapters }
      })
    } finally {
      if (startupProfileStarted) {
        try {
          const profile = await mainInspector.post('Profiler.stop', {})
          fsApi.writeFileSync(
            path.join(artifactDir, 'startup.cpuprofile'),
            JSON.stringify(profile.profile || profile)
          )
        } catch {
          /* Preserve the original attach error. */
        }
      }
    }

    const page = createCdpEvaluateAdapter(renderer)
    const paneChats = fixture.chats.map((chat) => ({
      appChatId: chat.appChatId,
      title: chat.title
    }))
    paneDrive = await (options.drivePanes || driveMultiviewPanes)({
      page,
      paneCount,
      paneChats,
      timing: { nowMs, sleep, ...options.driveTiming }
    })
    log(`[soak] multiview ${paneDrive.layout}: ${paneDrive.assigned.length} panes assigned`)
    try {
      const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png' })
      if (screenshot.data)
        fsApi.writeFileSync(
          path.join(artifactDir, 'panes-start.png'),
          Buffer.from(screenshot.data, 'base64')
        )
    } catch (error) {
      unsupported.push({ field: 'screenshot', reason: String(error.message || error) })
    }

    const engine = createSoakStreamEngine({ page, paddingChars: options.streamPaddingChars })
    for (const pane of paneDrive.assigned) {
      await engine.seedChat(pane.appChatId)
    }
    const samplers = createMetricsSamplers({
      page,
      rendererSend: renderer.send,
      mainInspector
    })
    const probes = await samplers.installProbes()

    const soakStartedMs = nowMs()
    let lastSampleMs = -Infinity
    let tickIndex = 0
    while (nowMs() - soakStartedMs < durationMs) {
      checkAbort(options.signal)
      // One concurrent publication per pane per tick, retaining the existing
      // renderer/preload/store queues and CAS acknowledgements.
      await Promise.all(
        paneDrive.assigned.map((pane) =>
          engine.appendTick(pane.appChatId, `SOAK ${pane.appChatId}`)
        )
      )
      tickIndex += 1
      if (nowMs() - lastSampleMs >= sampleIntervalMs) {
        lastSampleMs = nowMs()
        const [main, rendererSample, panes] = [
          await samplers.sampleMain(),
          await samplers.sampleRenderer(),
          await samplePaneEvidence(page, paneDrive.assigned)
        ]
        sampleCount += 1
        appendTimeSeriesSample(
          timeSeriesPath,
          {
            schemaVersion: 1,
            kind: 'taskwraith-multiview-soak-sample',
            seq: sampleCount,
            at: new Date(nowMs()).toISOString(),
            elapsedMs: nowMs() - soakStartedMs,
            main,
            renderer: rendererSample,
            panes,
            streaming: engine.stats()
          },
          fsApi
        )
        log(
          `[soak] sample ${sampleCount} @ ${(Math.round((nowMs() - soakStartedMs) / 100) / 10).toFixed(1)}s (ticks=${tickIndex})`
        )
      }
      await sleep(Math.min(streamTickMs, Math.max(0, durationMs - (nowMs() - soakStartedMs))))
    }

    const streamingEndedMs = nowMs()
    for (const pane of paneDrive.assigned) {
      const { sentinel } = await engine.finalMessage(pane.appChatId)
      const stored = await engine.verifyFinalStoredMessage(pane.appChatId, sentinel)
      const dom = await pollUntil(
        async () =>
          page.evaluate(
            `(function(){ const cell = document.querySelector('.multiview-cell[data-pane-index="${pane.paneIndex}"]'); if (!cell) return { ok: false, reason: 'cell missing' }; const text = cell.textContent || ''; return { ok: text.includes(${JSON.stringify(sentinel)}), reason: 'sentinel not rendered in pane ${pane.paneIndex} yet' } })()`
          ),
        { timeoutMs: 20_000, label: `pane ${pane.paneIndex} final text`, nowMs, sleep }
      ).then(
        () => ({ renderedSentinel: true }),
        (error) => ({ renderedSentinel: false, reason: String(error.message) })
      )
      finalChecks.push({ ...pane, sentinel, stored, dom })
    }
    streamStats = engine.stats()
    const finalPaneEvidence = await samplePaneEvidence(page, paneDrive.assigned)
    const finalStoredFiles = await pollUntil(
      async () => {
        const rows = finalChecks.map((check) => {
          try {
            const filePath = path.join(
              userDataResolved.userDataPath,
              'chats',
              check.appChatId + '.json'
            )
            const record = JSON.parse(fsApi.readFileSync(filePath, 'utf8'))
            return {
              appChatId: check.appChatId,
              filePath,
              persistenceRevision: record.persistenceRevision,
              sentinelIsLastMessage: Boolean(
                record.messages && record.messages.at(-1)?.content.startsWith(check.sentinel)
              )
            }
          } catch (error) {
            return { appChatId: check.appChatId, unavailable: String(error.message || error) }
          }
        })
        return {
          ok: rows.every((row) => row.sentinelIsLastMessage),
          rows,
          reason: 'final text has not reached durable chat files'
        }
      },
      { timeoutMs: 20_000, label: 'durable final chat files', nowMs, sleep }
    ).catch((error) => ({ ok: false, ...(error.last || {}), error: error.message }))
    try {
      const screenshot = await renderer.send('Page.captureScreenshot', { format: 'png' })
      if (screenshot.data)
        fsApi.writeFileSync(
          path.join(artifactDir, 'panes-final.png'),
          Buffer.from(screenshot.data, 'base64')
        )
    } catch {
      /* Screenshot absence does not substitute for final-text checks. */
    }

    const report = buildDiagnosticReportEnvelope({
      status:
        finalStoredFiles.ok &&
        !finalPaneEvidence.modalCount &&
        finalChecks.every((c) => c.stored.sentinelIsLastMessage && c.dom.renderedSentinel)
          ? 'passed'
          : 'failed',
      observedStreamingDurationMs: streamingEndedMs - soakStartedMs,
      startedAt,
      endedAt: new Date(nowMs()).toISOString(),
      durationMs,
      fxPosture: spawnPlan.fxPosture,
      sampleIntervalMs,
      streamTickMs,
      appVersion,
      instanceId: userDataResolved.sanitizedInstanceId,
      provenance: {
        gitSha: provenance.gitSha,
        dirty: provenance.dirty,
        dirtyPathCount: provenance.dirtyPaths.length,
        dirtyPaths: provenance.dirtyPaths,
        dirtyTreeFingerprint: provenance.dirtyTreeFingerprint,
        isolatedWorktree: provenance.isolatedWorktree,
        note: provenance.dirty
          ? 'DIRTY SHARED CHECKOUT — diagnostic evidence only; never comparable to clean-tree baselines'
          : 'clean tree at build time; lane remains diagnostic-only by design'
      },
      build: { ...buildResult, buildIdentity },
      isolation,
      home,
      userDataPath: userDataResolved.userDataPath,
      artifactDir,
      spawn: {
        pid: childSession.pid,
        remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
        mainInspectorPort: spawnPlan.mainInspectorPort,
        electronEntry: spawnPlan.electronEntry,
        safety: spawnPlan.safety,
        portOwnership
      },
      repos: {
        count: scratch.repos.length,
        paths: scratch.repos.map((repo) => repo.path),
        gitInitAvailable: scratch.gitInitAvailable,
        registryPath: binding.registryPath,
        chatAssignments: binding.assignments
      },
      fixture: {
        chatCount: fixture.chats.length,
        pagedChatId,
        manifestPath: materialized.manifestPath
      },
      multiview: { ...paneDrive, finalPaneEvidence },
      streaming: { ...streamStats, totalTicks: tickIndex },
      sampling: {
        count: sampleCount,
        intervalMs: sampleIntervalMs,
        timeSeriesPath,
        probes
      },
      finalChecks,
      finalStoredFiles,
      unsupported
    })
    resultReport = report
    fsApi.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    resultData = {
      ok: report.status === 'passed',
      reportPath,
      timeSeriesPath,
      artifactDir,
      report,
      spawnPlan,
      sampleCount
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    try {
      const report = buildDiagnosticReportEnvelope({
        startedAt,
        failedAt: new Date(nowMs()).toISOString(),
        status: 'failed',
        error: { code: failure.code || null, message: failure.message },
        provenance: {
          gitSha: provenance.gitSha,
          dirty: provenance.dirty,
          dirtyPathCount: provenance.dirtyPaths.length,
          dirtyTreeFingerprint: provenance.dirtyTreeFingerprint
        },
        artifactDir,
        build: { ...buildResult, buildIdentity },
        isolation,
        spawn: childSession
          ? {
              pid: childSession.pid,
              electronEntry: spawnPlan.electronEntry,
              remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
              mainInspectorPort: spawnPlan.mainInspectorPort
            }
          : null,
        multiview: paneDrive,
        finalChecks,
        sampling: { count: sampleCount, timeSeriesPath },
        unsupported
      })
      fsApi.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch (reportError) {
      failure.reportWriteError = String(
        reportError && reportError.message ? reportError.message : reportError
      )
    }
    throw failure
  } finally {
    if (renderer && typeof renderer.close === 'function') {
      try {
        renderer.close()
      } catch (error) {
        cleanupFailures.push({
          phase: 'renderer.close',
          error: String(error && error.message ? error.message : error)
        })
      }
    }
    if (mainInspector && typeof mainInspector.close === 'function') {
      try {
        mainInspector.close()
      } catch (error) {
        cleanupFailures.push({
          phase: 'mainInspector.close',
          error: String(error && error.message ? error.message : error)
        })
      }
    }
    if (childSession) {
      try {
        termination = await (options.terminateChild || terminateExactChild)(
          childSession,
          options.terminateOptions || {}
        )
        const confirmTerminated =
          options.confirmTerminated ||
          (async (session) => {
            await pollUntil(
              () => {
                try {
                  process.kill(session.pid, 0)
                  return { ok: false, reason: 'owned child still present' }
                } catch (error) {
                  if (error.code === 'ESRCH') return { ok: true }
                  throw error
                }
              },
              { timeoutMs: 2000, intervalMs: 100, label: 'owned child exit observation' }
            )
            return {
              pid: session.pid,
              exited: true,
              method: 'PID existence probe after exact-group termination'
            }
          })
        termination.exitObservation = await confirmTerminated(childSession)
        childTerminationSucceeded = termination.exitObservation.exited === true
        if (!childTerminationSucceeded) {
          cleanupFailures.push({
            phase: 'confirmTerminated',
            error: 'owned child exit was not confirmed'
          })
        }
      } catch (error) {
        cleanupFailures.push({
          phase: 'terminateExactChild',
          error: String(error && error.message ? error.message : error)
        })
      }
    }
    {
      if (cleanupFailures.length) log(`[soak] cleanup failures: ${JSON.stringify(cleanupFailures)}`)
      try {
        const existing = fsApi.existsSync(reportPath)
          ? JSON.parse(fsApi.readFileSync(reportPath, 'utf8'))
          : null
        if (existing) {
          existing.cleanupFailures = cleanupFailures
          existing.childTerminationSucceeded = childTerminationSucceeded
          existing.termination = termination
          const stderrFile = path.join(artifactDir, 'child.stderr.log')
          const stderr = fsApi.existsSync(stderrFile) ? fsApi.readFileSync(stderrFile, 'utf8') : ''
          existing.runtimeWarnings = [
            ...(stderr.includes('external Host unavailable')
              ? [
                  'External Host launch unavailable at artifact appPath; child used production in-process Host fallback'
                ]
              : []),
            ...(stderr.includes('Failed to start Gemini MCP broker')
              ? [
                  'Legacy Gemini MCP socket failed under long isolated HOME; this soak does not exercise that broker'
                ]
              : [])
          ]
          if (!childTerminationSucceeded || cleanupFailures.length) existing.status = 'failed'
          if (resultReport) Object.assign(resultReport, existing)
          fsApi.writeFileSync(reportPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
        }
      } catch {
        // Report augmentation is best-effort; the primary result/error stands.
      }
    }
    // Never auto-delete artifacts.
  }
  if (resultData)
    resultData.ok =
      resultData.report.status === 'passed' && resultData.report.childTerminationSucceeded === true
  return resultData
}

module.exports = {
  DEFAULT_SOAK_DURATION_MS,
  DEFAULT_SMOKE_DURATION_MS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_STREAM_TICK_MS,
  DEFAULT_PANE_COUNT,
  DEFAULT_REPO_COUNT,
  MAX_SOAK_DURATION_MS,
  LAYOUT_BY_PANE_COUNT,
  PAGE_SOAK_GLOBAL,
  captureBuildProvenance,
  fingerprintBuildOutput,
  buildSoakFixture,
  bindChatsToWorkspaces,
  createScratchRepos,
  buildSoakSpawnPlan,
  runDiagnosticBuild,
  verifyLaunchedBuildIdentity,
  driveMultiviewPanes,
  samplePaneEvidence,
  createSoakStreamEngine,
  createMetricsSamplers,
  appendTimeSeriesSample,
  buildDiagnosticReportEnvelope,
  runMultiviewSoak
}
