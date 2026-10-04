import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ESTIMATED_PROFILE_END,
  measureMainWindowProfileShares,
  mainWindowProfileSharesForCapture
} = require('./mainWindowProfileShares.cjs')

type Frame = { name: string; url?: string; line?: number; column?: number }
type Row = { stack: Frame[]; us: number }

const BUNDLE_URL = 'file:///build/out/main/index-AbCd1234.js'
const CHUNK_URL = 'file:///build/out/main/chatUpdateTransport-Zz99.js'
// The profile clock starts at 1000 ms; performance.now() is that clock less 1000 ms.
const PROFILE_START_US = 1_000_000

/**
 * The built main bundle the profile's frames point into. Every function the
 * share rules name is declared here; line numbers below are zero-based, as V8
 * reports them.
 */
const BUNDLE_LINES = [
  /* 0 */ 'function readJson$7(file) {',
  /* 1 */ '}',
  /* 2 */ 'class MainDurabilityFlusher {',
  /* 3 */ '  pump() {',
  /* 4 */ '    const each = () => {',
  /* 5 */ '    }',
  /* 6 */ '  }',
  /* 7 */ '}',
  /* 8 */ 'class ProviderOutputPump {',
  /* 9 */ '  pump() {',
  /* 10 */ '  }',
  /* 11 */ '}',
  /* 12 */ 'function getChat(id) { return readChatRecordCached(id) }',
  /* 13 */ 'function publishHostThreadRecordTransferOffLoop(input) { canCloneRecord(input) }',
  /* 14 */ 'function prepareChatForPersistence(input) { persistDetailCheckpoint(input) }',
  /* 15 */ 'function saveChat(chat) { beginPublication(chat); finishPublication(chat); settleBurst(chat) }',
  /* 16 */ 'function persistIncrementalChatForHostSave(chat) { appendRunEvent(chat); writeRunQueueJobs(chat) }',
  /* 17 */ 'const checkpointChat = (chatId) => checkpoint(chatId)'
]
const CHUNK_LINES = ['function computeChatSubRevisions(chat) {', '}']
const buildScripts = (bundleLines = BUNDLE_LINES) => [
  { url: BUNDLE_URL, text: bundleLines.join('\n') },
  { url: CHUNK_URL, text: CHUNK_LINES.join('\n') }
]

const js = (name: string, line = 100, column = 0): Frame => ({
  name,
  url: BUNDLE_URL,
  line,
  column
})
const native = (name: string): Frame => ({ name, url: '' })
const nodeFs = (name: string): Frame => ({ name, url: 'node:fs' })
const sync = [nodeFs('fsyncSync'), native('fsync')]

/** One sample per row, in time order; `us` is the time since the row before. */
function buildProfile(rows: Row[], tailUs = 3000) {
  const nodes: Array<{ id: number; callFrame: object; children: number[] }> = [
    {
      id: 1,
      callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
      children: []
    }
  ]
  const byPath = new Map<string, number>([['', 1]])
  const samples: number[] = []
  const timeDeltas: number[] = []
  for (const row of rows) {
    let path = ''
    let parent = 1
    for (const frame of row.stack) {
      path += `/${frame.name}@${frame.url ?? ''}:${frame.line ?? -1}:${frame.column ?? -1}`
      let id = byPath.get(path)
      if (id === undefined) {
        id = nodes.length + 1
        nodes.push({
          id,
          callFrame: {
            functionName: frame.name,
            url: frame.url ?? '',
            lineNumber: frame.line ?? -1,
            columnNumber: frame.column ?? -1
          },
          children: []
        })
        nodes[parent - 1].children.push(id)
        byPath.set(path, id)
      }
      parent = id
    }
    samples.push(parent)
    timeDeltas.push(row.us)
  }
  const total = timeDeltas.reduce((sum, delta) => sum + delta, 0)
  return {
    nodes,
    samples,
    timeDeltas,
    startTime: PROFILE_START_US,
    endTime: PROFILE_START_US + total + tailUs
  }
}

function marker(tag: string, beforeMs: number, afterMs: number, windowId = 'light_beside_0') {
  const source = `source of ${tag}`
  return {
    tag,
    beforeMs,
    afterMs,
    pid: 42,
    timeOrigin: 5000,
    identity: 'main:42:performance.timeOrigin:5000',
    clockId: 'node.performance.now',
    windowId,
    source,
    sourceSha256: createHash('sha256').update(source).digest('hex')
  }
}
const markerFrame = (tag: string): Frame => ({ name: tag, url: `taskwraith-calibration-${tag}.js` })

/**
 * A 150 ms profile whose measured window is performance.now 30..130 ms. One
 * percent of the window is 1000 us. The first and last rows inside the window
 * each straddle one of its edges by 5 ms.
 */
function windowRows(): Row[] {
  const save = js('saveChat')
  const transfer = [save, js('materialize'), js('publishHostThreadRecordTransferOffLoop')]
  return [
    // Start marker: its samples end 11 ms and 17 ms into the profile.
    { stack: [markerFrame('start')], us: 11_000 },
    { stack: [markerFrame('start')], us: 6_000 },
    { stack: [native('(idle)')], us: 8_000 },
    // Straddles the window start: 5 ms before it, 5 ms inside.
    { stack: [native('(idle)')], us: 10_000 },
    { stack: [native('(idle)')], us: 5_000 },
    { stack: [native('(garbage collector)')], us: 5_000 },
    // Disk syncs, one per owner.
    { stack: [save, js('begin'), js('beginPublication'), js('writeJson'), ...sync], us: 8_000 },
    {
      stack: [save, js('persistIncrementalChatForHostSave'), js('appendLine'), ...sync],
      us: 3_000
    },
    { stack: [js('checkpointChat'), js('checkpoint'), js('atomicWrite'), ...sync], us: 1_000 },
    { stack: [js('appendRunEvent'), js('append'), ...sync], us: 3_000 },
    {
      stack: [
        save,
        js('prepareChatForPersistence'),
        js('persistDetailCheckpoint'),
        js('appendRunEvent'),
        ...sync
      ],
      us: 2_000
    },
    {
      stack: [js('updateRunQueueJob'), js('writeRunQueueJobs'), js('writeJson$5'), ...sync],
      us: 1_000
    },
    { stack: [js('recordUsage'), js('durableAppend'), ...sync], us: 2_000 },
    // Preparing a record for saving, outside the syncs.
    {
      stack: [save, js('prepareChatForPersistence'), js('externalizeToolActivityDetails')],
      us: 3_000
    },
    // Whole-thread reads, from two callers.
    {
      stack: [
        js('sendAgentCompatLine'),
        js('currentProviderRunPersistenceAuthority'),
        js('getChat'),
        js('readChatRecordCached'),
        js('readJson$7', 0, 17),
        nodeFs('readFileSync')
      ],
      us: 12_000
    },
    {
      stack: [
        js('broadcastStreamedTail'),
        js('getChat', 300),
        js('getChat', 301),
        js('readChatRecordCached'),
        js('readJson$7', 0, 17),
        native('parse')
      ],
      us: 6_000
    },
    // A small JSON file, not the thread.
    { stack: [js('getRunQueueJobs'), js('readJson$2'), native('parse')], us: 2_000 },
    // The Host record transfer.
    { stack: [...transfer, js('publish'), js('canCloneRecord')], us: 7_000 },
    { stack: [...transfer, js('publish'), native('postMessage')], us: 3_000 },
    { stack: [...transfer, js('publish')], us: 1_000 },
    // A postMessage that is not the transfer's.
    { stack: [js('send'), native('postMessage')], us: 1_000 },
    {
      stack: [
        js('broadcastStreamedTail'),
        { name: 'computeChatSubRevisions', url: CHUNK_URL, line: 0, column: 32 },
        // The line is inside the flusher's class in the other script.
        { name: 'stableStringify', url: CHUNK_URL, line: 4, column: 0 }
      ],
      us: 4_000
    },
    // The flusher's own bookkeeping: a method and an arrow function inside the
    // class, and a method of the same name in another class.
    { stack: [js('noteWrite', 6, 2), js('pump', 3, 6)], us: 6_000 },
    { stack: [js('pump', 3, 6), js('', 4, 17)], us: 2_000 },
    { stack: [js('onLine'), js('pump', 9, 6)], us: 1_000 },
    // Declared above the flusher's class in the bundle.
    { stack: [js('handleProviderOutput', 1)], us: 12_000 },
    // Straddles the window end: 5 ms inside, 5 ms after it.
    { stack: [native('(program)')], us: 10_000 },
    { stack: [native('(idle)')], us: 5_000 },
    // End marker: its samples end 141 ms and 147 ms into the profile.
    { stack: [markerFrame('end')], us: 1_000 },
    { stack: [markerFrame('end')], us: 6_000 }
  ]
}

const WINDOW = {
  id: 'light_beside_0',
  repetition: 0,
  startedAtMs: 30,
  endedAtMs: 130,
  clock: {
    clockId: 'node.performance.now',
    identity: 'main:42:performance.timeOrigin:5000',
    provenance: 'node-performance-now'
  }
}
const MARKERS = [marker('start', 10, 18), marker('end', 140, 148)]

function measure(overrides: Record<string, unknown> = {}) {
  return measureMainWindowProfileShares({
    profile: buildProfile(windowRows()),
    windows: [WINDOW],
    markers: MARKERS,
    buildScripts: buildScripts(),
    ...overrides
  })
}

describe('main-thread shares of a measured window', () => {
  it('reports where the main thread spent the window, clipped to its edges', () => {
    const result = measure()
    expect(result).toMatchObject({
      schemaVersion: 1,
      frameMatching: 'bundled_base_names_and_class_lines'
    })
    expect(result.profile).toEqual({
      samples: windowRows().length,
      durationMs: 150,
      backwardsDeltas: 0,
      backwardsUs: 0
    })
    expect(result.build).toEqual({
      scripts: 2,
      missingNames: [],
      classes: {
        MainDurabilityFlusher: {
          found: true,
          script: 'index-AbCd1234.js',
          firstLine: 2,
          lastLine: 7
        }
      }
    })
    const [window] = result.windows
    expect(window).toMatchObject({
      id: 'light_beside_0',
      repetition: 0,
      measured: true,
      clock: { basis: 'markers' },
      windowMs: 100,
      sampledMs: 100
    })
    expect(window.clock.uncertaintyMs).toBeCloseTo(1, 6)
    expect(window.shares).toEqual({
      idle: 0.1,
      busy: 0.9,
      sync: 0.2,
      wholeThreadRead: 0.18,
      allJsonRead: 0.2,
      wholeThreadCopy: 0.11,
      prepareForSave: 0.05,
      garbageCollection: 0.05,
      transcriptHashing: 0.04,
      flusherBookkeeping: 0.08
    })
  })

  it('names the owner of each disk sync, tool detail before the run event under it', () => {
    const [window] = measure().windows
    expect(window.syncOwners).toEqual({
      cataloguePublication: 0.08,
      journal: 0.04,
      runEvents: 0.03,
      toolDetail: 0.02,
      runQueue: 0.01,
      other: 0.02
    })
    expect(window.syncOtherCallers).toEqual([
      { callers: 'durableAppend <- recordUsage', share: 0.02 }
    ])
  })

  it('names the callers that read the whole thread and splits the copy', () => {
    const [window] = measure().windows
    expect(window.wholeThreadReadCallers).toEqual([
      { caller: 'currentProviderRunPersistenceAuthority', share: 0.12, via: 'sendAgentCompatLine' },
      { caller: 'broadcastStreamedTail', share: 0.06, via: '' }
    ])
    expect(window.wholeThreadCopyParts).toEqual({ canCloneRecord: 0.07, postMessage: 0.03 })
  })

  it('counts a bundled function by its base name, whatever suffix the bundler gave it', () => {
    const rows = windowRows().map((row) => ({
      ...row,
      stack: row.stack.map((frame) =>
        frame.name === 'readJson$7' ? { ...frame, name: 'readJson$a' } : frame
      )
    }))
    const [window] = measure({ profile: buildProfile(rows) }).windows
    expect(window.shares.wholeThreadRead).toBe(0.18)
    expect(window.shares.allJsonRead).toBe(0.2)
  })

  it('counts a sync only in the runtime, not in an app function of the same name', () => {
    const rows = windowRows()
    const other = rows.findIndex((row) => row.stack.at(-1)?.name === 'handleProviderOutput')
    rows[other] = { stack: [js('flushNow'), js('fsync')], us: rows[other].us }
    const [window] = measure({ profile: buildProfile(rows) }).windows
    expect(window.shares.sync).toBe(0.2)
  })

  it('reports each window of a capture on its own', () => {
    const second = { ...WINDOW, id: 'light_beside_1', repetition: 1, startedAtMs: 50 }
    const result = measure({
      windows: [WINDOW, second],
      markers: [
        ...MARKERS,
        marker('start', 10, 18, 'light_beside_1'),
        marker('end', 140, 148, 'light_beside_1')
      ]
    })
    expect(result.windows.map((window: { id: string }) => window.id)).toEqual([
      'light_beside_0',
      'light_beside_1'
    ])
    // 30..50 ms held the idle, the collector and 5 ms of the catalogue syncs.
    expect(result.windows[1]).toMatchObject({ measured: true, windowMs: 80, sampledMs: 80 })
    expect(result.windows[1].shares.idle).toBe(0)
    expect(result.windows[1].shares.sync).toBe(0.1875)
  })
})

describe('the flusher share and the build', () => {
  it('leaves the flusher share unmeasured without the build, and says why', () => {
    const result = measure({ buildScripts: null })
    expect(result.build).toEqual({ scripts: 0, unavailable: 'build_scripts_not_given' })
    expect(result.windows[0].shares.flusherBookkeeping).toBeNull()
    expect(result.windows[0].shares.sync).toBe(0.2)
  })

  it('refuses a class whose layout in the bundle it cannot bound', () => {
    // Its own closing brace is gone; the next brace at the margin closes
    // another class and must not be taken for it.
    const lines = [...BUNDLE_LINES]
    lines[7] = '  // the class never closes at the margin'
    const result = measure({ buildScripts: buildScripts(lines) })
    expect(result.build.classes.MainDurabilityFlusher).toEqual({
      found: false,
      reason: 'class_layout_unrecognised'
    })
    expect(result.windows[0].shares.flusherBookkeeping).toBeNull()
  })

  it('says a class is absent from the build rather than reporting it idle', () => {
    const lines = BUNDLE_LINES.map((line) =>
      line === 'class MainDurabilityFlusher {' ? 'class RenamedFlusher {' : line
    )
    const result = measure({ buildScripts: buildScripts(lines) })
    expect(result.build.classes.MainDurabilityFlusher).toEqual({
      found: false,
      reason: 'class_not_in_build'
    })
    expect(result.windows[0].shares.flusherBookkeeping).toBeNull()
  })

  it('leaves a share unmeasured when the build no longer has the function it matches', () => {
    const lines = BUNDLE_LINES.map((line) => line.replaceAll('readChatRecordCached', 'readChat'))
    const result = measure({ buildScripts: buildScripts(lines) })
    expect(result.build.missingNames).toEqual(['readChatRecordCached'])
    expect(result.windows[0].shares.wholeThreadRead).toBeNull()
    expect(result.windows[0].wholeThreadReadCallers).toBeNull()
    // A share that does not depend on the missing name is still measured.
    expect(result.windows[0].shares.wholeThreadCopy).toBe(0.11)
  })

  it('leaves the sync owners unmeasured when an owner function is missing from the build', () => {
    const lines = BUNDLE_LINES.map((line) => line.replaceAll('appendRunEvent', 'appendEvent'))
    const result = measure({ buildScripts: buildScripts(lines) })
    expect(result.build.missingNames).toEqual(['appendRunEvent'])
    expect(result.windows[0].syncOwners).toBeNull()
    expect(result.windows[0].shares.sync).toBe(0.2)
  })
})

describe('the profile clock', () => {
  it('absorbs the microsecond steps backwards V8 leaves in a profile', () => {
    const profile = buildProfile(windowRows())
    // The 5 ms idle sample becomes three: the second steps 2 us backwards and
    // the third gives the time back.
    profile.timeDeltas.splice(4, 1, 3_000, -2, 2_002)
    profile.samples.splice(4, 1, profile.samples[4], profile.samples[4], profile.samples[4])
    const result = measure({ profile })
    expect(result.profile).toMatchObject({ backwardsDeltas: 1, backwardsUs: 2 })
    expect(result.windows[0].measured).toBe(true)
    expect(result.windows[0].shares.idle).toBe(0.1)
  })

  it('refuses a profile whose clock runs backwards by more than jitter', () => {
    const profile = buildProfile(windowRows())
    profile.timeDeltas[4] = -2_000
    const result = measure({ profile })
    expect(result.windows).toEqual([
      {
        id: 'light_beside_0',
        repetition: 0,
        measured: false,
        reason: 'profile_unreadable:clock_runs_backwards'
      }
    ])
  })

  it('refuses a profile that is not a tree of frames sampled over time', () => {
    const valid = () => buildProfile(windowRows())
    type Profile = ReturnType<typeof valid>
    const frame = { functionName: 'extra', url: '' }
    // The profile with `nodes` added, the first of them as a child of the root.
    const withNodes = (profile: Profile, ...nodes: object[]) => ({
      ...profile,
      nodes: [
        {
          ...profile.nodes[0],
          children: [...profile.nodes[0].children, (nodes[0] as { id: number }).id]
        },
        ...profile.nodes.slice(1),
        ...nodes
      ]
    })
    const broken: Array<[string, (profile: Profile) => object]> = [
      ['no samples', (profile) => ({ ...profile, samples: [], timeDeltas: [] })],
      ['a delta short', (profile) => ({ ...profile, timeDeltas: profile.timeDeltas.slice(1) })],
      ['an end before its start', (profile) => ({ ...profile, endTime: profile.startTime })],
      ['no start time', (profile) => ({ ...profile, startTime: undefined })],
      ['a node that is not one', (profile) => ({ ...profile, nodes: [...profile.nodes, null] })],
      [
        'a node without a whole-number id',
        (profile) => withNodes(profile, { id: 0.5, callFrame: frame })
      ],
      [
        'two nodes with one id',
        (profile) => ({ ...profile, nodes: [...profile.nodes, profile.nodes[1]] })
      ],
      ['a node without a frame', (profile) => withNodes(profile, { id: 900 })],
      [
        'a frame without a name',
        (profile) => withNodes(profile, { id: 900, callFrame: { url: '' } })
      ],
      [
        'a frame without a url',
        (profile) => withNodes(profile, { id: 900, callFrame: { functionName: 'extra' } })
      ],
      [
        'children that are not a list',
        (profile) => withNodes(profile, { id: 900, callFrame: frame, children: {} })
      ],
      [
        'a child that is no node',
        (profile) => withNodes(profile, { id: 900, callFrame: frame, children: [999] })
      ],
      [
        'a child of two parents',
        (profile) =>
          withNodes(profile, {
            id: 900,
            callFrame: frame,
            children: [profile.nodes[0].children[0]]
          })
      ],
      [
        'a second root',
        (profile) => ({ ...profile, nodes: [...profile.nodes, { id: 900, callFrame: frame }] })
      ],
      [
        'a loop beside the tree',
        (profile) => ({
          ...profile,
          nodes: [
            ...profile.nodes,
            { id: 900, callFrame: frame, children: [901] },
            { id: 901, callFrame: frame, children: [900] }
          ]
        })
      ],
      [
        'nothing but a loop',
        (profile) => ({
          ...profile,
          nodes: [
            { id: 1, callFrame: frame, children: [2] },
            { id: 2, callFrame: frame, children: [1] }
          ],
          samples: profile.samples.map(() => 1)
        })
      ],
      [
        'a sample of no node',
        (profile) => ({ ...profile, samples: [999, ...profile.samples.slice(1)] })
      ],
      [
        'a delta that is not a number',
        (profile) => ({ ...profile, timeDeltas: [NaN, ...profile.timeDeltas.slice(1)] })
      ]
    ]
    for (const [what, breakIt] of broken) {
      const result = measure({ profile: breakIt(valid()) })
      expect(result.profile, what).toEqual({ unreadable: 'malformed' })
      expect(result.windows[0], what).toMatchObject({
        measured: false,
        reason: 'profile_unreadable:malformed'
      })
    }
    // The helper itself adds a sound node: the refusals above are the breaks'.
    expect(measure({ profile: withNodes(valid(), { id: 900, callFrame: frame }) }).profile).toEqual(
      { samples: windowRows().length, durationMs: 150, backwardsDeltas: 0, backwardsUs: 0 }
    )
  })

  it('does not measure a window whose markers do not calibrate the profile', () => {
    const [window] = measure({ markers: [MARKERS[0]] }).windows
    expect(window.measured).toBe(false)
    expect(window.reason).toMatch(/^profile_calibration_unqualified:/)
  })

  it('does not measure a window that reaches outside its markers', () => {
    const [window] = measure({ windows: [{ ...WINDOW, endedAtMs: 144 }] }).windows
    expect(window).toMatchObject({ measured: false, reason: 'window_outside_calibrated_interval' })
  })

  it('does not measure a window recorded on another clock than its markers', () => {
    const clock = { ...WINDOW.clock, identity: 'main:43:performance.timeOrigin:9000' }
    const [window] = measure({ windows: [{ ...WINDOW, clock }] }).windows
    expect(window).toMatchObject({ measured: false, reason: 'window_clock_identity_mismatch' })
  })

  it('does not measure a window without a receipt from main', () => {
    const [window] = measure({ windows: [{ id: null, repetition: 2 }] }).windows
    expect(window).toEqual({
      id: null,
      repetition: 2,
      measured: false,
      reason: 'main_window_receipt_absent'
    })
  })

  it('estimates the clock of a capture that recorded no markers, and says how far off it may be', () => {
    // The profile ended 150 ms after it began; wall clock 9150 is taken as its
    // end, so the window 9030..9130 is the same 100 ms as above.
    const legacy = { id: 'light_beside_0', repetition: 0, startedAtMs: 9030, endedAtMs: 9130 }
    const result = measure({
      windows: [legacy],
      markers: [],
      capture: { stopRequestedAtMs: 9145 },
      estimate: { lagMs: 5, lagBoundsMs: [0, 10] }
    })
    const [window] = result.windows
    expect(window).toMatchObject({
      measured: true,
      clock: {
        basis: 'estimated_profile_end',
        assumedLagMs: 5,
        lagBoundsMs: [0, 10]
      },
      windowMs: 100,
      sampledMs: 100
    })
    expect(window.shares.idle).toBe(0.1)
    expect(window.shares.sync).toBe(0.2)
    // With no lag the window sits 5 ms later in the profile: it loses the
    // 5 ms of idle at its start and gains the 5 ms of (program) at its end.
    // With 10 ms of lag it sits 5 ms earlier and gains idle instead.
    expect(window.shareBounds.idle).toEqual([0.05, 0.15])
    expect(window.shareBounds.sync).toEqual([0.2, 0.2])
  })

  it('carries each sync owner across the bounds of the estimate too', () => {
    // Profile 49..99 ms: the window opens 4 ms before the catalogue sync ends.
    // With no lag it sits 5 ms later and misses that sync and 1 ms of the
    // journal's; with 10 ms of lag it sits 5 ms earlier and holds all 8 ms.
    const legacy = { id: 'light_beside_0', repetition: 0, startedAtMs: 9049, endedAtMs: 9099 }
    const estimated = {
      capture: { stopRequestedAtMs: 9145 },
      estimate: { lagMs: 5, lagBoundsMs: [0, 10] }
    }
    const [window] = measure({ windows: [legacy], markers: [], ...estimated }).windows
    expect(window.syncOwners).toMatchObject({ cataloguePublication: 0.08, journal: 0.08 })
    expect(window.syncOwnerBounds).toEqual({
      toolDetail: [0.04, 0.04],
      cataloguePublication: [0, 0.16],
      journal: [0.06, 0.08],
      runEvents: [0.06, 0.06],
      runQueue: [0.02, 0.02],
      other: [0.04, 0.04]
    })
    // An owner the build cannot vouch for has no bounds either.
    const renamed = buildScripts(
      BUNDLE_LINES.map((line) => line.replace('appendRunEvent', 'appendEvent'))
    )
    const [unowned] = measure({
      windows: [legacy],
      markers: [],
      buildScripts: renamed,
      ...estimated
    }).windows
    expect(unowned.syncOwners).toBeNull()
    expect(unowned.syncOwnerBounds).toBeNull()
    // Nor has a share the build could not vouch for.
    const [unbuilt] = measure({
      windows: [legacy],
      markers: [],
      buildScripts: null,
      ...estimated
    }).windows
    expect(unbuilt.shares.flusherBookkeeping).toBeNull()
    expect(unbuilt.shareBounds.flusherBookkeeping).toBeNull()
    // At 10 ms of lag the window opens 1 ms before the collector finishes.
    expect(unbuilt.shareBounds.garbageCollection).toEqual([0, 0.02])
    // A window placed by its markers has no estimate to bound.
    expect(measure().windows[0]).not.toHaveProperty('syncOwnerBounds')
  })

  it('does not measure a legacy window without the time the profile was stopped', () => {
    const legacy = { id: 'light_beside_0', repetition: 0, startedAtMs: 9030, endedAtMs: 9130 }
    const [window] = measure({ windows: [legacy], markers: [] }).windows
    expect(window).toMatchObject({ measured: false, reason: 'profile_clock_unknown' })
  })

  it('does not measure a window the profile does not cover', () => {
    const legacy = { id: 'light_beside_0', repetition: 0, startedAtMs: 9100, endedAtMs: 9200 }
    const [window] = measure({
      windows: [legacy],
      markers: [],
      capture: { stopRequestedAtMs: 9145 },
      estimate: { lagMs: 5, lagBoundsMs: [0, 10] }
    }).windows
    expect(window).toMatchObject({ measured: false, reason: 'profile_does_not_cover_window' })
  })

  it('assumes a capture’s profile ended half a second after its stop was asked for', () => {
    expect(ESTIMATED_PROFILE_END).toEqual({ lagMs: 500, lagBoundsMs: [0, 3000] })
  })
})

describe('reading a capture from disk', () => {
  function fakeFs(files: Record<string, string>, directories: Record<string, string[]>) {
    return {
      readFileSync(file: string) {
        if (!(file in files)) throw new Error(`ENOENT ${file}`)
        return files[file]
      },
      readdirSync(directory: string) {
        if (!(directory in directories)) throw new Error(`ENOENT ${directory}`)
        return directories[directory]
      }
    }
  }
  const report = {
    captureDeadline: { captureStartedAt: new Date(9145).toISOString() },
    liveRounds: {
      lanes: {
        windows: [
          {
            repetition: 0,
            mainWindow: {
              id: WINDOW.id,
              startedAtMs: WINDOW.startedAtMs,
              endedAtMs: WINDOW.endedAtMs,
              clock: WINDOW.clock
            }
          },
          { repetition: 1, mainWindow: null }
        ]
      }
    }
  }
  const files = () => ({
    '/capture/perf-t2-report.json': JSON.stringify(report),
    '/capture/profiles/main.cpuprofile': JSON.stringify(buildProfile(windowRows())),
    '/capture/main-profile-calibration.json': JSON.stringify({
      calibration: { markers: MARKERS }
    }),
    '/build/out/main/index-AbCd1234.js': BUNDLE_LINES.join('\n'),
    '/build/out/main/chatUpdateTransport-Zz99.js': CHUNK_LINES.join('\n')
  })
  const directories = {
    '/build/out/main': ['index-AbCd1234.js', 'chatUpdateTransport-Zz99.js', 'notes.txt']
  }

  it('measures each window from the report, the profile, the markers and the build', () => {
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(files(), directories)
    })
    expect(result.build).toMatchObject({ scripts: 2, missingNames: [] })
    expect(result.windows[0]).toMatchObject({ measured: true, clock: { basis: 'markers' } })
    expect(result.windows[0].shares.flusherBookkeeping).toBe(0.08)
    expect(result.windows[1]).toEqual({
      id: null,
      repetition: 1,
      measured: false,
      reason: 'main_window_receipt_absent'
    })
  })

  it('measures without the build when its scripts are gone, and says so', () => {
    const result = mainWindowProfileSharesForCapture('/capture', { fs: fakeFs(files(), {}) })
    expect(result.build).toEqual({ scripts: 0, unavailable: 'build_scripts_unreadable' })
    expect(result.windows[0].shares.sync).toBe(0.2)
    expect(result.windows[0].shares.flusherBookkeeping).toBeNull()
  })

  it('matches the build by path when the profile escapes it in its URLs', () => {
    const profile = buildProfile(windowRows())
    for (const node of profile.nodes as Array<{ callFrame: { url: string } }>) {
      node.callFrame.url = node.callFrame.url.replace('file:///build/', 'file:///build%20dir/')
    }
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(
        {
          ...files(),
          '/capture/profiles/main.cpuprofile': JSON.stringify(profile),
          '/build dir/out/main/index-AbCd1234.js': BUNDLE_LINES.join('\n'),
          '/build dir/out/main/chatUpdateTransport-Zz99.js': CHUNK_LINES.join('\n')
        },
        { '/build dir/out/main': ['index-AbCd1234.js', 'chatUpdateTransport-Zz99.js'] }
      )
    })
    expect(result.build).toMatchObject({ scripts: 2, missingNames: [] })
    expect(result.windows[0].shares.flusherBookkeeping).toBe(0.08)
  })

  it('says so when the profile names no bundled script to read the build from', () => {
    for (const url of ['file:///elsewhere/lib/index.js', 'file:///a%2Fb/out/main/index.js']) {
      const profile = buildProfile(windowRows())
      for (const node of profile.nodes as Array<{ callFrame: { url: string } }>) {
        if (node.callFrame.url.startsWith('file:///build/')) node.callFrame.url = url
      }
      const result = mainWindowProfileSharesForCapture('/capture', {
        fs: fakeFs(
          { ...files(), '/capture/profiles/main.cpuprofile': JSON.stringify(profile) },
          directories
        )
      })
      expect(result.build).toEqual({ scripts: 0, unavailable: 'build_scripts_not_in_profile' })
      expect(result.windows[0].shares.sync).toBe(0.2)
    }
  })

  it('places a capture without markers by the time its report says the stop was asked for', () => {
    const legacy = {
      ...report,
      liveRounds: {
        lanes: {
          windows: [
            {
              repetition: 0,
              mainWindow: { id: WINDOW.id, startedAtMs: 9030, endedAtMs: 9130 }
            }
          ]
        }
      }
    }
    const without = files() as Record<string, string>
    delete without['/capture/main-profile-calibration.json']
    without['/capture/perf-t2-report.json'] = JSON.stringify(legacy)
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(without, directories),
      estimate: { lagMs: 5, lagBoundsMs: [0, 10] }
    })
    expect(result.windows[0]).toMatchObject({
      measured: true,
      clock: { basis: 'estimated_profile_end', assumedLagMs: 5 }
    })
    expect(result.windows[0].shares.sync).toBe(0.2)
  })

  it('reports an unreadable report instead of throwing', () => {
    const broken = files()
    delete (broken as Record<string, string>)['/capture/perf-t2-report.json']
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(broken, directories)
    })
    expect(result.windows).toEqual([])
    expect(result.unavailable).toBe('report_unreadable')
  })

  it('reports an unreadable profile instead of throwing', () => {
    const broken = files()
    delete (broken as Record<string, string>)['/capture/profiles/main.cpuprofile']
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(broken, directories)
    })
    expect(result.windows).toEqual([])
    expect(result.unavailable).toBe('cpu_profile_unreadable')
  })
})
