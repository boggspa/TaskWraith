'use strict'

/**
 * A measured launch must never open a browser or start a provider login.
 * Every launch the T2 runner makes is held to that three ways:
 *
 * - main's Grok usage probe is handed an empty binary override, which it
 *   reads as "no binary", so it spawns no Grok TUI. In a home with no Grok
 *   sign-in that TUI starts a login and opens a browser;
 * - BROWSER names a stand-in in the capture's own folder that writes down
 *   what it was asked to open, opens nothing and exits 0;
 * - the processes are listed by pid and command name before and after the
 *   launch, and a browser that started in between is reported. Nothing here
 *   signals it.
 *
 * BROWSER reaches only a program that reads it. An opener that goes through
 * Launch Services, as Grok's does on macOS, never does, and a page opened in
 * a browser that was already running starts no process: neither is seen here.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

/** Read by main's Grok usage probe (src/main/grok/GrokUsageBinaryOverride.ts). */
const GROK_USAGE_BINARY_OVERRIDE_ENV = 'TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE'
const BROWSER_STAND_IN_FILE = 'browser-stand-in.sh'
const BROWSER_REQUESTS_FILE = 'browser-requests.txt'

/** The browsers watched for, by the name of their main executable. */
const BROWSER_NAMES = Object.freeze([
  'firefox',
  'Google Chrome',
  'Safari',
  'Arc',
  'Brave Browser',
  'Microsoft Edge'
])
/** A release channel's build carries its browser's name with the channel after it. */
const BROWSER_CHANNELS = Object.freeze(['Beta', 'Dev', 'Canary', 'Nightly', 'Technology Preview'])

/**
 * Characters every reader of BROWSER takes as one program path: Python
 * splits the variable on ':', and a space or '%s' changes how others run it.
 * No quote either: the stand-in names its file inside single quotes.
 */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(failure) {
  return String(failure && failure.message ? failure.message : failure)
}

function filesIn(captureDir) {
  const standIn = path.join(String(captureDir), BROWSER_STAND_IN_FILE)
  if (!PLAIN_PATH.test(standIn)) {
    throw new Error(
      `the browser stand-in needs a plain absolute path, which every reader of BROWSER runs as it is: ${standIn}`
    )
  }
  return { standIn, requests: path.join(String(captureDir), BROWSER_REQUESTS_FILE) }
}

/**
 * Set both for the measured child, which layers its plan env over the
 * runner's own, and in the command the plan records.
 */
function guardSpawnPlan(spawnPlan, captureDir) {
  if (
    !isPlainObject(spawnPlan) ||
    !isPlainObject(spawnPlan.env) ||
    typeof spawnPlan.shellCommand !== 'string'
  ) {
    throw new Error('spawn plan with an env and a shellCommand is required')
  }
  for (const key of [GROK_USAGE_BINARY_OVERRIDE_ENV, 'BROWSER']) {
    if (Object.prototype.hasOwnProperty.call(spawnPlan.env, key)) {
      throw new Error(`spawn plan already sets ${key}`)
    }
  }
  const files = filesIn(captureDir)
  return {
    spawnPlan: {
      ...spawnPlan,
      env: { ...spawnPlan.env, [GROK_USAGE_BINARY_OVERRIDE_ENV]: '', BROWSER: files.standIn },
      shellCommand: `env ${GROK_USAGE_BINARY_OVERRIDE_ENV}= BROWSER=${files.standIn} ${spawnPlan.shellCommand}`
    },
    record: { grokUsageBinaryOverride: '', browser: files.standIn, requestsFile: files.requests }
  }
}

/** Write the stand-in into the capture's folder, ready to run. */
function writeBrowserStandIn(captureDir, options = {}) {
  const fsApi = options.fs || fs
  const files = filesIn(captureDir)
  fsApi.writeFileSync(
    files.standIn,
    [
      '#!/bin/sh',
      '# Stands in for a web browser in a measured TaskWraith launch: it writes',
      '# down what it was asked to open and opens nothing.',
      `printf '%s\\n' "$*" >> '${files.requests}'`,
      'exit 0',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  fsApi.chmodSync(files.standIn, 0o755)
  return files
}

/**
 * What the stand-in was asked to open after byte `fromByte` of its file, a
 * line a request. Queries and fragments are cut: a login page's carry
 * one-time values. The file itself keeps them.
 */
function readBrowserRequests(requestsFile, fromByte, options = {}) {
  const fsApi = options.fs || fs
  let text
  try {
    text = fsApi.readFileSync(requestsFile).subarray(fromByte).toString('utf8')
  } catch (failure) {
    if (failure && failure.code === 'ENOENT') return []
    throw failure
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.replace(/([?#])\S*/g, '$1…'))
}

/** `ps` lines of pid and command name; anything else is skipped. */
function parseProcessList(stdout) {
  const processes = []
  for (const line of String(stdout).split('\n')) {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line)
    if (match !== null) processes.push({ pid: Number(match[1]), command: match[2].trimEnd() })
  }
  return processes
}

/** The watched browser a command is the main executable of, or null. */
function browserOf(command) {
  const name = path.basename(String(command)).toLowerCase()
  for (const browser of BROWSER_NAMES) {
    const base = browser.toLowerCase()
    if (
      name === base ||
      BROWSER_CHANNELS.some((channel) => name === `${base} ${channel.toLowerCase()}`)
    ) {
      return browser
    }
  }
  return null
}

/** The browsers in `after` that `before` did not hold, by pid and command. */
function browsersStartedSince(before, after) {
  const held = new Set(before.map((entry) => `${entry.pid} ${entry.command}`))
  return after
    .filter(
      (entry) => browserOf(entry.command) !== null && !held.has(`${entry.pid} ${entry.command}`)
    )
    .map((entry) => ({
      pid: entry.pid,
      command: path.basename(entry.command),
      browser: browserOf(entry.command)
    }))
}

/** Every process on the machine, by pid and command name only. */
function listProcessesByName() {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,comm='],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
      (failure, stdout) => {
        if (failure) reject(failure)
        else resolve(parseProcessList(stdout))
      }
    )
  })
}

async function listing(listProcesses) {
  try {
    return { processes: await listProcesses(), error: null }
  } catch (failure) {
    return { processes: null, error: messageOf(failure) }
  }
}

/**
 * Start one launch's guard, before its child is spawned: the stand-in is
 * written and the processes listed. `finish`, once the launch is down,
 * lists them again and reads what the stand-in was asked. It never throws:
 * what it could not read, it says so.
 */
async function startBrowserGuard(options) {
  const fsApi = options.fs || fs
  const listProcesses = options.listProcesses || listProcessesByName
  const files = writeBrowserStandIn(options.captureDir, { fs: fsApi })
  let fromByte = 0
  try {
    fromByte = fsApi.statSync(files.requests).size
  } catch {
    // Not written yet: everything in it will be this launch's.
  }
  const before = await listing(listProcesses)
  return {
    standIn: files.standIn,
    async finish() {
      const after = await listing(listProcesses)
      const listed = before.processes !== null && after.processes !== null
      const browsersStarted = listed ? browsersStartedSince(before.processes, after.processes) : []
      let requests = null
      let requestsError = null
      try {
        requests = readBrowserRequests(files.requests, fromByte, { fs: fsApi })
      } catch (failure) {
        requestsError = messageOf(failure)
      }
      return {
        browser: files.standIn,
        requestsFile: files.requests,
        requests,
        ...(requestsError === null ? {} : { requestsError }),
        browsers: !listed ? 'unknown' : browsersStarted.length > 0 ? 'started' : 'none_started',
        browsersStarted,
        processListing: {
          before: before.processes === null ? null : before.processes.length,
          after: after.processes === null ? null : after.processes.length,
          error: before.error || after.error
        }
      }
    }
  }
}

module.exports = {
  BROWSER_NAMES,
  GROK_USAGE_BINARY_OVERRIDE_ENV,
  browserOf,
  browsersStartedSince,
  guardSpawnPlan,
  listProcessesByName,
  parseProcessList,
  readBrowserRequests,
  startBrowserGuard,
  writeBrowserStandIn
}
