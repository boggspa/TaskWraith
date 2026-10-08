import { spawnSync } from 'node:child_process'
import {
  accessSync,
  appendFileSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GROK_USAGE_BINARY_OVERRIDE_ENV,
  resolveGrokUsageProbeBinary
} from '../../src/main/grok/GrokUsageBinaryOverride'

const require = createRequire(import.meta.url)
const guard = require('./browserGuard.cjs') as Record<string, any>

/** Every directory this file makes is named so, directly in the temporary folder. */
const PREFIX = 'harness-browser-guard-'
const made: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), PREFIX))
  made.push(dir)
  return dir
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop()!
    if (dir === tmpdir() || !dir.startsWith(tmpdir() + path.sep + PREFIX)) {
      throw new Error(`refusing to remove ${dir}: not a directory this file made`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox'
const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LOGIN = 'https://accounts.example.test/oauth2/auth?client_id=c1&state=s1#top'

describe('the measured child’s environment', () => {
  it.skipIf(process.platform === 'win32')(
    'empties the Grok usage override and names the stand-in as BROWSER, in the env and the recorded command',
    () => {
      const dir = makeDirectory()
      const { spawnPlan, record } = guard.guardSpawnPlan(
        {
          env: { TASKWRAITH_INSTANCE_ID: 'perf' },
          shellCommand: 'env A=1 Electron .',
          argv: ['.']
        },
        dir
      )
      const standIn = path.join(dir, 'browser-stand-in.sh')
      expect(spawnPlan.env).toEqual({
        TASKWRAITH_INSTANCE_ID: 'perf',
        TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE: '',
        BROWSER: standIn
      })
      expect(spawnPlan.shellCommand).toBe(
        `env TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE= BROWSER=${standIn} env A=1 Electron .`
      )
      expect(spawnPlan.argv).toEqual(['.'])
      expect(record).toEqual({
        grokUsageBinaryOverride: '',
        browser: standIn,
        requestsFile: path.join(dir, 'browser-requests.txt')
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'is the value the app’s own reader takes as no Grok binary, so its usage probe spawns nothing',
    async () => {
      expect(guard.GROK_USAGE_BINARY_OVERRIDE_ENV).toBe(GROK_USAGE_BINARY_OVERRIDE_ENV)
      const { spawnPlan } = guard.guardSpawnPlan(
        { env: {}, shellCommand: 'Electron' },
        makeDirectory()
      )
      const resolveDefault = vi.fn(async () => ({ binaryPath: '/usr/local/bin/grok' }))
      await expect(
        resolveGrokUsageProbeBinary({ env: spawnPlan.env, resolveDefault })
      ).resolves.toEqual({ binaryPath: null, source: 'invalid_override' })
      expect(resolveDefault).not.toHaveBeenCalled()
    }
  )

  it('refuses a plan that already sets either, and a folder whose path a reader of BROWSER would split', () => {
    const dir = makeDirectory()
    for (const key of ['TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE', 'BROWSER']) {
      expect(() =>
        guard.guardSpawnPlan({ env: { [key]: 'x' }, shellCommand: 'Electron' }, dir)
      ).toThrow(`spawn plan already sets ${key}`)
    }
    for (const folder of [
      'relative',
      '/tmp/a b',
      '/tmp/a:b',
      '/tmp/a%sb',
      "/tmp/it's",
      '/tmp/a\nb'
    ]) {
      expect(() => guard.guardSpawnPlan({ env: {}, shellCommand: 'Electron' }, folder)).toThrow(
        `the browser stand-in needs a plain absolute path, which every reader of BROWSER runs as it is: ${path.join(folder, 'browser-stand-in.sh')}`
      )
    }
    expect(() => guard.guardSpawnPlan({ env: {} }, dir)).toThrow(
      'spawn plan with an env and a shellCommand is required'
    )
  })
})

describe('the browser stand-in', () => {
  // The stand-in is a /bin/sh script that a reader of BROWSER runs as it is.
  // The harness runs only on macOS: Windows has neither the shell nor an
  // execute bit, and the guard refuses a Windows path.
  it.skipIf(process.platform === 'win32')(
    'writes down what it was asked to open, opens nothing and exits 0',
    () => {
      const dir = makeDirectory()
      const paths = guard.writeBrowserStandIn(dir)
      expect(paths).toEqual({
        standIn: path.join(dir, 'browser-stand-in.sh'),
        requests: path.join(dir, 'browser-requests.txt')
      })
      // Runnable as it is, which is all a reader of BROWSER needs of it.
      expect(() => accessSync(paths.standIn, constants.X_OK)).not.toThrow()
      const env = { PATH: '/usr/bin:/bin' }
      const first = spawnSync(paths.standIn, [LOGIN], { encoding: 'utf8', env })
      const second = spawnSync(paths.standIn, ['--new-window', 'https://example.test/next'], {
        encoding: 'utf8',
        env
      })
      for (const run of [first, second]) {
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe('')
      }
      expect(readFileSync(paths.requests, 'utf8')).toBe(
        `${LOGIN}\n--new-window https://example.test/next\n`
      )
    }
  )

  it('reads back only what was asked after a given point, without queries or fragments', () => {
    const dir = makeDirectory()
    const file = path.join(dir, 'browser-requests.txt')
    expect(guard.readBrowserRequests(file, 0)).toEqual([])
    writeFileSync(file, 'https://earlier.example.test/a?x=1\n')
    const from = statSync(file).size
    appendFileSync(file, `${LOGIN}\n\n--new-window https://example.test/next#part\n`)
    expect(guard.readBrowserRequests(file, from)).toEqual([
      'https://accounts.example.test/oauth2/auth?…',
      '--new-window https://example.test/next#…'
    ])
    expect(guard.readBrowserRequests(file, 0)).toHaveLength(3)
  })
})

describe('browsers among the processes', () => {
  it('reads a process by its pid and command name only', () => {
    expect(
      guard.parseProcessList(`  12287 ${FIREFOX}\n  501 ${CHROME}  \nnot a process\n\n`)
    ).toEqual([
      { pid: 12287, command: FIREFOX },
      { pid: 501, command: CHROME }
    ])
  })

  it('names each watched browser by its main executable, a release channel’s too, and none of their helpers', () => {
    const named: Record<string, string> = {
      [FIREFOX]: 'firefox',
      [CHROME]: 'Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary': 'Google Chrome',
      [SAFARI]: 'Safari',
      '/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview':
        'Safari',
      '/Applications/Arc.app/Contents/MacOS/Arc': 'Arc',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser': 'Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge': 'Microsoft Edge',
      '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta': 'Microsoft Edge'
    }
    for (const [command, browser] of Object.entries(named)) {
      expect(guard.browserOf(command)).toBe(browser)
    }
    for (const command of [
      '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
      '/Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container',
      '/usr/libexec/SafariLaunchAgent',
      '/usr/libexec/knowledge-agent',
      '/Applications/Google Chrome Unknown.app/Contents/MacOS/Google Chrome Unknown',
      'Electron',
      'Electron Helper (Renderer)',
      'chrome_crashpad_handler',
      ''
    ]) {
      expect(guard.browserOf(command)).toBeNull()
    }
  })

  it('reports a browser only when it was not there before the launch', () => {
    const before = [
      { pid: 10, command: SAFARI },
      { pid: 11, command: '/usr/sbin/cfprefsd' }
    ]
    const after = [
      { pid: 10, command: SAFARI },
      { pid: 11, command: FIREFOX },
      { pid: 12, command: CHROME },
      { pid: 13, command: '/usr/bin/python3' }
    ]
    expect(guard.browsersStartedSince(before, after)).toEqual([
      { pid: 11, command: 'firefox', browser: 'firefox' },
      { pid: 12, command: 'Google Chrome', browser: 'Google Chrome' }
    ])
    expect(guard.browsersStartedSince(after, after)).toEqual([])
  })

  it.runIf(process.platform === 'darwin')(
    'lists this machine’s processes, this one among them',
    async () => {
      const listed = await guard.listProcessesByName()
      const own = listed.find((entry: { pid: number }) => entry.pid === process.pid)
      expect(own).toEqual({ pid: process.pid, command: expect.stringMatching(/\S/) })
      expect(Object.keys(own)).toEqual(['pid', 'command'])
    }
  )
})

describe.skipIf(process.platform === 'win32')('one POSIX launch’s guard', () => {
  it('writes the stand-in, lists before and after, and reports what it caught', async () => {
    const dir = makeDirectory()
    const listings = [
      [{ pid: 10, command: SAFARI }],
      [
        { pid: 10, command: SAFARI },
        { pid: 20, command: FIREFOX }
      ]
    ]
    const listProcesses = vi.fn(async () => listings.shift())
    const watch = await guard.startBrowserGuard({ captureDir: dir, listProcesses })
    expect(listProcesses).toHaveBeenCalledTimes(1)
    // What the launch did meanwhile: something asked the stand-in for a login page.
    expect(spawnSync(watch.standIn, [LOGIN]).status).toBe(0)
    expect(await watch.finish()).toEqual({
      browser: path.join(dir, 'browser-stand-in.sh'),
      requestsFile: path.join(dir, 'browser-requests.txt'),
      requests: ['https://accounts.example.test/oauth2/auth?…'],
      browsers: 'started',
      browsersStarted: [{ pid: 20, command: 'firefox', browser: 'firefox' }],
      processListing: { before: 1, after: 2, error: null }
    })
    expect(listProcesses).toHaveBeenCalledTimes(2)
  })

  it('keeps out what an earlier launch left in the same folder, and says none started when none did', async () => {
    const dir = makeDirectory()
    writeFileSync(path.join(dir, 'browser-requests.txt'), `${LOGIN}\n`)
    const watch = await guard.startBrowserGuard({
      captureDir: dir,
      listProcesses: async () => [{ pid: 10, command: SAFARI }]
    })
    expect(await watch.finish()).toMatchObject({
      requests: [],
      browsers: 'none_started',
      browsersStarted: [],
      processListing: { before: 1, after: 1, error: null }
    })
  })

  it('cannot say no browser started when a listing failed', async () => {
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([{ pid: 10, command: SAFARI }])
      .mockRejectedValueOnce(new Error('ps timed out'))
    const watch = await guard.startBrowserGuard({ captureDir: makeDirectory(), listProcesses })
    expect(await watch.finish()).toMatchObject({
      browsers: 'unknown',
      browsersStarted: [],
      processListing: { before: 1, after: null, error: 'ps timed out' }
    })
    const failedFirst = await guard.startBrowserGuard({
      captureDir: makeDirectory(),
      listProcesses: vi
        .fn()
        .mockRejectedValueOnce(new Error('no ps'))
        .mockResolvedValueOnce([{ pid: 20, command: FIREFOX }])
    })
    expect(await failedFirst.finish()).toMatchObject({
      browsers: 'unknown',
      browsersStarted: [],
      processListing: { before: null, after: 1, error: 'no ps' }
    })
  })

  it('says what it could not read, and never throws', async () => {
    const dir = makeDirectory()
    const watch = await guard.startBrowserGuard({
      captureDir: dir,
      listProcesses: async () => [{ pid: 10, command: SAFARI }]
    })
    // Something left a folder where the stand-in writes.
    mkdirSync(path.join(dir, 'browser-requests.txt'))
    expect(await watch.finish()).toMatchObject({
      requests: null,
      requestsError: expect.stringContaining('EISDIR'),
      browsers: 'none_started'
    })
  })
})
