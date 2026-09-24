import { createRequire } from 'node:module'
import { afterEach, test } from 'vitest'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const {
  buildDiagnosticReportEnvelope,
  captureBuildProvenance,
  buildSoakSpawnPlan,
  verifyLaunchedBuildIdentity,
  createSoakStreamEngine,
  createMetricsSamplers,
  appendTimeSeriesSample,
  runMultiviewSoak
} = require('./multiviewSoakDriver.cjs')
const { parseArgs } = require('./runMultiviewSoak.cjs')

const tempRoots = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-soak-test-'))
  tempRoots.push(dir)
  return dir
}

function pageFixture(onSave = () => {}) {
  const chats = new Map()
  let saveMode = 'accept'
  const context = vm.createContext({
    window: {
      api: {
        getChat: async (id) =>
          structuredClone(chats.get(id) || { appChatId: id, persistenceRevision: 1, messages: [] }),
        saveChat: async (chat) => {
          if (saveMode === 'missing') return null
          if (saveMode === 'reject') return { persistenceRevision: chat.persistenceRevision }
          const saved = structuredClone({
            ...chat,
            persistenceRevision: chat.persistenceRevision + 1
          })
          chats.set(chat.appChatId, saved)
          onSave(saved)
          return saved
        }
      }
    },
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: () => ({
        textContent: [...chats.values()]
          .flatMap((c) => c.messages)
          .map((m) => m.content)
          .join(' ')
      })
    },
    performance: { now: () => 100 },
    requestAnimationFrame: () => {}
  })
  return {
    chats,
    context,
    mode: (mode) => {
      saveMode = mode
    },
    evaluate: async (expression) => vm.runInContext(expression, context)
  }
}

test('CLI is bounded, generates unique homes, and exposes no live attach or baseline bypass', () => {
  assert.equal(parseArgs([]).durationMs, 1800000)
  assert.equal(parseArgs(['--smoke']).durationMs, 90000)
  assert.notEqual(parseArgs([]).home, parseArgs([]).home)
  for (const arg of [
    '--port=9222 --launch',
    '--panes=5',
    '--duration-ms=0',
    '--sample-ms=NaN',
    '--repos=9',
    '--attach=123',
    '--skip-build',
    '--allow-dirty-launch'
  ]) {
    assert.throws(() => parseArgs([arg]))
  }
  assert.throws(() => parseArgs(['--port=9555', '--inspect-port=9555']))
  assert.equal(parseArgs(['--duration-ms=1800000', '--panes=8', '--repos=4']).paneCount, 8)
})

test('dirty provenance fingerprints actual bytes, not only path names; labels never claim baseline', (t) => {
  const dir = temp(t)
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  fs.mkdirSync(path.join(dir, 'src'))
  const source = path.join(dir, 'src', 'sample.ts')
  fs.writeFileSync(source, 'first')
  const before = captureBuildProvenance(dir)
  fs.writeFileSync(source, 'other')
  const after = captureBuildProvenance(dir)
  assert.equal(before.dirty, true)
  assert.equal(before.dirtyTreeFingerprint, after.dirtyTreeFingerprint)
  assert.notEqual(before.contentFingerprint, after.contentFingerprint)
  const report = buildDiagnosticReportEnvelope({
    provenance: after,
    diagnosticOnly: false,
    authoritativeBaseline: true,
    authoritativeEvidence: true,
    baseline: 'clean'
  })
  assert.equal(report.diagnosticOnly, true)
  assert.equal(report.authoritativeBaseline, false)
  assert.equal(report.authoritativeEvidence, false)
  assert.equal(report.baseline, 'none')
  assert.match(report.providerTraffic, /simulated/)
})

test('spawn plan uses exact fresh entry, distinct debug ports, isolated HOME and normal FX', () => {
  const plan = buildSoakSpawnPlan({
    buildOutDir: '/repo/perf-homes/fresh/artifacts/build',
    repoRoot: '/repo',
    home: '/repo/perf-homes/fresh',
    instanceId: 'perf-soak-test',
    remoteDebuggingPort: 9555,
    mainInspectorPort: 9955,
    adapters: { resolveElectronPath: () => '/repo/node_modules/Electron' }
  })
  assert.equal(plan.argv.includes('.'), false)
  // path.resolve: the plan is platform-shaped (drive letter + backslashes on win32).
  assert.ok(
    plan.argv.includes(path.resolve('/repo/perf-homes/fresh/artifacts/build/main/index.js'))
  )
  assert.equal(plan.env.HOME, path.resolve('/repo/perf-homes/fresh'))
  assert.equal(plan.fxPosture, 'cinematic_default')
  assert.equal(
    plan.argv.some((arg) => /disable-gpu|no-sandbox|user-data-dir/.test(arg)),
    false
  )
  assert.equal(plan.safety.attachOnlyExactChild, true)
})

test('build identity rejects a shared output even when appPath happens to be inside the artifact', async () => {
  const inspector = (argv1, appPath) => ({
    post: async () => ({ result: { value: JSON.stringify({ argv1, appPath, pid: 41 }) } })
  })
  await assert.rejects(
    verifyLaunchedBuildIdentity(inspector('/repo/out/main/index.js', '/fresh'), '/fresh'),
    /NOT the fresh/
  )
  const valid = await verifyLaunchedBuildIdentity(
    inspector('/fresh/main/index.js', '/fresh/main'),
    '/fresh'
  )
  assert.equal(valid.verified, true)
  assert.equal(valid.pid, 41)
})

test('identity accepts Electron switches before the exact entry, with artifact appPath', async () => {
  const inspector = {
    post: async () => ({
      result: {
        value: JSON.stringify({
          argv1: '--use-mock-keychain',
          argv: ['/Electron', '--use-mock-keychain', '/fresh/main/index.js', '--inspect=9955'],
          appPath: '/fresh/main',
          pid: 41
        })
      }
    })
  }
  const result = await verifyLaunchedBuildIdentity(inspector, '/fresh')
  assert.equal(result.entry, path.resolve('/fresh/main/index.js'))
  assert.equal(result.verified, true)
})

test('stream engine executes real page expressions, advances revisions and checks final text', async () => {
  const page = pageFixture()
  const engine = createSoakStreamEngine({ page, paddingChars: 80 })
  await Promise.all(['a', 'b'].map((id) => engine.seedChat(id)))
  for (let i = 0; i < 3; i++)
    await Promise.all(['a', 'b'].map((id) => engine.appendTick(id, 'SOAK ' + id)))
  const { sentinel } = await engine.finalMessage('a')
  assert.equal((await engine.verifyFinalStoredMessage('a', sentinel)).sentinelIsLastMessage, true)
  assert.equal(engine.stats().acceptedSaves.a, 4)
  assert.equal(engine.stats().acceptedSaves.b, 3)
  assert.match(page.chats.get('b').messages[2].content, /SOAK b tick 3/)
  assert.equal(engine.stats().canonicalRevisions.a, 5)
  page.mode('missing')
  await assert.rejects(engine.appendTick('b', 'lost'), /missing revision/)
  page.mode('reject')
  await assert.rejects(engine.appendTick('a', 'lost'), /did not advance/)
  assert.equal(engine.stats().acceptedSaves.a, 4)
})

test('metrics execute main expression with PID/heap/process units and wire CDP heap/DOM', async () => {
  const page = pageFixture()
  const mainContext = vm.createContext({
    process: {
      pid: 41,
      memoryUsage: () => ({ rss: 987654, heapUsed: 12345 }),
      cwd: () => '/repo',
      getBuiltinModule: () => ({
        createRequire: () => () => ({
          app: {
            getAppMetrics: () => [{ pid: 42, type: 'GPU', memory: { workingSetSize: 4096 } }]
          },
          webContents: {
            getAllWebContents: () => [
              {
                getType: () => 'window',
                id: 7,
                getOSProcessId: () => 43,
                getURL: () => 'file:///fresh/index.html'
              }
            ]
          }
        })
      })
    },
    setInterval: () => ({ unref: () => {} })
  })
  const calls = []
  const samplers = createMetricsSamplers({
    page,
    mainInspector: {
      post: async (method, args) => ({
        result: { value: vm.runInContext(args.expression, mainContext) }
      })
    },
    rendererSend: async (method) => {
      calls.push(method)
      return {
        metrics: [
          { name: 'Nodes', value: 432 },
          { name: 'JSHeapUsedSize', value: 56789 }
        ]
      }
    }
  })
  await samplers.installProbes()
  const main = await samplers.sampleMain()
  assert.equal(main.pid, 41)
  assert.equal(main.memoryUsage.rss, 987654)
  assert.equal(main.appMetrics[0].workingSetSizeKb, 4096)
  assert.equal(main.appMetrics[0].privateBytesKb, null)
  assert.equal(main.renderers[0].pid, 43)
  assert.ok(main.sampledAt > 0)
  const renderer = await samplers.sampleRenderer()
  assert.equal(renderer.performance.Nodes, 432)
  assert.equal(renderer.performance.JSHeapUsedSize, 56789)
  assert.deepEqual(calls, [
    'Performance.enable',
    'Input.dispatchMouseEvent',
    'Performance.getMetrics'
  ])
  const broken = createMetricsSamplers({
    page: {
      evaluate: async () => {
        throw new Error('renderer gone')
      }
    },
    mainInspector: {
      post: async () => {
        throw new Error('inspector gone')
      }
    },
    rendererSend: async () => ({})
  })
  assert.match((await broken.sampleMain()).unavailable, /inspector gone/)
  assert.match((await broken.sampleRenderer()).performance.unavailable, /no metrics/)
  assert.match((await broken.sampleRenderer()).frames.unavailable, /renderer gone/)
})

function lifecycle(t, overrides = {}) {
  const dir = temp(t)
  const userData = require('./devUserDataPath.cjs').resolveUnpackagedDevUserDataPath({
    instanceId: 'perf-soak-unit',
    home: path.join(dir, 'perf-homes', 'fresh')
  }).userDataPath
  const page = pageFixture((chat) => {
    fs.mkdirSync(path.join(userData, 'chats'), { recursive: true })
    fs.writeFileSync(path.join(userData, 'chats', chat.appChatId + '.json'), JSON.stringify(chat))
  })
  const events = []
  let time = 100000
  const options = {
    repoRoot: dir,
    home: path.join(dir, 'perf-homes', 'fresh'),
    instanceId: 'perf-soak-unit',
    durationMs: 5000,
    sampleIntervalMs: 500,
    streamTickMs: 500,
    paneCount: 2,
    repoCount: 2,
    provenance: {
      gitSha: 'abc123',
      dirty: true,
      dirtyPaths: ['src/peer.ts'],
      dirtyTreeFingerprint: 'paths-only',
      contentFingerprint: 'bytes'
    },
    nowMs: () => time,
    sleep: async (ms) => {
      time += ms
    },
    repoAdapters: { execFileSync: () => {} },
    materialize: () => ({ manifestPath: 'fixture.json' }),
    buildAdapters: {
      build: async () => {
        events.push('build')
        return { steps: [] }
      }
    },
    spawnPlanAdapters: { resolveElectronPath: () => '/fake/Electron' },
    portAdapters: {
      probePort: async () => ({ occupied: false }),
      probeCdp: async () => ({ reachable: false })
    },
    spawnChild: ({ spawnPlan }) => {
      events.push('spawn')
      return {
        pid: 41,
        pgid: 41,
        remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
        mainInspectorPort: spawnPlan.mainInspectorPort
      }
    },
    portOwnershipAdapters: { listPortPids: async () => [41], getProcessIdentity: async () => null },
    attachRenderer: async () => {
      events.push('attach')
      return {
        send: async (method, args) =>
          method === 'Runtime.evaluate'
            ? { result: { value: await page.evaluate(args.expression) } }
            : { metrics: [{ name: 'Nodes', value: 567 }] },
        close: () => events.push('renderer-close')
      }
    },
    cdpAdapters: {
      httpGetJson: async () => [{ webSocketDebuggerUrl: 'ws://127.0.0.1:9955/owned' }]
    },
    attachMainInspector: async () => ({
      post: async () => ({
        result: { value: JSON.stringify({ pid: 41, memoryUsage: { rss: 23456 } }) }
      }),
      close: () => events.push('inspector-close')
    }),
    verifyIsolatedHomeAndUserData: async () => ({ ok: true }),
    verifyBuildIdentity: async () => ({ verified: true, pid: 41 }),
    drivePanes: async ({ paneChats }) => ({
      layout: 'vertical-2',
      assigned: paneChats.map((chat, paneIndex) => ({ ...chat, paneIndex }))
    }),
    confirmTerminated: async (session) => ({ pid: session.pid, exited: true }),
    terminateChild: async (session) => {
      events.push('terminate:' + session.pid)
      return { pid: session.pid, terminated: true }
    },
    ...overrides
  }
  return { options, page, events, elapsed: () => time - 100000 }
}

test('orchestrator runs duration, samples, concurrent panes and final text, records exact cleanup', async (t) => {
  const fixture = lifecycle(t)
  const result = await runMultiviewSoak(fixture.options)
  assert.equal(result.ok, true)
  assert.equal(fixture.elapsed(), 5000)
  assert.equal(result.report.streaming.totalTicks, 10)
  assert.equal(result.report.finalChecks.length, 2)
  assert.ok(
    result.report.finalChecks.every(
      (check) => check.dom.renderedSentinel && check.stored.sentinelIsLastMessage
    )
  )
  const samples = fs.readFileSync(result.timeSeriesPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(samples.length, 10)
  assert.equal(samples[0].renderer.performance.Nodes, 567)
  assert.equal(samples[0].main.memoryUsage.rss, 23456)
  assert.equal(samples[9].elapsedMs, 4500)
  assert.equal(result.report.childTerminationSucceeded, true)
  assert.deepEqual(fixture.events.slice(-3), ['renderer-close', 'inspector-close', 'terminate:41'])
  assert.equal(JSON.parse(fs.readFileSync(result.reportPath)).termination.pid, 41)
})

test('occupied target refuses before spawn, attach or terminate; never reuses HOME', async (t) => {
  const fixture = lifecycle(t, {
    portAdapters: {
      probePort: async () => ({ occupied: true }),
      probeCdp: async () => ({ reachable: true })
    }
  })
  await assert.rejects(runMultiviewSoak(fixture.options), /preflight refused/)
  assert.deepEqual(fixture.events, ['build'])
  await assert.rejects(runMultiviewSoak(fixture.options), /Refuse nonempty HOME/)
  await assert.rejects(
    runMultiviewSoak({ ...fixture.options, mainInspectorUrl: 'ws://live:9222/x' }),
    /arbitrary inspector/
  )
})

test('foreign listener prevents attach and cleanup targets only the spawned child', async (t) => {
  const fixture = lifecycle(t, {
    portOwnershipAdapters: { listPortPids: async () => [999], getProcessIdentity: async () => null }
  })
  await assert.rejects(runMultiviewSoak(fixture.options), /not in owned Electron tree/)
  assert.deepEqual(fixture.events, ['build', 'spawn', 'terminate:41'])
})

test('post-attach failure closes sessions and records failed report with exact PID', async (t) => {
  const fixture = lifecycle(t, {
    verifyBuildIdentity: async () => {
      throw new Error('stale build')
    }
  })
  await assert.rejects(runMultiviewSoak(fixture.options), /stale build/)
  assert.deepEqual(fixture.events.slice(-2), ['inspector-close', 'terminate:41'])
  assert.equal(fixture.events.includes('attach'), false)
  const reportPath = path.join(
    fixture.options.home,
    'soak-artifacts-perf-soak-unit',
    'soak-report.json'
  )
  const report = JSON.parse(fs.readFileSync(reportPath))
  assert.equal(report.status, 'failed')
  assert.equal(report.spawn.pid, 41)
  assert.equal(report.childTerminationSucceeded, true)
})

test('append time series survives beyond the in-app 120-entry ring', (t) => {
  const target = path.join(temp(t), 'samples.jsonl')
  for (let seq = 1; seq <= 145; seq++) appendTimeSeriesSample(target, { seq })
  const rows = fs.readFileSync(target, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.length, 145)
  assert.equal(rows[0].seq, 1)
  assert.equal(rows[144].seq, 145)
})

test('failed rendered final text makes the result fail despite accepted saves', async (t) => {
  const fixture = lifecycle(t)
  fixture.page.context.document.querySelector = () => ({ textContent: 'stale transcript' })
  const result = await runMultiviewSoak(fixture.options)
  assert.equal(result.ok, false)
  assert.equal(result.report.status, 'failed')
  assert.ok(result.report.finalChecks.every((check) => check.stored.sentinelIsLastMessage))
  assert.ok(result.report.finalChecks.every((check) => !check.dom.renderedSentinel))
  assert.equal(result.report.childTerminationSucceeded, true)
})

test('cleanup error survives into final report and CLI outcome', async (t) => {
  const fixture = lifecycle(t, {
    terminateChild: async () => {
      throw new Error('owned child still alive')
    }
  })
  const result = await runMultiviewSoak(fixture.options)
  assert.equal(result.report.status, 'failed')
  assert.equal(result.ok, false)
  assert.equal(result.report.childTerminationSucceeded, false)
  assert.match(result.report.cleanupFailures[0].error, /owned child still alive/)
})

test('interruption during streaming still cleans up only the child', async (t) => {
  const controller = new AbortController()
  const fixture = lifecycle(t, { signal: controller.signal })
  const sleep = fixture.options.sleep
  fixture.options.sleep = async (ms) => {
    await sleep(ms)
    controller.abort()
  }
  await assert.rejects(runMultiviewSoak(fixture.options), /interrupted/)
  assert.equal(fixture.events.at(-1), 'terminate:41')
})
