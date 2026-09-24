#!/usr/bin/env node
'use strict'

/**
 * Build hook: stop the TaskWraith Hosts that serve THIS checkout's
 * `out/host` before `host:build` clears and rewrites it.
 *
 *   node scripts/host-stop-all.cjs --payload-root out/host
 *
 * `host:build` runs it first, so every `npm run build` (the release builds
 * included), `npm run dev` and `host:serve` does too. `npm run host:stop-all`
 * runs it on its own.
 *
 * SCOPE. A Host is in scope only when its entry in the machine-wide Host
 * registry (`~/.taskwraith/hosts`, or TASKWRAITH_HOST_REGISTRY_ROOT) records a
 * `cliPath` strictly under `<realpath of this checkout>/out/host/`. The test is
 * lexical with a path-separator boundary, so `out/host2`, a sibling or nested
 * worktree's `out/host` and the installed app never match. The checkout is
 * the directory this file lives in, never an argument or an environment
 * variable. `--payload-root` is resolved against it and must name exactly its
 * `out/host`. Anything else is refused. There is no `--all`, no `--profile`
 * and no argv scan: a Host that predates the registry is invisible here.
 *
 * PER IN-SCOPE ENTRY:
 * - Live pid. This needs a built `out/host/host-runtime/cli.js`, and the
 *   profile's discovery and authority lease must describe the same process
 *   as the entry, which must carry a 64-hex birth digest. Then
 *   `cli.js stop-all --profile <p> --expect-pid <pid> --expect-birth <digest>
 *   --json` stops exactly that Host through verified termination. A successor
 *   taking the profile is left alone, including on the authenticated socket.
 *   Without a usable CLI the Host is left running and named in a warning.
 *   This script never signals a process itself.
 * - Dead pid. Listed only. This hook has no sweeping path and rejects
 *   --sweep; it never removes a registry entry or socket directory itself.
 * - An older CLI that rejects the identity flags is warned about once for
 *   that attempt. There is no retry with weaker arguments.
 *
 * FAILURE POLICY. A registry, CLI or termination problem is a warning and
 * exits 0: the build continues. A Host left behind is replaced at the next
 * app launch anyway (payload mismatch), and a release build must not break on
 * a registry it does not own. Two things do fail the build:
 * - exit 2: a usage error. This covers no scope, a payload root other than
 *   this checkout's out/host, `--all` and an unknown flag.
 * - exit 1: the scope logic cannot be trusted. This covers three cases: the
 *   scope filter fails its built-in self-test, the CLI reports stopping a
 *   Host outside the profile and pid it was given, or the hook throws
 *   unexpectedly.
 *
 * BUDGET. Nothing to do costs one directory read. The registry walk is
 * bounded by WALK_DEADLINE_MS and the whole hook by HOOK_DEADLINE_MS. At
 * either deadline the hook kills its own CLI children (never a Host), warns
 * and exits 0.
 *
 * The registry reader mirrors src/host-runtime/HostRegistry.ts
 * (`readHostRegistry`), and host-stop-all.test.ts pins the two against each
 * other. It works on a first build, when `out` is still empty.
 */

const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

// Mirrors of src/host-runtime/HostRegistry.ts and
// src/shared/taskWraithHostPaths.node.ts (pinned by the test).
const HOST_REGISTRY_SCHEMA = 'taskwraith.host-registry.v1'
const HOST_REGISTRY_ROOT_ENV = 'TASKWRAITH_HOST_REGISTRY_ROOT'
const HOST_REGISTRY_MAX_ENTRY_BYTES = 16 * 1024
const HOST_DISCOVERY_FILE = 'taskwraith-host-v2.json'
const HOST_DISCOVERY_MAX_BYTES = 16 * 1024
const HOST_AUTHORITY_LEASE_FILE = 'taskwraith-host-authority-v1.json'
const HOST_AUTHORITY_LEASE_MAX_BYTES = 4 * 1024

/** Reading and classifying the registry; a slow or hung filesystem stops here. */
const WALK_DEADLINE_MS = 5_000
/**
 * The whole hook. The CLI's socket stop alone may take its acknowledgement,
 * drain and exit budgets (10 s + 45 s + 5 s), and a wedged Host reaches
 * SIGKILL after 10 s + 30 s. Past this the Host has been asked to stop and
 * the build continues.
 */
const HOOK_DEADLINE_MS = 75_000
const CLI_STDOUT_MAX_BYTES = 4 * 1024 * 1024
const CLI_STDERR_MAX_BYTES = 64 * 1024

const EXIT_OK = 0
const EXIT_SCOPE_BROKEN = 1
const EXIT_USAGE = 2

const ENTRY_ID_PATTERN = /^[0-9a-f]{16}$/
const LIFETIME_PHASE_PATTERN = /^[a-z][a-z-]{0,31}$/
const PAYLOAD_VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/
const BIRTH_DIGEST_PATTERN = /^[0-9a-f]{64}$/i

/** CLI outcomes after which the Host is proven gone (HOST_TERMINATION_SUCCESS_KINDS). */
const CLI_SUCCESS_KINDS = new Set(['stopped', 'already_gone', 'terminated', 'killed', 'pid_reused'])

const USAGE = [
  'Usage: node scripts/host-stop-all.cjs --payload-root out/host [--json]',
  '  Stops only the Hosts whose registry entry runs the out/host of this checkout.',
  '  --payload-root  must resolve, against this checkout, to its out/host',
  '  --json          print the report as JSON'
].join('\n')

class HostStopAllUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HostStopAllUsageError'
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isBoundedString(value, max) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !hasControlCharacters(value)
  )
}

function isCanonicalIso(value) {
  if (!isBoundedString(value, 100)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isPid(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isErrno(error, codes) {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && codes.includes(String(error.code))
  )
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Same decode, same order and same messages as HostRegistry.decodeHostRegistryEntry. */
function decodeHostRegistryEntry(value) {
  if (!isRecord(value)) return { ok: false, error: 'entry must be an object' }
  if (value.schema !== HOST_REGISTRY_SCHEMA) return { ok: false, error: 'unsupported schema' }
  if (!isBoundedString(value.profilePath, 4_096) || !path.isAbsolute(value.profilePath))
    return { ok: false, error: 'profilePath must be an absolute path' }
  if (!isPid(value.pid)) return { ok: false, error: 'pid must be a positive integer' }
  if (value.birthIdentity !== null && !isBoundedString(value.birthIdentity, 256))
    return { ok: false, error: 'birthIdentity must be a string or null' }
  if (!isCanonicalIso(value.startedAt))
    return { ok: false, error: 'startedAt must be canonical ISO' }
  if (!isBoundedString(value.hostId, 512)) return { ok: false, error: 'hostId must be a string' }
  if (value.bootEpoch !== null && !isBoundedString(value.bootEpoch, 512))
    return { ok: false, error: 'bootEpoch must be a string or null' }
  if (
    value.payloadVersion !== null &&
    (typeof value.payloadVersion !== 'string' ||
      !PAYLOAD_VERSION_PATTERN.test(value.payloadVersion))
  )
    return { ok: false, error: 'payloadVersion must be a SHA-256 identity or null' }
  if (!isBoundedString(value.socketPath, 1_000)) return { ok: false, error: 'socketPath invalid' }
  if (!isBoundedString(value.discoveryPath, 4_096))
    return { ok: false, error: 'discoveryPath invalid' }
  if (value.cliPath !== null && !isBoundedString(value.cliPath, 4_096))
    return { ok: false, error: 'cliPath must be a string or null' }
  if (value.nodeExecutable !== null && !isBoundedString(value.nodeExecutable, 4_096))
    return { ok: false, error: 'nodeExecutable must be a string or null' }
  if (typeof value.persist !== 'boolean') return { ok: false, error: 'persist must be boolean' }
  if (value.leaseMode !== 'lease') return { ok: false, error: 'leaseMode must be lease' }
  if (!isCanonicalIso(value.writtenAt))
    return { ok: false, error: 'writtenAt must be canonical ISO' }
  if (!isCount(value.beatSeq)) return { ok: false, error: 'beatSeq must be a count' }
  if (!isCount(value.holders)) return { ok: false, error: 'holders must be a count' }
  if (!isCount(value.implicitHolders))
    return { ok: false, error: 'implicitHolders must be a count' }
  if (typeof value.lifetimePhase !== 'string' || !LIFETIME_PHASE_PATTERN.test(value.lifetimePhase))
    return { ok: false, error: 'lifetimePhase invalid' }
  return {
    ok: true,
    entry: {
      schema: HOST_REGISTRY_SCHEMA,
      profilePath: value.profilePath,
      pid: value.pid,
      birthIdentity: value.birthIdentity,
      startedAt: value.startedAt,
      hostId: value.hostId,
      bootEpoch: value.bootEpoch,
      payloadVersion: value.payloadVersion,
      socketPath: value.socketPath,
      discoveryPath: value.discoveryPath,
      cliPath: value.cliPath,
      nodeExecutable: value.nodeExecutable,
      persist: value.persist,
      leaseMode: 'lease',
      writtenAt: value.writtenAt,
      beatSeq: value.beatSeq,
      holders: value.holders,
      implicitHolders: value.implicitHolders,
      lifetimePhase: value.lifetimePhase
    }
  }
}

function sameStatIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

async function assertPrivateRegular(file) {
  const stat = await fsp.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local control artifact is unsafe')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Local control artifact is not owner-only')
  }
  return stat
}

/**
 * The bounded, no-follow, owner-only read of hostLocalControlArtifacts.node's
 * readPrivateLocalControlArtifact, with the same before/open/after identity
 * checks, made asynchronous so a hung filesystem cannot outlive the deadline.
 */
async function readPrivateArtifact(file, maxBytes) {
  const before = await assertPrivateRegular(file)
  if (before.size < 1 || before.size > maxBytes)
    throw new Error('Local control artifact size is invalid')
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameStatIdentity(before, opened) || opened.size !== before.size) {
      throw new Error('Local control artifact changed while opening')
    }
    const buffer = Buffer.alloc(opened.size)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== buffer.length) throw new Error('Local control artifact read was incomplete')
    const after = await assertPrivateRegular(file)
    if (!sameStatIdentity(before, after) || after.size !== opened.size) {
      throw new Error('Local control artifact changed while reading')
    }
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** One registry entry file: present, missing (ENOENT only) or unreadable. */
async function readEntryFile(file) {
  let raw
  try {
    raw = await readPrivateArtifact(file, HOST_REGISTRY_MAX_ENTRY_BYTES)
  } catch (error) {
    if (isErrno(error, ['ENOENT'])) return { kind: 'missing', path: file }
    return { kind: 'unreadable', path: file, error: describe(error) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: 'unreadable', path: file, error: `not JSON: ${describe(error)}` }
  }
  const decoded = decodeHostRegistryEntry(parsed)
  return decoded.ok
    ? { kind: 'present', entry: decoded.entry, path: file }
    : { kind: 'unreadable', path: file, error: decoded.error }
}

/** Every decodable entry under the root; a missing root is an empty registry. */
async function readRegistry(root) {
  let names
  try {
    names = await fsp.readdir(root)
  } catch (error) {
    if (isErrno(error, ['ENOENT'])) return { root, entries: [], unreadable: [] }
    return { root, entries: [], unreadable: [{ path: root, error: describe(error) }] }
  }
  const entries = []
  const unreadable = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || !ENTRY_ID_PATTERN.test(name.slice(0, -'.json'.length))) continue
    const read = await readEntryFile(path.join(root, name))
    if (read.kind === 'present') entries.push(read.entry)
    else if (read.kind === 'unreadable') unreadable.push({ path: read.path, error: read.error })
  }
  return { root, entries, unreadable }
}

/** HostRegistry.resolveHostRegistryRoot, for this process's own environment. */
function resolveRegistryRoot(env = process.env, home = os.homedir()) {
  const value = env[HOST_REGISTRY_ROOT_ENV]
  const configured = typeof value === 'string' ? value.trim() : ''
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(home, '.taskwraith', 'hosts')
}

/** The entry name and the socket-directory suffix: sha256(profilePath), 16 hex. */
function hostRegistryEntryId(profilePath) {
  return createHash('sha256').update(profilePath).digest('hex').slice(0, 16)
}

function entryPathFor(registryRoot, profilePath) {
  return path.join(registryRoot, `${hostRegistryEntryId(profilePath)}.json`)
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

function foldCase(value, platform) {
  return platform === 'win32' ? value.toLowerCase() : value
}

/**
 * THE scope filter. True only for an absolute `cliPath` strictly below
 * `payloadRoot`, compared with a separator boundary so that `out/host2` and
 * `out/host-old` are other payloads. The comparison is lexical: `.` and `..`
 * are collapsed, symlinks are not followed. A Host records its own realpath
 * (`resolve(__dirname, 'cli.js')` of a main module), and `payloadRoot` is a
 * realpath (resolvePayloadRoot), so the two spellings agree for every Host
 * this checkout started and for no other. Windows compares case-insensitively.
 */
function isUnderPayloadRoot(cliPath, payloadRoot, platform = process.platform) {
  if (typeof cliPath !== 'string' || cliPath.length === 0) return false
  const api = pathApi(platform)
  if (!api.isAbsolute(cliPath) || !api.isAbsolute(payloadRoot)) return false
  const candidate = foldCase(api.resolve(cliPath), platform)
  const root = foldCase(api.resolve(payloadRoot), platform)
  return candidate.startsWith(`${root}${api.sep}`)
}

/**
 * Runs the scope filter against paths built from the real payload root: its
 * own CLI must match; `out/host2`, the root itself, a sibling and a nested
 * worktree, the installed app and a relative path must not. A failure means
 * the filter is broken and nothing may be selected with it.
 */
function selfTestScopeFilter(payloadRoot, checkoutRoot, platform = process.platform) {
  const api = pathApi(platform)
  const cli = (root) => api.join(root, 'host-runtime', 'cli.js')
  const filesystemRoot = api.parse(payloadRoot).root
  const installedHost = api.join(
    filesystemRoot,
    'Applications',
    'TaskWraith.app',
    'Contents',
    'Resources',
    'host'
  )
  const cases = [
    [cli(payloadRoot), true],
    [api.join(payloadRoot, 'host-runtime', '.', 'cli.js'), true],
    [cli(`${payloadRoot}2`), false],
    [cli(`${payloadRoot}-old`), false],
    [api.join(payloadRoot, '..', 'host2', 'host-runtime', 'cli.js'), false],
    [payloadRoot, false],
    [cli(api.join(`${checkoutRoot}-worktree`, 'out', 'host')), false],
    [cli(api.join(checkoutRoot, '.claude', 'worktrees', 'peer', 'out', 'host')), false],
    [cli(installedHost), false],
    [api.join('out', 'host', 'host-runtime', 'cli.js'), false],
    ['', false],
    [null, false]
  ]
  const failures = []
  for (const [candidate, expected] of cases) {
    if (isUnderPayloadRoot(candidate, payloadRoot, platform) !== expected) {
      failures.push(`${JSON.stringify(candidate)} should ${expected ? '' : 'not '}be in scope`)
    }
  }
  return failures
}

function parseArguments(argv) {
  let payloadRoot = null
  let json = false
  const once = (seen, option) => {
    if (seen) throw new HostStopAllUsageError(`${option} may appear once.`)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--payload-root') {
      once(payloadRoot !== null, option)
      const value = argv[index + 1]
      if (!value || value.startsWith('--'))
        throw new HostStopAllUsageError('--payload-root requires one value.')
      payloadRoot = value
      index += 1
    } else if (option === '--sweep') {
      throw new HostStopAllUsageError('--sweep is unavailable here: build hooks never sweep.')
    } else if (option === '--json') {
      once(json, option)
      json = true
    } else if (option === '--all') {
      throw new HostStopAllUsageError(
        '--all is never available here: this hook stops only the Hosts of this checkout.'
      )
    } else if (option === '--profile' || option === '--scan-argv') {
      throw new HostStopAllUsageError(
        `${option} is unavailable here: use out/host/host-runtime/cli.js stop-all directly.`
      )
    } else {
      throw new HostStopAllUsageError(`Unknown argument ${JSON.stringify(option)}.`)
    }
  }
  if (payloadRoot === null) {
    throw new HostStopAllUsageError(
      'Refusing to run without a scope: pass --payload-root out/host.'
    )
  }
  return { payloadRoot, json }
}

/**
 * The only payload root this checkout may act on: `<realpath of the
 * checkout>/out/host`. `requested` is resolved against the checkout, and any
 * other result is a usage error.
 */
function resolvePayloadRoot(requested, checkoutRoot, platform = process.platform) {
  const api = pathApi(platform)
  const expected = api.join(checkoutRoot, 'out', 'host')
  const actual = api.resolve(checkoutRoot, requested)
  if (foldCase(actual, platform) !== foldCase(expected, platform)) {
    throw new HostStopAllUsageError(
      `--payload-root must name the out/host of this checkout (${expected}), not ${actual}.`
    )
  }
  return expected
}

/** kill(pid, 0): ESRCH is dead; EPERM is another user's process, never one of ours. */
function probePid(pid) {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (isErrno(error, ['ESRCH'])) return 'dead'
    if (isErrno(error, ['EPERM'])) return 'foreign'
    return 'unknown'
  }
}

/**
 * A profile-side record (discovery or authority lease), reduced to the
 * fields that say which process wrote it. The lease also holds the owner
 * token. Nothing read here is ever printed: a malformed file is reported by
 * name only, since a JSON parse error quotes the input.
 */
async function readProfileRecord(file, maxBytes) {
  let raw
  try {
    raw = await readPrivateArtifact(file, maxBytes)
  } catch (error) {
    return isErrno(error, ['ENOENT']) ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unreadable' }
  }
  if (!isRecord(parsed) || !isPid(parsed.pid)) return { kind: 'unreadable' }
  return {
    kind: 'present',
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    socketPath: typeof parsed.socketPath === 'string' ? parsed.socketPath : null,
    processStartIdentity:
      typeof parsed.processStartIdentity === 'string' ? parsed.processStartIdentity : null
  }
}

async function readProfileRecords(profilePath) {
  const [discovery, lease] = await Promise.all([
    readProfileRecord(path.join(profilePath, HOST_DISCOVERY_FILE), HOST_DISCOVERY_MAX_BYTES),
    readProfileRecord(
      path.join(profilePath, HOST_AUTHORITY_LEASE_FILE),
      HOST_AUTHORITY_LEASE_MAX_BYTES
    )
  ])
  return { discovery, lease }
}

/**
 * Whether the profile's discovery and authority lease describe exactly the
 * process the registry entry names: the same pid, the same listener
 * (`startedAt` and `socketPath` are copied from discovery into the entry) and,
 * where both carry a birth digest, the same birth. A missing record is not a
 * contradiction; an unreadable one is.
 */
function recordsDescribeEntry(entry, records) {
  const { discovery, lease } = records
  if (discovery.kind === 'unreadable') return { ok: false, reason: 'its discovery is unreadable' }
  if (lease.kind === 'unreadable') return { ok: false, reason: 'its authority lease is unreadable' }
  if (discovery.kind === 'present') {
    if (discovery.pid !== entry.pid)
      return { ok: false, reason: `its discovery names pid ${discovery.pid}` }
    if (discovery.startedAt !== entry.startedAt || discovery.socketPath !== entry.socketPath)
      return { ok: false, reason: 'its discovery belongs to another start of that pid' }
  }
  if (lease.kind === 'present') {
    if (lease.pid !== entry.pid)
      return { ok: false, reason: `its authority lease names pid ${lease.pid}` }
    if (
      typeof entry.birthIdentity === 'string' &&
      BIRTH_DIGEST_PATTERN.test(entry.birthIdentity) &&
      typeof lease.processStartIdentity === 'string' &&
      BIRTH_DIGEST_PATTERN.test(lease.processStartIdentity) &&
      lease.processStartIdentity.toLowerCase() !== entry.birthIdentity.toLowerCase()
    )
      return { ok: false, reason: 'its authority lease belongs to another birth of that pid' }
  }
  return { ok: true }
}

/** The entry still names the same Host start, served from the same CLI. */
function sameEntry(current, judged) {
  return (
    current.pid === judged.pid &&
    current.birthIdentity === judged.birthIdentity &&
    current.bootEpoch === judged.bootEpoch &&
    current.startedAt === judged.startedAt &&
    current.profilePath === judged.profilePath &&
    current.cliPath === judged.cliPath
  )
}

async function lstatOrNull(file) {
  try {
    return await fsp.lstat(file)
  } catch {
    return null
  }
}

/**
 * Runs the identity-bound profile stop with the registry root pinned
 * to the one this script read, collecting bounded output. `children` lets
 * the hook deadline kill a CLI that outlives it (the CLI, never a Host).
 */
function runCliStop(input) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let child
    try {
      child = spawn(
        input.execPath,
        [
          input.cliPath,
          'stop-all',
          '--profile',
          input.profilePath,
          '--expect-pid',
          String(input.expected.pid),
          '--expect-birth',
          input.expected.birthIdentity,
          '--json'
        ],
        {
          env: { ...input.env, [HOST_REGISTRY_ROOT_ENV]: input.registryRoot },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: describe(error) })
      return
    }
    input.children?.add(child)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes <= CLI_STDOUT_MAX_BYTES) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes <= CLI_STDERR_MAX_BYTES) stderr += chunk
    })
    child.once('error', (error) => {
      stderr += describe(error)
    })
    child.once('close', (code, signal) => {
      input.children?.delete(child)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** HostStopAll's own comparison: realpath when it resolves, case-folded on Windows. */
async function canonicalProfile(profilePath, platform) {
  let value = profilePath
  try {
    value = await fsp.realpath(pathApi(platform).resolve(profilePath))
  } catch {
    value = profilePath
  }
  return foldCase(value, platform)
}

/**
 * Judges the CLI's report for one profile. Its `hosts` list is the whole
 * registry, so only `selected` rows count, and every selected row must be
 * the profile it was given (compared the way the CLI selects). Anything else
 * means a Host outside that profile was acted on: a scope failure, exit 1.
 */
async function judgeCliReport(result, profilePath, expectedPid, platform) {
  const log = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    report = null
  }
  if (!isRecord(report) || !Array.isArray(report.hosts) || !isRecord(report.scope)) {
    const why =
      result.code === 2 ? 'it predates stop-all or refused the arguments' : 'no JSON report'
    return {
      kind: 'no-report',
      log,
      warning: `the built CLI printed no stop-all report (exit ${result.code ?? result.signal}; ${why})`
    }
  }
  const wanted = await canonicalProfile(profilePath, platform)
  const same = async (value) =>
    typeof value === 'string' && (await canonicalProfile(value, platform)) === wanted
  const selected = report.hosts.filter((host) => isRecord(host) && host.selected === true)
  const foreign = []
  for (const host of selected) {
    if (!(await same(host.profilePath))) foreign.push(host.profilePath)
  }
  if (
    report.scope.kind !== 'profile' ||
    !(await same(report.scope.profilePath)) ||
    foreign.length
  ) {
    return {
      kind: 'scope-escape',
      log,
      error: `the CLI acted outside the profile it was given (${profilePath}): ${JSON.stringify(foreign)}`
    }
  }
  if (
    selected.length !== 1 ||
    selected.some(
      (host) =>
        host.pid !== expectedPid || !isRecord(host.outcome) || host.outcome.pid !== expectedPid
    )
  ) {
    return {
      kind: 'scope-escape',
      log,
      error: `the CLI report did not bind every selected row and outcome to expected pid ${expectedPid}`
    }
  }
  const outcome = selected.map((host) => host.outcome).find((value) => isRecord(value))
  if (!outcome || typeof outcome.kind !== 'string') {
    return { kind: 'no-outcome', log, warning: 'the CLI selected no Host for the profile' }
  }
  if (CLI_SUCCESS_KINDS.has(outcome.kind)) return { kind: 'gone', outcome: outcome.kind, log }
  return {
    kind: 'refused',
    outcome: outcome.kind,
    log,
    warning: `left running: verified termination answered ${outcome.kind}`
  }
}

async function cliIsPresent(cliPath) {
  const stat = await lstatOrNull(cliPath)
  return Boolean(stat && stat.isFile())
}

function withDeadline(promise, ms) {
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
  })
  return Promise.race([promise.then((value) => ({ timedOut: false, value })), deadline]).finally(
    () => clearTimeout(timer)
  )
}

/**
 * The hook itself, with every effect behind `ports` so tests can drive it
 * against a fake registry. `payloadRoot` must come from resolvePayloadRoot.
 * `onReport` receives the report as soon as it exists, so a caller whose
 * deadline fires still sees a scope failure recorded before it.
 */
async function runHostStopAll(options) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const ports = {
    readRegistry,
    readEntry: readEntryFile,
    probePid,
    readProfileRecords,
    runCliStop,
    cliIsPresent,
    ...options.ports
  }
  const registryRoot = options.registryRoot ?? resolveRegistryRoot(env)
  const payloadRoot = options.payloadRoot
  const cliPath = pathApi(platform).join(payloadRoot, 'host-runtime', 'cli.js')
  const warnings = []
  const report = {
    payloadRoot,
    registryRoot,
    cliPath,
    mode: 'fallback',
    hosts: [],
    warnings,
    exitCode: EXIT_OK
  }
  options.onReport?.(report)

  const scopeFailures = selfTestScopeFilter(payloadRoot, options.checkoutRoot, platform)
  if (scopeFailures.length) {
    report.error = `the scope filter failed its self-test: ${scopeFailures.join('; ')}`
    report.exitCode = EXIT_SCOPE_BROKEN
    return report
  }

  const walkDeadlineMs = options.walkDeadlineMs ?? WALK_DEADLINE_MS
  const walk = await withDeadline(
    (async () => {
      const listing = await ports.readRegistry(registryRoot)
      const inScope = listing.entries.filter((entry) =>
        isUnderPayloadRoot(entry.cliPath, payloadRoot, platform)
      )
      return { listing, inScope, cliPresent: await ports.cliIsPresent(cliPath) }
    })(),
    walkDeadlineMs
  )
  if (walk.timedOut) {
    warnings.push(`the registry walk passed ${walkDeadlineMs} ms; nothing was stopped`)
    return report
  }
  const { listing, inScope, cliPresent } = walk.value
  for (const unreadable of listing.unreadable) {
    warnings.push(`unreadable registry entry ${unreadable.path}: ${unreadable.error}`)
  }
  report.mode = cliPresent ? 'cli' : 'fallback'
  report.inScope = inScope.map((entry) => entry.profilePath)

  const stop = async (entry, host) => {
    if (
      typeof entry.birthIdentity !== 'string' ||
      entry.birthIdentity.length !== 64 ||
      !BIRTH_DIGEST_PATTERN.test(entry.birthIdentity)
    ) {
      const note = 'its registry entry has no valid birth digest for an identity-bound stop'
      warnings.push(`pid ${entry.pid} (${entry.profilePath}) left alone: ${note}`)
      return { ...host, action: 'left-alone', note }
    }
    if (!cliPresent) {
      warnings.push(
        `pid ${entry.pid} (${entry.profilePath}) left running: no built ${cliPath} to verify and stop it`
      )
      return { ...host, action: 'left-running' }
    }
    const records = await ports.readProfileRecords(entry.profilePath)
    const fresh = await ports.readEntry(entryPathFor(registryRoot, entry.profilePath))
    const consistent =
      fresh.kind === 'present' && sameEntry(fresh.entry, entry)
        ? recordsDescribeEntry(entry, records)
        : { ok: false, reason: 'its registry entry changed' }
    if (!consistent.ok) {
      warnings.push(
        `pid ${entry.pid} (${entry.profilePath}) left alone: ${consistent.reason}, so the profile may belong to another Host`
      )
      return { ...host, action: 'left-alone', note: consistent.reason }
    }
    const result = await ports.runCliStop({
      execPath: options.execPath ?? process.execPath,
      cliPath,
      profilePath: entry.profilePath,
      expected: { pid: entry.pid, birthIdentity: entry.birthIdentity.toLowerCase() },
      registryRoot,
      env,
      children: options.children
    })
    const judged = await judgeCliReport(result, entry.profilePath, entry.pid, platform)
    if (judged.kind === 'scope-escape') {
      report.error = judged.error
      report.exitCode = EXIT_SCOPE_BROKEN
    }
    if (judged.warning) warnings.push(`pid ${entry.pid} (${entry.profilePath}): ${judged.warning}`)
    return {
      ...host,
      action: 'cli-stop',
      result: judged.kind,
      ...(judged.outcome ? { outcome: judged.outcome } : {}),
      log: judged.log
    }
  }

  const handle = async (entry) => {
    const liveness = ports.probePid(entry.pid)
    const host = {
      profilePath: entry.profilePath,
      pid: entry.pid,
      cliPath: entry.cliPath,
      liveness
    }
    try {
      if (liveness === 'dead') {
        return { ...host, action: 'listed' }
      }
      if (liveness !== 'alive') {
        warnings.push(`pid ${entry.pid} (${entry.profilePath}) left alone: its pid is ${liveness}`)
        return { ...host, action: 'left-alone' }
      }
      return await stop(entry, host)
    } catch (error) {
      warnings.push(`pid ${entry.pid} (${entry.profilePath}) left alone: ${describe(error)}`)
      return { ...host, action: 'left-alone', note: describe(error) }
    }
  }

  report.hosts = await Promise.all(inScope.map((entry) => handle(entry)))
  return report
}

function formatReport(report) {
  const prefix = 'host-stop-all:'
  const lines = []
  if (!report.hosts.length && !report.error && !report.timedOut) {
    lines.push(`${prefix} no Host in ${report.registryRoot} serves ${report.payloadRoot}`)
  }
  for (const host of report.hosts) {
    const detail = [
      host.action,
      host.outcome,
      host.entry ? `entry ${host.entry}` : null,
      host.socketDirectory ? `socket directory ${host.socketDirectory}` : null,
      host.note ? `(${host.note})` : null
    ].filter(Boolean)
    lines.push(
      `${prefix} pid ${host.pid} ${host.liveness} ${host.profilePath} -> ${detail.join(', ')}`
    )
    for (const line of host.log ?? []) lines.push(`${prefix}   ${line}`)
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/**
 * The command: parse, pin the scope to this checkout, run under the hook
 * deadline, print, and return the exit code. `io` exists for tests; the
 * checkout root is never read from argv or the environment.
 */
async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text) => process.stderr.write(text))
  const platform = io.platform ?? process.platform
  let parsed
  let checkoutRoot
  let payloadRoot
  try {
    parsed = parseArguments(argv)
    checkoutRoot = fs.realpathSync(io.checkoutRoot ?? path.resolve(__dirname, '..'))
    payloadRoot = resolvePayloadRoot(parsed.payloadRoot, checkoutRoot, platform)
  } catch (error) {
    if (error instanceof HostStopAllUsageError) {
      stderr(`host-stop-all: ${error.message}\n${USAGE}\n`)
      return EXIT_USAGE
    }
    stderr(`host-stop-all: ERROR ${describe(error)}\n`)
    return EXIT_SCOPE_BROKEN
  }
  const children = new Set()
  const deadlineMs = io.hookDeadlineMs ?? HOOK_DEADLINE_MS
  let partial = null
  let run
  try {
    run = await withDeadline(
      runHostStopAll({
        ...(io.options ?? {}),
        checkoutRoot,
        payloadRoot,
        platform,
        env: io.env ?? process.env,
        children,
        onReport: (report) => {
          partial = report
        }
      }),
      deadlineMs
    )
  } catch (error) {
    stderr(`host-stop-all: ERROR the hook failed unexpectedly: ${describe(error)}\n`)
    return EXIT_SCOPE_BROKEN
  }
  let report = run.timedOut ? partial : run.value
  if (run.timedOut) {
    for (const child of children) child.kill('SIGKILL')
    // `partial` exists from the first line of runHostStopAll, so a scope
    // failure it recorded before the deadline still decides the exit code.
    const stopping = partial?.inScope?.length ? ` (${partial.inScope.join(', ')})` : ''
    const warning = `stopping the Hosts of this checkout${stopping} passed ${deadlineMs} ms; the build continues`
    report = {
      hosts: [],
      exitCode: EXIT_OK,
      ...report,
      timedOut: true,
      warnings: [...(report?.warnings ?? []), warning]
    }
  }
  if (parsed.json) stdout(`${JSON.stringify(report, null, 2)}\n`)
  else stdout(formatReport(report))
  for (const warning of report.warnings) stderr(`host-stop-all: warning: ${warning}\n`)
  if (report.error) stderr(`host-stop-all: ERROR ${report.error}\n`)
  return report.exitCode
}

if (require.main === module) {
  // An explicit exit: a registry read stuck in the filesystem must not hold
  // the process (and the build) open once the deadline has answered.
  main(process.argv.slice(2)).then(
    (code) => {
      const exit = () => process.exit(code)
      const fallback = setTimeout(exit, 1_000)
      process.stdout.write('', () => {
        clearTimeout(fallback)
        exit()
      })
    },
    (error) => {
      process.stderr.write(`host-stop-all: ERROR ${describe(error)}\n`)
      process.exit(EXIT_SCOPE_BROKEN)
    }
  )
}

module.exports = {
  CLI_SUCCESS_KINDS,
  EXIT_OK,
  EXIT_SCOPE_BROKEN,
  EXIT_USAGE,
  HOOK_DEADLINE_MS,
  HOST_AUTHORITY_LEASE_FILE,
  HOST_AUTHORITY_LEASE_MAX_BYTES,
  HOST_DISCOVERY_FILE,
  HOST_DISCOVERY_MAX_BYTES,
  HOST_REGISTRY_MAX_ENTRY_BYTES,
  HOST_REGISTRY_ROOT_ENV,
  HOST_REGISTRY_SCHEMA,
  WALK_DEADLINE_MS,
  HostStopAllUsageError,
  decodeHostRegistryEntry,
  hostRegistryEntryId,
  isUnderPayloadRoot,
  judgeCliReport,
  main,
  parseArguments,
  readEntryFile,
  readRegistry,
  recordsDescribeEntry,
  resolvePayloadRoot,
  resolveRegistryRoot,
  runHostStopAll,
  selfTestScopeFilter
}
