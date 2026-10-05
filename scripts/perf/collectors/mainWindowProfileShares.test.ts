import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ESTIMATED_PROFILE_END,
  LOOSE_CLOCK_SHARE_TOLERANCE,
  measureMainWindowProfileShares,
  mainWindowsOfReport,
  mainWindowProfileSharesForCapture,
  mainWindowProfileSharesForReport
} = require('./mainWindowProfileShares.cjs')

type Frame = { name: string; url?: string; line?: number; column?: number }
/** `atLine` is the line V8 puts the sample on, one-based; a function's first line by default. */
type Row = { stack: Frame[]; us: number; atLine?: number }

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
  /* 17 */ 'const checkpointChat = (chatId) => checkpoint(chatId)',
  /* 18 */ 'function recordUsage(entry) { releaseLock(entry) }',
  /* 19 */ 'function commitUnderFence(work) { acquireInstanceFence(work); releaseInstanceFence(work) }',
  /* 20 */ 'function persistOrThrow() {}',
  /* 21 */ 'function assertSourceMutationAllowed(id) { assertRecoveryHoldAllows(id); captureThreadCatalogueWitness(id) }',
  /* 22 */ 'function getCurrentChatAuthorityMetadata(id) { rememberChatRecord(id) }',
  /* 23 */ 'function joinDurability(operation) {',
  /* 24 */ '  while (!operation.done) Atomics.wait(operation.words, 0, 1, 5)',
  /* 25 */ '}',
  /* 26 */ 'const later = (words) => Atomics.waitAsync(words, 0, 1)'
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

/**
 * One sample per row, in time order; `us` is the time since the row before.
 * A sample of a script's function is ticked on its line, as V8 does.
 */
function buildProfile(rows: Row[], tailUs = 3000) {
  const nodes: Array<{
    id: number
    callFrame: object
    children: number[]
    positionTicks?: Array<{ line: number; ticks: number }>
  }> = [
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
    const leaf = row.stack[row.stack.length - 1]
    if (leaf.url) {
      const line = row.atLine ?? (leaf.line ?? 0) + 1
      const ticks = (nodes[parent - 1].positionTicks ??= [])
      const tick = ticks.find((entry) => entry.line === line)
      if (tick) tick.ticks += 1
      else ticks.push({ line, ticks: 1 })
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
      },
      atomicsWaitLines: [{ script: 'index-AbCd1234.js', line: 25 }]
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
      flusherBookkeeping: 0.08,
      plainFileCalls: 0,
      atomicsWait: 0
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
      usageLedger: 0.02,
      workspaceLock: 0,
      sessionCheckpoint: 0,
      catalogueChecks: 0,
      chatAuthority: 0,
      other: 0
    })
    expect(window.syncOtherCallers).toEqual([])
  })

  /** The window's rows, its 12 ms of busy time after the flusher spent as given. */
  function spendingTheRest(rows: Row[]) {
    const all = windowRows()
    const at = all.findIndex((row) => row.stack.at(-1)?.name === 'handleProviderOutput')
    expect(rows.reduce((sum, row) => sum + row.us, 0)).toBe(all[at].us)
    all.splice(at, 1, ...rows)
    return all
  }

  it('names the syncs left beside the thread’s stores, and leaves a store’s own to it inside them', () => {
    const fenced = [js('releaseAllForRun'), js('commitUnderFence')]
    const rows = spendingTheRest([
      {
        stack: [
          ...fenced,
          js('acquireTransitionFence'),
          js('acquireInstanceFence'),
          js('atomicCreateRegularFile'),
          js('fsyncDirectory'),
          ...sync
        ],
        us: 3_000
      },
      {
        stack: [js('commitUnderFence'), js('releaseInstanceFence'), js('fsyncDirectory'), ...sync],
        us: 1_000
      },
      // A journal sync made inside a fenced commit is still the journal's.
      { stack: [...fenced, js('persistIncrementalChatForHostSave'), ...sync], us: 2_000 },
      // The ledger's lock file goes as it appends: `releaseLock` is the ledger's own.
      {
        stack: [
          js('recordUsage'),
          js('append'),
          js('releaseLock'),
          js('retireRegularFileNoFollow'),
          js('fsyncDirectoryBestEffort'),
          ...sync
        ],
        us: 2_000
      },
      {
        stack: [js('updateSettings'), js('writeJson'), js('writeJsonAdmitted'), ...sync],
        us: 1_000
      },
      { stack: [js('handleProviderOutput', 1)], us: 3_000 }
    ])
    const [window] = measure({ profile: buildProfile(rows) }).windows
    expect(window.shares.sync).toBe(0.29)
    expect(window.syncOwners).toEqual({
      cataloguePublication: 0.08,
      journal: 0.06,
      runEvents: 0.03,
      toolDetail: 0.02,
      runQueue: 0.01,
      usageLedger: 0.04,
      workspaceLock: 0.04,
      sessionCheckpoint: 0,
      catalogueChecks: 0,
      chatAuthority: 0,
      other: 0.01
    })
    expect(window.syncOtherCallers).toEqual([
      { callers: 'writeJsonAdmitted <- writeJson <- updateSettings', share: 0.01 }
    ])
  })

  it('measures the plain file calls apart from syncs and reads, by owner and by call', () => {
    const checkpoint = [
      js('persistSessionCheckpoint'),
      js('upsertFromChat'),
      js('persist'),
      js('persistOrThrow')
    ]
    const rows = spendingTheRest([
      {
        stack: [
          js('saveChat'),
          js('begin'),
          js('beginPublication'),
          js('writeJson'),
          nodeFs('renameSync'),
          native('rename')
        ],
        us: 2_000
      },
      // Named by the call the app made, not the one the runtime made inside it.
      {
        stack: [...checkpoint, nodeFs('writeFileSync'), nodeFs('openSync'), native('open')],
        us: 2_000
      },
      // A sync inside a plain call (a write asked to flush) is a sync, owned the same way.
      { stack: [...checkpoint, nodeFs('writeFileSync'), ...sync], us: 1_000 },
      {
        stack: [
          js('saveChat'),
          js('begin'),
          js('assertSourceMutationAllowed'),
          js('isErasing'),
          js('epochRecord'),
          js('readJson$2'),
          nodeFs('openSync'),
          native('open')
        ],
        us: 1_000
      },
      // The runtime's own code under the call counts with it.
      {
        stack: [
          js('readCurrent'),
          js('getCurrentChatAuthorityMetadata'),
          js('authorityMetadataSource'),
          nodeFs('statSync'),
          { name: 'isURL', url: 'node:internal/url' }
        ],
        us: 1_000
      },
      {
        stack: [
          js('peopleDonorMutationOwned'),
          js('readPeopleMigrationLease'),
          nodeFs('existsSync'),
          native('existsSync')
        ],
        us: 1_000
      },
      // Not plain file calls: an app function of a runtime call's name, the
      // runtime's own code inside a sync, a read, and a directory's listing.
      { stack: [js('flushNow'), js('openSync')], us: 1_000 },
      {
        stack: [
          js('appendRunEvent'),
          nodeFs('fsyncSync'),
          { name: 'isInt32', url: 'node:internal/validators' }
        ],
        us: 1_000
      },
      { stack: [js('loadState'), nodeFs('readFileSync'), native('readFileUtf8')], us: 1_000 },
      { stack: [js('listThreads'), nodeFs('readdirSync'), native('readdir')], us: 1_000 }
    ])
    const [window] = measure({
      profile: buildProfile(rows),
      windows: [{ ...WINDOW, modelTurns: 10 }]
    }).windows
    expect(window.shares).toMatchObject({ sync: 0.21, plainFileCalls: 0.07, allJsonRead: 0.21 })
    expect(window.perModelTurn).toEqual({
      mainBusyMs: 9,
      syncMs: 2.1,
      plainFileCallMs: 0.7,
      atomicsWaitMs: 0,
      restMs: 6.2
    })
    expect(window.syncOwners).toMatchObject({ sessionCheckpoint: 0.01, other: 0 })
    expect(window.plainFileCallOwners).toEqual({
      cataloguePublication: 0.02,
      journal: 0,
      runEvents: 0,
      toolDetail: 0,
      runQueue: 0,
      usageLedger: 0,
      workspaceLock: 0,
      sessionCheckpoint: 0.02,
      catalogueChecks: 0.01,
      chatAuthority: 0.01,
      other: 0.01
    })
    expect(window.plainFileCallOtherCallers).toEqual([
      { callers: 'readPeopleMigrationLease <- peopleDonorMutationOwned', share: 0.01 }
    ])
    expect(window.plainFileCallsByCall).toEqual([
      { call: 'renameSync', share: 0.02 },
      { call: 'writeFileSync', share: 0.02 },
      { call: 'existsSync', share: 0.01 },
      { call: 'openSync', share: 0.01 },
      { call: 'statSync', share: 0.01 }
    ])
  })

  it('measures the main thread held in Atomics.wait, which V8 gives no frame of its own', () => {
    // V8 counts a wait as self time of the function that calls Atomics.wait,
    // ticked on the line of the call.
    const rows = spendingTheRest([
      { stack: [js('saveChat'), js('joinDurability', 23)], us: 4_000, atLine: 25 },
      // Another path to the same function: by its ticks, half of it waits.
      { stack: [js('flushNow'), js('joinDurability', 23)], us: 1_000, atLine: 25 },
      { stack: [js('flushNow'), js('joinDurability', 23)], us: 1_000, atLine: 24 },
      // An asynchronous wait does not hold the thread, and a line that waits
      // in one script says nothing of the same line in another.
      { stack: [js('later', 26)], us: 2_000, atLine: 27 },
      {
        stack: [{ name: 'computeChatSubRevisions', url: CHUNK_URL, line: 0, column: 32 }],
        us: 1_000,
        atLine: 25
      },
      { stack: [js('handleProviderOutput', 1)], us: 3_000 }
    ])
    const [window] = measure({
      profile: buildProfile(rows),
      windows: [{ ...WINDOW, modelTurns: 5 }]
    }).windows
    expect(window.shares.atomicsWait).toBe(0.05)
    expect(window.shares.sync).toBe(0.2)
    // A wait is a part of busy time of its own, apart from the rest.
    expect(window.perModelTurn).toEqual({
      mainBusyMs: 18,
      syncMs: 4,
      plainFileCallMs: 0,
      atomicsWaitMs: 1,
      restMs: 13
    })
  })

  it('leaves the wait unmeasured where it cannot be found, and zero where nothing can wait', () => {
    const rows = spendingTheRest([
      { stack: [js('saveChat'), js('joinDurability', 23)], us: 4_000, atLine: 25 },
      { stack: [js('handleProviderOutput', 1)], us: 8_000 }
    ])
    // Without the build there are no lines to look for.
    expect(
      measure({ profile: buildProfile(rows), buildScripts: null }).windows[0].shares
    ).toMatchObject({
      atomicsWait: null,
      sync: 0.2
    })
    // Without line ticks the profile cannot say which line a sample was on.
    const unticked = buildProfile(rows)
    for (const node of unticked.nodes) delete node.positionTicks
    expect(measure({ profile: unticked }).windows[0].shares.atomicsWait).toBeNull()
    // A build that never calls it cannot wait in it, ticks or none.
    const waitless = buildScripts(
      BUNDLE_LINES.map((line) => line.replace('Atomics.wait(', 'poll('))
    )
    const [window] = measure({ profile: unticked, buildScripts: waitless }).windows
    expect(window.shares.atomicsWait).toBe(0)
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
    expect(result.windows[0].shares.atomicsWait).toBeNull()
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

  it('leaves an owner the build cannot vouch for unmeasured, with every owner after it and other', () => {
    const lines = BUNDLE_LINES.map((line) => line.replaceAll('appendRunEvent', 'appendEvent'))
    const result = measure({ buildScripts: buildScripts(lines) })
    expect(result.build.missingNames).toEqual(['appendRunEvent'])
    // Its syncs could have fallen to an owner after it, never to one before.
    expect(result.windows[0].syncOwners).toEqual({
      toolDetail: 0.02,
      cataloguePublication: 0.08,
      journal: 0.04,
      runEvents: null,
      runQueue: null,
      usageLedger: null,
      workspaceLock: null,
      sessionCheckpoint: null,
      catalogueChecks: null,
      chatAuthority: null,
      other: null
    })
    expect(result.windows[0].syncOtherCallers).toBeNull()
    expect(result.windows[0].shares.sync).toBe(0.2)
  })

  it('does the same for the plain file calls’ owners, but still counts the calls', () => {
    const lines = BUNDLE_LINES.map((line) => line.replaceAll('persistOrThrow', 'persistNow'))
    const [window] = measure({ buildScripts: buildScripts(lines) }).windows
    const unvouched = {
      sessionCheckpoint: null,
      catalogueChecks: null,
      chatAuthority: null,
      other: null
    }
    expect(window.syncOwners).toMatchObject({ usageLedger: 0.02, workspaceLock: 0, ...unvouched })
    expect(window.plainFileCallOwners).toEqual({
      toolDetail: 0,
      cataloguePublication: 0,
      journal: 0,
      runEvents: 0,
      runQueue: 0,
      usageLedger: 0,
      workspaceLock: 0,
      ...unvouched
    })
    expect(window.plainFileCallOtherCallers).toBeNull()
    expect(window.shares.plainFileCalls).toBe(0)
    expect(window.plainFileCallsByCall).toEqual([])
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

  /**
   * Markers of a real capture's shape: 40 ms brackets sampled about every
   * 1.3 ms, so each anchor is 2.6 to 2.8 ms wide, more than the calibration's
   * own 2 ms. The window opens 350 ms after the first marker and closes 3.2 s
   * before the second. The profile clock is performance.now plus 1000 ms.
   */
  function looseRows(windowMs: number): Row[] {
    const save = js('saveChat')
    const read = [
      js('reconcile'),
      js('getChat'),
      js('readChatRecordCached'),
      js('readJson$7', 0, 17)
    ]
    return [
      { stack: [native('(idle)')], us: 10_000 },
      // Start marker 10..50 ms: samples end 11.3 and 48.7 ms into the window's clock.
      { stack: [markerFrame('start')], us: 1_300 },
      { stack: [markerFrame('start')], us: 37_400 },
      { stack: [native('(idle)')], us: 1_300 },
      { stack: [native('(idle)')], us: 348_600 },
      // A read of the thread that ends as the window opens.
      { stack: read, us: 1_400 },
      // The window, from 400 ms: a tenth in catalogue syncs, then a twentieth
      // in journal syncs, a fifth idle, 15% reading the thread, the rest busy.
      {
        stack: [save, js('begin'), js('beginPublication'), js('writeJson'), ...sync],
        us: windowMs * 0.1 * 1000
      },
      {
        stack: [save, js('persistIncrementalChatForHostSave'), js('appendLine'), ...sync],
        us: windowMs * 0.05 * 1000
      },
      { stack: [native('(idle)')], us: windowMs * 0.2 * 1000 },
      { stack: read, us: windowMs * 0.15 * 1000 },
      { stack: [js('handleProviderOutput', 1)], us: windowMs * 0.5 * 1000 },
      { stack: [native('(idle)')], us: 3_200_000 },
      // End marker: samples end 1.4 ms after it began and 1.4 ms before it ended.
      { stack: [markerFrame('end')], us: 1_400 },
      { stack: [markerFrame('end')], us: 37_200 },
      { stack: [native('(idle)')], us: 1_400 }
    ]
  }
  const looseMarkers = (windowMs: number) => {
    const endBeforeMs = 400 + windowMs + 3_200
    return [marker('start', 10, 50), marker('end', endBeforeMs, endBeforeMs + 40)]
  }
  const looseWindow = (windowMs: number) => ({
    ...WINDOW,
    startedAtMs: 400,
    endedAtMs: 400 + windowMs
  })
  const measureLoose = (windowMs: number) =>
    measure({
      profile: buildProfile(looseRows(windowMs)),
      windows: [looseWindow(windowMs)],
      markers: looseMarkers(windowMs)
    }).windows[0]

  it('measures a window whose markers are looser than the calibration allows, within their bounds', () => {
    const window = measureLoose(120_000)
    expect(window).toMatchObject({
      measured: true,
      clock: { basis: 'loose_markers' },
      windowMs: 120_000,
      sampledMs: 120_000
    })
    // The envelope of the two anchors is 2.8 ms wide: 1.4 ms either way.
    expect(window.clock.uncertaintyMs).toBeCloseTo(1.4, 6)
    expect(window.clock.markerUncertaintyMs.map((ms: number) => Math.round(ms * 10) / 10)).toEqual([
      2.6, 2.8
    ])
    expect(window.shares).toMatchObject({ idle: 0.2, busy: 0.8, sync: 0.15, wholeThreadRead: 0.15 })
    expect(window.syncOwners).toMatchObject({ cataloguePublication: 0.1, journal: 0.05 })
    // Placed 1.4 ms later it loses that much catalogue sync at its start and
    // gains idle at its end; placed earlier it gains the read before it and
    // loses busy time at its end.
    expect(window.shareBounds).toMatchObject({
      idle: [0.2, 0.20001],
      busy: [0.79999, 0.8],
      sync: [0.14999, 0.15],
      wholeThreadRead: [0.15, 0.15001]
    })
    expect(window.syncOwnerBounds).toMatchObject({
      cataloguePublication: [0.09999, 0.1],
      journal: [0.05, 0.05],
      other: [0, 0]
    })
    expect(window.plainFileCallOwnerBounds).toMatchObject({ cataloguePublication: [0, 0] })
    // An owner the build cannot vouch for has no bounds either.
    const renamed = buildScripts(
      BUNDLE_LINES.map((line) => line.replace('appendRunEvent', 'appendEvent'))
    )
    const [unowned] = measure({
      profile: buildProfile(looseRows(120_000)),
      windows: [looseWindow(120_000)],
      markers: looseMarkers(120_000),
      buildScripts: renamed
    }).windows
    expect(unowned).toMatchObject({
      measured: true,
      syncOwners: { cataloguePublication: 0.1, runEvents: null, other: null },
      syncOwnerBounds: { cataloguePublication: [0.09999, 0.1], runEvents: null, other: null },
      plainFileCallOwnerBounds: { journal: [0, 0], runEvents: null, other: null }
    })
  })

  it('carries each figure per turn across the bounds of loose markers', () => {
    const [window] = measure({
      profile: buildProfile(looseRows(120_000)),
      windows: [{ ...looseWindow(120_000), modelTurns: 100 }],
      markers: looseMarkers(120_000)
    }).windows
    expect(window.perModelTurn).toMatchObject({ mainBusyMs: 960, syncMs: 180 })
    expect(window.perModelTurnBounds).toMatchObject({
      mainBusyMs: [959.986, 960],
      syncMs: [179.986, 180]
    })
  })

  it('refuses a loose window only when its bounds move a share by more than the tolerance', () => {
    expect(LOOSE_CLOCK_SHARE_TOLERANCE).toBe(0.001)
    // 1.4 ms either way on 1,400 ms moves a share by exactly the tolerance.
    const accepted = measureLoose(1_400)
    expect(accepted.measured).toBe(true)
    expect(accepted.shareBounds.idle).toEqual([0.2, 0.201])
    // On 1,300 ms it moves it by more.
    const refused = measureLoose(1_300)
    expect(refused).toEqual({
      id: 'light_beside_0',
      repetition: 0,
      measured: false,
      reason: 'loose_clock_moves_share',
      clock: {
        basis: 'loose_markers',
        uncertaintyMs: refused.clock.uncertaintyMs,
        markerUncertaintyMs: refused.clock.markerUncertaintyMs
      },
      moved: { share: 'idle', bounds: [0.2, 0.20108], by: 0.00108, tolerance: 0.001 }
    })
    expect(refused.clock.uncertaintyMs).toBeCloseTo(1.4, 6)
  })

  it.each([
    ['sync', 'syncOwners', sync],
    ['plain file call', 'plainFileCallOwners', [nodeFs('writeSync'), native('writeString')]]
  ])(
    'refuses a loose window when its bounds move a %s owner, though no share moves',
    (_, table, call) => {
      // The window opens on a catalogue write and closes on a journal write, with
      // a journal write either side of it: placed later it trades catalogue for
      // journal, placed earlier journal for journal.
      const save = js('saveChat')
      const catalogue = [save, js('begin'), js('beginPublication'), js('writeJson'), ...call]
      const journal = [save, js('persistIncrementalChatForHostSave'), js('appendLine'), ...call]
      const windowMs = 1_300
      const rows: Row[] = [
        ...looseRows(windowMs).slice(0, 4),
        { stack: [native('(idle)')], us: 348_600 },
        { stack: journal, us: 1_400 },
        { stack: catalogue, us: 130_000 },
        { stack: [native('(idle)')], us: 260_000 },
        { stack: [js('handleProviderOutput', 1)], us: 845_000 },
        { stack: journal, us: 65_000 },
        { stack: journal, us: 1_400 },
        { stack: [native('(idle)')], us: 3_198_600 },
        ...looseRows(windowMs).slice(-3)
      ]
      const [window] = measure({
        profile: buildProfile(rows),
        windows: [looseWindow(windowMs)],
        markers: looseMarkers(windowMs)
      }).windows
      expect(window).toMatchObject({
        measured: false,
        reason: 'loose_clock_moves_share',
        moved: {
          share: `${table}.cataloguePublication`,
          bounds: [0.09892, 0.1],
          by: 0.00108,
          tolerance: 0.001
        }
      })
    }
  )

  it('still refuses loose markers that fail the calibration in any other way', () => {
    const windowMs = 120_000
    const [start, end] = looseMarkers(windowMs)
    const mismatched = { ...end, pid: 43, identity: 'main:43:performance.timeOrigin:5000' }
    const other = measure({
      profile: buildProfile(looseRows(windowMs)),
      windows: [looseWindow(windowMs)],
      markers: [start, mismatched]
    }).windows[0]
    expect(other).toMatchObject({ measured: false })
    expect(other.reason).toMatch(/^profile_calibration_unqualified:/)
    expect(other.reason).toContain('marker_uncertainty_exceeded')
    expect(other.reason).not.toBe('profile_calibration_unqualified:marker_uncertainty_exceeded')
    // A marker whose samples outlast its bracket is no placement at all.
    const outlasted = measure({
      profile: buildProfile(looseRows(windowMs)),
      windows: [looseWindow(windowMs)],
      markers: [marker('start', 12, 48), end]
    }).windows[0]
    expect(outlasted).toMatchObject({ measured: false })
    expect(outlasted.reason).toMatch(/^profile_calibration_unqualified:/)
    expect(outlasted.reason).toContain('marker_uncertainty_exceeded')
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
      usageLedger: [0.04, 0.04],
      workspaceLock: [0, 0],
      sessionCheckpoint: [0, 0],
      catalogueChecks: [0, 0],
      chatAuthority: [0, 0],
      other: [0, 0]
    })
    // No plain file call is near the window, so none moves.
    expect(Object.values(window.plainFileCallOwnerBounds)).toEqual(
      Object.values(window.syncOwnerBounds).map(() => [0, 0])
    )
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
    expect(unowned.syncOwners).toMatchObject({ journal: 0.08, runEvents: null, other: null })
    expect(unowned.syncOwnerBounds).toMatchObject({
      cataloguePublication: [0, 0.16],
      runEvents: null,
      other: null
    })
    expect(unowned.plainFileCallOwnerBounds).toMatchObject({ runEvents: null, other: null })
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

describe('main-thread time per model turn', () => {
  it('divides the window’s main-thread time by the model turns it was given', () => {
    const [window] = measure({ windows: [{ ...WINDOW, modelTurns: 4 }] }).windows
    expect(window.modelTurns).toBe(4)
    expect(window.mainThreadMs).toEqual({ busy: 90, sync: 20, plainFileCalls: 0, atomicsWait: 0 })
    expect(window.perModelTurn).toEqual({
      mainBusyMs: 22.5,
      syncMs: 5,
      plainFileCallMs: 0,
      atomicsWaitMs: 0,
      restMs: 17.5
    })
  })

  it('gives no figure per turn for a window without turns, or without a count of them', () => {
    const [none] = measure({ windows: [{ ...WINDOW, modelTurns: 0 }] }).windows
    expect(none).toMatchObject({
      measured: true,
      modelTurns: 0,
      perModelTurn: null,
      perModelTurnUnavailable: 'no_model_turns'
    })
    const [uncounted] = measure().windows
    expect(uncounted).toMatchObject({
      measured: true,
      modelTurns: null,
      perModelTurn: null,
      perModelTurnUnavailable: 'model_turns_unavailable'
    })
    // The window's own time is there either way.
    expect(uncounted.mainThreadMs.busy).toBe(90)
  })

  it('leaves a wait it cannot measure in the rest', () => {
    const [window] = measure({
      windows: [{ ...WINDOW, modelTurns: 4 }],
      buildScripts: null
    }).windows
    expect(window.mainThreadMs.atomicsWait).toBeNull()
    expect(window.perModelTurn).toMatchObject({ atomicsWaitMs: null, restMs: 17.5 })
  })

  it('carries each figure per turn across the bounds of an estimated clock', () => {
    const legacy = {
      id: 'light_beside_0',
      repetition: 0,
      startedAtMs: 9030,
      endedAtMs: 9130,
      modelTurns: 5
    }
    const [window] = measure({
      windows: [legacy],
      markers: [],
      capture: { stopRequestedAtMs: 9145 },
      estimate: { lagMs: 5, lagBoundsMs: [0, 10] }
    }).windows
    // Busy 90 ms at the estimate, 85 to 95 across its bounds.
    expect(window.perModelTurn).toMatchObject({ mainBusyMs: 18, syncMs: 4 })
    expect(window.perModelTurnBounds).toMatchObject({ mainBusyMs: [17, 19], syncMs: [4, 4] })
  })

  it('counts the turns the model began in the window the runner timed, however they ended', () => {
    const report = (windows: object[]) => ({ liveRounds: { agents: { windows } } })
    const window = { repetition: 0, startedAtMs: 1_000, endedAtMs: 2_000, mainWindow: {} }
    const turns = [
      // Streamed into the window, but began before it.
      { model: 'scripted-llama:t001', startedAtMs: 999, endedAtMs: 1_500, outcome: 'done' },
      { model: 'scripted-llama:t001', startedAtMs: 1_000, endedAtMs: 2_600, outcome: 'done' },
      // Another thread's, still streaming when the record was read.
      { model: 'scripted-llama:t002', startedAtMs: 1_400, endedAtMs: null, outcome: 'streaming' },
      { model: 'scripted-llama:t001', startedAtMs: 1_999, endedAtMs: 2_100, outcome: 'aborted' },
      // Begun as the window closed.
      { model: 'scripted-llama:t002', startedAtMs: 2_000, endedAtMs: 2_500, outcome: 'done' }
    ]
    expect(mainWindowsOfReport(report([window]), turns)[0].modelTurns).toBe(3)
    // A record whose turns do not say when they began counts nothing.
    expect(
      mainWindowsOfReport(report([window]), [...turns, { model: 'scripted-llama:t001' }])[0]
        .modelTurns
    ).toBeNull()
    // Without the runner's own times for the window there is nothing to count in.
    const untimed = { repetition: 0, mainWindow: {} }
    expect(mainWindowsOfReport(report([untimed]), turns)[0].modelTurns).toBeNull()
    expect(mainWindowsOfReport(report([window]), null)[0].modelTurns).toBeNull()
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

  it('counts each window’s model turns from the record the model left as it stopped', () => {
    const timed = {
      ...report,
      liveRounds: {
        lanes: {
          windows: [{ ...report.liveRounds.lanes.windows[0], startedAtMs: 5_000, endedAtMs: 6_000 }]
        },
        daemonStop: {
          summary: {
            turns: [
              {
                model: 'scripted-llama:latest',
                startedAtMs: 5_100,
                endedAtMs: 5_200,
                outcome: 'done'
              },
              {
                model: 'scripted-llama:heavy',
                startedAtMs: 5_900,
                endedAtMs: 6_300,
                outcome: 'done'
              }
            ]
          }
        }
      }
    }
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs({ ...files(), '/capture/perf-t2-report.json': JSON.stringify(timed) }, directories)
    })
    expect(result.modelTurns).toEqual({
      counted: 'began_streaming_in_the_runner_window',
      from: 'daemon_stop_record'
    })
    expect(result.windows[0]).toMatchObject({ modelTurns: 2, perModelTurn: { mainBusyMs: 45 } })
    // A capture whose model left no record has no turns to divide by.
    const plain = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(files(), directories)
    })
    expect(plain.modelTurns).toEqual({ unavailable: 'model_turns_not_recorded' })
    expect(plain.windows[0]).toMatchObject({ modelTurns: null, perModelTurn: null })
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

  // A many-agent capture keeps its one window where a live-lane capture keeps its three.
  const agentsReport = {
    captureDeadline: report.captureDeadline,
    liveRounds: {
      agents: {
        windows: [
          {
            repetition: 0,
            mainWindow: {
              id: WINDOW.id,
              startedAtMs: WINDOW.startedAtMs,
              endedAtMs: WINDOW.endedAtMs,
              clock: WINDOW.clock
            }
          }
        ]
      }
    }
  }

  it('measures a many-agent capture’s window as it does a live-lane capture’s', () => {
    const result = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(
        { ...files(), '/capture/perf-t2-report.json': JSON.stringify(agentsReport) },
        directories
      )
    })
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0]).toMatchObject({
      id: WINDOW.id,
      repetition: 0,
      measured: true,
      clock: { basis: 'markers' }
    })
    expect(result.windows[0].shares.flusherBookkeeping).toBe(0.08)
  })

  it('has no window for a report with neither kind of live window', () => {
    for (const liveRounds of [undefined, {}, { lanes: null, agents: null }, { agents: {} }]) {
      const result = mainWindowProfileSharesForCapture('/capture', {
        fs: fakeFs(
          {
            ...files(),
            '/capture/perf-t2-report.json': JSON.stringify({ ...report, liveRounds })
          },
          directories
        )
      })
      expect(result.windows).toEqual([])
      expect(result).not.toHaveProperty('unavailable')
    }
  })

  it('measures a report still in memory from the profile file and the markers it is given', () => {
    const fromReport = mainWindowProfileSharesForReport({
      report: agentsReport,
      profilePath: '/capture/profiles/main.cpuprofile',
      calibrationMarkers: MARKERS,
      fsApi: fakeFs(files(), directories)
    })
    const fromCapture = mainWindowProfileSharesForCapture('/capture', {
      fs: fakeFs(
        { ...files(), '/capture/perf-t2-report.json': JSON.stringify(agentsReport) },
        directories
      )
    })
    // Without the model's turns in hand, as a capture without its record.
    expect(fromReport).toEqual(fromCapture)
    expect(fromReport.build).toMatchObject({ scripts: 2, missingNames: [] })
    const counted = mainWindowProfileSharesForReport({
      report: {
        ...agentsReport,
        liveRounds: {
          agents: {
            windows: [
              { ...agentsReport.liveRounds.agents.windows[0], startedAtMs: 0, endedAtMs: 100 }
            ]
          }
        }
      },
      profilePath: '/capture/profiles/main.cpuprofile',
      calibrationMarkers: MARKERS,
      modelTurns: [
        { model: 'scripted-llama:t001', startedAtMs: 50, endedAtMs: 60, outcome: 'done' }
      ],
      fsApi: fakeFs(files(), directories)
    })
    expect(counted.modelTurns).toEqual({
      counted: 'began_streaming_in_the_runner_window',
      from: 'daemon_read'
    })
    expect(counted.windows[0]).toMatchObject({ modelTurns: 1, perModelTurn: { mainBusyMs: 90 } })
    const unread = mainWindowProfileSharesForReport({
      report: agentsReport,
      profilePath: '/capture/profiles/main.cpuprofile',
      calibrationMarkers: MARKERS,
      modelTurnsUnavailable: 'daemon_turns_unavailable',
      fsApi: fakeFs(files(), directories)
    })
    expect(unread.modelTurns).toEqual({ unavailable: 'daemon_turns_unavailable' })
    expect(fromReport.windows[0].shares.flusherBookkeeping).toBe(0.08)
    // Without the markers the window cannot be placed.
    const unplaced = mainWindowProfileSharesForReport({
      report: agentsReport,
      profilePath: '/capture/profiles/main.cpuprofile',
      calibrationMarkers: [],
      fsApi: fakeFs(files(), directories)
    })
    expect(unplaced.windows[0].measured).toBe(false)
  })

  it('names a profile file it cannot read, and measures no window from it', () => {
    for (const content of [undefined, '{not json', '[]']) {
      const withProfile = files() as Record<string, string>
      if (content === undefined) delete withProfile['/capture/profiles/main.cpuprofile']
      else withProfile['/capture/profiles/main.cpuprofile'] = content
      const result = mainWindowProfileSharesForReport({
        report: agentsReport,
        profilePath: '/capture/profiles/main.cpuprofile',
        calibrationMarkers: MARKERS,
        fsApi: fakeFs(withProfile, directories)
      })
      expect(result.unavailable).toBe('cpu_profile_unreadable')
      expect(result.build).toEqual({ scripts: 0, unavailable: 'build_scripts_not_given' })
      expect(result.windows).toHaveLength(1)
      expect(result.windows[0].measured).toBe(false)
    }
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
